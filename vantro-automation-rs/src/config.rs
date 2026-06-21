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

    /// x-user-id auth bypass for the LOCAL DEV HARNESS ONLY. Fail-closed:
    /// requires explicit RUST_DEV_AUTH_BYPASS=true, is force-disabled on any
    /// Railway deployment, and is never active in production.
    pub dev_auth_bypass: bool,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        // Phase 2C.35-P1 fail-closed default: an unset NODE_ENV is treated as
        // PRODUCTION (not development), so the x-user-id auth bypass cannot
        // silently activate on a misconfigured deployment.
        let app_env = env::var("NODE_ENV").unwrap_or_else(|_| "production".into());
        let dev_auth_bypass = compute_dev_auth_bypass(
            env::var("RUST_DEV_AUTH_BYPASS")
                .map(|v| v == "true")
                .unwrap_or(false),
            is_railway(),
            &app_env,
        );
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
            app_env,
            dev_auth_bypass,
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

/// True when the service appears to run on a Railway deployment. Any of the
/// standard Railway-injected vars being present marks a non-local environment.
fn is_railway() -> bool {
    env::var("RAILWAY_ENVIRONMENT").is_ok()
        || env::var("RAILWAY_SERVICE_NAME").is_ok()
        || env::var("RAILWAY_PROJECT_ID").is_ok()
        || env::var("RAILWAY_PUBLIC_URL").is_ok()
}

/// Pure, testable policy for the x-user-id dev auth bypass. Fail-closed: ON only
/// when explicitly opted in AND not on Railway AND not in production.
pub fn compute_dev_auth_bypass(explicit_optin: bool, on_railway: bool, app_env: &str) -> bool {
    explicit_optin && !on_railway && app_env != "production"
}

#[cfg(test)]
mod tests {
    use super::compute_dev_auth_bypass;

    #[test]
    fn bypass_off_by_default_no_optin() {
        // No explicit opt-in => bypass off regardless of env.
        assert!(!compute_dev_auth_bypass(false, false, "development"));
        assert!(!compute_dev_auth_bypass(false, false, "test"));
    }

    #[test]
    fn bypass_off_on_railway_even_with_optin() {
        // On any Railway deployment the bypass is force-disabled.
        assert!(!compute_dev_auth_bypass(true, true, "development"));
        assert!(!compute_dev_auth_bypass(true, true, "staging"));
        assert!(!compute_dev_auth_bypass(true, true, "production"));
    }

    #[test]
    fn bypass_off_in_production() {
        assert!(!compute_dev_auth_bypass(true, false, "production"));
    }

    #[test]
    fn bypass_on_only_explicit_local_dev() {
        assert!(compute_dev_auth_bypass(true, false, "development"));
        assert!(compute_dev_auth_bypass(true, false, "test"));
    }
}
