// FILE: lib/services/orchestrator/cashflow.service.js
// Creates and updates cashflow_events rows so the forecast page always reflects reality.
// Before Cortex: cash sales had no ledger entry; credit sales had no expected-inflow tracking.
// After Cortex: every sale, purchase, and payment creates the right cashflow_event.
// Never throws — cashflow failures are logged and swallowed.
const { supabase } = require('../../config/supabaseClient');
const { safeLog } = require('../../observability/logger');

function today() {
  return new Date().toISOString().split('T')[0];
}

// Called after a sale is created.
// Cash portion   → actual_inflow  (money already received)
// Credit portion → expected_inflow (money coming on due date)
async function createFromSale(userId, sale, totalAmount, paidAmount) {
  if (!userId || !sale?.id) return;
  const paid    = parseFloat(paidAmount  || 0);
  const total   = parseFloat(totalAmount || 0);
  const unpaid  = Math.max(0, total - paid);
  const saleDate = sale.sale_date || today();
  const dueDate  = sale.due_date  || saleDate;

  const rows = [];

  if (paid > 0) {
    rows.push({
      user_id:       userId,
      event_type:    'actual_inflow',
      source_type:   'sale',
      source_id:     sale.id,
      amount:        paid,
      expected_date: saleDate,
      actual_date:   saleDate,
      status:        'confirmed',
      notes:         `Cash received — ${sale.customer_name || 'sale'}`,
    });
  }

  if (unpaid > 0) {
    rows.push({
      user_id:       userId,
      event_type:    'expected_inflow',
      source_type:   'sale',
      source_id:     sale.id,
      amount:        unpaid,
      expected_date: dueDate,
      status:        'expected',
      notes:         `Receivable — ${sale.customer_name || 'sale'}`,
    });
  }

  if (!rows.length) return;

  try {
    const { error } = await supabase.from('cashflow_events').insert(rows);
    if (error) safeLog('warn', '[CashflowService] createFromSale failed', { error: error.message, saleId: sale.id });
  } catch (err) {
    safeLog('error', '[CashflowService] createFromSale unexpected error', { error: err.message });
  }
}

// Called after a purchase is created.
// Cash portion   → actual_outflow
// Credit portion → expected_outflow (payable due on due_date)
async function createFromPurchase(userId, purchase, totalAmount, paidAmount) {
  if (!userId || !purchase?.id) return;
  const paid         = parseFloat(paidAmount  || 0);
  const total        = parseFloat(totalAmount || 0);
  const unpaid       = Math.max(0, total - paid);
  const purchaseDate = purchase.purchase_date || today();
  const dueDate      = purchase.due_date      || purchaseDate;

  const rows = [];

  if (paid > 0) {
    rows.push({
      user_id:       userId,
      event_type:    'actual_outflow',
      source_type:   'purchase',
      source_id:     purchase.id,
      amount:        paid,
      expected_date: purchaseDate,
      actual_date:   purchaseDate,
      status:        'confirmed',
      notes:         `Cash paid — ${purchase.supplier_name || 'purchase'}`,
    });
  }

  if (unpaid > 0) {
    rows.push({
      user_id:       userId,
      event_type:    'expected_outflow',
      source_type:   'purchase',
      source_id:     purchase.id,
      amount:        unpaid,
      expected_date: dueDate,
      status:        'expected',
      notes:         `Payable — ${purchase.supplier_name || 'purchase'}`,
    });
  }

  if (!rows.length) return;

  try {
    const { error } = await supabase.from('cashflow_events').insert(rows);
    if (error) safeLog('warn', '[CashflowService] createFromPurchase failed', { error: error.message, purchaseId: purchase.id });
  } catch (err) {
    safeLog('error', '[CashflowService] createFromPurchase unexpected error', { error: err.message });
  }
}

// Called when a payment is received (mark-paid).
// Marks any pending expected_inflow for this invoice as confirmed.
// Also inserts a fresh actual_inflow so the forecast sees real money in.
async function confirmInflow(userId, invoiceId, amount, actualDate) {
  if (!userId || !invoiceId) return;
  const dateStr = actualDate || today();

  try {
    // 1. Mark existing expected_inflow as confirmed
    await supabase
      .from('cashflow_events')
      .update({ status: 'confirmed', actual_date: dateStr })
      .eq('user_id',    userId)
      .eq('source_id',  invoiceId)
      .eq('event_type', 'expected_inflow')
      .eq('status',     'expected');

    // 2. Insert actual_inflow (idempotent: check not already created for this invoice today)
    const { data: existing } = await supabase
      .from('cashflow_events')
      .select('id')
      .eq('user_id',    userId)
      .eq('source_id',  invoiceId)
      .eq('event_type', 'actual_inflow')
      .eq('actual_date', dateStr)
      .maybeSingle();

    if (!existing) {
      await supabase.from('cashflow_events').insert([{
        user_id:       userId,
        event_type:    'actual_inflow',
        source_type:   'invoice',
        source_id:     invoiceId,
        amount:        parseFloat(amount || 0),
        expected_date: dateStr,
        actual_date:   dateStr,
        status:        'confirmed',
        notes:         'Payment received',
      }]);
    }
  } catch (err) {
    safeLog('error', '[CashflowService] confirmInflow unexpected error', { error: err.message, invoiceId });
  }
}

