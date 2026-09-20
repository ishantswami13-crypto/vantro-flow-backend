// FILE: lib/services/agents/collectionsAgent.js
// Collections Recovery Agent — generates reminder actions based on overdue stage.
// Stages: polite (1–7d) → firm (8–30d) → escalation-WhatsApp (31–35d) →
//         escalation-call (36–89d) → bad debt flag (90+d)
// Uses Hinglish templates from aiPlanner. Respects policyGuard before returning.
// Pure async function — never throws, returns [] on error.
//
// "Closing the loop" (Cortex X, agent auto-execute pass) additions, per the
// user-approved plan:
//   - Escalation cap: at most one NEW escalation-tier action (firm reminder,
//     WhatsApp escalation, or auto-call) per customer per rolling 24h,
//     regardless of how many overdue invoices they have. Polite reminders
//     are not subject to this cap (they aren't an escalation).
//   - Cooldown before jumping to the voice-call tier: a customer has to have
//     been in the WhatsApp-escalation band (31+ days overdue) for at least
//     CALL_TIER_COOLDOWN_DAYS before ESCALATE_COLLECTION_CALL becomes
//     eligible, instead of jumping straight from a WhatsApp message to an
//     automated phone call the moment day 31 is crossed. Implemented as a
//     simple day-threshold (daysOverdue >= 31 + cooldown) rather than
//     checking for evidence a prior WhatsApp escalation was actually sent —
//     a deliberate simplicity/robustness tradeoff, noted here as a judgment
//     call.
//   - Per-customer pause: customers.escalation_paused (checked via
//     scoring.service's existing resolveCustomerId helper) stops ALL
//     reminder/escalation generation for that customer's invoices, polite
//     included, so the owner has one obvious kill switch.
//   - Actual sending: SEND_POLITE_REMINDER auto-sends (no tap) when both
//     FEATURE_AGENT_AUTOEXECUTE_ENABLED and
//     FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED are on (see server.js's
//     autoSendCollectionsReminders). SEND_FIRM_REMINDER and
//     ESCALATE_COLLECTION remain requires_approval (already forced by
//     policyGuard.ALWAYS_REQUIRES_APPROVAL for SEND_FIRM_REMINDER, and by
//     this agent's own high risk_level for ESCALATE_COLLECTION) — tapping
//     approve now actually sends the message (server.js's
//     executeCollectionsMessage). ESCALATE_COLLECTION_CALL always requires
//     approval and places a real call only on tap (server.js's
//     executeCollectionCall), same as before.
const { supabase }     = require('../../config/supabaseClient');
const { safeLog }      = require('../../observability/logger');

const CALL_TIER_COOLDOWN_DAYS = 5; // days spent in the WhatsApp-escalation band before voice-call escalation is offered
const ESCALATION_TYPES = ['SEND_FIRM_REMINDER', 'ESCALATE_COLLECTION', 'ESCALATE_COLLECTION_CALL'];

const STAGE_CONFIG = [
  { minDays: 1,  maxDays: 7,  type: 'SEND_POLITE_REMINDER',   priority: 'medium', riskLevel: 'low'    },
  { minDays: 8,  maxDays: 30, type: 'SEND_FIRM_REMINDER',      priority: 'high',   riskLevel: 'medium' },
  { minDays: 31, maxDays: 30 + CALL_TIER_COOLDOWN_DAYS, type: 'ESCALATE_COLLECTION',      priority: 'urgent', riskLevel: 'high' },
  { minDays: 31 + CALL_TIER_COOLDOWN_DAYS, maxDays: 89, type: 'ESCALATE_COLLECTION_CALL', priority: 'urgent', riskLevel: 'high' },
  { minDays: 90, maxDays: Infinity, type: 'FLAG_BAD_DEBT',     priority: 'urgent', riskLevel: 'high'   },
];

function getStage(daysOverdue) {
  return STAGE_CONFIG.find(s => daysOverdue >= s.minDays && daysOverdue <= s.maxDays) || STAGE_CONFIG[0];
}

// Ordered index of stages, used to move one step up/down the escalation ladder.
const STAGE_INDEX = STAGE_CONFIG.reduce((m, s, i) => { m[s.type] = i; return m; }, {});

