// FILE: vantro-automation-rs/src/api/cost.rs

use axum::{extract::State, routing::post, Json, Router};
use serde_json::{json, Value};
use std::time::Instant;

use crate::{
    auth::AuthUser,
    cortex::cost_engine::{self, CostRouteInput},
    error::AppResult,
    AppState,
};

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/v2/cortex/cost-route", post(cost_route))
}

async fn cost_route(
    State(_state): State<AppState>,
    _user: AuthUser,
    Json(req): Json<CostRouteInput>,
) -> AppResult<Json<Value>> {
    let t0 = Instant::now();
    let result = cost_engine::route(&req);
    let elapsed = t0.elapsed().as_millis();
    tracing::info!(task_type = ?req.task_type, route = ?result.route_decision, duration_ms = elapsed, "cost_route");
    Ok(Json(
        json!({ "success": true, "result": result, "durationMs": elapsed }),
    ))
}
