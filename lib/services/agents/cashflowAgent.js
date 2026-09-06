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
// Phase 6: cross-domain materiality gate for the at-risk-inflow signal.
// Reuses the exact 20% cutoff cashflowAgent.js's own gap-alert gate already
// uses (gapPct >= 20) — the smallest justified analog, per the plan's own
// stated judgment call, rather than inventing a new threshold.
const AT_RISK_INFLOW_MATERIALITY_PCT = 20;

// Phase 6: pure, deterministic materiality classifier — no DB, no side
// effects. Returns { atRiskPct, isMaterial }. `atRiskInflowAmount` <= 0 or
// `expectedInflow` <= 0 always yields not-material (never divides by zero,
// never material on an empty/negative base).
function isAtRiskInflowMaterial(atRiskInflowAmount, expectedInflow) {
  const amount = Number(atRiskInflowAmount) || 0;
  const total  = Number(expectedInflow) || 0;
  if (amount <= 0 || total <= 0) return { atRiskPct: 0, isMaterial: false };
  const atRiskPct = (amount / total) * 100;
  return { atRiskPct, isMaterial: atRiskPct >= AT_RISK_INFLOW_MATERIALITY_PCT };
}

async function run(userId, context = {}) {
  try {
    const { getWeekForecast, getAtRiskExpectedInflow, getCashflowAlertOutcomeMemory, wasLastCashflowAlertIneffective } = require('../orchestrator/cashflow.service');
    const { upgradePriority, upgradeRiskLevel, downgradePriority, downgradeRiskLevel } = require('./creditRiskAgent');

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
        let priority   = gapPct >= 50 ? 'urgent' : 'high';
        let riskLevel  = gapPct >= 50 ? 'high' : 'medium';
        let description = `Expected inflow ${fmtINR(expected_inflow)} vs outflow ${fmtINR(expected_outflow)} in next 7 days. Gap: ${Math.round(gapPct)}%.`;

        // Phase 6: cross-domain signal — never independently creates or
        // suppresses this alert (it only runs once the pre-existing
        // gap > 0 && gapPct >= 20 condition already holds, above), and
        // never downgrades. Any failure here degrades to the unmodified
        // pre-Phase-6 behavior (getAtRiskExpectedInflow never throws).
        let atRiskInflowAmount = 0;
        try {
          const atRisk = await getAtRiskExpectedInflow(userId);
          atRiskInflowAmount = atRisk.atRiskInflowAmount || 0;
        } catch (crossDomainErr) {
          safeLog('warn', '[CashflowAgent] at-risk-inflow lookup failed — proceeding without cross-domain upgrade', { error: crossDomainErr.message, userId });
          atRiskInflowAmount = 0;
        }

        const { atRiskPct, isMaterial } = isAtRiskInflowMaterial(atRiskInflowAmount, expected_inflow);

        if (isMaterial) {
          priority  = upgradePriority(priority);
          riskLevel = upgradeRiskLevel(riskLevel);
          description += ` Cash pressure is elevated because ${fmtINR(atRiskInflowAmount)} (${Math.round(atRiskPct)}%) of expected inflows are associated with customers carrying high credit risk.`;
        }

        // Learning-loop read: bulk/O(1) tenant-level lookup (there is only ever
        // one cashflow_alert_outcome row per tenant, see cashflow.service.js) —
        // if the tenant's last CASHFLOW_GAP_ALERT was recorded as ineffective,
        // demote priority/risk_level one notch and annotate. The alert is still
        // created and still goes through policyGuard exactly as before; memory
        // only adjusts prioritization, never suppresses. Never throws — any
        // lookup failure degrades to today's unmodified behavior.
        let previouslyIneffective = false;
        try {
          const outcomeMemory = await getCashflowAlertOutcomeMemory(userId);
          previouslyIneffective = wasLastCashflowAlertIneffective(outcomeMemory);
        } catch (memErr) {
          safeLog('warn', '[CashflowAgent] cashflow_alert_outcome lookup failed — proceeding without demotion', { error: memErr.message, userId });
          previouslyIneffective = false;
        }

        if (previouslyIneffective) {
          priority  = downgradePriority(priority);
          riskLevel = downgradeRiskLevel(riskLevel);
          description += ' (Previous CASHFLOW_GAP_ALERT for this business was ineffective — demoted.)';
        }

        specs.push({
          action_type:   'CASHFLOW_GAP_ALERT',
          title:         `Cash gap this week: ${fmtINR(gap)} shortfall`,
          description,
          priority,
          risk_level:    riskLevel,
          suggested_by:  'cashflow_agent',
          requires_approval: false,
          previously_ineffective: previouslyIneffective,
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

module.exports = { run, isAtRiskInflowMaterial, AT_RISK_INFLOW_MATERIALITY_PCT };