/**
 * Pure function: nudge the deterministically-chosen stage using the learned
 * `responds_to_${tone}_reminder` business_memory signal that evaluationAgent.js
 * writes and (until now) nobody read.
 *
 * Inputs:
 *   - stage: the STAGE_CONFIG entry chosen by getStage(daysOverdue) — the existing,
 *     unmodified deterministic decision based on days overdue.
 *   - memory: a plain object such as { polite: {v:true}, firm: {v:false} } keyed by
 *     tone, built from the customer's business_memory rows for
 *     responds_to_polite_reminder / responds_to_firm_reminder. Missing/malformed/
 *     empty MUST be tolerated — pass {} or undefined for "no memory".
 *
 * Rule (simple, explainable, derived from what evaluationAgent.js's value actually
 * means — "this reminder tone got this invoice paid before"):
 *   - Only applies to the two reminder stages (SEND_POLITE_REMINDER / SEND_FIRM_REMINDER);
 *     ESCALATE_COLLECTION and FLAG_BAD_DEBT are left untouched (memory only exists for the
 *     two reminder tones, and escalation/bad-debt already represents "reminders didn't work").
 *   - If the customer is currently on SEND_POLITE_REMINDER but memory says polite has NOT
 *     worked for them before (v === false) and firm HAS worked (v === true) in the past,
 *     escalate one step early to SEND_FIRM_REMINDER — evidence-based skip of a tone that's
 *     already known to fail for this customer.
 *   - If the customer is currently on SEND_FIRM_REMINDER but memory says polite DID work for
 *     them before (v === true) and there's no evidence firm worked, de-escalate to
 *     SEND_POLITE_REMINDER — a customer who has previously responded to a polite tone doesn't
 *     need to be greeted with a firmer one just because this particular invoice crossed the
 *     8-day threshold.
 *   - Any other combination (no memory, both/neither recorded, malformed values) falls back
 *     to the stage the existing threshold logic already picked — never throws, never blocks.
 */
function applyMemoryTonePreference(stage, memory) {
  try {
    if (!stage || (stage.type !== 'SEND_POLITE_REMINDER' && stage.type !== 'SEND_FIRM_REMINDER')) {
      return stage;
    }
    const m = memory && typeof memory === 'object' ? memory : {};
    const politeWorked = m.polite && m.polite.v === true;
    const politeFailed = m.polite && m.polite.v === false;
    const firmWorked   = m.firm && m.firm.v === true;

    if (stage.type === 'SEND_POLITE_REMINDER' && politeFailed && firmWorked) {
      return STAGE_CONFIG[STAGE_INDEX.SEND_FIRM_REMINDER];
    }
    if (stage.type === 'SEND_FIRM_REMINDER' && politeWorked && !firmWorked) {
      return STAGE_CONFIG[STAGE_INDEX.SEND_POLITE_REMINDER];
    }
    return stage;
  } catch (_e) {
    // Never let a malformed memory value block the existing deterministic flow.
    return stage;
  }
}

/**
 * Build a { polite, firm } memory map for one customer from raw business_memory rows.
 * Tolerates missing/malformed memory_value shapes — returns {} rather than throwing.
 */
function buildToneMemory(rows) {
  const out = {};
  for (const r of (rows || [])) {
    try {
      if (r.memory_key === 'responds_to_polite_reminder') out.polite = r.memory_value;
      if (r.memory_key === 'responds_to_firm_reminder')    out.firm   = r.memory_value;
    } catch (_e) { /* skip malformed row */ }
  }
  return out;
}

