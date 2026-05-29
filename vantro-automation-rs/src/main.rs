// FILE: vantro-automation-rs/src/main.rs
// Vantro Automation OS — full Axum service binary.
// Requires `--features server` (axum + sqlx + tokio).
// On Railway NIXPACKS (Linux): cargo build --release --features server
// On Windows dev (no MinGW): cargo check --lib runs pure tests only.

use axum::{http::Method, Router};
use std::sync::Arc;
use std::time::Duration;
use tower_http::{
    catch_panic::CatchPanicLayer,
    cors::{Any, CorsLayer},
    timeout::TimeoutLayer,
    trace::TraceLayer,
};

// Server-only modules
mod api;
mod auth;
mod cache;
mod config;
mod db;
mod error;
mod telemetry;

// Shared pure modules (also in lib.rs)
mod cashops {
    pub use vantro_automation_lib::cashops::*;
}
mod cortex {
    pub use vantro_automation_lib::cortex::*;
}
mod events {
    pub use vantro_automation_lib::events::*;
}

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<config::Config>,
    pub db: db::pool::DbPool,
    pub cache: Arc<cache::memory::MemoryCache>,
    pub events: Arc<events::publisher::EventPublisher>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    let cfg = Arc::new(config::Config::from_env()?);
    telemetry::init(&cfg.app_env);

    tracing::info!(port = cfg.port, env = %cfg.app_env, "Vantro Automation RS starting");

    let db = db::pool::create_pool(&cfg.database_url).await?;
    let cache = Arc::new(cache::memory::MemoryCache::new());
    let events = Arc::new(events::publisher::EventPublisher::new(
        cfg.nats_url.as_deref(),
    ));
    let state = AppState {
        config: cfg.clone(),
        db,
        cache,
        events,
    };

    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE])
        .allow_headers(Any)
        .allow_origin(Any);

    let app = Router::new()
        .merge(api::routes(state.clone()))
        .layer(CatchPanicLayer::new())
        .layer(TimeoutLayer::new(Duration::from_secs(30)))
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state);

    let addr = format!("0.0.0.0:{}", cfg.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("Listening on {}", addr);
    axum::serve(listener, app).await?;
    Ok(())
}
