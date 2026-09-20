// FILE: lib/services/agents/payablesAgent.js
// Payables Agent — recommends which suppliers to pay first when cash is tight.
//
// SAFETY: this agent NEVER executes a payment. It never updates purchases.status,
// purchases.paid_amount, or any bank/payment API. It only reads `purchases` and
// the existing cashflow forecast, and writes a single advisory ai_actions row
// with a ranked recommendation. Actually paying a supplier remains a manual
// action the owner takes elsewhere in the product. This mirrors the "PA001:
// proposed_action.type == 'execute_payment' -> deny" policy rule documented in
// the (unmerged) Atlas Agent Mesh 216 Phase 1 registry for this agent.
//
// Distinct from cashflowAgent.js's per-invoice SUPPLIER_PAYMENT_OVERDUE alerts:
// this agent produces one consolidated, cash-aware priority order instead of
// per-supplier nagging, so the two don't duplicate each other.
//
// "Closing the loop" (Cortex X, agent auto-execute pass), user-approved
// middle tier ONLY: when FEATURE_AGENT_AUTOEXECUTE_ENABLED is on, this agent
// additionally "prepares" a payment (PAYABLES_PAYMENT_READY) for each of the
// top few ranked suppliers, so the owner can one-tap approve a specific
// payment instead of acting on the consolidated plan by hand. This is
// PREPARATION ONLY, gated by policyGuard.ALWAYS_REQUIRES_APPROVAL and, even
// after the owner taps approve, server.js's executePayablesPayment() still
// does not move money -- there is no payout gateway or supplier bank/UPI
// destination configured anywhere in this codebase, so approval marks the
// action approved and tells the owner to finish paying manually. This is a
// hard line per explicit instruction, not just a default: real money
// movement always requires a human tap, at any amount, with no
// fully-autonomous auto-pay path of any kind.
const { supabase } = require('../../config/supabaseClient');
const { safeLog }  = require('../../observability/logger');

function fmtINR(n) {
  return n >= 100000
    ? `₹${(n / 100000).toFixed(1)}L`
    : `₹${Math.round(n).toLocaleString('en-IN')}`;
}

/**
 * Run the Payables Agent.
 * @param {string} userId
 * @returns {Array} ActionSpecs (0 or 1 element — a consolidated priority plan)
 */
