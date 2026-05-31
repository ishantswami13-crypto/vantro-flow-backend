'use strict';
// scripts/seed-agent-registry.js
// Seeds the 12 core Atlas agents into agent_registry.
// These are METADATA entries only — is_active=false, no runtime execution.
//
// Idempotent: uses INSERT ... ON CONFLICT (agent_id) DO UPDATE
//   Safe to run multiple times — updates metadata if definition changes.
//
// Safety guards:
//   - Blocks if DATABASE_URL contains the production Supabase project ID.
//   - Blocks if DATABASE_URL contains vantro.in (production domain).
//   - Blocks if NODE_ENV=production (unless ATLAS_SEED_ALLOW_PROD is explicitly set).
//
// Usage:
//   DATABASE_URL=<staging-postgres-url> node scripts/seed-agent-registry.js
//   DATABASE_URL=<staging-url> node scripts/seed-agent-registry.js --validate
//     (--validate: counts expected rows, does NOT write to DB)

const { Client } = require('pg');

const DB_URL = process.env.DATABASE_URL;
const VALIDATE_ONLY = process.argv.includes('--validate');

// ── Production guard ──────────────────────────────────────────────────────────
if (!DB_URL) {
  console.error('[seed-agent-registry] ERROR: DATABASE_URL is not set.');
  process.exit(1);
}

const PROD_SUPABASE_ID = 'alepdpyqesevldobjxbo';
if (DB_URL.includes(PROD_SUPABASE_ID)) {
  console.error('[seed-agent-registry] BLOCKED: DATABASE_URL contains the production Supabase project ID.');
  process.exit(1);
}

if (/vantro\.in/i.test(DB_URL)) {
  console.error('[seed-agent-registry] BLOCKED: DATABASE_URL looks like production (vantro.in).');
  process.exit(1);
}

if (process.env.NODE_ENV === 'production' && process.env.ATLAS_SEED_ALLOW_PROD !== 'true') {
  console.error('[seed-agent-registry] BLOCKED: NODE_ENV=production. Set ATLAS_SEED_ALLOW_PROD=true to override.');
  process.exit(1);
}

// ── 12 Core Agent Definitions ─────────────────────────────────────────────────
// All agents: is_active=false, status=registry, public_claim_status=core_public
// These match the taxonomy in docs/agent-mesh/agent-taxonomy-216.md

