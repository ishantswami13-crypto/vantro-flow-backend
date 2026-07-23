// FILE: lib/services/agents/promiseTrackerAgent.js
// Promise Tracker Agent — surfaces customers who promised to pay but haven't,
// and escalates repeat offenders. Read-mostly: never flips a promise's status
// itself (that remains the job of the dedicated PromiseCron in server.js which
// runs the authoritative active->broken transition). This agent only reads
// `promises` + `customers` and writes deduped ai_actions summarizing the signal
// for the owner — matching the pattern of the other agents in this folder.
//
// Planned per docs/agent-mesh/ (Atlas Agent Mesh 216, Phase 1 registry,
// never merged to main): "Track customer payment promises and detect broken
// commitments." Policy intent carried over: a customer whose broken promise
// has gone unresolved for 30+ days is flagged for owner review (PT002).
const { supabase } = require('../../config/supabaseClient');
const { safeLog }  = require('../../observability/logger');

function fmtINR(n) {
  return n >= 100000
    ? `₹${(n / 100000).toFixed(1)}L`
    : `₹${Math.round(n).toLocaleString('en-IN')}`;
}

function daysBetween(a, b) {
  return Math.floor((a.getTime() - b.getTime()) / 86400000);
}

/**
 * Run the Promise Tracker Agent.
 * @param {string} userId
 * @returns {Array} ActionSpecs
 */
async function run(userId, context = {}) {
  try {
    const now = new Date();
    const specs = [];

    // Existing pending actions from this agent, to avoid duplicate alerts per customer.
    const { data: existingActions } = await supabase
      .from('ai_actions')
      .select('related_entity_id')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .in('action_type', ['PROMISE_BROKEN_ALERT', 'PROMISE_AT_RISK']);
    const alreadyQueued = new Set((existingActions || []).map(a => a.related_entity_id));

    // ── 1. Broken promises — group by customer ─────────────────────────────
    const { data: broken, error: brokenErr } = await supabase
      .from('promises')
      .select('id, customer_id, promised_amount, promised_date, resolved_at, customers(name)')
      .eq('user_id', userId)
      .eq('status', 'broken');
    if (brokenErr) throw brokenErr;

    const byCustomer = {};
    for (const p of (broken || [])) {
      if (!p.customer_id) continue;
      const resolvedAt = p.resolved_at ? new Date(p.resolved_at) : now;
      const daysBroken = Math.max(0, daysBetween(resolvedAt, new Date(p.promised_date)));
      if (!byCustomer[p.customer_id]) {
        byCustomer[p.customer_id] = {
          customerId:  p.customer_id,
          name:        p.customers?.name || 'Unknown customer',
          count:       0,
          totalAmount: 0,
          maxDaysBroken: 0,
        };
      }
      const c = byCustomer[p.customer_id];
      c.count += 1;
      c.totalAmount += parseFloat(p.promised_amount || 0);
      c.maxDaysBroken = Math.max(c.maxDaysBroken, daysBroken);
    }

    for (const c of Object.values(byCustomer)) {
      if (alreadyQueued.has(c.customerId)) continue;

      // PT002: a broken promise unresolved 30+ days, or 3+ broken promises, escalates.
      const escalate = c.maxDaysBroken > 30 || c.count >= 3;

      specs.push({
        action_type:          'PROMISE_BROKEN_ALERT',
        title:                `${c.name} — ${c.count} broken promise${c.count > 1 ? 's' : ''}`,
        description:          `${fmtINR(c.totalAmount)} across ${c.count} broken payment promise${c.count > 1 ? 's' : ''}. Longest unresolved: ${c.maxDaysBroken}d.`,
        priority:             escalate ? 'urgent' : (c.count > 1 ? 'high' : 'medium'),
        risk_level:           escalate ? 'high' : 'medium',
        related_entity_type:  'customer',
        related_entity_id:    c.customerId,
        customer_id:          c.customerId,
        suggested_by:         'system',
        requires_approval:    false,
      });
    }

    // ── 2. Active promises whose due date has passed (safety net) ──────────
    // The nightly PromiseCron (server.js) is the authoritative process that flips
    // these to 'broken'. This is a defensive read-only check in case that cron
    // hasn't run yet for today, so the owner isn't blind in the interim.
    const todayStr = now.toISOString().split('T')[0];
    const { data: atRisk, error: atRiskErr } = await supabase
      .from('promises')
      .select('id, customer_id, promised_amount, promised_date, customers(name)')
      .eq('user_id', userId)
      .eq('status', 'active')
      .lt('promised_date', todayStr);
    if (atRiskErr) throw atRiskErr;

    for (const p of (atRisk || [])) {
      if (!p.customer_id || alreadyQueued.has(p.customer_id) || byCustomer[p.customer_id]) continue;
      const daysOverdue = daysBetween(now, new Date(p.promised_date));
      specs.push({
        action_type:          'PROMISE_AT_RISK',
        title:                `Promise overdue: ${p.customers?.name || 'Unknown customer'}`,
        description:          `Promised ${fmtINR(p.promised_amount || 0)} by ${p.promised_date} — ${daysOverdue}d past due, not yet marked broken.`,
        priority:             daysOverdue > 7 ? 'high' : 'medium',
        risk_level:           'low',
        related_entity_type:  'customer',
        related_entity_id:    p.customer_id,
        customer_id:          p.customer_id,
        suggested_by:         'system',
        requires_approval:    false,
      });
    }

    safeLog('info', '[PromiseTrackerAgent] Run complete', { userId, generated: specs.length, brokenCustomers: Object.keys(byCustomer).length });
    return specs;
  } catch (err) {
    safeLog('error', '[PromiseTrackerAgent] run failed', { error: err.message, userId });
    return [];
  }
}

module.exports = { run };
