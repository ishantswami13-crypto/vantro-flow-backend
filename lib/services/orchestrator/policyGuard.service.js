// FILE: lib/services/orchestrator/policyGuard.service.js
// Every AI/rule action passes through here before being saved.
// If validation fails: action is returned with status='system_blocked' (never thrown away silently).
// This is the last line of defence before an action reaches the owner's queue.
const { supabase } = require('../../config/supabaseClient');
const { safeLog } = require('../../observability/logger');

// Phrases that must never appear in any outgoing message draft.
const BLOCKED_PHRASES = [
  'legal action', 'file case', 'police', 'FIR', 'court', 'arrest', 'lawyer',
  'criminal', 'fraud', 'cheater', 'threaten', 'warning letter',
];

// Action types that always require owner approval before any external send.
const ALWAYS_REQUIRES_APPROVAL = new Set([
  'SEND_FIRM_REMINDER',
  'CALL_CUSTOMER',
  'ESCALATE_TO_OWNER',
  'STOP_CREDIT_WARNING',
  'CASHFLOW_RISK',
  'CREDIT_HOLD_SUGGESTED',
  'ASK_PARTIAL_PAYMENT',
]);

const HIGH_AMOUNT_THRESHOLD = 50000; // ₹50,000 — escalate for owner review

// Validate an action spec before persisting to ai_actions.
// Returns the action with status and requires_approval set correctly.
// Never throws.
async function validate(action, userId) {
  const errors = [];

  // 1. Tenant isolation — customer must belong to this user
  if (action.customer_id) {
    const { data: customer } = await supabase
      .from('customers')
      .select('id')
      .eq('id', action.customer_id)
      .eq('user_id', userId)
      .maybeSingle();
    if (!customer) {
      errors.push(`customer_id ${action.customer_id} not found for this user — possible hallucination`);
    }
  }

  // 2. Amount sanity — if action references a receivable, amount must match DB
  if (action.related_entity_type === 'invoice' && action.related_entity_id && action.amount) {
    const { data: invoice } = await supabase
      .from('invoices')
      .select('invoice_amount')
      .eq('id', action.related_entity_id)
      .eq('user_id', userId)
      .maybeSingle();
    if (invoice) {
      const dbAmount    = parseFloat(invoice.invoice_amount || 0);
      const actionAmount = parseFloat(action.amount || 0);
      if (Math.abs(dbAmount - actionAmount) > 1) {
        errors.push(`Amount mismatch: action says ₹${actionAmount}, DB says ₹${dbAmount}`);
      }
    }
  }

  // 3. No illegal/threatening language in message drafts
  if (action.recommended_message) {
    const msgLower = action.recommended_message.toLowerCase();
    const hit = BLOCKED_PHRASES.find(p => msgLower.includes(p.toLowerCase()));
    if (hit) errors.push(`Message contains blocked phrase: "${hit}"`);
  }

  // 4. AI must not suggest financial data mutations
  const FORBIDDEN_TYPES = ['MARK_PAID', 'CHANGE_AMOUNT', 'OFFER_DISCOUNT', 'DELETE_INVOICE'];
  if (FORBIDDEN_TYPES.includes(action.action_type)) {
    errors.push(`Action type ${action.action_type} is forbidden for AI/rule suggestions`);
  }

  if (errors.length > 0) {
    safeLog('warn', '[PolicyGuard] Action blocked', { errors, actionType: action.action_type, userId });
    // Persist to policy_decisions for audit trail
    supabase.from('policy_decisions').insert([{
      user_id:        userId,
      action_type:    action.action_type,
      action_payload: action,
      decision:       'block',
      reason:         errors.join('; '),
      blocked_phrase: errors.find(e => e.includes('blocked phrase'))?.match(/"([^"]+)"/)?.[1] || null,
    }]).then().catch(() => {});
    return {
      ...action,
      status:            'system_blocked',
      block_reason:      errors.join('; '),
      requires_approval: false,
    };
  }

  // 5. Set approval requirement
  const requiresApproval =
    ALWAYS_REQUIRES_APPROVAL.has(action.action_type) ||
    (action.amount && parseFloat(action.amount) > HIGH_AMOUNT_THRESHOLD) ||
    action.risk_level === 'high' ||
    !!action.requires_approval;

  // Log allow decision for risky actions (high amount or always-requires-approval types)
  if (requiresApproval) {
    supabase.from('policy_decisions').insert([{
      user_id:        userId,
      action_type:    action.action_type,
      action_payload: { action_type: action.action_type, title: action.title, risk_level: action.risk_level },
      decision:       'allow',
      reason:         'Requires owner approval before execution',
    }]).then().catch(() => {});
  }

  return { ...action, requires_approval: requiresApproval };
}

module.exports = { validate };