const CORE_AGENTS = [
  {
    agent_id: 'core.collections',
    name: 'Collections Agent',
    layer: 1,
    squad: 'Core',
    mission: 'Identify and prioritize overdue receivables for collection action.',
    business_function: 'Tells the owner who owes money, how much, how overdue, and what to do next. Eliminates manual spreadsheet review for collections.',
    trigger_events: ['invoice.overdue', 'daily.collections_run', 'owner.request'],
    input_schema: {
      required: ['business_id', 'date'],
      optional: ['customer_filter', 'min_amount', 'exclude_disputed'],
    },
    tools_required: ['tool.invoice_reader', 'tool.customer_history_reader', 'tool.collections_scorer'],
    output_schema: {
      type: 'collection_recommendations',
      fields: ['priority_rank', 'customer_id', 'amount', 'days_overdue', 'recommended_action', 'reasoning'],
    },
    risk_level: 'high',
    policy_rules: [
      { rule_id: 'C001', condition: "invoice.status == 'disputed'", action: 'deny' },
      { rule_id: 'C002', condition: 'customer.has_active_grievance', action: 'flag_for_review' },
    ],
    approval_required: false,
    audit_events: ['agent.collections_run', 'agent.customer_ranked'],
    success_metric: 'Top-3 list results in payment 60% within 7 days',
    cost_budget: { max_tokens_per_run: 2000, max_cost_usd_per_run: 0.003, monthly_budget_usd: 5.0 },
    harness_scenarios: [
      { type: 'static', description: 'Schema completeness check' },
      { type: 'dry_run', description: 'Run with 10 synthetic overdue invoices, verify disputed excluded' },
      { type: 'red_team', description: 'Grievance customer injection — verify flagged not ranked' },
      { type: 'live', description: 'Staging end-to-end validation' },
    ],
    feature_flag: 'atlas_core_collections_enabled',
    fallback_behavior: 'Return static list of overdue invoices sorted by amount descending',
    public_claim_status: 'core_public',
  },
  {
    agent_id: 'core.promise_tracker',
    name: 'Promise Tracker Agent',
    layer: 1,
    squad: 'Core',
    mission: 'Track customer payment promises and detect broken commitments.',
    business_function: 'Surfaces customers who said they would pay but have not — the most actionable collection signal available.',
    trigger_events: ['payment.due', 'promise.due_date_passed', 'daily.promise_check'],
    input_schema: {
      required: ['business_id'],
      optional: ['date_range', 'customer_id'],
    },
    tools_required: ['tool.promise_reader', 'tool.payment_checker', 'tool.customer_history_reader'],
    output_schema: {
      type: 'promise_status_report',
      fields: ['customer_id', 'promise_date', 'promised_amount', 'status', 'days_broken', 'action_recommended'],
    },
    risk_level: 'medium',
    policy_rules: [
      { rule_id: 'PT001', condition: "promise.status == 'fulfilled'", action: 'allow' },
      { rule_id: 'PT002', condition: 'promise.days_broken > 30', action: 'flag_for_review' },
    ],
    approval_required: false,
    audit_events: ['agent.promise_checked', 'agent.broken_promise_detected'],
    success_metric: 'False positive broken promise rate below 5%',
    cost_budget: { max_tokens_per_run: 500, max_cost_usd_per_run: 0.001, monthly_budget_usd: 2.0 },
    harness_scenarios: [
      { type: 'static', description: 'Schema completeness' },
      { type: 'dry_run', description: 'Fulfilled promises not flagged as broken' },
      { type: 'live', description: 'Staging accuracy test against known promise states' },
    ],
    feature_flag: 'atlas_core_promise_tracker_enabled',
    fallback_behavior: 'Return all invoices with promised_payment_date in the past',
    public_claim_status: 'core_public',
  },
  {
    agent_id: 'core.credit_risk',
    name: 'Credit Risk Agent',
    layer: 1,
    squad: 'Core',
    mission: 'Assess credit exposure risk per customer and recommend credit limit actions.',
    business_function: 'Prevents businesses from extending credit to high-risk customers, protecting cashflow from bad debt.',
    trigger_events: ['sale.created', 'credit_limit.review_due', 'daily.risk_run'],
    input_schema: {
      required: ['business_id', 'customer_id'],
      optional: ['include_all_customers', 'risk_threshold'],
    },
    tools_required: ['tool.customer_history_reader', 'tool.payment_behavior_scorer', 'tool.invoice_reader', 'tool.risk_calculator'],
    output_schema: {
      type: 'credit_risk_assessment',
      fields: ['customer_id', 'risk_score', 'risk_level', 'credit_limit_current', 'credit_limit_recommended', 'reasoning', 'flags'],
    },
    risk_level: 'high',
    policy_rules: [
      { rule_id: 'CR001', condition: 'output.contains_discriminatory_pattern', action: 'deny' },
      { rule_id: 'CR002', condition: 'output.financial_figure_unverified', action: 'deny' },
      { rule_id: 'CR003', condition: 'risk_score > 80', action: 'flag_for_review' },
    ],
    approval_required: false,
    audit_events: ['agent.credit_risk_assessed', 'agent.risk_flag_raised'],
    success_metric: 'High-risk customers default 3x more than low-risk within 90 days',
    cost_budget: { max_tokens_per_run: 1500, max_cost_usd_per_run: 0.002, monthly_budget_usd: 4.0 },
    harness_scenarios: [
      { type: 'static', description: 'Schema completeness' },
      { type: 'dry_run', description: 'Risk scores in range 0-100' },
      { type: 'red_team', description: 'No discriminatory scoring patterns' },
      { type: 'red_team', description: 'No hallucinated credit limit figures' },
      { type: 'live', description: 'Score accuracy vs actual payment outcomes' },
    ],
    feature_flag: 'atlas_core_credit_risk_enabled',
    fallback_behavior: 'Return payment_delay_days as proxy risk score, zero hallucination',
    public_claim_status: 'core_public',
  },
  {
    agent_id: 'core.cashflow',
    name: 'Cashflow Agent',
    layer: 1,
    squad: 'Core',
    mission: 'Monitor and forecast business cashflow position in real time.',
    business_function: 'Answers the owner\'s most important question: will I have enough cash this week and next month?',
    trigger_events: ['payment.received', 'invoice.created', 'daily.cashflow_run', 'owner.request'],
    input_schema: {
      required: ['business_id'],
      optional: ['forecast_days', 'include_pending', 'confidence_threshold'],
    },
    tools_required: ['tool.invoice_reader', 'tool.payment_reader', 'tool.cashflow_calculator'],
    output_schema: {
      type: 'cashflow_report',
      fields: ['current_balance', 'expected_inflows_7d', 'expected_outflows_7d', 'net_position_7d', 'forecast_30d', 'confidence_score', 'cash_gap_risk'],
    },
    risk_level: 'medium',
    policy_rules: [
      { rule_id: 'CF001', condition: 'output.unverified_financial_figure', action: 'deny' },
      { rule_id: 'CF002', condition: 'forecast.confidence_score < 0.6', action: 'add_disclaimer' },
    ],
    approval_required: false,
    audit_events: ['agent.cashflow_calculated', 'agent.cash_gap_detected'],
    success_metric: '7-day forecast within 20% of actual cashflow',
    cost_budget: { max_tokens_per_run: 1000, max_cost_usd_per_run: 0.001, monthly_budget_usd: 3.0 },
    harness_scenarios: [
      { type: 'static', description: 'Schema completeness' },
      { type: 'dry_run', description: 'Inflows minus outflows equals net position' },
      { type: 'dry_run', description: 'Low confidence forecast receives disclaimer' },
      { type: 'live', description: '7-day accuracy test against actuals' },
    ],
    feature_flag: 'atlas_core_cashflow_enabled',
    fallback_behavior: 'Return sum of overdue receivables as expected inflows estimate',
    public_claim_status: 'core_public',
  },
  {
    agent_id: 'core.inventory_cash',
    name: 'Inventory-Cash Agent',
    layer: 1,
    squad: 'Core',
    mission: 'Analyze inventory-to-cash conversion efficiency and flag reorder decisions.',
    business_function: 'Prevents cash being locked in slow-moving inventory while flagging stockout risks before they impact sales.',
    trigger_events: ['stock.updated', 'daily.inventory_run', 'sale.created'],
    input_schema: {
      required: ['business_id'],
      optional: ['sku_filter', 'low_stock_threshold', 'dead_stock_days'],
    },
    tools_required: ['tool.inventory_reader', 'tool.sales_reader', 'tool.cash_calculator'],
    output_schema: {
      type: 'inventory_cash_report',
      fields: ['locked_cash_in_inventory', 'slow_moving_skus', 'dead_stock_value', 'reorder_alerts', 'stockout_risk_items'],
    },
    risk_level: 'medium',
    policy_rules: [
      { rule_id: 'IC001', condition: 'output.negative_stock_value', action: 'deny' },
    ],
    approval_required: false,
    audit_events: ['agent.inventory_analyzed', 'agent.reorder_alert_raised'],
    success_metric: 'Reorder alerts prevent stockout 80% of time when acted on',
    cost_budget: { max_tokens_per_run: 800, max_cost_usd_per_run: 0.001, monthly_budget_usd: 2.0 },
    harness_scenarios: [
      { type: 'static', description: 'Schema completeness' },
      { type: 'dry_run', description: 'No negative stock scenarios in output' },
      { type: 'live', description: 'Staging accuracy with real inventory data' },
    ],
    feature_flag: 'atlas_core_inventory_cash_enabled',
    fallback_behavior: 'Return items with quantity below safety_stock as reorder alerts',
    public_claim_status: 'core_public',
  },
  {
    agent_id: 'core.payables',
    name: 'Payables Agent',
    layer: 1,
    squad: 'Core',
    mission: 'Optimize supplier payment timing and prioritization given cash constraints.',
    business_function: 'Tells the owner which supplier to pay first when cash is tight, protecting critical business relationships.',
    trigger_events: ['payment.due', 'cashflow.tight_alert', 'daily.payables_run'],
    input_schema: {
      required: ['business_id'],
      optional: ['cash_available', 'priority_override', 'exclude_suppliers'],
    },
    tools_required: ['tool.payables_reader', 'tool.supplier_reader', 'tool.cash_calculator', 'tool.payment_priority_scorer'],
    output_schema: {
      type: 'payment_priority_list',
      fields: ['priority_rank', 'supplier_id', 'amount_due', 'due_date', 'relationship_risk', 'recommended_action', 'reasoning'],
    },
    risk_level: 'high',
    policy_rules: [
      { rule_id: 'PA001', condition: "proposed_action.type == 'execute_payment'", action: 'deny' },
      { rule_id: 'PA002', condition: 'cash_available < total_due * 0.5', action: 'flag_for_review' },
    ],
    approval_required: false,
    audit_events: ['agent.payables_prioritized', 'agent.cash_constraint_flagged'],
    success_metric: 'Top-3 payment priorities defensible to finance reviewer 90% of time',
    cost_budget: { max_tokens_per_run: 1200, max_cost_usd_per_run: 0.002, monthly_budget_usd: 3.0 },
    harness_scenarios: [
      { type: 'static', description: 'Schema completeness' },
      { type: 'dry_run', description: 'Agent cannot trigger payment execution' },
      { type: 'red_team', description: 'Cash constraint injection uses real cash position' },
      { type: 'live', description: 'Priority quality reviewed by finance expert' },
    ],
    feature_flag: 'atlas_core_payables_enabled',
    fallback_behavior: 'Return payables sorted by due_date ascending',
    public_claim_status: 'core_public',
  },
  {
    agent_id: 'core.dispute',
    name: 'Dispute Agent',
    layer: 1,
    squad: 'Core',
    mission: 'Classify and route customer disputes to the appropriate resolution workflow.',
    business_function: 'Prevents collection actions on disputed invoices while ensuring disputes are tracked and resolved quickly.',
    trigger_events: ['dispute.raised', 'invoice.flagged_disputed', 'customer.complaint'],
    input_schema: {
      required: ['business_id', 'dispute_data'],
      optional: ['auto_halt_collection'],
    },
    tools_required: ['tool.dispute_reader', 'tool.invoice_reader', 'tool.collection_halter'],
    output_schema: {
      type: 'dispute_classification',
      fields: ['dispute_id', 'category', 'severity', 'recommended_action', 'collection_halt_required', 'resolution_owner'],
    },
    risk_level: 'medium',
    policy_rules: [
      { rule_id: 'D001', condition: 'dispute.active == true', action: 'require_approval' },
      { rule_id: 'D002', condition: "dispute.severity == 'legal'", action: 'flag_for_review' },
    ],
    approval_required: false,
    audit_events: ['agent.dispute_classified', 'agent.collection_halted'],
    success_metric: 'Correct dispute category assigned 85% of time, verified by resolution outcome',
    cost_budget: { max_tokens_per_run: 800, max_cost_usd_per_run: 0.001, monthly_budget_usd: 2.0 },
    harness_scenarios: [
      { type: 'static', description: 'Schema completeness' },
      { type: 'dry_run', description: 'Disputed invoice halts collection action' },
      { type: 'red_team', description: 'Misclassification edge cases do not block valid collections' },
      { type: 'live', description: 'End-to-end dispute routing in staging' },
    ],
    feature_flag: 'atlas_core_dispute_enabled',
    fallback_behavior: 'Flag invoice as disputed, halt all collection actions on it',
    public_claim_status: 'core_public',
  },
  {
    agent_id: 'core.owner_briefing',
    name: 'Owner Briefing Agent',
    layer: 1,
    squad: 'Core',
    mission: 'Synthesize daily business intelligence into an owner-ready briefing.',
    business_function: 'Gives the owner everything they need to know in 2 minutes — cash, collections, risks, wins, and next actions.',
    trigger_events: ['daily.briefing_run', 'owner.request', 'significant.event'],
    input_schema: {
      required: ['business_id', 'date'],
      optional: ['briefing_style', 'max_items', 'include_sections'],
    },
    tools_required: ['tool.collections_reader', 'tool.cashflow_reader', 'tool.inventory_reader', 'tool.briefing_composer'],
    output_schema: {
      type: 'owner_briefing',
      fields: ['priority_actions', 'cash_position', 'collections_summary', 'top_risks', 'wins_today', 'recommended_next_steps'],
    },
    risk_level: 'low',
    policy_rules: [
      { rule_id: 'OB001', condition: 'output.unverified_data_point', action: 'deny' },
    ],
    approval_required: false,
    audit_events: ['agent.briefing_generated'],
    success_metric: 'Briefing opened and acted on same day 70% of time',
    cost_budget: { max_tokens_per_run: 3000, max_cost_usd_per_run: 0.004, monthly_budget_usd: 6.0 },
    harness_scenarios: [
      { type: 'static', description: 'Schema completeness' },
      { type: 'dry_run', description: 'All briefing sections present, no invented data' },
      { type: 'live', description: 'Quality review by product team' },
    ],
    feature_flag: 'atlas_core_owner_briefing_enabled',
    fallback_behavior: 'Return static summary: overdue count, cash position, top 3 actions',
    public_claim_status: 'core_public',
  },
  {
    agent_id: 'core.data_quality',
    name: 'Data Quality Agent',
    layer: 1,
    squad: 'Core',
    mission: 'Detect and flag data quality issues across business records.',
    business_function: 'Prevents bad data from corrupting agent recommendations — garbage in, garbage out prevention.',
    trigger_events: ['data.import', 'daily.quality_run', 'record.updated'],
    input_schema: {
      required: ['business_id'],
      optional: ['scope', 'severity_threshold', 'auto_flag'],
    },
    tools_required: ['tool.data_scanner', 'tool.record_reader', 'tool.quality_scorer'],
    output_schema: {
      type: 'data_quality_report',
      fields: ['issue_count', 'issues_by_type', 'affected_records', 'severity_distribution', 'recommended_fixes'],
    },
    risk_level: 'low',
    policy_rules: [
      { rule_id: 'DQ001', condition: "action.type == 'delete_record'", action: 'deny' },
      { rule_id: 'DQ002', condition: "issue.severity == 'critical'", action: 'flag_for_review' },
    ],
    approval_required: false,
    audit_events: ['agent.quality_scan_run', 'agent.quality_issue_flagged'],
    success_metric: 'Catches over 80% of data issues with fewer than 10% false positives',
    cost_budget: { max_tokens_per_run: 500, max_cost_usd_per_run: 0.001, monthly_budget_usd: 2.0 },
    harness_scenarios: [
      { type: 'static', description: 'Schema completeness' },
      { type: 'dry_run', description: 'Agent flags but never deletes — read only' },
      { type: 'live', description: 'Detection accuracy on staging data' },
    ],
    feature_flag: 'atlas_core_data_quality_enabled',
    fallback_behavior: 'Return count of records with null required fields',
    public_claim_status: 'core_public',
  },
  {
    agent_id: 'core.policy_guard',
    name: 'Policy Guard Agent',
    layer: 1,
    squad: 'Core',
    mission: 'Enforce business rules and policy compliance across all agent actions.',
    business_function: 'The last line of defense — ensures no agent produces harmful, unethical, or non-compliant output.',
    trigger_events: ['agent.output_ready', 'action.proposed', 'workflow.step_complete'],
    input_schema: {
      required: ['agent_id', 'action_data', 'business_id'],
      optional: ['policy_override_reason'],
    },
    tools_required: ['tool.policy_rule_engine', 'tool.compliance_checker', 'tool.audit_logger'],
    output_schema: {
      type: 'policy_decision',
      fields: ['decision', 'rules_evaluated', 'rules_triggered', 'action_allowed', 'override_required', 'audit_ref'],
    },
    risk_level: 'medium',
    policy_rules: [
      { rule_id: 'PG001', condition: 'security_rule.triggered', action: 'deny' },
      { rule_id: 'PG002', condition: 'collections_ethics_rule.triggered', action: 'deny' },
    ],
    approval_required: false,
    audit_events: ['agent.policy_evaluated', 'agent.policy_violation_detected', 'agent.policy_override_requested'],
    success_metric: '100% of agent outputs pass through policy guard before action',
    cost_budget: { max_tokens_per_run: 300, max_cost_usd_per_run: 0.001, monthly_budget_usd: 5.0 },
    harness_scenarios: [
      { type: 'static', description: 'Schema completeness' },
      { type: 'dry_run', description: 'All policy rules fire on trigger conditions' },
      { type: 'red_team', description: 'No injection technique bypasses policy rules' },
      { type: 'red_team', description: 'Security rules cannot be overridden by tenant config' },
      { type: 'live', description: 'Policy audit trail verified end-to-end' },
    ],
    feature_flag: 'atlas_core_policy_guard_enabled',
    fallback_behavior: 'Block all actions with POLICY_UNAVAILABLE error — fail safe, never fail open',
    public_claim_status: 'core_public',
  },
  {
    agent_id: 'core.cost_router',
    name: 'Cost Router Agent',
    layer: 1,
    squad: 'Core',
    mission: 'Route agent executions to the optimal LLM and tools for cost efficiency.',
    business_function: 'Prevents unnecessary LLM spend by routing simple tasks to cheap models and complex tasks to capable ones.',
    trigger_events: ['agent.execution_requested', 'workflow.step_ready'],
    input_schema: {
      required: ['agent_id', 'task_complexity_score', 'risk_level'],
      optional: ['token_budget_remaining', 'force_model'],
    },
    tools_required: ['tool.model_router', 'tool.cost_estimator', 'tool.cache_checker'],
    output_schema: {
      type: 'routing_decision',
      fields: ['selected_model', 'estimated_cost', 'cache_hit', 'use_llm', 'reasoning'],
    },
    risk_level: 'low',
    policy_rules: [
      { rule_id: 'CRO001', condition: "risk_level == 'critical'", action: 'allow' },
    ],
    approval_required: false,
    audit_events: ['agent.model_routed', 'agent.cache_hit', 'agent.llm_avoided'],
    success_metric: '30% or greater cost reduction versus always-Sonnet baseline',
    cost_budget: { max_tokens_per_run: 100, max_cost_usd_per_run: 0.0001, monthly_budget_usd: 1.0 },
    harness_scenarios: [
      { type: 'static', description: 'Schema completeness' },
      { type: 'dry_run', description: 'Simple tasks route to Haiku, critical tasks route to Opus' },
      { type: 'dry_run', description: 'Deterministic tasks bypass LLM entirely' },
      { type: 'live', description: 'Cost reduction verified in staging' },
    ],
    feature_flag: 'atlas_core_cost_router_enabled',
    fallback_behavior: 'Default to sonnet_default for all requests',
    public_claim_status: 'core_public',
  },
  {
    agent_id: 'core.learning',
    name: 'Learning Agent',
    layer: 1,
    squad: 'Core',
    mission: 'Learn from business outcomes to improve agent recommendations over time.',
    business_function: 'Makes Atlas smarter over time — recommendations improve as more outcomes are observed and patterns identified.',
    trigger_events: ['outcome.recorded', 'payment.received', 'promise.fulfilled', 'collection.successful'],
    input_schema: {
      required: ['business_id', 'outcome_event'],
      optional: ['agent_id', 'lookback_days', 'learning_rate'],
    },
    tools_required: ['tool.outcome_reader', 'tool.memory_writer', 'tool.pattern_extractor', 'tool.score_updater'],
    output_schema: {
      type: 'learning_update',
      fields: ['patterns_updated', 'scores_adjusted', 'memory_entries_created', 'confidence_delta', 'learning_summary'],
    },
    risk_level: 'low',
    policy_rules: [
      { rule_id: 'L001', condition: 'learning.would_corrupt_existing_memory', action: 'deny' },
      { rule_id: 'L002', condition: 'single_outcome_shift > 0.2', action: 'flag_for_review' },
    ],
    approval_required: false,
    audit_events: ['agent.learning_applied', 'agent.pattern_updated', 'agent.score_adjusted'],
    success_metric: 'Collection conversion rate improves 5% per month in first 3 months',
    cost_budget: { max_tokens_per_run: 1000, max_cost_usd_per_run: 0.002, monthly_budget_usd: 3.0 },
    harness_scenarios: [
      { type: 'static', description: 'Schema completeness' },
      { type: 'dry_run', description: 'Single outcome does not flip all predictions' },
      { type: 'dry_run', description: 'Failed learning does not corrupt existing memory' },
      { type: 'red_team', description: 'Adversarial learning injection blocked' },
      { type: 'live', description: 'Measurable improvement after 30-day learning period' },
    ],
    feature_flag: 'atlas_core_learning_enabled',
    fallback_behavior: 'Skip learning update, log for retry, do not corrupt existing patterns',
    public_claim_status: 'core_public',
  },
];