// Read 7-day cashflow window for rules engine evaluation.
// Returns { expected_inflow, expected_outflow } for the next 7 days.
async function getWeekForecast(userId) {
  const from = today();
  const to   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const { data } = await supabase
    .from('cashflow_events')
    .select('event_type, amount')
    .eq('user_id', userId)
    .eq('status', 'expected')
    .gte('expected_date', from)
    .lte('expected_date', to);

  const rows = data || [];
  return {
    expected_inflow:  rows.filter(r => r.event_type === 'expected_inflow') .reduce((s, r) => s + parseFloat(r.amount || 0), 0),
    expected_outflow: rows.filter(r => r.event_type === 'expected_outflow').reduce((s, r) => s + parseFloat(r.amount || 0), 0),
  };
}

// ─── Phase 6: cross-domain cashflow-reliability signal ─────────────────────
// Cross-domain, additive, upgrade-only. See STARLANE_PHASE_6_PLAN.md and
// STARLANE_PHASE_6_IMPLEMENTATION.md for the full evidence trail. This does
// NOT change getWeekForecast()'s existing contract or any of its callers.
//
// Resolves the portion of the tenant's expected_inflow (same 7-day window
// getWeekForecast() already uses) that is linked to customers currently
// carrying a HIGH_RISK credit_risk_score (>=70 — the exact threshold
// creditRiskAgent.js::deriveTier() already uses, reused here unchanged, not
// reinvented). Never throws; any resolution failure degrades to "not
// at-risk" for that portion, matching this codebase's existing fail-open
// convention (see cashflowAgent.js, creditRiskAgent.js).
//
// Only `expected_inflow` rows with source_type === 'sale' can be resolved to
// a customer at all today (createFromSale() is the only writer of
// expected_inflow rows, always with source_type:'sale', source_id:sale.id —
// confirmed by direct re-read of createFromSale() above). Rows of any other
// source_type, rows with a NULL/unresolvable source_id, sales rows with no
// customer_id, or customers with no customer_scores row are all treated as
// NOT at-risk — excluded from the sum, never a thrown error.
const HIGH_RISK_CREDIT_SCORE_THRESHOLD = 70; // mirrors creditRiskAgent.js::deriveTier()

// Pure, deterministic, DB-free classification/aggregation step — extracted
// so the decision logic itself is unit-testable without a database.
// `inflowRows`: [{ source_id, source_type, amount }] — expected_inflow rows
//   already scoped to one tenant and the forecast window by the caller.
// `customerIdBySaleId`: Map<saleId, customerId> — already tenant-scoped.
// `scoreByCustomerId`: Map<customerId, numericCreditRiskScore> — already
//   tenant-scoped.
// Never throws: malformed/missing map entries are simply excluded from the
// at-risk sum (fallback = "not at-risk"), never blocking the total.
function computeAtRiskInflowAmount(inflowRows, customerIdBySaleId, scoreByCustomerId) {
  const rows = Array.isArray(inflowRows) ? inflowRows : [];
  let atRiskInflowAmount = 0;

  for (const row of rows) {
    if (!row || row.source_type !== 'sale' || !row.source_id) continue; // non-sale / no source_id — not at-risk
    const customerId = customerIdBySaleId instanceof Map ? customerIdBySaleId.get(row.source_id) : undefined;
    if (!customerId) continue; // unresolved sale, or sale.customer_id NULL — not at-risk
    const score = scoreByCustomerId instanceof Map ? scoreByCustomerId.get(customerId) : undefined;
    if (score === undefined || score === null || !Number.isFinite(Number(score))) continue; // no score row — not at-risk
    if (Number(score) >= HIGH_RISK_CREDIT_SCORE_THRESHOLD) {
      atRiskInflowAmount += parseFloat(row.amount || 0);
    }
  }

  return atRiskInflowAmount;
}

