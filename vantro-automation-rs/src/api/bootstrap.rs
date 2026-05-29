// FILE: vantro-automation-rs/src/api/bootstrap.rs
// Bootstrap routes — serve from L1 cache or DB. Target: <500ms uncached, <5ms cached.

use axum::{extract::State, routing::get, Json, Router};
use serde_json::{json, Value};
use std::time::Instant;

use crate::{auth::AuthUser, cache::keys, db::queries, error::AppResult, AppState};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v2/dashboard/bootstrap", get(dashboard_bootstrap))
        .route("/api/v2/collections/bootstrap", get(collections_bootstrap))
}

async fn dashboard_bootstrap(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Value>> {
    let t0 = Instant::now();
    let key = keys::dashboard_bootstrap(user.user_id);

    let (data, source) = state
        .cache
        .get_or_set(&key, keys::TTL_DASHBOARD, || {
            let pool = state.db.clone();
            let uid = user.user_id;
            async move { queries::dashboard_bootstrap(&pool, uid).await }
        })
        .await?;

    let elapsed = t0.elapsed().as_millis();
    tracing::info!(user_id = %user.user_id, source, duration_ms = elapsed, "dashboard_bootstrap");

    Ok(Json(json!({
        "success":      true,
        "kpis":         data.kpis,
        "topActions":   data.top_actions,
        "lastUpdated":  data.last_updated,
        "source":       source,
        "durationMs":   elapsed,
    })))
}

async fn collections_bootstrap(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Value>> {
    let t0 = Instant::now();
    let key = keys::collections_bootstrap(user.user_id);

    let (data, source) = state
        .cache
        .get_or_set(&key, keys::TTL_COLLECTIONS, || {
            let pool = state.db.clone();
            let uid = user.user_id;
            async move { queries::collections_bootstrap(&pool, uid).await }
        })
        .await?;

    let elapsed = t0.elapsed().as_millis();
    tracing::info!(user_id = %user.user_id, source, duration_ms = elapsed, "collections_bootstrap");

    Ok(Json(json!({
        "success":      true,
        "summary":      data.summary,
        "lastUpdated":  data.last_updated,
        "source":       source,
        "durationMs":   elapsed,
    })))
}
