// FILE: vantro-automation-rs/src/api/health.rs

use crate::AppState;
use axum::{routing::get, Json, Router};
use serde_json::{json, Value};

pub fn routes() -> Router<AppState> {
    Router::new().route("/health", get(health_handler))
}

async fn health_handler() -> Json<Value> {
    Json(json!({
        "ok":      true,
        "service": "vantro-automation-rs",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}