async function getAtRiskExpectedInflow(userId) {
  if (!userId) return { atRiskInflowAmount: 0, totalExpectedInflow: 0 };

  try {
    const from = today();
    const to   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const { data: rows } = await supabase
      .from('cashflow_events')
      .select('source_id, source_type, amount')
      .eq('user_id', userId)
      .eq('event_type', 'expected_inflow')
      .eq('status', 'expected')
      .gte('expected_date', from)
      .lte('expected_date', to);

    const inflowRows = rows || [];
    const totalExpectedInflow = inflowRows.reduce((s, r) => s + parseFloat(r.amount || 0), 0);

    // Only 'sale'-sourced rows with a source_id are resolvable to a customer.
    const saleRows = inflowRows.filter(r => r.source_type === 'sale' && r.source_id);
    if (!saleRows.length) return { atRiskInflowAmount: 0, totalExpectedInflow };

    const saleIds = [...new Set(saleRows.map(r => r.source_id))];

    // Batched resolution: sale -> customer_id (mirrors businessState.js's own
    // batch-join pattern, not N+1 per-row queries).
    const { data: sales } = await supabase
      .from('sales')
      .select('id, customer_id')
      .eq('user_id', userId)
      .in('id', saleIds);

    const customerIdBySaleId = new Map();
    (sales || []).forEach(s => { if (s.customer_id) customerIdBySaleId.set(s.id, s.customer_id); });

    const customerIds = [...new Set([...customerIdBySaleId.values()])];
    if (!customerIds.length) return { atRiskInflowAmount: 0, totalExpectedInflow };

    // Batched resolution: customer_id -> credit_risk_score.
    const { data: scores } = await supabase
      .from('customer_scores')
      .select('customer_id, credit_risk_score')
      .eq('user_id', userId)
      .in('customer_id', customerIds);

    const scoreByCustomerId = new Map((scores || []).map(s => [s.customer_id, parseFloat(s.credit_risk_score || 0)]));

    const atRiskInflowAmount = computeAtRiskInflowAmount(saleRows, customerIdBySaleId, scoreByCustomerId);

    return { atRiskInflowAmount, totalExpectedInflow };
  } catch (err) {
    // Fail-open: never let this cross-domain signal break the caller's
    // existing (unmodified) gap-alert behavior.
    safeLog('warn', '[CashflowService] getAtRiskExpectedInflow failed — treating as no at-risk inflow', { error: err.message, userId });
    return { atRiskInflowAmount: 0, totalExpectedInflow: 0 };
  }
}

// ─── Learning-loop read: cashflow_alert_outcome consultation ────────────────
// evaluationAgent.js writes a single tenant-level `cashflow_alert_outcome`
// business_memory row per tenant (entity_type:'global', entity_id: userId —
// a stable sentinel since Postgres never matches NULL in the upsert's unique
// index; see evaluationAgent.js's CASHFLOW_GAP_ALERT branch). Nothing read it
// back until now. This is a single-row lookup (there is only ever one such
// row per tenant because of the upsert), so it is already a bulk/O(1) fetch —
// never N+1 — and is exposed here so cashflowAgent.js (the actual
// CASHFLOW_GAP_ALERT creator) can consult it the same way it already consults
// getAtRiskExpectedInflow() above for the Phase 6 cross-domain signal.

/**
 * Fetch the tenant's last cashflow_alert_outcome memory row, if any.
 * Never throws — returns null on any failure or absence, which callers must
 * treat as "no prior outcome" (today's unmodified behavior).
 */
async function getCashflowAlertOutcomeMemory(userId) {
  if (!userId) return null;
  try {
    const { data } = await supabase
      .from('business_memory')
      .select('entity_id, memory_value')
      .eq('user_id', userId)
      .eq('entity_type', 'global')
      .eq('entity_id', userId)
      .eq('memory_key', 'cashflow_alert_outcome')
      .maybeSingle();
    return data || null;
  } catch (err) {
    safeLog('warn', '[CashflowService] getCashflowAlertOutcomeMemory failed — treating as no prior outcome', { error: err.message, userId });
    return null;
  }
}

/**
 * Pure function: was the tenant's last recorded CASHFLOW_GAP_ALERT outcome
 * ineffective? Only an explicit `v === false` counts; anything else
 * (missing row, malformed memory_value, v === true, v undefined) is treated
 * as "no evidence of ineffectiveness" and never throws.
 */
function wasLastCashflowAlertIneffective(memoryRow) {
  try {
    return !!(memoryRow && memoryRow.memory_value && memoryRow.memory_value.v === false);
  } catch (_e) {
    return false;
  }
}

module.exports = {
  createFromSale,
  createFromPurchase,
  confirmInflow,
  getWeekForecast,
  getAtRiskExpectedInflow,
  computeAtRiskInflowAmount,
  getCashflowAlertOutcomeMemory,
  wasLastCashflowAlertIneffective,
  HIGH_RISK_CREDIT_SCORE_THRESHOLD,
};
