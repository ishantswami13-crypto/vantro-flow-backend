# Atlas Agent Mesh 216 — Complete Agent Taxonomy

> **INTERNAL DOCUMENT** — Not for public release
> **Version:** 2.0 | **Date:** 2026-06-01 | **Status:** Registry Design (Phase 0)
> **Public claim:** "12 core specialized agents with an expandable Agent Mesh architecture"
> **216 agents** = complete planned architecture, proof-gated per rollout-plan-216.md

---

## Layer Summary

| Layer | Name | Count | Public Status |
|-------|------|-------|--------------|
| 1 | Public Core Agents | 12 | core_public |
| 2 | Business Domain Agents | 72 | future_public |
| 3 | Cortex / Automation / Data Agents | 48 | hidden |
| 4 | Security / Compliance / Harness Agents | 36 | hidden |
| 5 | Infrastructure / Reliability / Cost Agents | 24 | hidden |
| 6 | GTM / Support / Admin / Enterprise Agents | 24 | hidden |
| **Total** | **Atlas Agent Mesh 216** | **216** | — |

---

# LAYER 1 — 12 PUBLIC CORE AGENTS

```yaml
agent_id: core.collections
name: Collections Agent
layer: 1
squad: Core
mission: "Identify and prioritize overdue receivables for collection action."
business_function: "Tells the owner who owes money, how much, how overdue, and what to do next."
trigger_events: [invoice.overdue, daily.collections_run, owner.request]
input_schema:
  required: [business_id, date]
  optional: [customer_filter, min_amount, exclude_disputed]
tools_required: [tool.invoice_reader, tool.customer_history_reader, tool.collections_scorer]
output_schema:
  type: collection_recommendations
  fields: [priority_rank, customer_id, amount, days_overdue, recommended_action, reasoning]
risk_level: high
policy_rules:
  - {rule_id: C001, condition: "invoice.status == 'disputed'", action: deny}
  - {rule_id: C002, condition: "customer.has_active_grievance", action: flag_for_review}
approval_required: false
approval_type: none
audit_events: [agent.collections_run, agent.customer_ranked]
success_metric: {name: "Collection conversion", target: "Top-3 list results in payment 60% within 7 days"}
cost_budget: {max_tokens_per_run: 2000, max_cost_usd_per_run: 0.003, monthly_budget_usd: 5.00}
sla_target_ms: 3000
harness_scenarios:
  - {type: static, description: "Schema completeness check"}
  - {type: dry_run, description: "Run with 10 synthetic overdue invoices"}
  - {type: red_team, description: "Inject disputed invoice — verify blocked"}
  - {type: live, description: "Staging end-to-end validation"}
feature_flag: atlas_core_collections_enabled
status: planned
fallback_behavior: "Return static list sorted by amount descending"
public_claim_status: core_public
react_dashboard_section: workflow_console
react_permissions_scope: [collections.read, customers.read]
react_visualization_type: table
react_action_panel: [view_customer, start_collection, export_list]
rust_execution_engine: cortex_core
parallel_execution_allowed: true
queue_execution_supported: true
cache_strategy: {enabled: true, ttl_seconds: 300}
memory_retrieval_required: true
llm_routing_policy: haiku_first
tool_execution_mode: parallel
cost_engine_tracking: true
harness_x_required: true
```

```yaml
agent_id: core.promise_tracker
name: Promise Tracker Agent
layer: 1
squad: Core
mission: "Track customer payment promises and detect broken commitments."
business_function: "Surfaces customers who said they would pay but haven't — the most actionable collection signal."
trigger_events: [payment.due, promise.due_date_passed, daily.promise_check]
input_schema:
  required: [business_id]
  optional: [date_range, customer_id]
tools_required: [tool.promise_reader, tool.payment_checker, tool.customer_history_reader]
output_schema:
  type: promise_status_report
  fields: [customer_id, promise_date, promised_amount, status, days_broken, action_recommended]
risk_level: medium
policy_rules:
  - {rule_id: PT001, condition: "promise.status == 'fulfilled'", action: allow}
  - {rule_id: PT002, condition: "promise.days_broken > 30", action: flag_for_review}
approval_required: false
approval_type: none
audit_events: [agent.promise_checked, agent.broken_promise_detected]
success_metric: {name: "Promise detection accuracy", target: "<5% false positive broken promises"}
cost_budget: {max_tokens_per_run: 500, max_cost_usd_per_run: 0.001, monthly_budget_usd: 2.00}
sla_target_ms: 2000
harness_scenarios:
  - {type: static, description: "Schema completeness"}
  - {type: dry_run, description: "Verify fulfilled promises not flagged as broken"}
  - {type: live, description: "Staging accuracy test"}
feature_flag: atlas_core_promise_tracker_enabled
status: planned
fallback_behavior: "Return all overdue invoices with promised_payment_date in past"
public_claim_status: core_public
react_dashboard_section: workflow_console
react_permissions_scope: [collections.read, customers.read]
react_visualization_type: table
react_action_panel: [view_promise, mark_resolved, escalate]
rust_execution_engine: cortex_core
parallel_execution_allowed: true
queue_execution_supported: true
cache_strategy: {enabled: true, ttl_seconds: 300}
memory_retrieval_required: true
llm_routing_policy: no_llm
tool_execution_mode: sequential
cost_engine_tracking: true
harness_x_required: false
```

```yaml
agent_id: core.credit_risk
name: Credit Risk Agent
layer: 1
squad: Core
mission: "Assess credit exposure risk per customer and recommend credit limit actions."
business_function: "Prevents businesses from extending credit to high-risk customers, protecting cash flow."
trigger_events: [sale.created, credit_limit.review_due, daily.risk_run]
input_schema:
  required: [business_id, customer_id]
  optional: [include_all_customers, risk_threshold]
tools_required: [tool.customer_history_reader, tool.payment_behavior_scorer, tool.invoice_reader, tool.risk_calculator]
output_schema:
  type: credit_risk_assessment
  fields: [customer_id, risk_score, risk_level, credit_limit_current, credit_limit_recommended, reasoning, flags]
risk_level: high
policy_rules:
  - {rule_id: CR001, condition: "output.contains_discriminatory_pattern", action: deny}
  - {rule_id: CR002, condition: "output.financial_figure_unverified", action: deny}
  - {rule_id: CR003, condition: "risk_score > 80", action: flag_for_review}
approval_required: false
approval_type: none
audit_events: [agent.credit_risk_assessed, agent.risk_flag_raised]
success_metric: {name: "Predictive accuracy", target: "High-risk customers default 3x more than low-risk within 90 days"}
cost_budget: {max_tokens_per_run: 1500, max_cost_usd_per_run: 0.002, monthly_budget_usd: 4.00}
sla_target_ms: 3000
harness_scenarios:
  - {type: static, description: "Schema completeness"}
  - {type: dry_run, description: "Risk score range 0-100 verified"}
  - {type: red_team, description: "No discriminatory patterns in scoring model"}
  - {type: red_team, description: "No hallucinated credit limits"}
  - {type: live, description: "Score accuracy vs actual payment outcomes"}
feature_flag: atlas_core_credit_risk_enabled
status: planned
fallback_behavior: "Return payment_delay_days as proxy risk score"
public_claim_status: core_public
react_dashboard_section: workflow_console
react_permissions_scope: [credit.read, customers.read]
react_visualization_type: gauge
react_action_panel: [view_history, suggest_credit_hold, export_risk_report]
rust_execution_engine: cortex_core
parallel_execution_allowed: true
queue_execution_supported: true
cache_strategy: {enabled: true, ttl_seconds: 600}
memory_retrieval_required: true
llm_routing_policy: sonnet_default
tool_execution_mode: parallel
cost_engine_tracking: true
harness_x_required: true
```

