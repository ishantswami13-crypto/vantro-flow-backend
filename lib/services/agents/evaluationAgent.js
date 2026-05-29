// FILE: lib/services/agents/evaluationAgent.js
// Evaluation Agent — 48h post-action check to determine if approved actions were effective.
// "Effective" = the underlying problem was resolved after the action was taken.
//
// Rules per action type:
//   SEND_POLITE_REMINDER / SEND_FIRM_REMINDER → effective if invoice paid within 7 days
//   ESCALATE_COLLECTION → effective if a new promise was created within 3 days
//   FLAG_BAD_DEBT → effective if invoice was eventually paid (no time limit, just check)
//   CASHFLOW_GAP_ALERT → effective if gap closed (expected_inflow > outflow) within 7 days
//   CREDIT_RISK_ALERT → effective if score dropped below HIGH_RISK threshold within 14 days
//   DAILY_OWNER_BRIEFING / LOW_STOCK_ALERT / DATA_QUALITY → always 'unknown' (can't auto-check)
//
// Writes outcome + outcome_at + outcome_notes to ai_actions.
// Also writes to business_memory when a customer responds positively.
const { supabase } = require('../../config/supabaseClient');
const { safeLog }  = require('../../observability/logger');

const EVAL_WINDOW_DAYS = {
  SEND_POLITE_REMINDER: 7,
  SEND_FIRM_REMINDER:   7,
  ESCALATE_COLLECTION:  3,
  FLAG_BAD_DEBT:        30,
  CASHFLOW_GAP_ALERT:   7,
  CREDIT_RISK_ALERT:    14,
};

const AUTO_EFFECTIVE = new Set(['DAILY_OWNER_BRIEFING', 'LOW_STOCK_ALERT', 'DATA_QUALITY', 'SUPPLIER_PAYMENT_OVERDUE']);

async function evaluateAction(action) {
  const type = action.action_type;

  // Auto-categorise types we can't check
  if (AUTO_EFFECTIVE.has(type)) {
    return { outcome: 'unknown', notes: 'Manual evaluation required' };
  }

  // Reminder actions — check if invoice was paid
  if (['SEND_POLITE_REMINDER', 'SEND_FIRM_REMINDER', 'ESCALATE_COLLECTION', 'FLAG_BAD_DEBT'].includes(type)) {
    if (!action.related_entity_id) return { outcome: 'unknown', notes: 'No invoice linked' };

    const { data: invoice } = await supabase
      .from('invoices')
      .select('payment_status, payment_date')
      .eq('id', action.related_entity_id)
      .maybeSingle();

    if (!invoice) return { outcome: 'unknown', notes: 'Invoice not found' };

    if (invoice.payment_status === 'Paid') {
      const daysSinceDone = action.completed_at
        ? Math.floor((new Date(invoice.payment_date || Date.now()) - new Date(action.completed_at)) / 86400000)
        : 0;
      const window = EVAL_WINDOW_DAYS[type] || 7;
      const isEffective = daysSinceDone <= window;
      return {
        outcome: isEffective ? 'effective' : 'ineffective',
        notes:   isEffective
          ? `Invoice paid ${daysSinceDone}d after action — within ${window}d window`
          : `Invoice paid but after ${window}d window`,
      };
    }

    // Escalation: check if a promise was created after the action
    if (type === 'ESCALATE_COLLECTION') {
      const { data: promise } = await supabase
        .from('promises')
        .select('id, created_at')
        .eq('user_id', action.user_id)
        .gt('created_at', action.completed_at || action.approved_at || action.created_at)
        .maybeSingle();
      if (promise) return { outcome: 'effective', notes: 'Promise created after escalation' };
    }

    return { outcome: 'ineffective', notes: 'Invoice still unpaid' };
  }

  // Cashflow gap — check if gap closed
  if (type === 'CASHFLOW_GAP_ALERT') {
    const { getWeekForecast } = require('../orchestrator/cashflow.service');
    const forecast = await getWeekForecast(action.user_id);
    const gapClosed = forecast.expected_inflow >= forecast.expected_outflow;
    return {
      outcome: gapClosed ? 'effective' : 'ineffective',
      notes:   gapClosed ? 'Cashflow gap resolved' : 'Gap still open',
    };
  }

  // Credit risk — check if score improved
  if (type === 'CREDIT_RISK_ALERT' && action.related_entity_id) {
    const { data: score } = await supabase
      .from('customer_scores')
      .select('credit_risk_score')
      .eq('user_id', action.user_id)
      .eq('customer_id', action.related_entity_id)
      .maybeSingle();
    if (score) {
      const improved = parseFloat(score.credit_risk_score) < 70;
      return {
        outcome: improved ? 'effective' : 'ineffective',
        notes:   improved ? `Score now ${Math.round(score.credit_risk_score)} — below HIGH_RISK` : `Score still ${Math.round(score.credit_risk_score)}`,
      };
    }
  }

  return { outcome: 'unknown', notes: 'Could not evaluate' };
}

