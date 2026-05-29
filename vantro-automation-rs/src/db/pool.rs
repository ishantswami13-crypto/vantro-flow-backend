// FILE: vantro-automation-rs/src/db/pool.rs
// sqlx Postgres pool. Uses direct Postgres (bypasses Supabase HTTP overhead).
// Read-only queries: safe. Write queries: reserved for audit logs only.

use sqlx::{postgres::PgPoolOptions, PgPool};

pub type DbPool = PgPool;

pub async fn create_pool(database_url: &str) -> anyhow::Result<DbPool> {
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .min_connections(2)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .idle_timeout(std::time::Duration::from_secs(300))
        .connect(database_url)
        .await
        .map_err(|e| anyhow::anyhow!("[DB] Failed to connect: {}", e))?;

    tracing::info!("[DB] Pool established");
    Ok(pool)
}