```yaml
agent_id: core.cashflow
name: Cashflow Agent
layer: 1
squad: Core
mission: "Monitor and forecast business cashflow position in real time."
business_function: "Answers the most important question for any business owner: will I have enough cash this week and next month?"
trigger_events: [payment.received, invoice.created, daily.cashflow_run, owner.request]
input_schema:
  required: [business_id]
  optional: [forecast_days, include_pending, confidence_threshold]
tools_required: [tool.invoice_reader, tool.payment_reader, tool.cashflow_calculator]
output_schema:
  type: cashflow_report
  fields: [current_balance, expected_inflows_7d, expected_outflows_7d, net_position_7d, forecast_30d, confidence_score, cash_gap_risk]
risk_level: medium
policy_rules:
  - {rule_id: CF001, condition: "output.unverified_financial_figure", action: deny}
  - {rule_id: CF002, condition: "forecast.confidence_score < 0.6", action: add_disclaimer}
approval_required: false
approval_type: none
audit_events: [agent.cashflow_calculated, agent.cash_gap_detected]
success_metric: {name: "Forecast accuracy", target: "7-day forecast within 20% of actual"}
cost_budget: {max_tokens_per_run: 1000, max_cost_usd_per_run: 0.001, monthly_budget_usd: 3.00}
sla_target_ms: 2000
harness_scenarios:
  - {type: static, description: "Schema completeness"}
  - {type: dry_run, description: "Math accuracy: inflows - outflows = net position"}
  - {type: dry_run, description: "Low confidence forecast gets disclaimer"}
  - {type: live, description: "Accuracy vs 7-day actuals in staging"}
feature_flag: atlas_core_cashflow_enabled
status: planned
fallback_behavior: "Return sum of overdue receivables as expected inflows"
public_claim_status: core_public
react_dashboard_section: workflow_console
react_permissions_scope: [finance.read]
react_visualization_type: chart
react_action_panel: [view_detail, export_forecast, set_alert]
rust_execution_engine: cortex_core
parallel_execution_allowed: true
queue_execution_supported: false
cache_strategy: {enabled: true, ttl_seconds: 300}
memory_retrieval_required: false
llm_routing_policy: no_llm
tool_execution_mode: sequential
cost_engine_tracking: true
harness_x_required: false
```

```yaml
agent_id: core.inventory_cash
name: Inventory-Cash Agent
layer: 1
squad: Core
mission: "Analyze inventory-to-cash conversion efficiency and flag reorder decisions."
business_function: "Prevents cash being locked in slow-moving inventory while flagging stockout risks."
trigger_events: [stock.updated, daily.inventory_run, sale.created]
input_schema:
  required: [business_id]
  optional: [sku_filter, low_stock_threshold, dead_stock_days]
tools_required: [tool.inventory_reader, tool.sales_reader, tool.cash_calculator]
output_schema:
  type: inventory_cash_report
  fields: [locked_cash_in_inventory, slow_moving_skus, dead_stock_value, reorder_alerts, stockout_risk_items]
risk_level: medium
policy_rules:
  - {rule_id: IC001, condition: "output.negative_stock_value", action: deny}
approval_required: false
approval_type: none
audit_events: [agent.inventory_analyzed, agent.reorder_alert_raised]
success_metric: {name: "Reorder accuracy", target: "Reorder alerts prevent stockout 80% of time when acted on"}
cost_budget: {max_tokens_per_run: 800, max_cost_usd_per_run: 0.001, monthly_budget_usd: 2.00}
sla_target_ms: 2000
harness_scenarios:
  - {type: static, description: "Schema completeness"}
  - {type: dry_run, description: "No negative stock scenarios"}
  - {type: live, description: "Staging accuracy with real inventory data"}
feature_flag: atlas_core_inventory_cash_enabled
status: planned
fallback_behavior: "Return items with quantity < safety_stock as reorder alerts"
public_claim_status: core_public
react_dashboard_section: workflow_console
react_permissions_scope: [inventory.read]
react_visualization_type: table
react_action_panel: [view_sku, create_reorder, export_report]
rust_execution_engine: cortex_core
parallel_execution_allowed: true
queue_execution_supported: true
cache_strategy: {enabled: true, ttl_seconds: 600}
memory_retrieval_required: false
llm_routing_policy: no_llm
tool_execution_mode: parallel
cost_engine_tracking: true
harness_x_required: false
```

```yaml
agent_id: core.payables
name: Payables Agent
layer: 1
squad: Core
mission: "Optimize supplier payment timing and prioritization given cash constraints."
business_function: "Tells the owner which supplier to pay first when cash is tight, protecting critical relationships."
trigger_events: [payment.due, cashflow.tight_alert, daily.payables_run]
input_schema:
  required: [business_id]
  optional: [cash_available, priority_override, exclude_suppliers]
tools_required: [tool.payables_reader, tool.supplier_reader, tool.cash_calculator, tool.payment_priority_scorer]
output_schema:
  type: payment_priority_list
  fields: [priority_rank, supplier_id, amount_due, due_date, relationship_risk, recommended_action, reasoning]
risk_level: high
policy_rules:
  - {rule_id: PA001, condition: "proposed_action.type == 'execute_payment'", action: deny}
  - {rule_id: PA002, condition: "cash_available < total_due * 0.5", action: flag_for_review}
approval_required: false
approval_type: none
audit_events: [agent.payables_prioritized, agent.cash_constraint_flagged]
success_metric: {name: "Priority quality", target: "Top-3 priorities defensible to finance reviewer 90% of time"}
cost_budget: {max_tokens_per_run: 1200, max_cost_usd_per_run: 0.002, monthly_budget_usd: 3.00}
sla_target_ms: 3000
harness_scenarios:
  - {type: static, description: "Schema completeness"}
  - {type: dry_run, description: "Agent cannot trigger payment execution"}
  - {type: red_team, description: "Cash constraint injection — agent uses real cash, not hallucinated"}
  - {type: live, description: "Priority quality reviewed by finance expert"}
feature_flag: atlas_core_payables_enabled
status: planned
fallback_behavior: "Return payables sorted by due_date ascending"
public_claim_status: core_public
react_dashboard_section: workflow_console
react_permissions_scope: [payables.read, suppliers.read]
react_visualization_type: table
react_action_panel: [view_supplier, mark_paid, export_schedule]
rust_execution_engine: cortex_core
parallel_execution_allowed: true
queue_execution_supported: true
cache_strategy: {enabled: true, ttl_seconds: 300}
memory_retrieval_required: true
llm_routing_policy: haiku_first
tool_execution_mode: parallel
cost_engine_tracking: true
harness_x_required: true
```

```yaml
agent_id: core.dispute
name: Dispute Agent
layer: 1
squad: Core
mission: "Classify and route customer disputes to the appropriate resolution workflow."
business_function: "Prevents collection actions on disputed invoices while ensuring disputes are resolved quickly."
trigger_events: [dispute.raised, invoice.flagged_disputed, customer.complaint]
input_schema:
  required: [business_id, dispute_data]
  optional: [auto_halt_collection]
tools_required: [tool.dispute_reader, tool.invoice_reader, tool.collection_halter]
output_schema:
  type: dispute_classification
  fields: [dispute_id, category, severity, recommended_action, collection_halt_required, resolution_owner]
risk_level: medium
policy_rules:
  - {rule_id: D001, condition: "dispute.active == true", action: require_approval}
  - {rule_id: D002, condition: "dispute.severity == 'legal'", action: flag_for_review}
approval_required: false
approval_type: none
audit_events: [agent.dispute_classified, agent.collection_halted]
success_metric: {name: "Classification accuracy", target: "Correct category 85% of time, verified by resolution outcome"}
cost_budget: {max_tokens_per_run: 800, max_cost_usd_per_run: 0.001, monthly_budget_usd: 2.00}
sla_target_ms: 2000
harness_scenarios:
  - {type: static, description: "Schema completeness"}
  - {type: dry_run, description: "Disputed invoice halts collection"}
  - {type: red_team, description: "Misclassification edge cases don't block valid collections"}
  - {type: live, description: "End-to-end dispute routing in staging"}
feature_flag: atlas_core_dispute_enabled
status: planned
fallback_behavior: "Flag invoice as disputed, halt all collection actions on it"
public_claim_status: core_public
react_dashboard_section: workflow_console
react_permissions_scope: [disputes.read, invoices.read]
react_visualization_type: table
react_action_panel: [view_dispute, resolve, escalate_to_legal]
rust_execution_engine: cortex_core
parallel_execution_allowed: true
queue_execution_supported: false
cache_strategy: {enabled: false, ttl_seconds: 0}
memory_retrieval_required: false
llm_routing_policy: sonnet_default
tool_execution_mode: sequential
cost_engine_tracking: true
harness_x_required: false
```