// Phase 7: bounded, deterministic ordering nudge composing a THIRD signal family
// (credit risk + promise reliability) on top of the existing, unmodified
// days_overdue-based ordering. This never changes getStage()'s stage assignment,
// never changes buildMessage()'s tone logic (Phase 3A, untouched), and never
// reorders an invoice across a materially different aging magnitude — it only
// nudges rank a small, bounded amount, and that nudge is scaled down sharply
// once two invoices are far apart in days_overdue (see computeCollectionPriorityBoost
// callers in reorderByRiskAndReliability below for the exact banding mechanism).
//
// Reused threshold: HIGH_RISK_CREDIT_SCORE_THRESHOLD = 70, verbatim from
// creditRiskAgent.js::deriveTier() (Phase 5/6's own reuse convention).
const HIGH_RISK_CREDIT_SCORE_THRESHOLD = 70;
// Reused-style threshold: >=2 broken promises mirrors rules.service.js's own
// ruleBrokenPromiseEscalate gate (`brokenPromises >= 2`, Phase 1-era rule),
// i.e. this is not a newly-invented cutoff, it is the codebase's existing
// definition of "a serial promise-breaker" applied here for the first time
// to an ordering decision rather than an escalation gate.
const BROKEN_PROMISE_THRESHOLD = 2;
// Bounded nudge amounts (in "virtual days_overdue" units, since the primary
// sort key is days_overdue itself) — small enough that they can only ever
// re-order invoices that are already close in aging (see MAX_AGING_GAP_FOR_NUDGE
// below), never large enough to vault a barely-overdue invoice ahead of a
// severely overdue one.
const RISK_BOOST_DAYS            = 3; // credit_risk_score >= 70
const BROKEN_PROMISE_BOOST_DAYS  = 3; // broken_promise_count >= 2
const COMBINED_BONUS_DAYS        = 2; // both signals present together
// The nudge is only ever allowed to affect ordering between two invoices whose
// days_overdue differ by less than this many days — i.e. it acts strictly as a
// same-aging-neighborhood tie-breaker/minor reorder, never as a mechanism that
// can invert gross aging precedence (a 120-day-overdue invoice can never be
// pushed behind a 2-day-overdue one by this nudge, because the gap comparison
// below refuses to apply the boost across a gap this large).
const MAX_AGING_GAP_FOR_NUDGE = 10;

/**
 * Pure, deterministic function: compute a small bounded "priority boost" (in
 * virtual days_overdue units) from a customer's credit_risk_score and
 * broken_promise_count. Used only as a secondary/tie-breaking key layered on
 * top of the existing days_overdue-descending order — never a replacement for
 * it. Missing/null/malformed inputs always yield 0 (no boost, i.e. today's
 * pure days_overdue behavior for that item) and this function never throws.
 *
 * @param {number} daysOverdue - unused by the computation itself (the value is
 *   accepted for interface symmetry/explainability logging only); banding
 *   against daysOverdue is applied by the caller (reorderByRiskAndReliability),
 *   not here, so this function stays a pure function of risk/reliability alone.
 * @param {number|null|undefined} creditRiskScore
 * @param {number|null|undefined} brokenPromiseCount
 * @returns {number} boost in the range [0, RISK_BOOST_DAYS + BROKEN_PROMISE_BOOST_DAYS + COMBINED_BONUS_DAYS]
 */
function computeCollectionPriorityBoost(daysOverdue, creditRiskScore, brokenPromiseCount) {
  try {
    const score   = Number(creditRiskScore);
    const promises = Number(brokenPromiseCount);
    const isHighRisk       = Number.isFinite(score) && score >= HIGH_RISK_CREDIT_SCORE_THRESHOLD;
    const isSerialBreaker  = Number.isFinite(promises) && promises >= BROKEN_PROMISE_THRESHOLD;

    let boost = 0;
    if (isHighRisk)      boost += RISK_BOOST_DAYS;
    if (isSerialBreaker) boost += BROKEN_PROMISE_BOOST_DAYS;
    if (isHighRisk && isSerialBreaker) boost += COMBINED_BONUS_DAYS;
    return boost;
  } catch (_e) {
    return 0;
  }
}

/**
 * Reorder an array of { ...anything, days_overdue, _priorityBoost } items so that,
 * WITHIN a same-aging neighborhood (days_overdue gap < MAX_AGING_GAP_FOR_NUDGE),
 * a higher risk/reliability boost sorts earlier. Outside that neighborhood, the
 * comparator falls straight back to days_overdue descending — i.e. gross aging
 * precedence can never be inverted by this mechanism, only fine-tuned locally.
 *
 * This is a stable-ish comparator (Array.prototype.sort is stable in Node per
 * spec since V8 7.0 / Node 11+), so items with identical (days_overdue, boost)
 * retain their original relative order.
 */
