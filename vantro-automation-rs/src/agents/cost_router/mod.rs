// FILE: vantro-automation-rs/src/agents/cost_router/mod.rs
// Agent-layer wrapper for the core.cost_router agent.
//
// Delegates model-selection routing to the pure cortex::cost_engine::route()
// engine. The agent layer adds:
//   - policy block gate (policy_decision == "block" → route = block)
//   - external action gate (requires_external_action → require_approval)
//   - critical risk gate (risk_level == "critical" → require_approval)
//   - high-risk + LLM gate (high risk + LLM route → require_approval)
//   - deterministic override (deterministic_possible → rules_only)
//   - cache override (cache_available → cache before calling LLM)
//
// Phase 2C invariants (tested):
//   - safe_to_execute  = false for every response
//   - approval_required = true  for every response

use crate::cortex::cost_engine::{
    route as cortex_route, AccuracyLevel, CostRouteInput, RouteDecision, TaskType,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Clone)]
pub struct CostRouterInput {
    pub task_type: String,
    pub agent_id: Option<String>,
    /// "low" | "medium" | "high" | "critical"
    pub risk_level: Option<String>,
    pub requires_reasoning: Option<bool>,
    pub requires_message_drafting: Option<bool>,
    /// True when the action would send an external message or call an external API.
    pub requires_external_action: Option<bool>,
    /// Estimated total tokens (input + output combined) for budget guard.
    pub estimated_tokens: Option<u32>,
    pub cache_available: Option<bool>,
    /// True when the task can be handled by rules / scoring / deterministic code.
    pub deterministic_possible: Option<bool>,
    pub batchable: Option<bool>,
    /// "low" | "medium" | "high"
    pub latency_sensitivity: Option<String>,
    pub business_value: Option<String>,
    /// Policy guard decision for this action: "allow" | "block" | "require_approval"
    pub policy_decision: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CostRouterOutput {
    pub agent_id: String,
    pub status: String,
    /// "rules_only" | "cache" | "cheap_model" | "strong_model" | "batch" |
    /// "require_approval" | "block"
    pub route: String,
    /// "none" | "cheap" | "strong"
    pub model_tier: String,
    pub reason_codes: Vec<String>,
    pub estimated_cost_usd: f64,
    /// Conservative token budget ceiling for this route.
    pub max_token_budget: u32,
    /// Phase 2C invariant: always true.
    pub approval_required: bool,
    /// Whether a policy guard evaluation is needed before execution.
    pub policy_required: bool,
    /// Phase 2C invariant: always false.
    pub safe_to_execute: bool,
    pub checks_run: u32,
    pub duration_ms: u64,
    pub audit_event: String,
}

// ─── Internal helpers ────────────────────────────────────────────────────────

fn make_output(
    route: &str,
    model_tier: &str,
    reason_codes: Vec<String>,
    estimated_cost_usd: f64,
    max_token_budget: u32,
    policy_required: bool,
    checks_run: u32,
    duration_ms: u64,
) -> CostRouterOutput {
    CostRouterOutput {
        agent_id: "core.cost_router".to_string(),
        status: "ok".to_string(),
        route: route.to_string(),
        model_tier: model_tier.to_string(),
        reason_codes,
        estimated_cost_usd,
        max_token_budget,
        // Phase 2C invariants — always enforced.
        approval_required: true,
        policy_required,
        safe_to_execute: false,
        checks_run,
        duration_ms,
        audit_event: "cost_router_evaluate".to_string(),
    }
}

fn parse_task_type(s: &str) -> TaskType {
    match s.to_lowercase().as_str() {
        "rule_evaluation" | "rule" | "rules" => TaskType::RuleEvaluation,
        "score_customer" | "scoring" | "score" => TaskType::ScoreCustomer,
        "policy_check" | "policy" => TaskType::PolicyCheck,
        "simulation_check" | "simulation" => TaskType::SimulationCheck,
        "simple_draft" | "draft_message" | "draft" => TaskType::SimpleDraft,
        "data_extraction" | "extraction" => TaskType::DataExtraction,
        "complex_analysis" | "analysis" | "complex" => TaskType::ComplexAnalysis,
        "owner_briefing" | "briefing" => TaskType::OwnerBriefing,
        // Unknown task types default to SimpleDraft (safe: cheap model, not no-LLM)
        _ => TaskType::SimpleDraft,
    }
}

fn parse_accuracy(risk: Option<&str>) -> AccuracyLevel {
    match risk {
        Some("critical") => AccuracyLevel::Critical,
        Some("high") => AccuracyLevel::High,
        Some("low") => AccuracyLevel::Low,
        _ => AccuracyLevel::Medium,
    }
}

fn model_tier_for_route(route: &RouteDecision) -> &'static str {
    match route {
        RouteDecision::RulesOnly | RouteDecision::CacheHit => "none",
        RouteDecision::CheapModel | RouteDecision::Batch => "cheap",
        RouteDecision::StrongModel => "strong",
    }
}