```yaml
agent_id: core.owner_briefing
name: Owner Briefing Agent
layer: 1
squad: Core
mission: "Synthesize daily business intelligence into an owner-ready briefing."
business_function: "Gives the owner everything they need to know in 2 minutes — no data digging required."
trigger_events: [daily.briefing_run, owner.request, significant.event]
input_schema:
  required: [business_id, date]
  optional: [briefing_style, max_items, include_sections]
tools_required: [tool.collections_reader, tool.cashflow_reader, tool.inventory_reader, tool.briefing_composer]
output_schema:
  type: owner_briefing
  fields: [priority_actions, cash_position, collections_summary, top_risks, wins_today, recommended_next_steps]
risk_level: low
policy_rules:
  - {rule_id: OB001, condition: "output.unverified_data_point", action: deny}
  - {rule_id: OB002, condition: "briefing.length > 500_words", action: flag_for_review}
approval_required: false
approval_type: none
audit_events: [agent.briefing_generated]
success_metric: {name: "Owner engagement", target: "Briefing opened and acted on same day 70% of time"}
cost_budget: {max_tokens_per_run: 3000, max_cost_usd_per_run: 0.004, monthly_budget_usd: 6.00}
sla_target_ms: 5000
harness_scenarios:
  - {type: static, description: "Schema completeness"}
  - {type: dry_run, description: "All briefing sections present"}
  - {type: dry_run, description: "No invented data — all figures traceable"}
  - {type: live, description: "Quality review by product team"}
feature_flag: atlas_core_owner_briefing_enabled
status: planned
fallback_behavior: "Return static summary: overdue count, cash position, top 3 actions"
public_claim_status: core_public
react_dashboard_section: agent_registry
react_permissions_scope: [owner.read]
react_visualization_type: card
react_action_panel: [view_full_briefing, share, export_pdf]
rust_execution_engine: direct
parallel_execution_allowed: false
queue_execution_supported: true
cache_strategy: {enabled: true, ttl_seconds: 3600}
memory_retrieval_required: true
llm_routing_policy: sonnet_default
tool_execution_mode: parallel
cost_engine_tracking: true
harness_x_required: false
```

```yaml
agent_id: core.data_quality
name: Data Quality Agent
layer: 1
squad: Core
mission: "Detect and flag data quality issues across business records."
business_function: "Prevents bad data from corrupting agent recommendations — garbage in, garbage out prevention."
trigger_events: [data.import, daily.quality_run, record.updated]
input_schema:
  required: [business_id]
  optional: [scope, severity_threshold, auto_flag]
tools_required: [tool.data_scanner, tool.record_reader, tool.quality_scorer]
output_schema:
  type: data_quality_report
  fields: [issue_count, issues_by_type, affected_records, severity_distribution, recommended_fixes]
risk_level: low
policy_rules:
  - {rule_id: DQ001, condition: "action.type == 'delete_record'", action: deny}
  - {rule_id: DQ002, condition: "issue.severity == 'critical'", action: flag_for_review}
approval_required: false
approval_type: none
audit_events: [agent.quality_scan_run, agent.quality_issue_flagged]
success_metric: {name: "Detection rate", target: "Catches >80% of data issues, <10% false positives"}
cost_budget: {max_tokens_per_run: 500, max_cost_usd_per_run: 0.001, monthly_budget_usd: 2.00}
sla_target_ms: 5000
harness_scenarios:
  - {type: static, description: "Schema completeness"}
  - {type: dry_run, description: "Agent flags not deletes — read only"}
  - {type: live, description: "Detection accuracy on staging data"}
feature_flag: atlas_core_data_quality_enabled
status: planned
fallback_behavior: "Return count of records with null required fields"
public_claim_status: core_public
react_dashboard_section: agent_registry
react_permissions_scope: [data.read]
react_visualization_type: chart
react_action_panel: [view_issues, export_report, dismiss_issue]
rust_execution_engine: direct
parallel_execution_allowed: true
queue_execution_supported: true
cache_strategy: {enabled: false, ttl_seconds: 0}
memory_retrieval_required: false
llm_routing_policy: no_llm
tool_execution_mode: parallel
cost_engine_tracking: true
harness_x_required: false
```

```yaml
agent_id: core.policy_guard
name: Policy Guard Agent
layer: 1
squad: Core
mission: "Enforce business rules and policy compliance across all agent actions."
business_function: "The last line of defense — ensures no agent produces harmful, unethical, or non-compliant output."
trigger_events: [agent.output_ready, action.proposed, workflow.step_complete]
input_schema:
  required: [agent_id, action_data, business_id]
  optional: [policy_override_reason]
tools_required: [tool.policy_rule_engine, tool.compliance_checker, tool.audit_logger]
output_schema:
  type: policy_decision
  fields: [decision, rules_evaluated, rules_triggered, action_allowed, override_required, audit_ref]
risk_level: medium
policy_rules:
  - {rule_id: PG001, condition: "security_rule.triggered", action: deny}
  - {rule_id: PG002, condition: "collections_ethics_rule.triggered", action: deny}
approval_required: false
approval_type: none
audit_events: [agent.policy_evaluated, agent.policy_violation_detected, agent.policy_override_requested]
success_metric: {name: "Coverage completeness", target: "100% of agent outputs pass through policy guard"}
cost_budget: {max_tokens_per_run: 300, max_cost_usd_per_run: 0.001, monthly_budget_usd: 5.00}
sla_target_ms: 500
harness_scenarios:
  - {type: static, description: "Schema completeness"}
  - {type: dry_run, description: "All policy rules fire on trigger conditions"}
  - {type: red_team, description: "No injection technique bypasses policy rules"}
  - {type: red_team, description: "Security rules cannot be overridden by tenant config"}
  - {type: live, description: "Policy audit trail verified end-to-end"}
feature_flag: atlas_core_policy_guard_enabled
status: planned
fallback_behavior: "Block all actions with POLICY_UNAVAILABLE error — fail safe"
public_claim_status: core_public
react_dashboard_section: governance_dashboard
react_permissions_scope: [admin.read, policy.read]
react_visualization_type: table
react_action_panel: [view_rules, view_violations, export_audit]
rust_execution_engine: cortex_core
parallel_execution_allowed: false
queue_execution_supported: false
cache_strategy: {enabled: false, ttl_seconds: 0}
memory_retrieval_required: false
llm_routing_policy: no_llm
tool_execution_mode: sequential
cost_engine_tracking: true
harness_x_required: true
```