function compareForCollectionPriority(a, b) {
  const gap = Math.abs((a.days_overdue || 0) - (b.days_overdue || 0));
  if (gap >= MAX_AGING_GAP_FOR_NUDGE) {
    // Far apart in aging: pure days_overdue descending, boost is irrelevant.
    return (b.days_overdue || 0) - (a.days_overdue || 0);
  }
  // Close in aging: let the boost break the neighborhood tie first, then fall
  // back to days_overdue descending for any remaining tie.
  const boostDiff = (b._priorityBoost || 0) - (a._priorityBoost || 0);
  if (boostDiff !== 0) return boostDiff;
  return (b.days_overdue || 0) - (a.days_overdue || 0);
}

function buildMessage(customerName, amount, daysOverdue, stage) {
  const first  = (customerName || 'ji').split(' ')[0];
  const amtStr = amount >= 100000
    ? `₹${(amount / 100000).toFixed(1)}L`
    : `₹${Math.round(amount).toLocaleString('en-IN')}`;

  if (stage.type === 'SEND_POLITE_REMINDER') {
    return `Namaste ${first} ji 🙏 Umeed hai sab theek hai. Bas ek chhoti si reminder — hamare ${amtStr} (${daysOverdue} din se pending) aapka wait kar rahe hain. Aaj payment ho sakti hai kya? UPI/NEFT dono chalega. Shukriya!`;
  }
  if (stage.type === 'SEND_FIRM_REMINDER') {
    return `${first} ji, ${amtStr} ${daysOverdue} din se overdue hai. Ye amount jaldi settle karna zaroori hai. Aaj hi payment bhej do ya call karein — 8448 0XX XXX. Aapki cooperation ki zaroorat hai.`;
  }
  if (stage.type === 'ESCALATE_COLLECTION') {
    return `${first} ji, ${amtStr} (${daysOverdue} din overdue) abhi tak settle nahi hua. Ye serious ho raha hai. Aaj hi contact karein warna aage ki proceedings shuru hongi. Immediate action required.`;
  }
  if (stage.type === 'ESCALATE_COLLECTION_CALL') {
    return `Internal: ${customerName} — ₹${amount} (${daysOverdue} din overdue), WhatsApp escalation already sent. Auto-call queued pending owner approval.`;
  }
  return `Internal: ${customerName} — ₹${amount} flagged as potential bad debt after ${daysOverdue} days. Review required.`;
}

/**
 * Run the Collections Agent for a user.
 * Scans overdue invoices and generates reminder ActionSpecs for unprompted customers.
 * @param {string} userId
 * @param {object} context - optional: { customerId, invoiceId } to scope to one customer
 * @returns {Array} ActionSpecs (not yet persisted)
 */