fn route_name_for(route: &RouteDecision) -> &'static str {
    match route {
        RouteDecision::RulesOnly => "rules_only",
        RouteDecision::CacheHit => "cache",
        RouteDecision::CheapModel => "cheap_model",
        RouteDecision::StrongModel => "strong_model",
        RouteDecision::Batch => "batch",
    }
}

// ─── Public evaluate ─────────────────────────────────────────────────────────

pub fn evaluate(input: &CostRouterInput, duration_ms: u64) -> CostRouterOutput {
    let mut checks = 0u32;
    let tokens = input.estimated_tokens.unwrap_or(500);
    let budget = tokens.saturating_mul(2).max(500);

    // ── Check 1: Policy block ────────────────────────────────────────────────
    checks += 1;
    if input.policy_decision.as_deref() == Some("block") {
        return make_output(
            "block",
            "none",
            vec!["POLICY_BLOCKED".to_string()],
            0.0,
            0,
            true,
            checks,
            duration_ms,
        );
    }

    // ── Check 2: Critical risk → require approval before any model ───────────
    checks += 1;
    let is_critical = matches!(input.risk_level.as_deref(), Some("critical"));
    if is_critical {
        return make_output(
            "require_approval",
            "none",
            vec!["CRITICAL_RISK_REQUIRES_APPROVAL".to_string()],
            0.0,
            0,
            true,
            checks,
            duration_ms,
        );
    }

    // ── Check 3: External action gate ────────────────────────────────────────
    checks += 1;
    let requires_external = input.requires_external_action.unwrap_or(false);
    if requires_external {
        return make_output(
            "require_approval",
            "none",
            vec!["EXTERNAL_ACTION_REQUIRES_APPROVAL".to_string()],
            0.0,
            0,
            true,
            checks,
            duration_ms,
        );
    }

    // ── Check 4: Policy decision = require_approval ──────────────────────────
    checks += 1;
    if input.policy_decision.as_deref() == Some("require_approval") {
        return make_output(
            "require_approval",
            "none",
            vec!["POLICY_REQUIRES_APPROVAL".to_string()],
            0.0,
            budget,
            true,
            checks,
            duration_ms,
        );
    }

    // ── Check 5: Deterministic override ─────────────────────────────────────
    checks += 1;
    if input.deterministic_possible.unwrap_or(false) {
        return make_output(
            "rules_only",
            "none",
            vec!["DETERMINISTIC_NO_LLM_NEEDED".to_string()],
            0.0,
            0,
            false,
            checks,
            duration_ms,
        );
    }

    // ── Check 6: Cache override ──────────────────────────────────────────────
    checks += 1;
    if input.cache_available.unwrap_or(false) {
        return make_output(
            "cache",
            "none",
            vec!["CACHE_AVAILABLE".to_string()],
            0.0,
            100,
            false,
            checks,
            duration_ms,
        );
    }

    // ── Check 7: Delegate to cortex cost engine ──────────────────────────────
    checks += 1;
    let accuracy = parse_accuracy(input.risk_level.as_deref());
    let task_type = parse_task_type(&input.task_type);
    let batch_eligible = input.batchable.unwrap_or(false);
    let latency_budget_ms = match input.latency_sensitivity.as_deref() {
        Some("high") => Some(500u32),
        Some("low") => Some(10_000u32),
        _ => None,
    };

    let cortex_input = CostRouteInput {
        task_type,
        input_tokens_estimate: tokens / 2,
        output_tokens_estimate: tokens / 2,
        latency_budget_ms,
        accuracy_required: accuracy,
        is_cacheable: input.cache_available.unwrap_or(false),
        batch_eligible,
        context: None,
    };

    let cortex = cortex_route(&cortex_input);

    // High-risk + LLM call → escalate to require_approval
    let is_high_risk = matches!(input.risk_level.as_deref(), Some("high"));
    let uses_llm = !matches!(
        cortex.route_decision,
        RouteDecision::RulesOnly | RouteDecision::CacheHit
    );
    if is_high_risk && uses_llm {
        let mut codes = vec!["HIGH_RISK_LLM_REQUIRES_APPROVAL".to_string()];
        codes.extend(cortex.reasons);
        return make_output(
            "require_approval",
            model_tier_for_route(&cortex.route_decision),
            codes,
            cortex.estimated_cost_usd,
            budget,
            true,
            checks,
            duration_ms,
        );
    }

    let route = route_name_for(&cortex.route_decision);
    let tier = model_tier_for_route(&cortex.route_decision);

    make_output(
        route,
        tier,
        cortex.reasons,
        cortex.estimated_cost_usd,
        budget,
        false,
        checks,
        duration_ms,
    )
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn base_input(task_type: &str) -> CostRouterInput {
        CostRouterInput {
            task_type: task_type.to_string(),
            agent_id: None,
            risk_level: None,
            requires_reasoning: None,
            requires_message_drafting: None,
            requires_external_action: None,
            estimated_tokens: None,
            cache_available: None,
            deterministic_possible: None,
            batchable: None,
            latency_sensitivity: None,
            business_value: None,
            policy_decision: None,
        }
    }

    // ── Phase 2C invariants ───────────────────────────────────────────────────

    #[test]
    fn phase_2c_invariants_on_all_routes() {
        let inputs = [
            base_input("rule_evaluation"),
            base_input("complex_analysis"),
            CostRouterInput {
                policy_decision: Some("block".to_string()),
                ..base_input("draft_message")
            },
            CostRouterInput {
                requires_external_action: Some(true),
                ..base_input("send_message")
            },
        ];
        for inp in &inputs {
            let out = evaluate(inp, 0);
            assert!(
                !out.safe_to_execute,
                "Phase 2C: safe_to_execute must always be false (route={})",
                out.route
            );
            assert!(
                out.approval_required,
                "Phase 2C: approval_required must always be true (route={})",
                out.route
            );
        }
    }

    // ── Block / require_approval cases ────────────────────────────────────────

    #[test]
    fn policy_block_routes_to_block() {
        let out = evaluate(
            &CostRouterInput {
                policy_decision: Some("block".to_string()),
                ..base_input("draft_message")
            },
            0,
        );
        assert_eq!(out.route, "block");
        assert_eq!(out.estimated_cost_usd, 0.0);
        assert!(out.reason_codes.contains(&"POLICY_BLOCKED".to_string()));
    }

    #[test]
    fn critical_risk_routes_to_require_approval() {
        let out = evaluate(
            &CostRouterInput {
                risk_level: Some("critical".to_string()),
                ..base_input("owner_briefing")
            },
            0,
        );
        assert_eq!(out.route, "require_approval");
        assert!(out
            .reason_codes
            .contains(&"CRITICAL_RISK_REQUIRES_APPROVAL".to_string()));
    }

    #[test]
    fn external_action_routes_to_require_approval() {
        let out = evaluate(
            &CostRouterInput {
                requires_external_action: Some(true),
                ..base_input("send_message")
            },
            0,
        );
        assert_eq!(out.route, "require_approval");
        assert!(out.policy_required);
        assert!(out
            .reason_codes
            .contains(&"EXTERNAL_ACTION_REQUIRES_APPROVAL".to_string()));
    }

    #[test]
    fn high_risk_llm_task_routes_to_require_approval() {
        let out = evaluate(
            &CostRouterInput {
                risk_level: Some("high".to_string()),
                ..base_input("complex_analysis")
            },
            0,
        );
        assert_eq!(out.route, "require_approval");
        assert!(out
            .reason_codes
            .contains(&"HIGH_RISK_LLM_REQUIRES_APPROVAL".to_string()));
    }

    // ── Routing decisions ─────────────────────────────────────────────────────

    #[test]
    fn deterministic_task_routes_to_rules_only() {
        let out = evaluate(
            &CostRouterInput {
                deterministic_possible: Some(true),
                ..base_input("score_customer")
            },
            0,
        );
        assert_eq!(out.route, "rules_only");
        assert_eq!(out.model_tier, "none");
        assert_eq!(out.estimated_cost_usd, 0.0);
    }

    #[test]
    fn cache_available_routes_to_cache() {
        let out = evaluate(
            &CostRouterInput {
                cache_available: Some(true),
                ..base_input("owner_briefing")
            },
            0,
        );
        assert_eq!(out.route, "cache");
        assert_eq!(out.model_tier, "none");
        assert_eq!(out.estimated_cost_usd, 0.0);
    }

    #[test]
    fn rule_evaluation_task_type_routes_to_rules_only() {
        let out = evaluate(&base_input("rule_evaluation"), 0);
        assert_eq!(out.route, "rules_only");
        assert_eq!(out.estimated_cost_usd, 0.0);
    }

    #[test]
    fn simple_draft_routes_to_cheap_model() {
        let out = evaluate(
            &CostRouterInput {
                risk_level: Some("low".to_string()),
                ..base_input("simple_draft")
            },
            0,
        );
        assert_eq!(out.route, "cheap_model");
        assert_eq!(out.model_tier, "cheap");
    }

    #[test]
    fn complex_analysis_routes_to_strong_model() {
        let out = evaluate(
            &CostRouterInput {
                risk_level: Some("medium".to_string()),
                ..base_input("complex_analysis")
            },
            0,
        );
        assert_eq!(out.route, "strong_model");
        assert_eq!(out.model_tier, "strong");
    }

    #[test]
    fn batchable_low_priority_routes_to_batch() {
        // estimated_tokens=1200 → input_tokens_estimate=600; cortex batch requires >500.
        let out = evaluate(
            &CostRouterInput {
                batchable: Some(true),
                latency_sensitivity: Some("low".to_string()),
                estimated_tokens: Some(1_200),
                risk_level: Some("low".to_string()),
                ..base_input("simple_draft")
            },
            0,
        );
        assert_eq!(out.route, "batch");
        assert_eq!(out.model_tier, "cheap");
    }

    #[test]
    fn high_token_estimate_respected_in_budget() {
        let out = evaluate(
            &CostRouterInput {
                estimated_tokens: Some(10_000),
                ..base_input("complex_analysis")
            },
            0,
        );
        assert!(
            out.max_token_budget >= 10_000,
            "budget should scale with estimated_tokens"
        );
    }

    #[test]
    fn audit_event_is_correct() {
        let out = evaluate(&base_input("rule_evaluation"), 0);
        assert_eq!(out.audit_event, "cost_router_evaluate");
    }

    #[test]
    fn checks_run_is_nonzero() {
        let out = evaluate(&base_input("owner_briefing"), 0);
        assert!(out.checks_run > 0);
    }
}
