//! Vantro ASI -- Agent Mesh registry.
//!
//! The single source of truth for every agent Vantro can run. Registry +
//! schema only -- NO runtime execution. Each agent stays disabled until its
//! harness scenarios pass and a per-agent runtime flag is added (future work).

use super::types::{AgentSpec, ApprovalRule, CostBudget, RiskLevel};

// Cost-engine shorthands.
const RULES_ONLY: CostBudget = CostBudget {
    max_usd_per_run: 0.0,
    prefer_rules_over_llm: true,
};
const CHEAP_LLM: CostBudget = CostBudget {
    max_usd_per_run: 0.01,
    prefer_rules_over_llm: true,
};
const STRONG_LLM: CostBudget = CostBudget {
    max_usd_per_run: 0.05,
    prefer_rules_over_llm: false,
};

// ── 1. Collections agent ─────────────────────────────────────────────────────
const COLLECTIONS: AgentSpec = AgentSpec {
    agent_id: "collections_agent",
    name: "Collections Agent",
    mission: "Decide who to follow up with, when, and with what tone, to recover overdue receivables without damaging relationships.",
    inputs: &["overdue_invoices", "customer_metrics", "cpi_inputs", "business_cash_pressure"],
    tools: &["calculate_cpi", "tone_engine", "timing_engine", "draft_reminder"],
    output_schema: "CollectionPlan { customer_id, next_best_action, tone, send_time, draft_message, approval_required, why }",
    risk_level: RiskLevel::High,
    approval_rules: &[ApprovalRule::OwnerForExternalAction],
    policy_rules: &[
        "no_external_message_without_approval",
        "no_legal_threat_language",
        "no_fake_customer_or_invoice_id",
        "respect_dispute_pause",
    ],
    audit_events: &["collection_plan_created", "reminder_drafted", "owner_approval_requested"],
    success_metric: "rupees_recovered_per_followup",
    cost_budget: CHEAP_LLM,
    harness_scenarios: &["collections/late-payer", "collections/firm-reminder-needed", "ai-safety/unsafe-legal-threat"],
    can_execute_external: true,
};

// ── 2. Promise tracker agent ─────────────────────────────────────────────────
const PROMISE_TRACKER: AgentSpec = AgentSpec {
    agent_id: "promise_tracker_agent",
    name: "Promise Tracker Agent",
    mission: "Track payment promises, detect broken/kept promises, and surface broken-promise velocity for prioritisation.",
    inputs: &["promises", "payments", "call_logs"],
    tools: &["match_payment_to_promise", "compute_promise_reliability"],
    output_schema: "PromiseStatus { customer_id, kept, broken, reliability, velocity }",
    risk_level: RiskLevel::Low,
    approval_rules: &[ApprovalRule::NoneRequired],
    policy_rules: &["no_external_action", "internal_read_and_classify_only"],
    audit_events: &["promise_classified", "broken_promise_detected"],
    success_metric: "promise_classification_accuracy",
    cost_budget: RULES_ONLY,
    harness_scenarios: &["learning/promise-kept", "learning/promise-broken"],
    can_execute_external: false,
};

// ── 3. Credit risk agent ─────────────────────────────────────────────────────
const CREDIT_RISK: AgentSpec = AgentSpec {
    agent_id: "credit_risk_agent",
    name: "Credit Risk Agent",
    mission: "Score credit risk and simulate proposed credit sales, recommending advance/hold when exposure is unsafe.",
    inputs: &["customer_metrics", "credit_limit", "proposed_sale", "business_cash_pressure"],
    tools: &["score_customer", "simulate_credit_sale", "credit_control"],
    output_schema: "CreditDecision { score, risk_level, projected_exposure, recommendation, approval_required, why }",
    risk_level: RiskLevel::High,
    approval_rules: &[ApprovalRule::OwnerForCreditHold, ApprovalRule::OwnerForHighRisk],
    policy_rules: &["no_auto_credit_hold_without_approval", "explain_every_recommendation", "no_fake_customer_id"],
    audit_events: &["credit_scored", "credit_sale_simulated", "credit_hold_recommended"],
    success_metric: "bad_debt_avoided_minus_lost_sales",
    cost_budget: RULES_ONLY,
    harness_scenarios: &["risk/risky-credit-sale", "risk/credit-limit-exceeded", "risk/high-value-risky-customer"],
    can_execute_external: false,
};