async function run(userId, context = {}) {
  try {
    const { isEnabled } = require('../../featureFlags');

    // Dedupe — one open priority plan at a time is enough; a fresh one replaces
    // the need for a stale one once the owner clears it.
    const { data: existing } = await supabase
      .from('ai_actions')
      .select('id')
      .eq('user_id', userId)
      .eq('action_type', 'PAYABLES_PRIORITY_PLAN')
      .eq('status', 'pending')
      .maybeSingle();

    // Separately track which purchases already have a pending
    // PAYABLES_PAYMENT_READY so re-runs don't prepare duplicate payments.
    const { data: existingPrepared } = await supabase
      .from('ai_actions')
      .select('related_entity_id')
      .eq('user_id', userId)
      .eq('action_type', 'PAYABLES_PAYMENT_READY')
      .eq('status', 'pending');
    const alreadyPrepared = new Set((existingPrepared || []).map(a => String(a.related_entity_id)));

    if (existing) return [];

    // Read-only: all unpaid/partially-paid purchases. Note the real column is
    // `amount`, not `total_amount` (a mismatch exists elsewhere in this repo's
    // cashflowAgent.js that silently no-ops its payables query — this agent
    // uses the correct column name).
    const { data: purchases, error } = await supabase
      .from('purchases')
      .select('id, supplier_name, amount, paid_amount, due_date, status')
      .eq('user_id', userId)
      .neq('status', 'paid');
    if (error) throw error;
    if (!purchases?.length) return [];

    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const in7Days = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const outstanding = purchases
      .map(p => ({
        id:            p.id,
        supplierName:  p.supplier_name,
        dueDate:       p.due_date,
        unpaid:        Math.max(0, Number(p.amount || 0) - Number(p.paid_amount || 0)),
        overdue:       p.due_date ? p.due_date < todayStr : false,
        dueSoon:       p.due_date ? (p.due_date >= todayStr && p.due_date <= in7Days) : false,
      }))
      .filter(p => p.unpaid > 0);
    if (!outstanding.length) return [];

    // Available cash proxy: expected inflow over the next 7 days, reusing the
    // same forecast the cashflow agent already relies on. Not a real bank
    // balance lookup — no agent in this codebase has one today.
    const { getWeekForecast } = require('../orchestrator/cashflow.service');
    const { expected_inflow } = await getWeekForecast(userId);

    // Priority: overdue first (most overdue amount first), then due-soon by
    // due date ascending, then everything else by due date ascending.
    const ranked = outstanding
      .filter(p => p.overdue || p.dueSoon)
      .sort((a, b) => {
        if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
        return (a.dueDate || '9999-99-99').localeCompare(b.dueDate || '9999-99-99');
      });

    if (!ranked.length) return [];

    const dueSoonTotal = ranked.reduce((s, p) => s + p.unpaid, 0);
    const overdueCount = ranked.filter(p => p.overdue).length;
    const cashConstrained = dueSoonTotal > expected_inflow;

    const top5 = ranked.slice(0, 5);
    const listStr = top5
      .map((p, i) => `${i + 1}. ${p.supplierName} — ${fmtINR(p.unpaid)}${p.overdue ? ' (overdue)' : ` (due ${p.dueDate})`}`)
      .join(' · ');

    const priority = cashConstrained && overdueCount > 0
      ? 'urgent'
      : (overdueCount > 0 ? 'high' : 'medium');

    const specs = [{
      action_type:         'PAYABLES_PRIORITY_PLAN',
      title:               cashConstrained
        ? `Cash tight — ${ranked.length} supplier${ranked.length > 1 ? 's' : ''} competing for ${fmtINR(dueSoonTotal)}`
        : `Supplier payment priority — ${ranked.length} due soon`,
      description:         `Recommended pay order (advisory only, no payment sent): ${listStr}. Expected inflow next 7d: ${fmtINR(expected_inflow)}.`,
      priority,
      risk_level:          'high',
      suggested_by:        'system',
      requires_approval:   true, // this agent never pays anything — any follow-through is a manual owner action
      reason_json: {
        rule:            'payables_priority_plan',
        expected_inflow,
        due_soon_total:  dueSoonTotal,
        cash_constrained: cashConstrained,
        ranked_purchase_ids: ranked.map(p => p.id),
      },
    }];

    // Prepare (never execute) a one-tap-approvable payment for the top 3
    // ranked suppliers, capped to avoid flooding the owner with WhatsApp
    // approval links every single day.
    if (isEnabled('agent_autoexecute_enabled')) {
      for (const p of top5.slice(0, 3)) {
        if (alreadyPrepared.has(String(p.id))) continue;
        specs.push({
          action_type:         'PAYABLES_PAYMENT_READY',
          title:               `Pay ${p.supplierName} — ${fmtINR(p.unpaid)}`,
          description:         `${p.overdue ? 'Overdue' : `Due ${p.dueDate}`}. Tap to approve — this only prepares the payment, it is never sent automatically.`,
          priority:            p.overdue ? 'urgent' : 'high',
          risk_level:          'high',
          related_entity_type: 'purchase',
          related_entity_id:   p.id,
          suggested_by:        'system',
          requires_approval:   true, // also enforced by policyGuard.ALWAYS_REQUIRES_APPROVAL — never bypassed regardless of amount
          reason_json: {
            rule:          'payables_payment_ready',
            purchase_id:   p.id,
            supplier_name: p.supplierName,
            amount:        p.unpaid,
          },
        });
      }
    }

    return specs;
  } catch (err) {
    safeLog('error', '[PayablesAgent] run failed', { error: err.message, userId });
    return [];
  }
}

module.exports = { run };