async function run(userId, context = {}) {
  try {
    const { validate: policyValidate } = require('../orchestrator/policyGuard.service');
    const { resolveCustomerId } = require('../orchestrator/scoring.service');

    let query = supabase
      .from('invoices')
      .select('id, customer_id, customer_name, customer_phone, invoice_amount, days_overdue, last_reminder_sent')
      .eq('user_id', userId)
      .eq('payment_status', 'Pending')
      .eq('dunning_paused', false) // NOTE(disputeAgent): disputed invoices are paused here and must be excluded from reminders
      .gt('days_overdue', 0)
      .order('days_overdue', { ascending: false })
      .limit(context.customerId ? 10 : 50);
    // last_reminder_sent doubles as a cross-system "contacted today" gate
    // shared with the legacy dunning_rules cron (see server.js's
    // runDunningCycle) -- whichever system contacts an invoice first today,
    // the other skips it below, so a customer never gets double-contacted.
    const todayStr = new Date().toISOString().split('T')[0];

    if (context.invoiceId) query = query.eq('id', context.invoiceId);

    const { data: invoices, error } = await query;
    if (error) throw error;
    if (!invoices?.length) return [];

    // Check which invoices already have a pending action to avoid duplication
    const { data: existingActions } = await supabase
      .from('ai_actions')
      .select('related_entity_id')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .in('action_type', ['SEND_POLITE_REMINDER', 'SEND_FIRM_REMINDER', 'ESCALATE_COLLECTION', 'ESCALATE_COLLECTION_CALL', 'FLAG_BAD_DEBT']);
    const alreadyQueued = new Set((existingActions || []).map(a => a.related_entity_id));

    // Bulk-fetch reminder-tone memory for every customer_id in scope (tenant-scoped,
    // one query instead of N) — this is the Learning-loop read: evaluationAgent.js
    // already writes responds_to_polite_reminder / responds_to_firm_reminder to
    // business_memory when a reminder works; nothing consulted it until now.
    const customerIds = [...new Set((invoices || []).map(i => i.customer_id).filter(Boolean))];
    let memoryByCustomer = {};
    if (customerIds.length) {
      const { data: memRows } = await supabase
        .from('business_memory')
        .select('entity_id, memory_key, memory_value')
        .eq('user_id', userId)
        .eq('entity_type', 'customer')
        .in('entity_id', customerIds)
        .in('memory_key', ['responds_to_polite_reminder', 'responds_to_firm_reminder']);

      memoryByCustomer = (memRows || []).reduce((acc, r) => {
        (acc[r.entity_id] = acc[r.entity_id] || []).push(r);
        return acc;
      }, {});
    }

    // Phase 7: bulk-fetch customer_scores for every customer_id in scope (tenant-
    // scoped, one query instead of N — mirrors the exact bulk-fetch pattern used
    // above for business_memory). Consumed only to compute a small, bounded
    // reordering nudge (computeCollectionPriorityBoost/compareForCollectionPriority);
    // it never changes getStage()'s stage assignment or buildMessage()'s tone.
    // Missing table/row/columns degrade to boost 0 for that customer (pure
    // days_overdue order, unchanged from pre-Phase-7 behavior) — never throws.
    let riskByCustomer = {};
    if (customerIds.length) {
      try {
        const { data: scoreRows } = await supabase
          .from('customer_scores')
          .select('customer_id, credit_risk_score, broken_promise_count')
          .eq('user_id', userId)
          .in('customer_id', customerIds);

        riskByCustomer = (scoreRows || []).reduce((acc, r) => {
          acc[r.customer_id] = r;
          return acc;
        }, {});
      } catch (scoreErr) {
        safeLog('warn', '[CollectionsAgent] customer_scores lookup failed, falling back to days_overdue-only order', { error: scoreErr.message, userId });
        riskByCustomer = {};
      }
    }

    // Attach a bounded priority boost to each invoice (0 when no customer_id,
    // no customer_scores row, or malformed score fields) and reorder within
    // same-aging neighborhoods only — see compareForCollectionPriority.
    const invoicesWithBoost = (invoices || []).map(inv => {
      const scoreRow = inv.customer_id ? riskByCustomer[inv.customer_id] : null;
      const boost = scoreRow
        ? computeCollectionPriorityBoost(inv.days_overdue, scoreRow.credit_risk_score, scoreRow.broken_promise_count)
        : 0;
      return { ...inv, _priorityBoost: boost, _creditRiskScore: scoreRow?.credit_risk_score ?? null, _brokenPromiseCount: scoreRow?.broken_promise_count ?? null };
    });
    invoicesWithBoost.sort(compareForCollectionPriority);
    if (invoicesWithBoost.some(inv => inv._priorityBoost > 0)) {
      safeLog('info', '[CollectionsAgent] Phase 7 risk/reliability reorder applied', {
        userId,
        boosted: invoicesWithBoost.filter(inv => inv._priorityBoost > 0).map(inv => ({
          invoiceId: inv.id, daysOverdue: inv.days_overdue, boost: inv._priorityBoost,
          creditRiskScore: inv._creditRiskScore, brokenPromiseCount: inv._brokenPromiseCount,
        })),
      });
    }

    // Escalation cap: which customers already got a NEW escalation-tier
    // action (firm reminder or above) in the last rolling 24h?
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentEscalations } = await supabase
      .from('ai_actions')
      .select('customer_id')
      .eq('user_id', userId)
      .in('action_type', ESCALATION_TYPES)
      .gte('created_at', since24h)
      .not('customer_id', 'is', null);
    const escalatedRecently = new Set((recentEscalations || []).map(a => a.customer_id));

    const specs = [];

    for (const inv of invoicesWithBoost) {
      if (alreadyQueued.has(inv.id)) continue;

      if (inv.last_reminder_sent && String(inv.last_reminder_sent).split('T')[0] === todayStr) {
        safeLog('info', '[CollectionsAgent] Skipping — already contacted today (cross-system gate)', { userId, invoiceId: inv.id });
        continue;
      }

      // Resolve customer_id so we can check the per-customer pause + cap.
      // Best-effort: if resolution fails (no matching customers row), the
      // pause/cap simply can't apply to this invoice — same as before this
      // change, not a regression.
      let customerId = null;
      try { customerId = await resolveCustomerId(userId, inv.customer_name, inv.customer_phone); } catch { /* ignore */ }

      if (customerId) {
        // customerId already came from a user-scoped lookup, but the tenant
        // filter is repeated here deliberately: the service_role key bypasses
        // RLS, so an application-level user_id filter is the only thing that
        // keeps one business's rows out of another's agent run.
        const { data: customer } = await supabase.from('customers').select('escalation_paused').eq('id', customerId).eq('user_id', userId).maybeSingle();
        if (customer?.escalation_paused) {
          safeLog('info', '[CollectionsAgent] Skipping — escalation paused for customer', { userId, customerId, invoiceId: inv.id });
          continue;
        }
      }

      const baseStage = getStage(inv.days_overdue);
      const toneMemory = inv.customer_id ? buildToneMemory(memoryByCustomer[inv.customer_id]) : {};
      const stage = applyMemoryTonePreference(baseStage, toneMemory);
      // Escalation cap checked against the FINAL (memory-adjusted) stage —
      // that is the action_type this run would actually create, and
      // ESCALATION_TYPES/escalatedRecently are keyed on action_type.
      const isEscalationTier = ESCALATION_TYPES.includes(stage.type);

      if (isEscalationTier && customerId && escalatedRecently.has(customerId)) {
        safeLog('info', '[CollectionsAgent] Escalation cap hit — skipping for 24h', { userId, customerId, invoiceId: inv.id });
        continue;
      }

      const message = buildMessage(inv.customer_name, inv.invoice_amount, inv.days_overdue, stage);

      const spec = {
        action_type:          stage.type,
        title:                `${stage.type === 'FLAG_BAD_DEBT' ? '⚠️ Bad Debt Risk' : stage.type === 'ESCALATE_COLLECTION_CALL' ? '📞 Auto-call ready' : stage.type === 'ESCALATE_COLLECTION' ? '🚨 Escalate'  : '📩 Reminder'}: ${inv.customer_name}`,
        description:          `₹${Math.round(inv.invoice_amount).toLocaleString('en-IN')} — ${inv.days_overdue} days overdue`,
        priority:             stage.priority,
        risk_level:           stage.riskLevel,
        recommended_message:  stage.type !== 'FLAG_BAD_DEBT' ? message : null,
        related_entity_type:  'invoice',
        related_entity_id:    inv.id,
        customer_id:          customerId || null,
        suggested_by:         'system',
        requires_approval:    stage.riskLevel === 'high' || stage.type === 'ESCALATE_COLLECTION_CALL',
        _customer_phone:      inv.customer_phone, // for policy guard context
        _customer_name:       inv.customer_name,
      };

      // Policy guard
      const guard = await policyValidate(spec, userId);
      if (guard.status === 'system_blocked') {
        safeLog('info', '[CollectionsAgent] Action blocked by policy', { reason: guard.block_reason, invoice: inv.id });
        continue;
      }

      // Mark this customer as "escalated recently" for the rest of this run
      // too, so a customer with 3 overdue invoices doesn't get 3 escalation
      // actions in the same pass.
      if (isEscalationTier && customerId) escalatedRecently.add(customerId);

      specs.push(spec);
    }

    safeLog('info', '[CollectionsAgent] Run complete', { userId, generated: specs.length });
    return specs;
  } catch (err) {
    safeLog('error', '[CollectionsAgent] run failed', { error: err.message, userId });
    return [];
  }
}

module.exports = {
  run,
  getStage,
  applyMemoryTonePreference,
  buildToneMemory,
  STAGE_CONFIG,
  computeCollectionPriorityBoost,
  compareForCollectionPriority,
  HIGH_RISK_CREDIT_SCORE_THRESHOLD,
  BROKEN_PROMISE_THRESHOLD,
  RISK_BOOST_DAYS,
  BROKEN_PROMISE_BOOST_DAYS,
  COMBINED_BONUS_DAYS,
  MAX_AGING_GAP_FOR_NUDGE,
};
