// FILE: lib/services/orchestrator/scoring.service.js
// Deterministic customer scoring — V1.
// No black-box AI. Every score comes with score_reason_json so the owner can understand why.
// Triggered after: payment received, promise broken/kept, new overdue invoice.
const { supabase } = require('../../config/supabaseClient');
const { safeLog } = require('../../observability/logger');
const { isEnabled } = require('../../featureFlags');

// Recalculate and upsert customer_scores for a given customer UUID.
// customerId must be a valid uuid from the customers table.
async function recalculate(userId, customerId) {
  if (!isEnabled('customer_scoring')) return null;
  if (!userId || !customerId) return null;

  try {
    // 1. Get customer name for invoice lookup (invoices still keyed by name string)
    const { data: customer } = await supabase
      .from('customers')
      .select('name')
      .eq('id', customerId)
      .eq('user_id', userId)
      .maybeSingle();

    if (!customer) {
      safeLog('warn', '[ScoringService] Customer not found', { customerId, userId });
      return null;
    }

    // 2. Fetch invoices, promises, and call logs in parallel
    const [invoicesRes, promisesRes, callLogsRes] = await Promise.all([
      supabase.from('invoices')
        .select('invoice_amount, days_overdue, payment_status, payment_amount')
        .eq('user_id', userId)
        .ilike('customer_name', customer.name),
      supabase.from('promises')
        .select('status, promised_amount')
        .eq('user_id', userId)
        .eq('customer_id', customerId),
      supabase.from('call_logs')
        .select('did_pick_up')
        .eq('user_id', userId)
        .ilike('customer_name', customer.name),
    ]);

    const invoices  = invoicesRes.data  || [];
    const promises  = promisesRes.data  || [];
    const callLogs  = callLogsRes.data  || [];

    // 3. Compute inputs
    const overdueInvoices = invoices.filter(i => i.payment_status === 'Pending' && (i.days_overdue || 0) > 0);
    const totalOverdue    = overdueInvoices.reduce((s, i) => s + parseFloat(i.invoice_amount || 0), 0);
    const maxDelay        = overdueInvoices.reduce((m, i) => Math.max(m, i.days_overdue || 0), 0);
    const avgDelay        = overdueInvoices.length
      ? overdueInvoices.reduce((s, i) => s + (i.days_overdue || 0), 0) / overdueInvoices.length
      : 0;

    const brokenPromises     = promises.filter(p => p.status === 'broken').length;
    const keptPromises       = promises.filter(p => p.status === 'kept').length;
    const totalPromises      = promises.length;
    const promiseReliability = totalPromises > 0
      ? Math.round(((totalPromises - brokenPromises) / totalPromises) * 100)
      : 100;

    const callsTotal  = callLogs.length;
    const callsPicked = callLogs.filter(c => c.did_pick_up).length;
    const responseScore = callsTotal > 0
      ? Math.round((callsPicked / callsTotal) * 100)
      : 50; // neutral when no data

    // 4. Composite credit risk score (0–100, higher = riskier)
    // Weights: overdue amount 40%, max delay 20%, broken promises 20%, non-response 20%
    let score = 0;
    score += Math.min(40, (totalOverdue / 10000) * 5);   // every ₹10k adds 5pts, capped at 40
    score += Math.min(20, maxDelay * 1.0);               // every day adds 1pt, capped at 20
    score += Math.min(20, brokenPromises * 7);           // every broken promise adds 7pts, capped at 20
    score += Math.max(0, 20 - responseScore * 0.2);      // low response rate adds up to 20pts

    const creditRiskScore       = Math.min(100, Math.round(score));
    const collectionPriority    = creditRiskScore; // V1: same; V2 will weight customer value

    // 5. Build human-readable reason
    const reasons = [];
    if (totalOverdue > 0) reasons.push(`₹${Math.round(totalOverdue).toLocaleString('en-IN')} overdue`);
    if (maxDelay > 0)     reasons.push(`up to ${maxDelay} days late`);
    if (brokenPromises > 0) reasons.push(`${brokenPromises} broken promise${brokenPromises > 1 ? 's' : ''}`);
    if (responseScore < 40) reasons.push('low call pickup rate');

    const scoreReason = reasons.length
      ? `Scored ${creditRiskScore}/100: ${reasons.join(', ')}.`
      : `Scored ${creditRiskScore}/100: no overdue amounts.`;

    // 6. Upsert customer_scores
    const payload = {
      user_id:                    userId,
      customer_id:                customerId,
      average_delay_days:         Math.round(avgDelay * 10) / 10,
      max_delay_days:             maxDelay,
      overdue_frequency:          overdueInvoices.length,
      promise_reliability_score:  promiseReliability,
      broken_promise_count:       brokenPromises,
      response_time_score:        responseScore,
      credit_risk_score:          creditRiskScore,
      collection_priority_score:  collectionPriority,
      score_reason_json: {
        scoreReason,
        reasons,
        inputs: { totalOverdue, maxDelay, avgDelay, brokenPromises, keptPromises, totalPromises, callsPicked, callsTotal },
      },
      last_calculated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from('customer_scores')
      .upsert([payload], { onConflict: 'user_id,customer_id' });

    if (error) {
      safeLog('warn', '[ScoringService] Upsert failed', { error: error.message, customerId, userId });
      return null;
    }

    return payload;
  } catch (err) {
    safeLog('error', '[ScoringService] Unexpected error', { error: err.message, customerId, userId });
    return null;
  }
}

// Resolve a customer UUID from a name+phone string (used by event handlers that only have names).
// Returns null if not found — callers must handle.
async function resolveCustomerId(userId, customerName, customerPhone = null) {
  if (!userId || !customerName) return null;
  let q = supabase.from('customers').select('id').eq('user_id', userId).ilike('name', customerName.trim());
  if (customerPhone) q = q.eq('phone', customerPhone);
  const { data } = await q.limit(1).maybeSingle();
  return data?.id || null;
}

module.exports = { recalculate, resolveCustomerId };