/**
 * Run the Evaluation Agent.
 * Checks all done/approved actions older than 48h that have no outcome yet.
 */
async function run(userId) {
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const { data: actions, error } = await supabase
      .from('ai_actions')
      .select('id, action_type, user_id, related_entity_id, completed_at, approved_at, created_at')
      .eq('user_id', userId)
      .in('status', ['done', 'approved'])
      .lt('updated_at', cutoff)
      .is('outcome', null)
      .limit(50);

    if (error) throw error;
    if (!actions?.length) return { evaluated: 0 };

    let evaluated = 0;
    const memoryRows = [];

    for (const action of actions) {
      try {
        const { outcome, notes } = await evaluateAction(action);

        await supabase
          .from('ai_actions')
          .update({
            outcome,
            outcome_at:    new Date().toISOString(),
            outcome_notes: notes,
            updated_at:    new Date().toISOString(),
          })
          .eq('id', action.id);

        evaluated++;

        // Memory learning: if effective reminder → customer responds to this type
        if (outcome === 'effective' && action.related_entity_id &&
            ['SEND_POLITE_REMINDER', 'SEND_FIRM_REMINDER'].includes(action.action_type)) {
          const { data: invoice } = await supabase
            .from('invoices')
            .select('customer_name')
            .eq('id', action.related_entity_id)
            .maybeSingle();

          if (invoice) {
            // Find customer UUID
            const { data: customer } = await supabase
              .from('customers')
              .select('id')
              .eq('user_id', userId)
              .ilike('name', invoice.customer_name)
              .maybeSingle();

            if (customer) {
              const tone = action.action_type === 'SEND_POLITE_REMINDER' ? 'polite' : 'firm';
              memoryRows.push({
                user_id:      userId,
                entity_type:  'customer',
                entity_id:    customer.id,
                memory_key:   `responds_to_${tone}_reminder`,
                memory_value: { v: true, action_id: action.id, learnedAt: new Date().toISOString() },
                source:       'evaluation_agent',
                updated_at:   new Date().toISOString(),
              });
            }
          }
        }
      } catch (evalErr) {
        safeLog('warn', '[EvalAgent] Single action eval failed', { actionId: action.id, error: evalErr.message });
      }
    }

    // Persist memory learnings
    if (memoryRows.length) {
      await supabase.from('business_memory')
        .upsert(memoryRows, { onConflict: 'user_id,entity_type,entity_id,memory_key' });
    }

    safeLog('info', '[EvalAgent] Run complete', { userId, evaluated, memoryLearnings: memoryRows.length });
    return { evaluated, memoryLearnings: memoryRows.length };
  } catch (err) {
    safeLog('error', '[EvalAgent] run failed', { error: err.message, userId });
    return { evaluated: 0, error: err.message };
  }
}

module.exports = { run };
