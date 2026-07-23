// FILE: lib/services/orchestrator/rules.service.js
// Deterministic rules engine — evaluates a business_events row and returns action specs.
// Rules are pure functions: (userId, event) => ActionSpec[]
// Rules NEVER modify data directly. They only return specs; action.service creates them.
// Add new rules by pushing to ALL_RULES array — no other change needed.
const { supabase } = require('../../config/supabaseClient');
const { safeLog } = require('../../observability/logger');
const { isEnabled } = require('../../featureFlags');
const { planWithLLM } = require('./llmPlanner.service');

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
// NOTE (fixed alongside the promise-event pipeline fix): this rule used to
// read `event.entity_id` and treat it as an invoice id. Now that
// PROMISE_BROKEN events are correctly persisted with entityType:'promise' /
// entityId:<promise id> (see server.js's /api/promises routes and
// PromiseCron), the linked invoice -- if any -- comes from the promise's
// own `receivable_id`, which the emitting call sites now include in
// payload_json. A promise is not required to have a linked invoice
// (receivable_id is nullable), in which case this rule has nothing to
// check the ₹10,000 threshold against and correctly no-ops.
async function ruleBrokenPromiseEscalate(userId, event) {
  if (event.event_type !== 'PROMISE_BROKEN') return [];

  const customerId = event.payload_json?.customer_id;
  if (!customerId) return [];

  const receivableId = event.payload_json?.receivable_id;
  if (!receivableId) return [];

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
    .eq('id', receivableId)
    .eq('user_id', userId)
    .maybeSingle();

  if (!inv || parseFloat(inv.invoice_amount || 0) < 10000) return [];

  return [{
    action_type:          'ESCALATE_TO_OWNER',
    title:                `Escalate: ${inv.customer_name} has broken ${brokenCount} promises`,
    priority:             'urgent',
    customer_id:          customerId,
    related_entity_type:  'invoice',
    related_entity_id:    receivableId,
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

// ─── Rule: LLM-assisted inventory reorder plan (Phase 2 wiring) ─────────────
// This is the first live wiring of llmPlanner.service.js's planWithLLM() into
// the actual production pipeline. Per that module's own header comment, the
// intended integration point is rules.service.js -- this is that integration.
//
// Deliberately narrow scope for this first rollout:
//   - Only triggers on LOW_STOCK_DETECTED, a naturally low-frequency,
//     event-driven trigger (fires only when stock genuinely crosses a
//     reorder threshold, not on every sale/purchase transaction). This
//     bounds LLM call volume and cost while the feature is unreviewed.
//   - Gated by the EXISTING 'agent_planner_enabled' flag
//     (FEATURE_AGENT_PLANNER_ENABLED, defaults OFF) that planWithLLM()
//     already checks internally -- checked again here too, before any
//     Supabase context-building queries run, so enabling/disabling costs
//     nothing extra when off. A second, differently-named flag was
//     deliberately NOT added: it would just be a second on/off switch for
//     the same behavior and risks the two flags drifting out of sync.
//   - Uses modelKind:'fast' (the cheaper/faster model tier in
//     llmPlanner.service.js's pickModel()) rather than the full planner
//     model, for cost control on this first wiring.
//   - promptGuard.service.js (sanitizeContextObject / shouldBlockLLMUse) is
//     invoked automatically -- it lives inside planWithLLM() itself and
//     runs on every call regardless of caller. Nothing extra was needed
//     here to activate it; it was simply never reachable before because
//     nothing called planWithLLM().
//   - Every action planWithLLM() returns already has requires_approval
//     forced to true (defence in depth inside llmPlanner.service.js itself)
//     and is validated against ALLOWED_ACTION_TYPES + real product/customer
//     IDs from the context (hallucination guard) before it ever reaches
//     policyGuard.validate() -> actionService.create(), same as every
//     deterministic rule's output.
//
// Complements, does not replace, ruleLowStock() above: that rule still
// fires a deterministic LOW_STOCK_ALERT unconditionally. This rule adds an
// LLM-suggested PURCHASE_SUGGESTION with reorder-quantity reasoning when the
// planner is enabled -- if it fails, is disabled, or produces nothing, the
// deterministic alert above still gets the owner notified either way.
async function ruleLLMInventoryPlan(userId, event) {
  if (!isEnabled('agent_planner_enabled')) return [];
  if (event.event_type !== 'LOW_STOCK_DETECTED') return [];

  const productId = event.entity_id;
  if (!productId) return [];

  try {
    const { data: product } = await supabase
      .from('products')
      .select('id, name, sku, category, unit, current_stock, low_stock_alert')
      .eq('id', productId)
      .eq('user_id', userId)
      .maybeSingle();
    if (!product) return [];

    // Recent sales velocity for this product — cheap, real signal for the
    // LLM to reason about reorder quantity without guessing.
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recentOut } = await supabase
      .from('stock_movements')
      .select('quantity')
      .eq('user_id', userId)
      .eq('product_id', productId)
      .eq('movement_type', 'out')
      .gte('created_at', since30d);
    const unitsSoldLast30d = (recentOut || []).reduce((s, m) => s + Number(m.quantity || 0), 0);

    const context = {
      customers: [],
      suppliers: [],
      products: [{
        id:               product.id,
        name:             product.name,
        sku:              product.sku || null,
        category:         product.category || null,
        unit:             product.unit || null,
        current_stock:    product.current_stock,
        low_stock_alert:  product.low_stock_alert,
      }],
      signal: {
        event_type:          'LOW_STOCK_DETECTED',
        units_sold_last_30d: unitsSoldLast30d,
      },
    };

    safeLog('info', '[RulesEngine] Invoking LLM planner', {
      userId, eventType: event.event_type, productId, goal: 'plan_inventory_reorder_for_low_stock_event',
    });

    const plan = await planWithLLM({
      userId,
      goal:      'plan_inventory_reorder_for_low_stock_event',
      context,
      planType:  'inventory_plan',
      modelKind: 'fast',
    });

    if (!plan) {
      // null means: flag off, Anthropic unavailable, prompt-guard hard-block,
      // LLM call failed, or non-JSON/invalid response -- planWithLLM already
      // logged the specific reason. Nothing further to do here.
      return [];
    }

    safeLog('info', '[RulesEngine] LLM inventory plan received', {
      userId, productId,
      planType:   plan.plan_type,
      actions:    plan.actions.length,
      rejected:   plan.rejected_actions?.length || 0,
      confidence: plan.confidence,
      model:      plan.model,
    });

    if (!plan.actions.length) return [];

    return plan.actions.map(a => ({
      ...a,
      suggested_by:         'ai', // distinct from 'rule' -- this action came from the LLM planner, not a deterministic rule
      related_entity_type:  a.related_entity_type || 'product',
      related_entity_id:    a.related_entity_id   || productId,
      reason_json: {
        ...(a.reason_json || {}),
        source:         'llm_planner',
        prompt_version: plan.prompt_version,
        model:          plan.model,
        confidence:     plan.confidence,
        rule:           'llm_inventory_reorder_plan',
      },
    }));
  } catch (err) {
    safeLog('error', '[RulesEngine] LLM planner rule failed', { error: err.message, userId, productId });
    return [];
  }
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
  ruleLLMInventoryPlan,
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
