// FILE: lib/services/agents/receivablesRiskAgent.js
// Receivables Risk Agent — Phase B of the Verified Execution Loop V1 initiative.
// Pure, deterministic EVIDENCE ASSEMBLY for overdue invoices: reads existing
// signals (customer_scores, customer_score_history, promises, invoices) and
// produces a structured evidence bundle per at-risk invoice. Does NOT generate
// or persist actions — no writes anywhere in this module. Turning this evidence
// into approved/executed actions is Phase C's job (separate, later task).
//
// Reuse, not re-derivation:
//   - credit_risk_score / risk tier: reuses creditRiskAgent.js::deriveTier() verbatim
//     (>=70 HIGH_RISK, >=40 MEDIUM, else LOW) — never recomputed here.
//   - score trajectory: reuses creditRiskAgent.js::classifyScoreTrajectory() verbatim,
//     fed the same customer_score_history shape (rows ordered recorded_at DESC).
//   - customer_id resolution for a null FK: reuses scoring.service.js::resolveCustomerId()
//     verbatim (ilike name [+ exact phone] against `customers`) — the same helper
//     server.js already calls for this exact situation. No new resolution logic.
//   - business-memory bulk-fetch-once-per-tenant pattern: mirrors collectionsAgent.js's
//     memoryByCustomer / riskByCustomer construction (one query per table per tenant
//     run, keyed by customer_id, never a per-invoice query).
//
// Never throws — degrades to [] on hard failure, and degrades per-invoice (null
// customer-scoped fields) when a customer_id can't be resolved or a downstream
// table read fails, exactly like collectionsAgent.js already does for this case.
const { supabase } = require('../../config/supabaseClient');
const { safeLog }  = require('../../observability/logger');
const { resolveCustomerId } = require('../orchestrator/scoring.service');
const { deriveTier, classifyScoreTrajectory } = require('./creditRiskAgent');

// This phase produces evidence only (no ai_actions row, no action_type), but the
// codebase-wide convention (policyGuard.service.js::ALWAYS_REQUIRES_APPROVAL) is
// that every reminder/collection-adjacent customer-facing or risk-flagging action
// (SEND_FIRM_REMINDER, CASHFLOW_RISK, CREDIT_HOLD_SUGGESTED, ...) always requires
// owner approval before anything external happens. A receivables-risk evidence
// bundle sits in that same class, so this mirrors that convention rather than
// inventing a new approval rule. Discrepancy note: policyGuard.service.js has no
// RECEIVABLES_RISK entry (there is no action_type here for it to key on yet —
// that arrives in Phase C when this evidence is turned into an actual ai_action),
// so this is a deliberate, documented mirror of the existing convention, not a
// literal reuse of a lookup against that Set.
const REQUIRES_APPROVAL = true;

