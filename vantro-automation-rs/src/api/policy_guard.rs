// FILE: vantro-automation-rs/src/api/policy_guard.rs
// POST /api/v2/agents/core.policy_guard/evaluate
// Read-only policy evaluation for the authenticated user.
//
// Pure evaluation — no DB queries, no mutations, no LLM calls.
// Uses dynamic structs from agents::policy_guard — no .sqlx/ cache needed.

use axum::{extract::State, routing::post, Json, Router};
use serde_json::{json, Value};
use std::time::Instant;
use vantro_automation_lib::agents::policy_guard::{evaluate, PolicyGuardInput};

use crate::{auth::AuthUser, error::AppResult, AppState};

pub fn routes() -> Router<AppState> {
    Router::new().route(
        "/api/v2/agents/core.policy_guard/evaluate",
        post(policy_guard_evaluate),
    )
}

async fn policy_guard_evaluate(
    State(_state): State<AppState>,
    _user: AuthUser,
    Json(req): Json<PolicyGuardInput>,
) -> AppResult<Json<Value>> {
    let t0 = Instant::now();
    let duration_ms = 0u64; // pure evaluation — measure after
    let result = evaluate(&req, duration_ms);
    let elapsed = t0.elapsed().as_millis() as u64;

    tracing::info!(
        action_type = %req.proposed_action_type,
        blocked = result.decision.blocked,
        allowed = result.decision.allowed,
        duration_ms = elapsed,
        "policy_guard_evaluate"
    );

    Ok(Json(json!({
        "success":            true,
        "agentId":            result.agent_id,
        "status":             result.status,
        "decision": {
            "allowed":           result.decision.allowed,
            "blocked":           result.decision.blocked,
            "approvalRequired":  result.decision.approval_required,
            "safeToAutoExecute": result.decision.safe_to_auto_execute,
            "blockReason":       result.decision.block_reason,
            "reasons":           result.decision.reasons,
            "riskLevel":         result.decision.risk_level,
        },
        "checksRun":          result.checks_run,
        "durationMs":         elapsed,
        "auditEvent":         result.audit_event,
    })))
}
