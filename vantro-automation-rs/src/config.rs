// FILE: vantro-automation-rs/src/config.rs
// All runtime configuration sourced from environment variables.
// Validated once at startup; the app exits with a clear message if required vars are missing.

use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    /// Port for the Axum service (default 3002, distinct from Node on 3001).
    pub port: u16,

    /// Postgres connection string — same DATABASE_URL used by Node/pg.js.
    pub database_url: String,

    /// JWT secret — same JWT_SECRET used by Node to sign auth tokens.
    pub jwt_secret: String,

    /// Rust automation API enabled gate. Mirrors Node feature flag.
    pub enabled: bool,

    /// Optional Redis URL.  If absent, L2 cache is skipped.
    pub redis_url: Option<String>,

    /// Optional NATS URL.  If absent, event publishing falls back to DB.
    pub nats_url: Option<String>,

    /// Optional Temporal host.  If absent, workflow scheduling is a no-op.
    pub temporal_host: Option<String>,

    /// Environment: development | staging | production
    pub app_env: String,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        Ok(Config {
            // Port precedence (Railway-compatible):
            //   1. PORT                 — injected by Railway/PaaS; the port the
            //                             platform health-checks and routes to.
            //   2. RUST_AUTOMATION_PORT — explicit override for local/multi-service dev.
            //   3. 3002                 — default (distinct from Node on 3001).
            // Honouring PORT directly means the service binds the platform port
            // even if RUST_AUTOMATION_PORT=$PORT was not set in the service env,
            // which is the documented cause of the 30s health-check timeout.
            port: env::var("PORT")
                .ok()
                .or_else(|| env::var("RUST_AUTOMATION_PORT").ok())
                .and_then(|v| v.parse().ok())
                .unwrap_or(3002),
            database_url: require("DATABASE_URL")?,
            jwt_secret: require("JWT_SECRET")?,
            enabled: env::var("RUST_AUTOMATION_API_ENABLED")
                .map(|v| v == "true")
                .unwrap_or(false),
            redis_url: env::var("REDIS_URL").ok(),
            nats_url: env::var("NATS_URL").ok(),
            temporal_host: env::var("TEMPORAL_HOST").ok(),
            app_env: env::var("NODE_ENV").unwrap_or_else(|_| "development".into()),
        })
    }

    pub fn is_dev(&self) -> bool {
        self.app_env == "development" || self.app_env == "test"
    }

    pub fn is_prod(&self) -> bool {
        self.app_env == "production"
    }
}

fn require(key: &str) -> anyhow::Result<String> {
    env::var(key).map_err(|_| anyhow::anyhow!("[Config] Missing required env var: {}", key))
}
