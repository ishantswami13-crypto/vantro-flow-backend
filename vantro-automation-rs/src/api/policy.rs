// FILE: vantro-automation-rs/src/api/policy.rs

use axum::{extract::State, routing::post, Json, Router};
use serde_json::{json, Value};
use std::time::Instant;

use crate::{
    auth::AuthUser,
    cortex::policy_guard::{self, PolicyInput},
    error::AppResult,
    AppState,
};

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/v2/cortex/evaluate-policy", post(evaluate_policy))
}

async fn evaluate_policy(
    State(_state): State<AppState>,
    _user: AuthUser,
    Json(req): Json<PolicyInput>,
) -> AppResult<Json<Value>> {
    let t0 = Instant::now();
    let decision = policy_guard::evaluate(&req);
    let elapsed = t0.elapsed().as_millis();
    tracing::info!(action_type = %req.action_type, blocked = decision.blocked, duration_ms = elapsed, "evaluate_policy");
    Ok(Json(
        json!({ "success": true, "decision": decision, "durationMs": elapsed }),
    ))
}
