// FILE: vantro-automation-rs/src/db/pool.rs
// sqlx Postgres pool. Uses direct Postgres (bypasses Supabase HTTP overhead).
// Read-only queries: safe. Write queries: reserved for audit logs only.

use sqlx::{postgres::PgPoolOptions, PgPool};

pub type DbPool = PgPool;

// Liveness decoupling (Phase 2C.31S): the pool is created LAZILY — connections are
// established on first use, NOT at startup. This lets the HTTP server bind and serve the
// `/health` liveness endpoint within the Railway healthcheck window even when the
// database is missing, slow, invalid, or temporarily unreachable. DB-dependent business
// endpoints still require a working database: their first query fails closed if the DB is
// unavailable (this does NOT bypass the DB requirement for real operations). `connect_lazy`
// still validates the connection-string FORMAT, so a malformed DATABASE_URL fails fast at
// startup, and config still requires the database URL to be set. No eager connect-then-await
// call and no `min_connections`, so liveness never blocks on database readiness.
pub fn create_pool(database_url: &str) -> anyhow::Result<DbPool> {
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .idle_timeout(std::time::Duration::from_secs(300))
        .connect_lazy(database_url)
        .map_err(|e| anyhow::anyhow!("[DB] Invalid database URL: {}", e))?;

    tracing::info!("[DB] Pool created (lazy; connects on first use)");
    Ok(pool)
}