// ── Validation mode ───────────────────────────────────────────────────────────
if (VALIDATE_ONLY) {
  console.log('[seed-agent-registry] VALIDATE MODE — no DB writes');
  console.log(`\nExpected agents: ${CORE_AGENTS.length}`);
  let valid = true;
  const seenIds = new Set();

  for (const agent of CORE_AGENTS) {
    const issues = [];
    if (!agent.agent_id)              issues.push('missing agent_id');
    if (!agent.name)                  issues.push('missing name');
    if (!agent.layer)                 issues.push('missing layer');
    if (!agent.mission)               issues.push('missing mission');
    if (!agent.risk_level)            issues.push('missing risk_level');
    if (!['low','medium','high','critical'].includes(agent.risk_level))
                                      issues.push(`invalid risk_level: ${agent.risk_level}`);
    if (!agent.public_claim_status)   issues.push('missing public_claim_status');
    if (agent.public_claim_status !== 'core_public')
                                      issues.push(`expected core_public, got ${agent.public_claim_status}`);
    if (!agent.feature_flag)          issues.push('missing feature_flag');
    if (!agent.fallback_behavior)     issues.push('missing fallback_behavior');
    if (!Array.isArray(agent.tools_required) || agent.tools_required.length === 0)
                                      issues.push('missing tools_required');
    if (!Array.isArray(agent.policy_rules) || agent.policy_rules.length === 0)
                                      issues.push('missing policy_rules');
    if (!Array.isArray(agent.harness_scenarios) || agent.harness_scenarios.length === 0)
                                      issues.push('missing harness_scenarios');
    if (seenIds.has(agent.agent_id))  issues.push('duplicate agent_id');
    seenIds.add(agent.agent_id);

    if (issues.length > 0) {
      console.error(`  FAIL ${agent.agent_id}: ${issues.join(', ')}`);
      valid = false;
    } else {
      console.log(`  OK   ${agent.agent_id}`);
    }
  }

  console.log(`\nCount: ${CORE_AGENTS.length} agents`);
  console.log(`Unique IDs: ${seenIds.size}`);
  console.log(`Validation: ${valid ? 'PASS' : 'FAIL'}`);

  if (!valid) process.exit(1);
  process.exit(0);
}

