// FILE: lib/services/agents/cashflowAgent.js
// Cashflow Gap Agent — detects when expected outflows exceed inflows in the next 7 days.
// Creates urgent ai_actions when the gap exceeds 20% of inflow.
// Also surfaces overdue payables (supplier payments past due).
const { supabase } = require('../../config/supabaseClient');
const { safeLog }  = require('../../observability/logger');

function fmtINR(n) {
  return n >= 100000
    ? `₹${(n / 100000).toFixed(1)}L`
    : `₹${Math.round(n).toLocaleString('en-IN')}`;
}

/**
 * Run the Cashflow Agent.
 * @param {string} userId
 * @returns {Array} ActionSpecs
 */
async function run(userId, context = {}) {
  try {
    const { getWeekForecast } = require('../orchestrator/cashflow.service');

    const { expected_inflow, expected_outflow } = await getWeekForecast(userId);

    const specs = [];

    // ── Gap detection ──────────────────────────────────────────────────────
    const gap = expected_outflow - expected_inflow;
    const gapPct = expected_inflow > 0
      ? (gap / expected_inflow) * 100
      : (expected_outflow > 0 ? 100 : 0);

    if (gap > 0 && gapPct >= 20) {
      // Check no duplicate pending action
      const { data: existing } = await supabase
        .from('ai_actions')
        .select('id')
        .eq('user_id', userId)
        .eq('action_type', 'CASHFLOW_GAP_ALERT')
        .eq('status', 'pending')
        .maybeSingle();

      if (!existing) {
        specs.push({
          action_type:   'CASHFLOW_GAP_ALERT',
          title:         `Cash gap this week: ${fmtINR(gap)} shortfall`,
          description:   `Expected inflow ${fmtINR(expected_inflow)} vs outflow ${fmtINR(expected_outflow)} in next 7 days. Gap: ${Math.round(gapPct)}%.`,
          priority:      gapPct >= 50 ? 'urgent' : 'high',
          risk_level:    gapPct >= 50 ? 'high' : 'medium',
          suggested_by:  'cashflow_agent',
          requires_approval: false,
        });
      }
    }

    // ── Overdue payables (purchases past due_date) ─────────────────────────
    const today = new Date().toISOString().split('T')[0];
    const { data: overduePayables } = await supabase
      .from('purchases')
      .select('id, supplier_name, total_amount, paid_amount, due_date')
      .eq('user_id', userId)
      .neq('status', 'paid')
      .lt('due_date', today)
      .order('due_date', { ascending: true })
      .limit(5);

    for (const p of (overduePayables || [])) {
      const unpaid = Number(p.total_amount || 0) - Number(p.paid_amount || 0);
      if (unpaid <= 0) continue;

      const { data: existingPayable } = await supabase
        .from('ai_actions')
        .select('id')
        .eq('user_id', userId)
        .eq('action_type', 'SUPPLIER_PAYMENT_OVERDUE')
        .eq('related_entity_id', p.id)
        .eq('status', 'pending')
        .maybeSingle();

      if (!existingPayable) {
        const daysLate = Math.floor((Date.now() - new Date(p.due_date).getTime()) / 86400000);
        specs.push({
          action_type:         'SUPPLIER_PAYMENT_OVERDUE',
          title:               `Pay ${p.supplier_name} — ${daysLate}d overdue`,
          description:         `${fmtINR(unpaid)} due to ${p.supplier_name} was due on ${p.due_date}.`,
          priority:            daysLate > 14 ? 'urgent' : 'high',
          risk_level:          'medium',
          related_entity_type: 'purchase',
          related_entity_id:   p.id,
          suggested_by:        'cashflow_agent',
          requires_approval:   false,
        });
      }
    }

    safeLog('info', '[CashflowAgent] Run complete', { userId, specs: specs.length, gap, gapPct: Math.round(gapPct) });
    return specs;
  } catch (err) {
    safeLog('error', '[CashflowAgent] run failed', { error: err.message, userId });
    return [];
  }
}

module.exports = { run };
