// FILE: lib/services/orchestrator/rules.service.js
// Deterministic rules engine — evaluates a business_events row and returns action specs.
// Rules are pure functions: (userId, event) => ActionSpec[]
// Rules NEVER modify data directly. They only return specs; action.service creates them.
// Add new rules by pushing to ALL_RULES array — no other change needed.
const { supabase } = require('../../config/supabaseClient');
const { safeLog } = require('../../observability/logger');
const { isEnabled } = require('../../featureFlags');

// ─── Rule: Polite reminder for 1-3 days overdue ──────────────────────────────
async function rulePoliteReminder(userId, event) {
  const triggers = ['SALE_CREATED', 'SALE_UPDATED', 'RECEIVABLE_CREATED'];
  if (!triggers.includes(event.event_type)) return [];

  const { data } = await supabase
    .from('invoices')
    .select('id, customer_name, invoice_amount, days_overdue')
    .eq('user_id', userId)
    .eq('payment_status', 'Pending')
    .gte('days_overdue', 1)
    .lte('days_overdue', 3)
    .limit(20);

  return (data || []).map(r => ({
    action_type:          'SEND_POLITE_REMINDER',
    title:                `Send polite reminder to ${r.customer_name}`,
    priority:             'medium',
    related_entity_type:  'invoice',
    related_entity_id:    r.id,
    reason_json: {
      overdue_days: r.days_overdue,
      amount:       r.invoice_amount,
      rule:         'overdue_1_to_3_days',
    },
    suggested_by:      'rule',
    requires_approval: false,
  }));
}

// ─── Rule: Firm reminder for > 7 days overdue ────────────────────────────────
async function ruleFirmReminder(userId, event) {
  const triggers = ['SALE_CREATED', 'SALE_UPDATED', 'PAYMENT_RECEIVED', 'PROMISE_BROKEN'];
  if (!triggers.includes(event.event_type)) return [];

  const { data } = await supabase
    .from('invoices')
    .select('id, customer_name, invoice_amount, days_overdue')
    .eq('user_id', userId)
    .eq('payment_status', 'Pending')
    .gt('days_overdue', 7)
    .limit(20);

  return (data || []).map(r => ({
    action_type:          'SEND_FIRM_REMINDER',
    title:                `Send firm reminder — ${r.customer_name} (${r.days_overdue}d overdue)`,
    priority:             r.days_overdue > 14 ? 'high' : 'medium',
    related_entity_type:  'invoice',
    related_entity_id:    r.id,
    reason_json: {
      overdue_days: r.days_overdue,
      amount:       r.invoice_amount,
      rule:         'overdue_over_7_days',
    },
    suggested_by:      'rule',
    requires_approval: true,
    risk_level:        r.days_overdue > 14 ? 'high' : 'medium',
  }));
}

// ─── Rule: Escalate on repeated broken promises ──────────────────────────────
async function ruleBrokenPromiseEscalate(userId, event) {
  if (event.event_type !== 'PROMISE_BROKEN') return [];

  const customerId = event.payload_json?.customer_id;
  if (!customerId) return [];

  const { data: score } = await supabase
    .from('customer_scores')
    .select('broken_promise_count, credit_risk_score')
    .eq('customer_id', customerId)
    .eq('user_id', userId)
    .maybeSingle();

  const brokenCount = score?.broken_promise_count || 0;
  if (brokenCount < 2) return [];

  const { data: inv } = await supabase
    .from('invoices')
    .select('id, invoice_amount, customer_name')
    .eq('id', event.entity_id)
    .eq('user_id', userId)
    .maybeSingle();

  if (!inv || parseFloat(inv.invoice_amount || 0) < 10000) return [];

  return [{
    action_type:          'ESCALATE_TO_OWNER',
    title:                `Escalate: ${inv.customer_name} has broken ${brokenCount} promises`,
    priority:             'urgent',
    customer_id:          customerId,
    related_entity_type:  'invoice',
    related_entity_id:    event.entity_id,
    reason_json: {
      broken_promise_count: brokenCount,
      amount:               inv.invoice_amount,
      rule:                 'repeated_broken_promise',
    },
    suggested_by:      'rule',
    requires_approval: true,
    risk_level:        'high',
  }];
}

