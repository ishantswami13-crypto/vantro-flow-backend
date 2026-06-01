// FILE: vantro-automation-rs/src/api/cost_router.rs
// POST /api/v2/agents/core.cost_router/evaluate
// Read-only routing decision for the authenticated user.
//
// Pure evaluation — no DB queries, no mutations, no LLM calls.
// Uses dynamic structs from agents::cost_router — no .sqlx/ cache needed.

use axum::{extract::State, routing::post, Json, Router};
use serde_json::{json, Value};
use std::time::Instant;
use vantro_automation_lib::agents::cost_router::{evaluate, CostRouterInput};

use crate::{auth::AuthUser, error::AppResult, AppState};

pub fn routes() -> Router<AppState> {
    Router::new().route(
        "/api/v2/agents/core.cost_router/evaluate",
        post(cost_router_evaluate),
    )
}

async fn cost_router_evaluate(
    State(_state): State<AppState>,
    _user: AuthUser,
    Json(req): Json<CostRouterInput>,
) -> AppResult<Json<Value>> {
    let t0 = Instant::now();
    let result = evaluate(&req, 0);
    let elapsed = t0.elapsed().as_millis() as u64;

    tracing::info!(
        task_type = %req.task_type,
        route = %result.route,
        model_tier = %result.model_tier,
        duration_ms = elapsed,
        "cost_router_evaluate"
    );

    Ok(Json(json!({
        "success":          true,
        "agentId":          result.agent_id,
        "status":           result.status,
        "route":            result.route,
        "modelTier":        result.model_tier,
        "reasonCodes":      result.reason_codes,
        "estimatedCostUsd": result.estimated_cost_usd,
        "maxTokenBudget":   result.max_token_budget,
        "approvalRequired": result.approval_required,
        "policyRequired":   result.policy_required,
        "safeToExecute":    result.safe_to_execute,
        "checksRun":        result.checks_run,
        "durationMs":       elapsed,
        "auditEvent":       result.audit_event,
    })))
}
