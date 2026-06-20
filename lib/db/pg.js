// FILE: lib/db/pg.js
// Direct Postgres pool for multi-statement transactions.
// Supabase JS client does not support BEGIN/COMMIT — use this for orchestrator writes.
// If DATABASE_URL is not set, withTransaction() throws. Callers must handle gracefully.
const { Pool } = require('pg');
const { safeLog } = require('../observability/logger');

let pool = null;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL not configured — pg transactions unavailable. Set it in Railway env from Supabase → Settings → Database → Transaction mode pooler (port 6543).');
    }
    const { buildSanitizedPgConfig } = require('./pgConfig');
    pool = new Pool(buildSanitizedPgConfig(process.env.DATABASE_URL));
    pool.on('error', (err) => {
      safeLog('error', '[pg] Unexpected pool error', { error: err.message });
    });
  }
  return pool;
}

// Execute fn(client) inside a BEGIN/COMMIT block.
// Automatically ROLLBACK on any thrown error, then re-throws.
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function isAvailable() {
  return !!process.env.DATABASE_URL;
}

module.exports = { getPool, withTransaction, isAvailable };
