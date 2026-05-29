// FILE: vantro-automation-rs/src/api/scoring.rs

use axum::{extract::State, routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Instant;
use uuid::Uuid;

use crate::{
    auth::AuthUser,
    cache::keys,
    cashops::collection_priority::{self, CpiInput},
    cortex::scoring::{self, CustomerMetrics},
    db::queries,
    error::AppResult,
    AppState,
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v2/cortex/score-customer", post(score_customer))
        .route("/api/v2/cortex/calculate-cpi", post(calculate_cpi))
}

#[derive(Deserialize)]
struct ScoreRequest {
    customer_id: Uuid,
}

async fn score_customer(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<ScoreRequest>,
) -> AppResult<Json<Value>> {
    let t0 = Instant::now();
    let key = keys::customer_score(user.user_id, req.customer_id);

    let (result, source) = state
        .cache
        .get_or_set::<scoring::ScoreResult, _, _>(&key, keys::TTL_SCORE, || {
            let pool = state.db.clone();
            let uid = user.user_id;
            let cid = req.customer_id;
            async move {
                let row = queries::customer_metrics(&pool, uid, cid)
                    .await?
                    .ok_or_else(|| anyhow::anyhow!("Customer not found for this user"))?;
                Ok(scoring::score_customer(&CustomerMetrics {
                    total_overdue: row.total_overdue,
                    max_delay_days: row.max_delay_days,
                    avg_delay_days: row.avg_delay_days,
                    broken_promises: row.broken_promises as u32,
                    kept_promises: row.kept_promises as u32,
                    calls_total: row.calls_total as u32,
                    calls_picked: row.calls_picked as u32,
                }))
            }
        })
        .await?;

    let elapsed = t0.elapsed().as_millis();
    tracing::info!(user_id = %user.user_id, customer_id = %req.customer_id, source, duration_ms = elapsed, "score_customer");

    Ok(Json(
        json!({ "success": true, "source": source, "durationMs": elapsed, "data": result }),
    ))
}

#[derive(Deserialize)]
struct CpiRequest {
    customer_id: Uuid,
    business_cash_pressure: Option<f64>,
}

async fn calculate_cpi(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<CpiRequest>,
) -> AppResult<Json<Value>> {
    let t0 = Instant::now();
    let key = keys::customer_cpi(user.user_id, req.customer_id);

    let (result, source) = state
        .cache
        .get_or_set::<collection_priority::CpiResult, _, _>(&key, keys::TTL_SCORE, || {
            let pool = state.db.clone();
            let uid = user.user_id;
            let cid = req.customer_id;
            let bcp = req.business_cash_pressure.unwrap_or(0.3);
            async move {
                let row = queries::customer_metrics(&pool, uid, cid)
                    .await?
                    .ok_or_else(|| anyhow::anyhow!("Customer not found"))?;
                let promise_total = (row.broken_promises + row.kept_promises) as u32;
                let promise_rel = if promise_total > 0 {
                    row.kept_promises as f64 / promise_total as f64
                } else {
                    1.0
                };
                Ok(collection_priority::calculate(&CpiInput {
                    overdue_amount: row.overdue_amount,
                    days_overdue: row.max_delay_days as u32,
                    broken_promises: row.broken_promises as u32,
                    promise_due_missed: row.broken_promises > 0,
                    response_probability: if row.calls_total > 0 {
                        row.calls_picked as f64 / row.calls_total as f64
                    } else {
                        0.5
                    },
                    recovery_probability: promise_rel,
                    business_cash_pressure: bcp,
                    customer_value_inr: row.current_outstanding * 10.0,
                    credit_exposure_risk: (row.overdue_amount / (row.credit_limit.max(1.0)))
                        .min(1.0),
                    followup_urgency: (row.max_delay_days / 60.0).min(1.0),
                    active_dispute: false,
                    relationship_risk: 0.2,
                    last_payment_days_ago: None,
                    partial_payment_ok: true,
                }))
            }
        })
        .await?;

    let elapsed = t0.elapsed().as_millis();
    tracing::info!(user_id = %user.user_id, customer_id = %req.customer_id, source, duration_ms = elapsed, "calculate_cpi");

    Ok(Json(
        json!({ "success": true, "source": source, "durationMs": elapsed, "data": result }),
    ))
}