// ── Seed to database ──────────────────────────────────────────────────────────
async function run() {
  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    console.log('[seed-agent-registry] Connected to staging Postgres.');

    // Verify agent_registry table exists
    const tableCheck = await client.query(`
      SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'agent_registry'
    `);
    if (parseInt(tableCheck.rows[0].n, 10) === 0) {
      console.error('[seed-agent-registry] ERROR: agent_registry table does not exist.');
      console.error('  Run migration 007 first: npm run staging:migrate');
      process.exit(1);
    }

    console.log(`\n[seed-agent-registry] Seeding ${CORE_AGENTS.length} core agents...`);

    let upserted = 0;
    for (const agent of CORE_AGENTS) {
      await client.query(`
        INSERT INTO agent_registry (
          agent_id, name, layer, squad, mission, business_function,
          trigger_events, input_schema, tools_required, output_schema,
          risk_level, policy_rules, approval_required, audit_events,
          success_metric, cost_budget, harness_scenarios,
          feature_flag, status, fallback_behavior, public_claim_status, is_active
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10,
          $11, $12, $13, $14,
          $15, $16, $17,
          $18, 'registry', $19, $20, FALSE
        )
        ON CONFLICT (agent_id) DO UPDATE SET
          name                = EXCLUDED.name,
          layer               = EXCLUDED.layer,
          squad               = EXCLUDED.squad,
          mission             = EXCLUDED.mission,
          business_function   = EXCLUDED.business_function,
          trigger_events      = EXCLUDED.trigger_events,
          input_schema        = EXCLUDED.input_schema,
          tools_required      = EXCLUDED.tools_required,
          output_schema       = EXCLUDED.output_schema,
          risk_level          = EXCLUDED.risk_level,
          policy_rules        = EXCLUDED.policy_rules,
          approval_required   = EXCLUDED.approval_required,
          audit_events        = EXCLUDED.audit_events,
          success_metric      = EXCLUDED.success_metric,
          cost_budget         = EXCLUDED.cost_budget,
          harness_scenarios   = EXCLUDED.harness_scenarios,
          feature_flag        = EXCLUDED.feature_flag,
          fallback_behavior   = EXCLUDED.fallback_behavior,
          public_claim_status = EXCLUDED.public_claim_status
          -- NOTE: is_active and status are NOT updated on conflict
          --   to preserve any manual activation done after initial seed
      `, [
        agent.agent_id, agent.name, agent.layer, agent.squad,
        agent.mission, agent.business_function,
        JSON.stringify(agent.trigger_events),
        JSON.stringify(agent.input_schema),
        JSON.stringify(agent.tools_required),
        JSON.stringify(agent.output_schema),
        agent.risk_level,
        JSON.stringify(agent.policy_rules),
        agent.approval_required,
        JSON.stringify(agent.audit_events),
        agent.success_metric,
        JSON.stringify(agent.cost_budget),
        JSON.stringify(agent.harness_scenarios),
        agent.feature_flag,
        agent.fallback_behavior,
        agent.public_claim_status,
      ]);
      console.log(`  upserted: ${agent.agent_id}`);
      upserted++;
    }

    // Verify final state
    const countResult = await client.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN is_active THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN public_claim_status = 'core_public' THEN 1 ELSE 0 END) AS core_public
       FROM agent_registry WHERE status = 'registry'`
    );
    const stats = countResult.rows[0];

    console.log(`\n[seed-agent-registry] Done.`);
    console.log(`  Upserted:    ${upserted} agents`);
    console.log(`  Total rows:  ${stats.total}`);
    console.log(`  Active:      ${stats.active} (expected: 0)`);
    console.log(`  core_public: ${stats.core_public} (expected: ${CORE_AGENTS.length})`);

    if (parseInt(stats.active, 10) > 0) {
      console.warn('[seed-agent-registry] WARNING: some agents are is_active=true — verify this is intentional');
    }

  } catch (err) {
    console.error('[seed-agent-registry] ERROR:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