// ── 4. Cashflow agent ────────────────────────────────────────────────────────
const CASHFLOW: AgentSpec = AgentSpec {
    agent_id: "cashflow_agent",
    name: "Cashflow Agent",
    mission: "Forecast the 7-day cash position, flag gaps between expected inflow and required outflow, and quantify cash pressure.",
    inputs: &["expected_inflow_7d", "expected_outflow_7d", "current_balance", "supplier_dues"],
    tools: &["simulate_cashflow_gap", "rank_inflows"],
    output_schema: "CashflowForecast { gap, risk_level, cash_pressure, drivers }",
    risk_level: RiskLevel::Low,
    approval_rules: &[ApprovalRule::NoneRequired],
    policy_rules: &["no_external_action", "advisory_only"],
    audit_events: &["cashflow_forecasted", "cashflow_gap_flagged"],
    success_metric: "forecast_error_vs_actual",
    cost_budget: RULES_ONLY,
    harness_scenarios: &["cashflow/cashflow-gap", "cashflow/expected-cash-week"],
    can_execute_external: false,
};

// ── 5. Inventory-cash agent ──────────────────────────────────────────────────
const INVENTORY_CASH: AgentSpec = AgentSpec {
    agent_id: "inventory_cash_agent",
    name: "Inventory-Cash Decision Agent",
    mission: "Recommend stock/purchase decisions that balance avoiding stockouts against locking up cash, given cash pressure.",
    inputs: &["product_stock", "low_stock_alerts", "sales_velocity", "cash_pressure"],
    tools: &["rank_low_stock", "estimate_reorder_cost"],
    output_schema: "InventoryDecision { product_id, action, suggested_qty, cash_impact, approval_required, why }",
    risk_level: RiskLevel::Medium,
    approval_rules: &[ApprovalRule::OwnerForPayment],
    policy_rules: &["no_auto_purchase_without_approval", "respect_cash_pressure_ceiling"],
    audit_events: &["inventory_decision_made", "reorder_suggested"],
    success_metric: "stockout_days_avoided_per_rupee_locked",
    cost_budget: RULES_ONLY,
    harness_scenarios: &["inventory/low-stock", "inventory/dead-stock", "inventory/fast-moving-stock"],
    can_execute_external: false,
};

// ── 6. Payables agent ────────────────────────────────────────────────────────
const PAYABLES: AgentSpec = AgentSpec {
    agent_id: "payables_agent",
    name: "Payables Priority Agent",
    mission: "Prioritise which supplier payables to pay first given due dates, relationships, and available cash. Never auto-pays.",
    inputs: &["supplier_dues", "due_dates", "current_balance", "supplier_relationship_risk"],
    tools: &["rank_payables", "estimate_late_penalty"],
    output_schema: "PayablesPlan { ordered_payables, rationale, approval_required }",
    risk_level: RiskLevel::Medium,
    approval_rules: &[ApprovalRule::OwnerForPayment],
    policy_rules: &["never_initiate_payment", "owner_orders_actual_payment", "explain_ranking"],
    audit_events: &["payables_ranked", "payment_priority_suggested"],
    success_metric: "late_penalties_avoided",
    cost_budget: RULES_ONLY,
    harness_scenarios: &["cashflow/supplier-due-risk"],
    can_execute_external: false,
};

// ── 7. Dispute agent ─────────────────────────────────────────────────────────
const DISPUTE: AgentSpec = AgentSpec {
    agent_id: "dispute_agent",
    name: "Dispute Resolution Agent",
    mission: "Detect disputes, pause dunning, and route to a resolution-first path before any further collection pressure.",
    inputs: &["disputes", "invoice_context", "customer_metrics"],
    tools: &["detect_dispute", "pause_dunning", "draft_resolution_message"],
    output_schema: "DisputePlan { dispute_id, pause_dunning, next_step, draft_message, approval_required }",
    risk_level: RiskLevel::High,
    approval_rules: &[ApprovalRule::OwnerForExternalAction],
    policy_rules: &["pause_dunning_on_open_dispute", "no_external_message_without_approval", "no_legal_threat_language"],
    audit_events: &["dispute_detected", "dunning_paused", "resolution_drafted"],
    success_metric: "disputes_resolved_without_relationship_loss",
    cost_budget: CHEAP_LLM,
    harness_scenarios: &["collections/dispute-first"],
    can_execute_external: true,
};