// ─── Rule: Low stock alert ───────────────────────────────────────────────────
async function ruleLowStock(userId, event) {
  if (!isEnabled('low_stock_alerts')) return [];
  if (event.event_type !== 'LOW_STOCK_DETECTED') return [];

  const productId = event.entity_id;
  const { data: product } = await supabase
    .from('products')
    .select('id, name, current_stock, low_stock_alert')
    .eq('id', productId)
    .eq('user_id', userId)
    .maybeSingle();

  if (!product) return [];

  return [{
    action_type:          'LOW_STOCK_ALERT',
    title:                `Restock ${product.name} — only ${product.current_stock} units left`,
    priority:             'medium',
    related_entity_type:  'product',
    related_entity_id:    productId,
    reason_json: {
      current_stock: product.current_stock,
      min_stock:     product.low_stock_alert,
      rule:          'stock_below_minimum',
    },
    suggested_by:      'rule',
    requires_approval: false,
  }];
}

// ─── Rule: Cashflow risk — outflows > inflows next 7 days ────────────────────
async function ruleCashflowRisk(userId, event) {
  if (!isEnabled('cashflow_forecast')) return [];
  if (event.event_type !== 'CASHFLOW_UPDATED') return [];

  const { expected_inflow = 0, expected_outflow = 0 } = event.payload_json || {};
  if (expected_outflow <= expected_inflow) return [];

  const gap = expected_outflow - expected_inflow;

  return [{
    action_type:  'CASHFLOW_RISK',
    title:        `Cashflow warning: outflows exceed inflows by ₹${gap.toLocaleString('en-IN')}`,
    priority:     gap > 50000 ? 'urgent' : 'high',
    reason_json: {
      expected_inflow,
      expected_outflow,
      gap,
      rule: 'outflow_exceeds_inflow_7d',
    },
    suggested_by:      'rule',
    requires_approval: false,
    risk_level:        'high',
  }];
}

// ─── Rule: Credit risk warning before new credit sale ───────────────────────
async function ruleCreditRiskWarning(userId, event) {
  if (!isEnabled('credit_risk_warning')) return [];
  if (event.event_type !== 'SALE_CREATED') return [];

  const customerId = event.payload_json?.customer_id;
  if (!customerId) return [];

  const { data: score } = await supabase
    .from('customer_scores')
    .select('credit_risk_score')
    .eq('customer_id', customerId)
    .eq('user_id', userId)
    .maybeSingle();

  if (!score || score.credit_risk_score < 80) return [];

  return [{
    action_type:          'STOP_CREDIT_WARNING',
    title:                `High-risk customer given credit — review before next sale`,
    priority:             'high',
    customer_id:          customerId,
    related_entity_type:  'sale',
    related_entity_id:    event.entity_id,
    reason_json: {
      credit_risk_score: score.credit_risk_score,
      rule:              'credit_risk_over_80',
    },
    suggested_by:      'rule',
    requires_approval: true,
    risk_level:        'high',
  }];
}

// ─── Rule: Supplier payment due within 3 days ───────────────────────────────
async function ruleSupplierPaymentDue(userId, event) {
  const triggers = ['PURCHASE_CREATED', 'PURCHASE_UPDATED'];
  if (!triggers.includes(event.event_type)) return [];

  const today = new Date();
  const in3Days = new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const todayStr = today.toISOString().split('T')[0];

  const { data } = await supabase
    .from('purchases')
    .select('id, supplier_name, amount, due_date')
    .eq('user_id', userId)
    .eq('status', 'unpaid')
    .gte('due_date', todayStr)
    .lte('due_date', in3Days)
    .limit(10);

  return (data || []).map(p => ({
    action_type:          'SUPPLIER_PAYMENT_DUE',
    title:                `Pay ${p.supplier_name} by ${p.due_date} — ₹${parseFloat(p.amount).toLocaleString('en-IN')}`,
    priority:             'high',
    related_entity_type:  'purchase',
    related_entity_id:    p.id,
    reason_json: {
      due_date:      p.due_date,
      amount:        p.amount,
      supplier_name: p.supplier_name,
      rule:          'supplier_due_in_3_days',
    },
    suggested_by:      'rule',
    requires_approval: false,
  }));
}

// ─── All active rules ────────────────────────────────────────────────────────
const ALL_RULES = [
  rulePoliteReminder,
  ruleFirmReminder,
  ruleBrokenPromiseEscalate,
  ruleLowStock,
  ruleCashflowRisk,
  ruleCreditRiskWarning,
  ruleSupplierPaymentDue,
];

// Evaluate all rules against an event. Returns flat array of action specs.
// Individual rule failures are caught and logged — never propagate.
async function evaluate(userId, event) {
  const actions = [];
  for (const rule of ALL_RULES) {
    try {
      const specs = await rule(userId, event);
      if (Array.isArray(specs)) actions.push(...specs);
    } catch (err) {
      safeLog('warn', '[RulesEngine] Rule threw — skipped', { ruleName: rule.name, error: err.message, userId });
    }
  }
  return actions;
}

module.exports = { evaluate };