```yaml
agent_id: core.cost_router
name: Cost Router Agent
layer: 1
squad: Core
mission: "Route agent executions to the optimal LLM and tools for cost efficiency."
business_function: "Prevents unnecessary LLM spend by routing simple tasks to cheap models and complex tasks to capable ones."
trigger_events: [agent.execution_requested, workflow.step_ready]
input_schema:
  required: [agent_id, task_complexity_score, risk_level]
  optional: [token_budget_remaining, force_model]
tools_required: [tool.model_router, tool.cost_estimator, tool.cache_checker]
output_schema:
  type: routing_decision
  fields: [selected_model, estimated_cost, cache_hit, use_llm, reasoning]
risk_level: low
policy_rules:
  - {rule_id: CR001, condition: "risk_level == 'critical'", action: allow}
  - {rule_id: CR002, condition: "task_complexity < 30", action: allow}
approval_required: false
approval_type: none
audit_events: [agent.model_routed, agent.cache_hit, agent.llm_avoided]
success_metric: {name: "Cost reduction", target: "≥30% cost reduction vs always-Sonnet baseline"}
cost_budget: {max_tokens_per_run: 100, max_cost_usd_per_run: 0.0001, monthly_budget_usd: 1.00}
sla_target_ms: 100
harness_scenarios:
  - {type: static, description: "Schema completeness"}
  - {type: dry_run, description: "Simple tasks route to Haiku"}
  - {type: dry_run, description: "Critical tasks route to Opus"}
  - {type: dry_run, description: "Deterministic tasks bypass LLM"}
  - {type: live, description: "Cost reduction verified in staging"}
feature_flag: atlas_core_cost_router_enabled
status: planned
fallback_behavior: "Default to sonnet_default for all requests"
public_claim_status: core_public
react_dashboard_section: cost_intelligence
react_permissions_scope: [admin.read]
react_visualization_type: chart
react_action_panel: [view_routing_log, set_budget, export_cost_report]
rust_execution_engine: cortex_core
parallel_execution_allowed: true
queue_execution_supported: false
cache_strategy: {enabled: true, ttl_seconds: 60}
memory_retrieval_required: false
llm_routing_policy: no_llm
tool_execution_mode: sequential
cost_engine_tracking: true
harness_x_required: false
```

```yaml
agent_id: core.learning
name: Learning Agent
layer: 1
squad: Core
mission: "Learn from business outcomes to improve agent recommendations over time."
business_function: "Makes Atlas smarter over time — agents recommendations improve as more outcomes are observed."
trigger_events: [outcome.recorded, payment.received, promise.fulfilled, collection.successful]
input_schema:
  required: [business_id, outcome_event]
  optional: [agent_id, lookback_days, learning_rate]
tools_required: [tool.outcome_reader, tool.memory_writer, tool.pattern_extractor, tool.score_updater]
output_schema:
  type: learning_update
  fields: [patterns_updated, scores_adjusted, memory_entries_created, confidence_delta, learning_summary]
risk_level: low
policy_rules:
  - {rule_id: L001, condition: "learning.would_corrupt_existing_memory", action: deny}
  - {rule_id: L002, condition: "single_outcome_shift > 0.2", action: flag_for_review}
approval_required: false
approval_type: none
audit_events: [agent.learning_applied, agent.pattern_updated, agent.score_adjusted]
success_metric: {name: "Recommendation improvement", target: "Collection conversion rate improves 5%/month in first 3 months"}
cost_budget: {max_tokens_per_run: 1000, max_cost_usd_per_run: 0.002, monthly_budget_usd: 3.00}
sla_target_ms: 10000
harness_scenarios:
  - {type: static, description: "Schema completeness"}
  - {type: dry_run, description: "Single outcome doesn't flip all predictions"}
  - {type: dry_run, description: "Failed learning doesn't corrupt existing memory"}
  - {type: red_team, description: "Adversarial learning injection blocked"}
  - {type: live, description: "Measurable improvement after 30-day learning period"}
feature_flag: atlas_core_learning_enabled
status: planned
fallback_behavior: "Skip learning update, log for retry"
public_claim_status: core_public
react_dashboard_section: memory_explorer
react_permissions_scope: [admin.read]
react_visualization_type: chart
react_action_panel: [view_patterns, view_memory, reset_learning]
rust_execution_engine: queue
parallel_execution_allowed: false
queue_execution_supported: true
cache_strategy: {enabled: false, ttl_seconds: 0}
memory_retrieval_required: true
llm_routing_policy: haiku_first
tool_execution_mode: sequential
cost_engine_tracking: true
harness_x_required: false
```

---

# LAYER 2 — 72 BUSINESS DOMAIN AGENTS

## Squad A: CashOps / Collections (16 agents)

| agent_id | name | risk | approval | llm_policy | status | public |
|----------|------|------|----------|-----------|--------|--------|
| cashops.collections_priority | Collections Priority Agent | medium | none | haiku_first | planned | future_public |
| cashops.broken_promise | Broken Promise Agent | medium | none | no_llm | planned | future_public |
| cashops.followup_timing | Follow-up Timing Agent | low | none | no_llm | planned | future_public |
| cashops.tone_strategy | Tone Strategy Agent | high | none | sonnet_default | planned | future_public |
| cashops.partial_payment | Partial Payment Agent | medium | none | haiku_first | planned | future_public |
| cashops.owner_escalation | Owner Escalation Agent | high | owner | sonnet_default | planned | future_public |
| cashops.credit_hold | Credit Hold Agent | critical | owner | opus_critical | planned | future_public |
| cashops.dispute_aware_collection | Dispute-Aware Collection Agent | medium | none | haiku_first | planned | future_public |
| cashops.month_end_pattern | Month-End Pattern Agent | low | none | no_llm | planned | future_public |
| cashops.silence_recovery | Silence Recovery Agent | medium | none | sonnet_default | planned | future_public |
| cashops.recovery_probability | Recovery Probability Agent | medium | none | haiku_first | planned | future_public |
| cashops.aging_bucket | Aging Bucket Agent | low | none | no_llm | planned | future_public |
| cashops.overdue_exposure | Overdue Exposure Agent | medium | none | no_llm | planned | future_public |
| cashops.commitment_confirmation | Commitment Confirmation Agent | medium | none | haiku_first | planned | future_public |
| cashops.pressure_sensitivity | Customer Pressure Sensitivity Agent | medium | none | sonnet_default | planned | future_public |
| cashops.recovery_outcome | Recovery Outcome Agent | low | none | no_llm | planned | future_public |

### CashOps Agent Details

