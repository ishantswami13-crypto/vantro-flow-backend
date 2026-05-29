// FILE: vantro-automation-rs/src/cortex/cost_engine.rs
// AI Cost Routing Engine — routes tasks to the cheapest appropriate resource.
// Foundation for Vantro Compute cost tracking.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Clone)]
pub struct CostRouteInput {
    pub task_type: TaskType,
    pub input_tokens_estimate: u32,
    pub output_tokens_estimate: u32,
    pub latency_budget_ms: Option<u32>,
    pub accuracy_required: AccuracyLevel,
    pub is_cacheable: bool,
    pub batch_eligible: bool,
    pub context: Option<String>,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskType {
    RuleEvaluation,  // No LLM needed
    ScoreCustomer,   // No LLM needed
    PolicyCheck,     // No LLM needed
    SimpleDraft,     // Fast/cheap LLM
    ComplexAnalysis, // Strong LLM
    OwnerBriefing,   // Strong LLM
    DataExtraction,  // Fast/cheap LLM
    SimulationCheck, // No LLM needed
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub enum AccuracyLevel {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RouteDecision {
    RulesOnly,   // No LLM at all — deterministic
    CacheHit,    // Serve from cache
    CheapModel,  // claude-haiku or equivalent
    StrongModel, // claude-sonnet or equivalent
    Batch,       // Queue for batch processing
}

#[derive(Debug, Serialize)]
pub struct CostRouteResult {
    pub success: bool,
    pub route_decision: RouteDecision,
    pub recommended_model: Option<String>,
    pub estimated_cost_usd: f64,
    pub cheaper_model_possible: bool,
    pub cache_recommended: bool,
    pub batch_recommended: bool,
    pub reasons: Vec<String>,
    pub approximate_latency_ms: u32,
}

const HAIKU_COST_PER_1K_IN: f64 = 0.000_25;
const HAIKU_COST_PER_1K_OUT: f64 = 0.001_25;
const SONNET_COST_PER_1K_IN: f64 = 0.003;
const SONNET_COST_PER_1K_OUT: f64 = 0.015;

pub fn route(input: &CostRouteInput) -> CostRouteResult {
    let mut reasons = Vec::new();

    // ─── No-LLM tasks ──────────────────────────────────────────
    let no_llm = matches!(
        input.task_type,
        TaskType::RuleEvaluation
            | TaskType::ScoreCustomer
            | TaskType::PolicyCheck
            | TaskType::SimulationCheck
    );
    if no_llm {
        reasons.push("Task is deterministic — no LLM required".to_string());
        return CostRouteResult {
            success: true,
            route_decision: RouteDecision::RulesOnly,
            recommended_model: None,
            estimated_cost_usd: 0.0,
            cheaper_model_possible: false,
            cache_recommended: input.is_cacheable,
            batch_recommended: false,
            reasons,
            approximate_latency_ms: 5,
        };
    }

    // ─── Cache check ────────────────────────────────────────────
    if input.is_cacheable {
        reasons.push("Result is cacheable — check cache before calling LLM".to_string());
        // Return suggestion; actual cache miss/hit is handled by the caller
        reasons.push("Cache hit would cost $0.00 and serve in <5ms".to_string());
    }

    // ─── Model selection ────────────────────────────────────────
    let use_strong = matches!(
        input.accuracy_required,
        AccuracyLevel::High | AccuracyLevel::Critical
    ) || matches!(
        input.task_type,
        TaskType::ComplexAnalysis | TaskType::OwnerBriefing
    );

    let (model, cost_in, cost_out, latency) = if use_strong {
        (
            "claude-sonnet-4-6",
            SONNET_COST_PER_1K_IN,
            SONNET_COST_PER_1K_OUT,
            800u32,
        )
    } else {
        (
            "claude-haiku-4-5-20251001",
            HAIKU_COST_PER_1K_IN,
            HAIKU_COST_PER_1K_OUT,
            200u32,
        )
    };

    let estimated_cost = (input.input_tokens_estimate as f64 / 1000.0) * cost_in
        + (input.output_tokens_estimate as f64 / 1000.0) * cost_out;

    // ─── Batch recommendation ───────────────────────────────────
    let batch = input.batch_eligible
        && input.latency_budget_ms.map_or(true, |b| b > 5000)
        && input.input_tokens_estimate > 500;

    if batch {
        reasons.push(
            "Batch eligible and latency allows — batch processing saves ~50% cost".to_string(),
        );
    }

    let cheaper_possible = use_strong
        && matches!(input.accuracy_required, AccuracyLevel::High)
        && !matches!(input.task_type, TaskType::OwnerBriefing);

    if cheaper_possible {
        reasons.push(format!(
            "Cheaper model (haiku) might be sufficient — saves ~90% cost vs {}",
            model
        ));
    }

    let route_decision = if batch {
        RouteDecision::Batch
    } else if use_strong {
        RouteDecision::StrongModel
    } else {
        RouteDecision::CheapModel
    };

    CostRouteResult {
        success: true,
        route_decision,
        recommended_model: Some(model.to_string()),
        estimated_cost_usd: estimated_cost,
        cheaper_model_possible: cheaper_possible,
        cache_recommended: input.is_cacheable,
        batch_recommended: batch,
        reasons,
        approximate_latency_ms: latency,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_only_for_policy_check() {
        let r = route(&CostRouteInput {
            task_type: TaskType::PolicyCheck,
            input_tokens_estimate: 200,
            output_tokens_estimate: 50,
            latency_budget_ms: None,
            accuracy_required: AccuracyLevel::High,
            is_cacheable: true,
            batch_eligible: false,
            context: None,
        });
        assert_eq!(r.route_decision, RouteDecision::RulesOnly);
        assert_eq!(r.estimated_cost_usd, 0.0);
    }

    #[test]
    fn scoring_needs_no_llm() {
        let r = route(&CostRouteInput {
            task_type: TaskType::ScoreCustomer,
            input_tokens_estimate: 100,
            output_tokens_estimate: 50,
            latency_budget_ms: None,
            accuracy_required: AccuracyLevel::Medium,
            is_cacheable: true,
            batch_eligible: false,
            context: None,
        });
        assert_eq!(r.route_decision, RouteDecision::RulesOnly);
        assert_eq!(r.estimated_cost_usd, 0.0, "scoring must not cost money");
    }

    #[test]
    fn complex_analysis_uses_strong_model() {
        let r = route(&CostRouteInput {
            task_type: TaskType::ComplexAnalysis,
            input_tokens_estimate: 1000,
            output_tokens_estimate: 500,
            latency_budget_ms: None,
            accuracy_required: AccuracyLevel::High,
            is_cacheable: false,
            batch_eligible: false,
            context: None,
        });
        assert!(matches!(r.route_decision, RouteDecision::StrongModel));
    }
}
