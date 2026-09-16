// FILE: lib/world/ingestLock.js
// World Intelligence Phase 3C — overlap protection for scheduled world-source
// ingestion crons. These crons are tenant-agnostic (they write to the shared
// world_events table, not per-user data), so the failure mode this guards
// against is two server processes/replicas — or a slow run overlapping the
// next scheduled tick — both calling a source's ingest() at once and racing
// on the same dedup upserts. Uses Postgres session-level advisory locks
// (pg_try_advisory_lock), the same primitive already used by scripts/migrate.js
// for its own single-runner guarantee — no new infrastructure (no Redis, no
// new table) for a problem Postgres already solves.
//
// pg_try_advisory_xact_lock (transaction-scoped, not pg_try_advisory_lock)
// is deliberate: this DB connects through Supabase's transaction-mode
// pgbouncer pooler (see lib/db/pg.js's DATABASE_URL comment — port 6543),
// which can silently reassign a logical connection to a different physical
// backend between two autocommit statements that aren't wrapped in an
// explicit BEGIN/COMMIT. Verified live: a session-level pg_advisory_lock +
// pg_advisory_unlock pair (no explicit transaction) failed to block a second
// concurrent caller under this pooler — the lock and unlock statements
// weren't guaranteed to land on the same backend. Wrapping the whole
// lock-work-commit sequence in one explicit transaction keeps it pinned to a
// single backend for its duration, and the xact-scoped lock auto-releases on
// COMMIT/ROLLBACK, so a crashed process (or dropped connection) still frees
// it — no separate unlock call needed.
const { getPool } = require('../db/pg');

// Fixed, distinct lock keys per source — arbitrary but stable int8 values
// derived from hashtext() once and hardcoded so they never drift between
// deploys (hashtext(...) is not guaranteed stable across PG versions).
const LOCK_KEYS = {
  usgs_earthquakes: 987654321001,
  fx_rates: 987654321002,
};

/**
 * Runs fn() only if the named source's advisory lock is free. Returns
 * { ran: true, result } if it ran, or { ran: false, reason: 'locked' } if
 * another run is already in progress.
 */
async function withIngestLock(sourceName, fn) {
  const lockKey = LOCK_KEYS[sourceName];
  if (!lockKey) throw new Error(`withIngestLock: unknown source "${sourceName}" — add a fixed lock key to LOCK_KEYS`);

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT pg_try_advisory_xact_lock($1) AS acquired', [lockKey]);
    if (!rows[0].acquired) {
      await client.query('ROLLBACK');
      return { ran: false, reason: 'locked' };
    }
    try {
      const result = await fn();
      await client.query('COMMIT');
      return { ran: true, result };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    client.release();
  }
}

module.exports = { withIngestLock };