```yaml
agent_id: cashops.collections_priority
mission: "Rank all overdue customers by collection urgency using behavior, amount, and risk."
business_function: "Tells the owner exactly which customer to call first and why."
trigger_events: [daily.collections_run, invoice.overdue, owner.request]
input_schema: {required: [business_id, overdue_invoices], optional: [date, max_results]}
tools_required: [tool.collections_scorer, tool.customer_history_reader, tool.invoice_reader]
output_schema: {type: priority_list, fields: [rank, customer_id, amount, days_overdue, score, action]}
policy_rules: [{rule_id: CP001, condition: "invoice.disputed", action: deny}]
audit_events: [agent.priority_list_generated]
success_metric: {name: "Top-3 conversion", target: "Top-3 results in payment 60% within 7 days"}
cost_budget: {max_tokens_per_run: 2000, max_cost_usd_per_run: 0.003, monthly_budget_usd: 5.00}
harness_scenarios: [{type: static}, {type: dry_run, description: "Disputed invoices excluded"}, {type: red_team, description: "Grievance customer injection"}]
feature_flag: atlas_cashops_collections_priority_enabled
fallback_behavior: "Sort overdue by amount descending"

agent_id: cashops.broken_promise
mission: "Detect customers who have broken payment promises and surface them for immediate action."
trigger_events: [promise.due_date_passed, daily.promise_check]
tools_required: [tool.promise_reader, tool.payment_checker]
policy_rules: [{rule_id: BP001, condition: "promise.fulfilled", action: deny}]
audit_events: [agent.broken_promise_detected]
cost_budget: {max_tokens_per_run: 300, max_cost_usd_per_run: 0.0005, monthly_budget_usd: 1.00}

agent_id: cashops.tone_strategy
mission: "Select the optimal communication tone and draft a collection message for review."
trigger_events: [collection.message_requested, workflow.tone_selection_needed]
tools_required: [tool.customer_history_reader, tool.tone_engine, tool.message_drafter]
policy_rules:
  - {rule_id: TS001, condition: "tone == 'threatening'", action: deny}
  - {rule_id: TS002, condition: "send_time NOT IN business_hours", action: deny}
  - {rule_id: TS003, condition: "contact_attempts_7d >= 3", action: require_approval}
audit_events: [agent.tone_selected, agent.message_drafted]
harness_scenarios: [{type: red_team, description: "Aggressive context injection — verify blocking"}]
cost_budget: {max_tokens_per_run: 1500, max_cost_usd_per_run: 0.003, monthly_budget_usd: 8.00}

agent_id: cashops.credit_hold
mission: "Propose placing a customer on credit hold based on risk and overdue exposure."
trigger_events: [credit_risk.critical_threshold, owner.credit_hold_request]
tools_required: [tool.credit_checker, tool.risk_calculator, tool.approval_requester]
policy_rules:
  - {rule_id: CH001, condition: "action.type == 'execute_credit_hold'", action: require_approval}
  - {rule_id: CH002, condition: "hold_amount > 100000", action: require_approval}
approval_required: true
approval_type: owner
audit_events: [agent.credit_hold_proposed, approval.requested, approval.decided, agent.credit_hold_executed]
harness_scenarios: [{type: red_team, description: "Direct execution bypass attempt"}, {type: live, description: "Approval workflow end-to-end"}]
cost_budget: {max_tokens_per_run: 500, max_cost_usd_per_run: 0.001, monthly_budget_usd: 2.00}
harness_x_required: true
```

## Squad B: Sales / Revenue (10 agents)

| agent_id | name | risk | llm_policy | mission |
|----------|------|------|-----------|---------|
| sales.entry_validation | Sales Entry Validation Agent | low | no_llm | Validate sales entries for completeness and accuracy before processing |
| sales.revenue_trend | Revenue Trend Agent | low | no_llm | Identify revenue growth or decline trends over configurable periods |
| sales.customer_value | Customer Value Agent | medium | haiku_first | Score customers by lifetime value and strategic importance |
| sales.upsell_signal | Upsell Signal Agent | medium | sonnet_default | Detect customers ready for larger orders or new product categories |
| sales.discount_risk | Discount Risk Agent | medium | haiku_first | Flag excessive discounting patterns that erode margins |
| sales.forecast | Sales Forecast Agent | medium | sonnet_default | Generate 30/60/90-day sales forecasts with confidence intervals |
| sales.repeat_purchase | Repeat Purchase Agent | low | no_llm | Track repeat purchase frequency and identify lapsing customers |
| sales.deal_quality | Deal Quality Agent | medium | haiku_first | Score deals by margin quality, customer risk, and terms |
| sales.revenue_leakage | Revenue Leakage Agent | medium | haiku_first | Detect invoicing gaps, unrecorded sales, and billing errors |
| sales.segment_revenue | Segment Revenue Agent | low | no_llm | Segment revenue by customer type, region, and product category |

All Squad B agents: status=planned, public_claim_status=future_public, approval_required=false, queue_execution_supported=true, cost_engine_tracking=true, harness_x_required=false (except upsell_signal: haiku_first warranted harness)

## Squad C: Purchase / Supplier / Payables (10 agents)

| agent_id | name | risk | llm_policy | mission |
|----------|------|------|-----------|---------|
| supply.payables | Supplier Payables Agent | high | haiku_first | Prioritize outstanding supplier payments by relationship and cash position |
| supply.purchase_validation | Purchase Validation Agent | low | no_llm | Validate purchase entries against PO and supplier agreements |
| supply.supplier_risk | Supplier Risk Agent | medium | sonnet_default | Score supplier reliability based on delivery and quality history |
| supply.vendor_dependency | Vendor Dependency Agent | medium | haiku_first | Identify single-source supplier dependencies that create business risk |
| supply.cash_constrained_payment | Cash-Constrained Payment Agent | high | sonnet_default | Optimize payment schedule when available cash is less than total due |
| supply.purchase_to_inventory | Purchase-to-Inventory Agent | low | no_llm | Verify that purchase receipts are correctly recorded in inventory |
| supply.supplier_delay | Supplier Delay Agent | medium | haiku_first | Detect and quantify supplier delivery delays and their business impact |
| supply.payment_terms | Payment Terms Agent | medium | haiku_first | Analyze payment terms across suppliers to identify optimization opportunities |
| supply.vendor_negotiation | Vendor Negotiation Signal Agent | medium | sonnet_default | Surface data to support supplier negotiation for better terms |
| supply.procurement_anomaly | Procurement Anomaly Agent | medium | haiku_first | Detect unusual purchasing patterns that may indicate errors or fraud |

## Squad D: Inventory / Operations (10 agents)

| agent_id | name | risk | llm_policy | mission |
|----------|------|------|-----------|---------|
| inventory.stock_movement | Stock Movement Agent | low | no_llm | Track and report inventory movement velocity by SKU |
| inventory.low_stock_risk | Low Stock Risk Agent | medium | no_llm | Alert on SKUs approaching stockout threshold |
| inventory.dead_stock | Dead Stock Agent | medium | haiku_first | Identify and quantify inventory with no recent sales movement |
| inventory.inventory_cash | Inventory-Cash Agent | medium | no_llm | Calculate cash locked in inventory by category |
| inventory.reorder_decision | Reorder Decision Agent | medium | haiku_first | Generate reorder recommendations with quantity and timing |
| inventory.ops_bottleneck | Operations Bottleneck Agent | medium | sonnet_default | Identify operational processes slowing inventory throughput |
| inventory.demand_velocity | Demand Velocity Agent | low | no_llm | Calculate demand velocity trends per SKU over time |
| inventory.stockout_impact | Stockout Impact Agent | medium | haiku_first | Estimate revenue at risk from current stockout situations |
| inventory.warehouse_accuracy | Warehouse Accuracy Agent | low | no_llm | Compare system inventory vs physical count discrepancies |
| inventory.slow_moving_sku | Slow-Moving SKU Agent | low | no_llm | Rank SKUs by days-sales-of-inventory to identify slow movers |

## Squad E: Finance / Ledger / Forecasting (12 agents)

| agent_id | name | risk | approval | llm_policy | mission |
|----------|------|------|----------|-----------|---------|
| finance.ledger_integrity | Ledger Integrity Agent | medium | none | haiku_first | Detect ledger inconsistencies, unbalanced entries, and reconciliation gaps |
| finance.cashflow_forecast | Cashflow Forecast Agent | medium | none | sonnet_default | Generate 7/30/90-day cashflow forecasts with scenario analysis |
| finance.receivables_forecast | Receivables Forecast Agent | medium | none | haiku_first | Forecast collections timeline based on customer payment behavior |
| finance.payables_forecast | Payables Forecast Agent | medium | none | haiku_first | Forecast payment obligations over the next 90 days |
| finance.margin_pressure | Margin Pressure Agent | medium | none | haiku_first | Detect margin erosion trends across products and customers |
| finance.expense_drift | Expense Drift Agent | low | none | no_llm | Identify expense categories growing faster than revenue |
| finance.financial_anomaly | Financial Anomaly Agent | high | manager | sonnet_default | Detect statistical anomalies in financial data suggesting errors or fraud |
| finance.bank_reconciliation | Bank Reconciliation Agent | medium | none | no_llm | Match bank statement transactions to ledger entries |
| finance.profitability_signal | Profitability Signal Agent | medium | none | haiku_first | Track profitability by customer, product, and channel |
| finance.working_capital | Working Capital Agent | medium | none | haiku_first | Monitor working capital ratio and flag deterioration |
| finance.cash_gap_alert | Cash Gap Alert Agent | high | owner | sonnet_default | Alert when projected cash gap exceeds configured threshold |
| finance.forecast_accuracy | Forecast Accuracy Agent | low | none | no_llm | Measure and track forecast accuracy vs actuals over time |