function fmtInr(amount) {
  const n = Number(amount) || 0;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

/**
 * Pure function: normalize a DATE-column value to a plain YYYY-MM-DD string.
 * The local pg-backed supabase shim returns DATE columns as JS Date objects
 * serialized with a timezone offset (e.g. "2026-09-19T18:30:00.000Z" for a
 * stored '2026-09-20' in an IST-ahead environment) — using that raw value
 * directly in an evidence string would misstate the actual promised date by
 * a day and imply false precision (a time-of-day that was never stored).
 * This strips it back down to the calendar date alone. Never throws;
 * malformed/missing input passes through unchanged rather than being masked.
 */
function normalizeDateOnly(value) {
  if (!value) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  try {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    // A DATE column has no time-of-day. The local pg-backed shim constructs
    // this Date at LOCAL midnight for the stored calendar day (not UTC
    // midnight), so reading it back with the *local* getters recovers the
    // original date exactly — using the UTC getters/toISOString() here would
    // shift the date by one day in any timezone ahead of UTC (e.g. IST).
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  } catch (_e) {
    return value;
  }
}

/**
 * Pure function: map a creditRiskAgent-derived tier to this evidence bundle's
 * risk_level. Mirrors creditRiskAgent.js's own tier->risk_level convention
 * (HIGH_RISK -> 'high', MEDIUM -> 'medium') and extends it one step for LOW
 * (-> 'low') since this module (unlike creditRiskAgent) must report a level
 * for every scored invoice, not only worsening ones. Returns 'unknown' only
 * when there is genuinely no score to classify (never fabricated).
 */
function riskLevelFromTier(tier) {
  if (tier === 'HIGH_RISK') return 'high';
  if (tier === 'MEDIUM')    return 'medium';
  if (tier === 'LOW')       return 'low';
  return 'unknown';
}

/**
 * Pure function: build the deterministic, human-readable evidence[] array for
 * one invoice from already-fetched, already-resolved data. Every string is
 * built directly from a real number/field passed in — no rounding that implies
 * false precision beyond what buildMessage()/healthEvidence() already do
 * elsewhere in this codebase (whole-rupee amounts, integer day counts, the
 * score as stored).
 */
function buildEvidenceStrings({ invoiceAmount, daysOverdue, customerResolved, creditRiskScore, tier, brokenPromiseCount, activePromise }) {
  const evidence = [];

  evidence.push(`${fmtInr(invoiceAmount)} overdue by ${daysOverdue} day${daysOverdue === 1 ? '' : 's'}`);

  if (!customerResolved) {
    evidence.push('Customer identity could not be resolved for this invoice — customer-scoped signals (credit risk, promise history) are unavailable.');
    return evidence;
  }

  if (tier) {
    const tierLabel = tier === 'HIGH_RISK' ? 'HIGH' : tier === 'MEDIUM' ? 'MEDIUM' : 'LOW';
    evidence.push(`Credit risk ${tierLabel}, score ${Math.round(creditRiskScore)}/100`);
  } else {
    evidence.push('No credit risk score on file for this customer.');
  }

  if (Number.isFinite(brokenPromiseCount) && brokenPromiseCount > 0) {
    evidence.push(`${brokenPromiseCount} broken promise${brokenPromiseCount === 1 ? '' : 's'} on this account`);
  }

  if (activePromise) {
    evidence.push(`Active promise-to-pay on this invoice, promised for ${normalizeDateOnly(activePromise.promised_date)}`);
  }

  return evidence;
}

/**
 * Assemble the receivables-risk evidence bundle for one tenant.
 * Pure read/compute/return — no writes, no ai_actions, no execution_records.
 * @param {string} userId
 * @returns {Promise<Array>} evidence objects, one per overdue ('Pending', days_overdue > 0) invoice
 */
async function assembleReceivablesEvidence(userId) {
  try {
    if (!userId) return [];

    const { data: invoices, error: invErr } = await supabase
      .from('invoices')
      .select('id, customer_id, customer_name, customer_phone, invoice_amount, days_overdue, due_date')
      .eq('user_id', userId)
      .eq('payment_status', 'Pending')
      .gt('days_overdue', 0)
      .order('days_overdue', { ascending: false });

    if (invErr) throw invErr;
    if (!invoices || !invoices.length) return [];

    // Resolve any invoices whose customer_id FK is null via the exact same
    // name(+phone) lookup server.js already uses for this situation
    // (scoring.service.js::resolveCustomerId). This is bounded to the subset
    // of invoices actually missing a customer_id — not a per-invoice query for
    // every invoice, mirroring creditRiskAgent.js's own convention of only
    // doing a per-row lookup for an already-filtered subset.
    const resolvedCustomerIdByInvoice = {};
    for (const inv of invoices) {
      if (inv.customer_id) {
        resolvedCustomerIdByInvoice[inv.id] = inv.customer_id;
        continue;
      }
      try {
        const resolved = await resolveCustomerId(userId, inv.customer_name, inv.customer_phone || null);
        resolvedCustomerIdByInvoice[inv.id] = resolved || null;
      } catch (resolveErr) {
        safeLog('warn', '[ReceivablesRiskAgent] resolveCustomerId failed, degrading to unresolved customer', { error: resolveErr.message, invoiceId: inv.id, userId });
        resolvedCustomerIdByInvoice[inv.id] = null;
      }
    }

    const customerIds = [...new Set(Object.values(resolvedCustomerIdByInvoice).filter(Boolean))];

    // Bulk-fetch customer_scores once per tenant (never per-invoice).
    let scoreByCustomer = {};
    if (customerIds.length) {
      try {
        const { data: scoreRows } = await supabase
          .from('customer_scores')
          .select('customer_id, credit_risk_score, broken_promise_count, promise_reliability_score, collection_priority_score')
          .eq('user_id', userId)
          .in('customer_id', customerIds);
        scoreByCustomer = (scoreRows || []).reduce((acc, r) => { acc[r.customer_id] = r; return acc; }, {});
      } catch (scoreErr) {
        safeLog('warn', '[ReceivablesRiskAgent] customer_scores lookup failed, degrading to no-score evidence', { error: scoreErr.message, userId });
        scoreByCustomer = {};
      }
    }

    // Bulk-fetch customer_score_history once per tenant, for all customers in
    // scope, ordered so the latest two rows per customer sit first — grouped
    // in JS below rather than one query per customer. Feeds
    // creditRiskAgent.js::classifyScoreTrajectory() unmodified.
    let historyByCustomer = {};
    if (customerIds.length) {
      try {
        const { data: historyRows } = await supabase
          .from('customer_score_history')
          .select('customer_id, credit_risk_score, recorded_at')
          .eq('user_id', userId)
          .in('customer_id', customerIds)
          .order('recorded_at', { ascending: false });
        historyByCustomer = (historyRows || []).reduce((acc, r) => {
          (acc[r.customer_id] = acc[r.customer_id] || []).push(r);
          return acc;
        }, {});
      } catch (histErr) {
        safeLog('warn', '[ReceivablesRiskAgent] customer_score_history lookup failed, degrading to UNKNOWN trajectory', { error: histErr.message, userId });
        historyByCustomer = {};
      }
    }

    // Bulk-fetch active promises once per tenant, scoped by receivable_id (the
    // invoice FK on `promises`) so per-invoice active_promise lookup is a plain
    // map read below, never a query inside the loop.
    const invoiceIds = invoices.map(inv => inv.id);
    let activePromiseByInvoice = {};
    if (invoiceIds.length) {
      try {
        const { data: promiseRows } = await supabase
          .from('promises')
          .select('id, receivable_id, promised_date, promised_amount, status')
          .eq('user_id', userId)
          .eq('status', 'active')
          .in('receivable_id', invoiceIds);
        activePromiseByInvoice = (promiseRows || []).reduce((acc, r) => { acc[r.receivable_id] = r; return acc; }, {});
      } catch (promErr) {
        safeLog('warn', '[ReceivablesRiskAgent] promises lookup failed, degrading to no-active-promise evidence', { error: promErr.message, userId });
        activePromiseByInvoice = {};
      }
    }

    const bundles = [];
    for (const inv of invoices) {
      const customerId = resolvedCustomerIdByInvoice[inv.id] || null;
      const scoreRow    = customerId ? scoreByCustomer[customerId] : null;
      const historyRows = customerId ? (historyByCustomer[customerId] || []) : [];
      const activePromise = activePromiseByInvoice[inv.id] || null;

      const creditRiskScore = scoreRow ? Number(scoreRow.credit_risk_score) : null;
      const tier             = scoreRow ? deriveTier(scoreRow.credit_risk_score) : null;
      const trajectory       = customerId ? classifyScoreTrajectory(historyRows) : 'UNKNOWN';
      const brokenPromiseCount = scoreRow && Number.isFinite(Number(scoreRow.broken_promise_count))
        ? Number(scoreRow.broken_promise_count)
        : null;

      const evidence = buildEvidenceStrings({
        invoiceAmount:   inv.invoice_amount,
        daysOverdue:     inv.days_overdue,
        customerResolved: !!customerId,
        creditRiskScore,
        tier,
        brokenPromiseCount,
        activePromise,
      });

      if (trajectory === 'DETERIORATING') {
        evidence.push('Credit risk trajectory is DETERIORATING across recent snapshots.');
      }

      bundles.push({
        invoice_id:            inv.id,
        customer_id:           customerId,
        outstanding_amount:    inv.invoice_amount,
        days_overdue:          inv.days_overdue,
        due_date:              inv.due_date ?? null,
        credit_risk_score:     creditRiskScore,
        risk_tier:             tier,
        trajectory,
        broken_promise_count:  brokenPromiseCount,
        active_promise:        !!activePromise,
        active_promise_details: activePromise ? { promised_date: normalizeDateOnly(activePromise.promised_date), promised_amount: activePromise.promised_amount } : null,
        evidence,
        risk_level:            customerId ? riskLevelFromTier(tier) : 'unknown',
        requires_approval:     REQUIRES_APPROVAL,
      });
    }

    safeLog('info', '[ReceivablesRiskAgent] Evidence assembly complete', { userId, invoices: bundles.length });
    return bundles;
  } catch (err) {
    safeLog('error', '[ReceivablesRiskAgent] assembleReceivablesEvidence failed', { error: err.message, userId });
    return [];
  }
}

// Day 1 sprint (2026-09-06/07): wire the previously-orphaned evidence assembly
// above into the live orchestrator pipeline, following the EXACT pattern every
// other agent already uses (creditRiskAgent.js / cashflowAgent.js): a run(userId)
// that returns ActionSpecs, one per at-risk invoice, deduped against existing
// pending actions for the same invoice, gated to invoices that actually carry a
// real risk signal (not every overdue invoice — collectionsAgent.js already owns
// generic overdue reminders; this agent only fires when the evidence assembled
// above shows genuine elevated risk: HIGH_RISK credit tier, a DETERIORATING
// trajectory, or a broken-promise history on the account). Never fabricates —
// an unresolved customer_id or missing score simply does not qualify here.
const ACTION_TYPE = 'RECEIVABLES_RISK_ALERT';

/**
 * Pure function: decide whether an evidence bundle for one invoice justifies
 * creating an ai_action. Deliberately conservative — only real, already-derived
 * signals (never invented): HIGH_RISK credit tier, a DETERIORATING trajectory,
 * or at least one broken promise on the account. A merely-overdue invoice with
 * no customer-scoped risk signal (unresolved customer, no score, LOW tier,
 * no broken promises) does not qualify — that case is already covered by
 * collectionsAgent.js's generic reminder flow and would be noise here.
 */
function qualifiesForAlert(bundle) {
  if (!bundle) return false;
  if (bundle.risk_tier === 'HIGH_RISK') return true;
  if (bundle.trajectory === 'DETERIORATING') return true;
  if (Number.isFinite(bundle.broken_promise_count) && bundle.broken_promise_count > 0) return true;
  return false;
}

/**
 * Run the Receivables Risk Agent.
 * Assembles evidence (assembleReceivablesEvidence, unmodified) and turns the
 * subset that qualifies (qualifiesForAlert) into ActionSpecs, one per invoice,
 * deduped against any existing pending RECEIVABLES_RISK_ALERT for the same
 * invoice — mirrors cashflowAgent.js's per-related_entity_id dedupe for
 * SUPPLIER_PAYMENT_OVERDUE exactly (both are one-alert-per-entity signals,
 * unlike CASHFLOW_GAP_ALERT's single tenant-level dedupe).
 * @param {string} userId
 * @returns {Promise<Array>} ActionSpecs
 */
async function run(userId) {
  try {
    if (!userId) return [];

    const bundles = await assembleReceivablesEvidence(userId);
    if (!bundles.length) return [];

    const qualifying = bundles.filter(qualifiesForAlert);
    if (!qualifying.length) {
      safeLog('info', '[ReceivablesRiskAgent] Run complete — no qualifying invoices', { userId, evaluated: bundles.length });
      return [];
    }

    const { data: existingAlerts } = await supabase
      .from('ai_actions')
      .select('related_entity_id')
      .eq('user_id', userId)
      .eq('action_type', ACTION_TYPE)
      .eq('status', 'pending');
    const alreadyAlerted = new Set((existingAlerts || []).map(a => a.related_entity_id));

    const specs = [];
    for (const bundle of qualifying) {
      if (alreadyAlerted.has(String(bundle.invoice_id))) continue;

      const tierLabel = bundle.risk_tier === 'HIGH_RISK' ? 'HIGH' : bundle.risk_tier === 'MEDIUM' ? 'MEDIUM' : bundle.risk_tier || 'unscored';
      specs.push({
        action_type:         ACTION_TYPE,
        title:               `Receivable at risk — ${fmtInr(bundle.outstanding_amount)} overdue ${bundle.days_overdue}d`,
        description:         bundle.evidence.join('; '),
        priority:            bundle.risk_tier === 'HIGH_RISK' ? 'high' : 'medium',
        risk_level:          bundle.risk_level === 'unknown' ? 'low' : bundle.risk_level,
        related_entity_type: 'invoice',
        related_entity_id:   bundle.invoice_id,
        customer_id:         bundle.customer_id || null,
        suggested_by:        'receivables_risk_agent',
        requires_approval:   REQUIRES_APPROVAL,
        reason_json: {
          credit_risk_score: bundle.credit_risk_score,
          risk_tier:         bundle.risk_tier,
          tier_label:        tierLabel,
          trajectory:        bundle.trajectory,
          broken_promise_count: bundle.broken_promise_count,
          active_promise:    bundle.active_promise,
          evidence:          bundle.evidence,
        },
      });
    }

    safeLog('info', '[ReceivablesRiskAgent] Run complete', { userId, evaluated: bundles.length, qualifying: qualifying.length, created: specs.length });
    return specs;
  } catch (err) {
    safeLog('error', '[ReceivablesRiskAgent] run failed', { error: err.message, userId });
    return [];
  }
}

module.exports = {
  assembleReceivablesEvidence,
  riskLevelFromTier,
  buildEvidenceStrings,
  normalizeDateOnly,
  qualifiesForAlert,
  run,
  ACTION_TYPE,
  REQUIRES_APPROVAL,
};