// ── 8. Owner briefing agent ──────────────────────────────────────────────────
const OWNER_BRIEFING: AgentSpec = AgentSpec {
    agent_id: "owner_briefing_agent",
    name: "Owner Briefing Agent",
    mission: "Produce a concise, explainable daily briefing of the most important money decisions awaiting the owner.",
    inputs: &["action_feed", "cpi_top", "cashflow_forecast", "pending_approvals"],
    tools: &["summarise_actions", "rank_by_impact"],
    output_schema: "OwnerBriefing { headline, top_actions, pending_approvals, why_each }",
    risk_level: RiskLevel::Low,
    approval_rules: &[ApprovalRule::NoneRequired],
    policy_rules: &["read_only", "no_external_action", "no_unverified_claims"],
    audit_events: &["briefing_generated"],
    success_metric: "owner_actions_taken_from_briefing",
    cost_budget: STRONG_LLM,
    harness_scenarios: &["orchestration/payment-received"],
    can_execute_external: false,
};

// ── 9. Data quality agent ────────────────────────────────────────────────────
const DATA_QUALITY: AgentSpec = AgentSpec {
    agent_id: "data_quality_agent",
    name: "Data Quality Agent",
    mission: "Detect missing/inconsistent customer, invoice, and payment data that would degrade other agents' decisions.",
    inputs: &["customers", "invoices", "payments", "promises"],
    tools: &["detect_missing_fields", "detect_duplicates", "flag_anomalies"],
    output_schema: "DataQualityReport { issues, severity, suggested_fix }",
    risk_level: RiskLevel::Low,
    approval_rules: &[ApprovalRule::NoneRequired],
    policy_rules: &["read_only", "never_auto_edit_records", "flag_only"],
    audit_events: &["data_issue_flagged"],
    success_metric: "decisions_protected_from_bad_data",
    cost_budget: RULES_ONLY,
    harness_scenarios: &["ai-safety/fake-invoice-action"],
    can_execute_external: false,
};

// ── 10. Policy guard agent ───────────────────────────────────────────────────
const POLICY_GUARD: AgentSpec = AgentSpec {
    agent_id: "policy_guard_agent",
    name: "Policy Guard Agent",
    mission: "Enforce the safety policy on every proposed action: block forbidden actions, unsafe messages, and hallucinated ids.",
    inputs: &["proposed_action", "known_customer_ids", "message_draft"],
    tools: &["evaluate_policy"],
    output_schema: "PolicyDecision { allowed, blocked, requires_approval, block_reason, reasons }",
    risk_level: RiskLevel::Critical,
    // The guard itself does not act on customers; it gates other agents. It
    // requires owner approval to ever be overridden.
    approval_rules: &[ApprovalRule::OwnerAlways],
    policy_rules: &[
        "block_mark_paid_change_amount_delete",
        "block_external_message_without_approval",
        "block_legal_threats",
        "block_cross_user_access",
        "block_hallucinated_ids",
    ],
    audit_events: &["policy_evaluated", "action_blocked", "approval_required"],
    success_metric: "unsafe_actions_blocked_with_zero_false_negatives",
    cost_budget: RULES_ONLY,
    harness_scenarios: &[
        "ai-safety/unsafe-legal-threat",
        "ai-safety/fake-payment-received",
        "ai-safety/external-message-without-approval",
        "security/cross-business-leak",
    ],
    can_execute_external: false,
};

// ── 11. Cost router agent ────────────────────────────────────────────────────
const COST_ROUTER: AgentSpec = AgentSpec {
    agent_id: "cost_router_agent",
    name: "Cortex Cost Router Agent",
    mission: "Route each task to the cheapest resource that meets accuracy/latency: rules, cache, cheap model, or strong model.",
    inputs: &["task_type", "accuracy_required", "latency_budget", "is_cacheable", "batch_eligible"],
    tools: &["cost_route"],
    output_schema: "CostRouteResult { route_decision, recommended_model, estimated_cost_usd, cheaper_model_possible, reasons }",
    risk_level: RiskLevel::Low,
    approval_rules: &[ApprovalRule::NoneRequired],
    policy_rules: &["never_exceed_task_cost_budget", "prefer_rules_when_viable", "internal_only"],
    audit_events: &["task_routed", "cheaper_model_flagged"],
    success_metric: "cost_per_useful_action",
    cost_budget: RULES_ONLY,
    harness_scenarios: &["orchestration/cash-sale-orchestration"],
    can_execute_external: false,
};