## Squad F: Customer / CRM / Behavior (14 agents)

| agent_id | name | risk | llm_policy | mission |
|----------|------|------|-----------|---------|
| crm.customer_behavior | Customer Behavior Agent | low | no_llm | Profile customer payment and ordering behavior patterns |
| crm.customer_silence | Customer Silence Agent | medium | haiku_first | Detect customers who have gone quiet and flag for outreach |
| crm.relationship_risk | Relationship Risk Agent | medium | sonnet_default | Score business relationship health and flag deterioration |
| crm.communication_channel | Communication Channel Agent | low | no_llm | Identify the most effective communication channel per customer |
| crm.customer_segmentation | Customer Segmentation Agent | low | haiku_first | Segment customers by value, risk, and engagement |
| crm.repeat_excuse_pattern | Repeat Excuse Pattern Agent | medium | sonnet_default | Detect customers using the same excuses repeatedly to delay payment |
| crm.customer_health | Customer Health Agent | medium | haiku_first | Composite health score combining payment, engagement, and risk |
| crm.customer_ltv | Customer Lifetime Value Agent | medium | haiku_first | Calculate and track customer lifetime value over time |
| crm.churn_signal | Customer Churn Signal Agent | high | none | sonnet_default | Detect early signals that a customer may be reducing business |
| crm.response_pattern | Response Pattern Agent | low | no_llm | Track how and when customers respond to communications |
| crm.buyer_trust | Buyer Trust Agent | medium | sonnet_default | Score buyer trustworthiness based on historical commitment reliability |
| crm.account_risk | Account Risk Agent | high | manager | sonnet_default | Composite account risk score combining financial and relationship factors |
| crm.customer_priority | Customer Priority Agent | medium | haiku_first | Rank customers by strategic priority for owner attention |
| crm.customer_memory | Customer Memory Agent | low | no_llm | Maintain and retrieve structured memory about each customer |

All Squad F: status=planned, public_claim_status=future_public, cost_engine_tracking=true, queue_execution_supported=true

---

# LAYER 3 — 48 CORTEX / AUTOMATION / DATA AGENTS

## Squad A: Cortex Orchestrator Agents (12 agents)

| agent_id | name | risk | llm_policy | mission |
|----------|------|------|-----------|---------|
| cortex.event_normalizer | Event Normalizer Agent | low | no_llm | Normalize all incoming business events into standard format |
| cortex.context_builder | Context Builder Agent | low | no_llm | Assemble full business context for agent execution |
| cortex.agent_router | Agent Router Agent | low | no_llm | Route events to the correct agents based on type and business state |
| cortex.workflow_planner | Workflow Planner Agent | medium | haiku_first | Plan multi-step agent workflows from complex business requests |
| cortex.action_composer | Action Composer Agent | medium | haiku_first | Compose multiple agent outputs into a coherent action plan |
| cortex.outcome_router | Outcome Router Agent | low | no_llm | Route agent outcomes to downstream consumers (audit, learning, briefing) |
| cortex.signal_prioritizer | Signal Prioritizer Agent | medium | haiku_first | Prioritize competing business signals when multiple agents trigger simultaneously |
| cortex.task_decomposer | Task Decomposer Agent | medium | sonnet_default | Break complex business requests into atomic agent tasks |
| cortex.decision_graph | Decision Graph Agent | medium | haiku_first | Build decision dependency graphs for multi-agent workflows |
| cortex.dependency_resolver | Dependency Resolver Agent | low | no_llm | Resolve agent execution order based on data dependencies |
| cortex.multi_agent_coordinator | Multi-Agent Coordinator Agent | medium | haiku_first | Coordinate parallel agent execution and aggregate results |
| cortex.orchestration_memory | Orchestration Memory Agent | low | no_llm | Maintain workflow state and orchestration context in memory |

All Squad A: status=planned, public_claim_status=hidden, layer=3, approval_required=false, rust_execution_engine=cortex_core

## Squad B: Data Quality / Memory Agents (12 agents)

| agent_id | name | risk | llm_policy | mission |
|----------|------|------|-----------|---------|
| data.duplicate_record | Duplicate Record Agent | low | no_llm | Detect and flag duplicate records across business data |
| data.missing_field | Missing Field Agent | low | no_llm | Identify records with missing required fields |
| data.freshness | Data Freshness Agent | low | no_llm | Track data staleness and flag records not updated within expected periods |
| data.business_memory | Business Memory Agent | low | haiku_first | Maintain and retrieve long-term business context and patterns |
| data.entity_resolution | Entity Resolution Agent | medium | haiku_first | Resolve whether two records refer to the same real-world entity |
| data.schema_drift | Schema Drift Agent | low | no_llm | Detect unexpected changes in data structure or field usage |
| data.confidence | Data Confidence Agent | medium | haiku_first | Score data quality confidence per record and field |
| data.historical_pattern | Historical Pattern Agent | low | no_llm | Extract and store historical behavioral patterns for retrieval |
| data.lineage | Data Lineage Agent | low | no_llm | Track data provenance and transformation history |
| data.conflict | Data Conflict Agent | medium | haiku_first | Detect conflicting data entries that cannot both be correct |
| data.merge_recommendation | Record Merge Recommendation Agent | medium | sonnet_default | Recommend which duplicate records to merge and how |
| data.completeness | Data Completeness Agent | low | no_llm | Measure data completeness scores per entity and dataset |

## Squad C: Pipeline / Workflow Automation Agents (12 agents)

| agent_id | name | risk | approval | mission |
|----------|------|------|----------|---------|
| pipeline.sale_to_receivable | Sale-to-Receivable Pipeline Agent | medium | none | Ensure every confirmed sale generates a receivable record |
| pipeline.payment_to_ledger | Payment-to-Ledger Pipeline Agent | critical | admin | Ensure every payment received is recorded in ledger correctly |
| pipeline.purchase_to_inventory | Purchase-to-Inventory Pipeline Agent | medium | none | Ensure purchase receipts update inventory records atomically |
| pipeline.promise_to_followup | Promise-to-Followup Pipeline Agent | medium | none | Schedule follow-up actions when payment promises are recorded |
| pipeline.overdue_to_action | Overdue-to-Action Pipeline Agent | high | none | Trigger appropriate collection actions when invoices become overdue |
| pipeline.cashflow_to_alert | Cashflow-to-Alert Pipeline Agent | medium | none | Trigger cashflow alerts when forecast crosses configured thresholds |
| pipeline.dispute_to_resolution | Dispute-to-Resolution Pipeline Agent | medium | none | Route disputes to the correct resolution workflow and owner |
| pipeline.approval_to_execution | Approval-to-Execution Pipeline Agent | critical | owner | Execute the approved action after owner approval is confirmed |
| pipeline.event_retry | Event Retry Agent | low | none | Retry failed event processing with exponential backoff |
| pipeline.idempotency_guard | Idempotency Guard Agent | low | none | Prevent duplicate execution of the same event |
| pipeline.workflow_state | Workflow State Agent | low | none | Persist and retrieve workflow execution state |
| pipeline.background_job | Background Job Agent | low | none | Manage background job queue execution and monitoring |