// ── 12. Learning agent ───────────────────────────────────────────────────────
const LEARNING: AgentSpec = AgentSpec {
    agent_id: "learning_agent",
    name: "Learning Agent",
    mission: "Write back outcomes (paid/no-response, tone success, best reply time) to business memory to improve future decisions.",
    inputs: &["action_outcomes", "tone_results", "reply_times"],
    tools: &["record_outcome", "update_business_memory"],
    output_schema: "LearningUpdate { customer_id, learned_fact, confidence }",
    risk_level: RiskLevel::Medium,
    // Internal memory write only; no external action, but writes are gated so a
    // bad learning cannot silently poison future decisions at scale.
    approval_rules: &[ApprovalRule::NoneRequired],
    policy_rules: &["internal_memory_write_only", "no_external_action", "confidence_threshold_required"],
    audit_events: &["outcome_recorded", "memory_updated"],
    success_metric: "decision_quality_lift_over_time",
    cost_budget: RULES_ONLY,
    harness_scenarios: &["learning/action-outcome-paid", "learning/action-outcome-no-response", "learning/tone-success-learning"],
    can_execute_external: false,
};

/// The complete agent mesh. Order is stable and meaningful (orchestration order
/// is decided elsewhere; this is just the catalogue).
pub const ALL: &[AgentSpec] = &[
    COLLECTIONS,
    PROMISE_TRACKER,
    CREDIT_RISK,
    CASHFLOW,
    INVENTORY_CASH,
    PAYABLES,
    DISPUTE,
    OWNER_BRIEFING,
    DATA_QUALITY,
    POLICY_GUARD,
    COST_ROUTER,
    LEARNING,
];

/// All registered agents.
pub fn all() -> &'static [AgentSpec] {
    ALL
}

/// Look up an agent by its stable id.
pub fn by_id(id: &str) -> Option<&'static AgentSpec> {
    ALL.iter().find(|a| a.agent_id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn registry_has_all_twelve_agents() {
        assert_eq!(ALL.len(), 12, "expected exactly 12 agents in the mesh");
    }

    #[test]
    fn all_agent_ids_are_unique() {
        let mut seen = HashSet::new();
        for a in ALL {
            assert!(
                seen.insert(a.agent_id),
                "duplicate agent_id: {}",
                a.agent_id
            );
        }
        assert_eq!(seen.len(), ALL.len());
    }

    #[test]
    fn every_agent_has_a_success_metric() {
        for a in ALL {
            assert!(
                !a.success_metric.trim().is_empty(),
                "{} has no success_metric",
                a.agent_id
            );
        }
    }

    #[test]
    fn every_agent_has_a_nonempty_mission_and_inputs() {
        for a in ALL {
            assert!(
                !a.mission.trim().is_empty(),
                "{} has no mission",
                a.agent_id
            );
            assert!(!a.inputs.is_empty(), "{} has no inputs", a.agent_id);
            assert!(!a.tools.is_empty(), "{} has no tools", a.agent_id);
            assert!(
                !a.output_schema.trim().is_empty(),
                "{} has no output_schema",
                a.agent_id
            );
        }
    }

    #[test]
    fn every_risky_agent_requires_approval() {
        for a in ALL {
            if a.risk_level.is_risky() {
                assert!(
                    a.requires_any_approval(),
                    "risky agent {} ({:?}) must require approval but does not",
                    a.agent_id,
                    a.risk_level
                );
            }
        }
    }

    #[test]
    fn every_agent_has_at_least_one_harness_scenario() {
        for a in ALL {
            assert!(
                !a.harness_scenarios.is_empty(),
                "{} has no harness scenario -- it cannot be enabled",
                a.agent_id
            );
        }
    }

    #[test]
    fn no_external_action_agent_without_policy_and_approval() {
        for a in ALL {
            if a.can_execute_external {
                assert!(
                    !a.policy_rules.is_empty(),
                    "external agent {} must have policy_rules",
                    a.agent_id
                );
                assert!(
                    a.requires_any_approval(),
                    "external agent {} must require approval",
                    a.agent_id
                );
                // External agents are inherently High or Critical risk.
                assert!(
                    a.risk_level.is_risky(),
                    "external agent {} must be High/Critical risk",
                    a.agent_id
                );
            }
        }
    }

    #[test]
    fn every_agent_has_audit_events() {
        for a in ALL {
            assert!(
                !a.audit_events.is_empty(),
                "{} has no audit_events",
                a.agent_id
            );
        }
    }

    #[test]
    fn by_id_finds_known_and_rejects_unknown() {
        assert!(by_id("collections_agent").is_some());
        assert!(by_id("policy_guard_agent").is_some());
        assert!(by_id("nonexistent_agent").is_none());
    }
}