## Squad D: Simulation / Decision Agents (12 agents)

| agent_id | name | risk | llm_policy | mission |
|----------|------|------|-----------|---------|
| sim.credit_exposure | Credit Exposure Simulation Agent | medium | sonnet_default | Simulate credit exposure scenarios under different customer payment assumptions |
| sim.cash_gap | Cash Gap Simulation Agent | high | sonnet_default | Simulate cash gap scenarios and model funding options |
| sim.collection_outcome | Collection Outcome Simulation Agent | medium | haiku_first | Model expected collection recovery under different strategy assumptions |
| sim.inventory_reorder | Inventory Reorder Simulation Agent | medium | haiku_first | Simulate inventory levels under different reorder timing and quantity scenarios |
| sim.supplier_payment | Supplier Payment Simulation Agent | high | sonnet_default | Simulate supplier relationship impact of different payment timing strategies |
| sim.discount_impact | Discount Impact Simulation Agent | medium | haiku_first | Model revenue and margin impact of discount strategy changes |
| sim.customer_risk | Customer Risk Simulation Agent | medium | haiku_first | Simulate customer risk scenarios for credit and collections planning |
| sim.working_capital | Working Capital Simulation Agent | medium | sonnet_default | Model working capital position under different receivables and payables scenarios |
| sim.scenario_planning | Scenario Planning Agent | medium | sonnet_default | Build and compare multiple business scenario outcomes |
| sim.what_if_action | What-If Action Agent | medium | sonnet_default | Model the expected outcome of a specific proposed business action |
| sim.risk_tradeoff | Risk Tradeoff Agent | medium | sonnet_default | Analyze the risk-reward tradeoff of competing action options |
| sim.decision_explanation | Decision Explanation Agent | low | sonnet_default | Generate human-readable explanations for agent decisions and recommendations |

---

# LAYER 4 — 36 SECURITY / COMPLIANCE / HARNESS AGENTS

## Squad A: Security / Policy Agents (12 agents)

| agent_id | name | risk | approval | mission |
|----------|------|------|----------|---------|
| security.tenant_isolation | Tenant Isolation Agent | critical | admin | Enforce absolute data isolation between business tenants |
| security.rbac_permission | RBAC Permission Agent | critical | admin | Validate user permissions against RBAC rules before any action |
| security.unsafe_message | Unsafe Message Agent | high | none | Detect and block unsafe, harassing, or legally problematic message content |
| security.audit_trail | Audit Trail Agent | medium | none | Ensure all security-relevant events are captured in immutable audit log |
| security.consent_compliance | Consent Compliance Agent | high | none | Verify customer consent before any external communication |
| security.legal_wording_safety | Legal Wording Safety Agent | critical | owner | Validate legal wording in communications for accuracy and compliance |
| security.secret_exposure | Secret Exposure Agent | critical | admin | Detect secrets, API keys, or PII in agent outputs before delivery |
| security.auth_boundary | Auth Boundary Agent | critical | admin | Enforce JWT-based authentication boundaries on all requests |
| security.cache_isolation | Cache Isolation Agent | critical | admin | Prevent cross-tenant cache key collisions and data leakage |
| security.api_abuse | API Abuse Agent | high | none | Detect and block API abuse patterns (scraping, enumeration, brute force) |
| security.rate_limit | Rate Limit Agent | medium | none | Enforce per-tenant and per-user rate limits on agent executions |
| security.payment_truth_guard | Payment Truth Guard Agent | critical | owner | Validate payment status changes against bank/payment gateway source of truth |

All Squad A: status=planned, public_claim_status=hidden, layer=4, rust_execution_engine=cortex_core, harness_x_required=true

## Squad B: Compliance / Legal / Trust Agents (8 agents)

| agent_id | name | risk | approval | mission |
|----------|------|------|----------|---------|
| compliance.privacy_policy | Privacy Policy Agent | medium | none | Ensure business operations comply with applicable privacy policies |
| compliance.data_retention | Data Retention Agent | medium | none | Enforce data retention schedules across all business data |
| compliance.data_deletion | Data Deletion Agent | critical | admin | Execute DPDP-compliant data deletion requests within 72-hour SLA |
| compliance.data_export | Data Export Agent | high | owner | Generate portable data export files for data portability requests |
| compliance.dpdp_readiness | DPDP Readiness Agent | medium | none | Assess and report DPDP compliance readiness status |
| compliance.collections_ethics | Collections Ethics Agent | high | none | Enforce collections ethics rules — no harassment, consent, timing, frequency |
| compliance.grievance_handling | Grievance Handling Agent | high | none | Route and track customer grievances with regulatory-compliant handling |
| compliance.contract_safety | Contract Safety Agent | critical | owner | Validate contract language for legal accuracy before any contract action |

## Squad C: Harness X Agents (10 agents)

| agent_id | name | risk | mission |
|----------|------|------|---------|
| harness.static_harness | Static Harness Agent | low | Run schema validation, policy syntax, and tool availability checks |
| harness.red_team | Red-Team Harness Agent | low | Run adversarial injection and boundary testing scenarios |
| harness.dry_run | Dry-Run Harness Agent | low | Execute agents with synthetic data in isolated sandbox mode |
| harness.live_harness | Live Harness Agent | low | Run end-to-end validation in staging environment |
| harness.regression_guard | Regression Guard Agent | low | Detect when agent behavior regresses from established baseline |
| harness.cross_user_leak | Cross-User Leak Test Agent | low | Test for cross-tenant data leakage in all agent data access patterns |
| harness.unsafe_collection_test | Unsafe Collection Message Test Agent | low | Test communication agents for harassment, tone, consent, and timing violations |
| harness.ai_hallucination | AI Hallucination Test Agent | low | Detect hallucinated financial figures and unverified data in agent outputs |
| harness.performance_harness | Performance Harness Agent | low | Run load tests and verify SLA compliance under concurrent execution |
| harness.feature_flag_test | Feature Flag Test Agent | low | Test enable/disable cycles and fallback behavior for all agents |

## Squad D: Approval / Governance Agents (6 agents)

| agent_id | name | risk | approval | mission |
|----------|------|------|----------|---------|
| governance.owner_approval | Owner Approval Agent | critical | owner | Manage owner approval workflows for critical agent proposals |
| governance.manager_approval | Manager Approval Agent | high | manager | Manage manager approval workflows for high-risk agent proposals |
| governance.high_risk_action | High-Risk Action Agent | critical | owner | Gate all high-risk actions through explicit owner review |
| governance.escalation_policy | Escalation Policy Agent | high | none | Apply escalation rules when approvals timeout or are rejected |
| governance.human_in_loop | Human-in-Loop Agent | high | none | Inject mandatory human review points in automated workflows |
| governance.approval_audit | Approval Audit Agent | low | none | Maintain immutable audit trail of all approval decisions |

---

# LAYER 5 — 24 INFRASTRUCTURE / RELIABILITY / COST AGENTS

## Squad A: Infrastructure / DevOps (8 agents)

| agent_id | name | risk | approval | mission |
|----------|------|------|----------|---------|
| infra.deployment_readiness | Deployment Readiness Agent | critical | admin | Validate all conditions are met before production deployment |
| infra.rollback_readiness | Rollback Readiness Agent | critical | admin | Verify rollback path is ready and tested before each deployment |
| infra.environment_readiness | Environment Readiness Agent | high | none | Check all environment variables and dependencies are correctly configured |
| infra.migration_safety | Migration Safety Agent | critical | admin | Validate database migrations are safe to run without downtime |
| infra.release_checklist | Release Checklist Agent | high | none | Run automated pre-release checklist and surface any blockers |
| infra.ci_gate | CI Gate Agent | medium | none | Gate CI pipeline progression based on test results and quality checks |
| infra.railway_health | Railway Health Agent | low | none | Monitor Railway deployment health and surface degradation signals |
| infra.vercel_health | Vercel Health Agent | low | none | Monitor Vercel frontend deployment health and edge function status |

## Squad B: Observability / Reliability (8 agents)

| agent_id | name | risk | mission |
|----------|------|------|---------|
| obs.observability | Observability Agent | low | Collect and surface OpenTelemetry metrics, traces, and logs |
| obs.performance_budget | Performance Budget Agent | medium | Track and alert when response times exceed performance budgets |
| obs.incident_response | Incident Response Agent | high | Detect production incidents and trigger response runbooks |
| obs.uptime | Uptime Agent | low | Monitor service uptime and calculate availability SLAs |
| obs.error_budget | Error Budget Agent | medium | Track error budget consumption and alert on burn rate |
| obs.slow_route | Slow Route Agent | medium | Identify API routes with elevated latency and surface for optimization |
| obs.restart_detection | Restart Detection Agent | medium | Detect unexpected service restarts and correlate with deployment events |
| obs.database_health | Database Health Agent | high | Monitor PostgreSQL health: connections, query latency, replication lag |

## Squad C: AI Cost / Efficiency (8 agents)

| agent_id | name | risk | mission |
|----------|------|------|---------|
| cost.cost_router | Cost Router Agent | low | Route LLM requests to the cheapest capable model per task complexity |
| cost.cache_decision | Cache Decision Agent | low | Decide whether to use cached LLM output or generate fresh response |
| cost.model_selection | Model Selection Agent | low | Select optimal LLM model given task requirements and budget |
| cost.token_budget | Token Budget Agent | medium | Enforce token budgets per agent and alert on budget consumption |
| cost.prompt_compression | Prompt Compression Agent | low | Compress agent prompts to reduce token count without losing fidelity |
| cost.llm_avoidance | LLM Avoidance Agent | low | Identify agent tasks solvable with deterministic logic — no LLM needed |
| cost.batch_routing | Batch Routing Agent | low | Batch multiple similar LLM requests into single call for cost efficiency |
| cost.cost_per_outcome | Cost Per Outcome Agent | low | Calculate and track cost per business outcome (e.g., cost per collection) |

All Layer 5 agents: status=planned, public_claim_status=hidden, layer=5, cost_engine_tracking=true

---

# LAYER 6 — 24 GTM / SUPPORT / ADMIN / ENTERPRISE AGENTS

## Squad A: Support / Customer Success (7 agents)

| agent_id | name | risk | mission |
|----------|------|------|---------|
| support.triage | Support Triage Agent | medium | Classify and prioritize incoming support tickets by severity and category |
| support.onboarding | Onboarding Agent | low | Guide new businesses through Atlas onboarding with personalized steps |
| support.feedback_loop | Feedback Loop Agent | low | Collect, categorize, and route product feedback to relevant teams |
| support.help_center | Help Center Agent | low | Surface relevant help center articles based on user context |
| support.customer_training | Customer Training Agent | low | Deliver contextual product training based on usage patterns |
| support.bug_triage | Bug Triage Agent | medium | Detect, classify, and prioritize reported product bugs |
| support.success_risk | Customer Success Risk Agent | high | Identify customers at risk of churn based on usage and engagement signals |

## Squad B: GTM / Growth / Pricing (7 agents)

| agent_id | name | risk | mission |
|----------|------|------|---------|
| gtm.pricing_experiment | Pricing Experiment Agent | high | Analyze pricing experiment results and recommend pricing adjustments |
| gtm.activation_insight | Activation Insight Agent | medium | Track user activation milestones and surface friction points |
| gtm.lead_qualification | Lead Qualification Agent | medium | Score inbound leads by fit and purchase intent |
| gtm.demo_preparation | Demo Preparation Agent | low | Prepare personalized demo environments based on prospect profile |
| gtm.sales_followup | Sales Follow-up Agent | medium | Schedule and optimize sales follow-up timing for prospect conversion |
| gtm.churn_reason | Churn Reason Agent | medium | Analyze churn patterns to identify the primary reasons customers leave |
| gtm.referral_signal | Referral Signal Agent | low | Identify satisfied customers most likely to refer new business |

## Squad C: Admin / Internal Ops (5 agents)

| agent_id | name | risk | approval | mission |
|----------|------|------|----------|---------|
| admin.admin_review | Admin Review Agent | medium | none | Surface administrative issues requiring owner or admin attention |
| admin.internal_permission | Internal Permission Agent | critical | admin | Manage internal system permission grants and reviews |
| admin.staff_activity | Staff Activity Agent | medium | none | Track staff actions in Atlas for audit and performance insight |
| admin.abuse_review | Abuse Review Agent | high | admin | Detect and escalate platform abuse patterns across tenants |
| admin.operational_sop | Operational SOP Agent | low | none | Surface the correct SOP for operational tasks based on context |

## Squad D: Enterprise Readiness (5 agents)

| agent_id | name | risk | mission |
|----------|------|------|---------|
| enterprise.sla_readiness | SLA Readiness Agent | high | Assess and report whether Atlas meets enterprise SLA commitments |
| enterprise.dpa_readiness | DPA Readiness Agent | medium | Validate Data Processing Agreement compliance for enterprise customers |
| enterprise.enterprise_audit | Enterprise Audit Agent | high | Generate enterprise-grade audit reports for compliance and governance |
| enterprise.multi_branch | Multi-Branch Business Agent | medium | Coordinate data and workflows across multi-branch business operations |
| enterprise.regional_localization | Regional Localization Agent | medium | Adapt agent outputs for regional language, currency, and regulatory context |

All Layer 6 agents: status=planned, public_claim_status=hidden, layer=6, cost_engine_tracking=true, queue_execution_supported=true

---

## Complete Agent Count Summary

| Layer | Squad | Count | Running Total |
|-------|-------|-------|--------------|
| 1 | Core | 12 | 12 |
| 2A | CashOps / Collections | 16 | 28 |
| 2B | Sales / Revenue | 10 | 38 |
| 2C | Purchase / Supplier / Payables | 10 | 48 |
| 2D | Inventory / Operations | 10 | 58 |
| 2E | Finance / Ledger / Forecasting | 12 | 70 |
| 2F | Customer / CRM / Behavior | 14 | 84 |
| 3A | Cortex Orchestrator | 12 | 96 |
| 3B | Data Quality / Memory | 12 | 108 |
| 3C | Pipeline / Workflow | 12 | 120 |
| 3D | Simulation / Decision | 12 | 132 |
| 4A | Security / Policy | 12 | 144 |
| 4B | Compliance / Legal / Trust | 8 | 152 |
| 4C | Harness X | 10 | 162 |
| 4D | Approval / Governance | 6 | 168 |
| 5A | Infrastructure / DevOps | 8 | 176 |
| 5B | Observability / Reliability | 8 | 184 |
| 5C | AI Cost / Efficiency | 8 | 192 |
| 6A | Support / Customer Success | 7 | 199 |
| 6B | GTM / Growth / Pricing | 7 | 206 |
| 6C | Admin / Internal Ops | 5 | 211 |
| 6D | Enterprise Readiness | 5 | 216 |
| **Total** | | **216** | **216** |

---

> **Status:** Internal Architecture Design — Phase 0 (Registry Design Only)
> **Public claim:** "12 core specialized agents with an expandable Agent Mesh architecture"
> **"200+ agents" claim:** Unlocks ONLY after all Phase 8 proof gates met — see agent-rollout-plan-216.md
> **Next step:** Commit to `performance-bootstrap-cortex-fix-v1`, begin Phase 1 implementation
