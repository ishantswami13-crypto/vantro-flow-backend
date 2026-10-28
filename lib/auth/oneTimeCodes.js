// Short-lived, single-use codes: sign-up verification codes, phone sign-in
// codes and the browser-to-desktop sign-in handoff. Codes are compared as
// SHA-256 hashes, and each key allows a few wrong guesses before it is burned.
//
// With a database (useDatabase), codes live in one_time_codes, so a code sent
// by one server instance can be checked by another and survives a redeploy.
// Without one, or if the table cannot be reached, they are held in memory, as
// before: a restart drops every open code, which only means asking again.
'use strict';
const crypto = require('crypto');

const store = new Map(); // key -> { hash, data, expiresAt, attempts }
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

let getPool = null;
let ensured = null;
let lastSweep = 0;

function useDatabase(poolGetter) {
  getPool = poolGetter;
  ensured = null;
}

// migrations/068 creates the table; this covers a deploy that runs first.
function ensureTable(pool) {
  if (!ensured) {
    const create = () => pool.query(`
      CREATE TABLE IF NOT EXISTS one_time_codes (
        key TEXT PRIMARY KEY, hash TEXT NOT NULL, data JSONB NOT NULL DEFAULT '{}'::jsonb,
        expires_at TIMESTAMPTZ NOT NULL, attempts INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      ALTER TABLE IF EXISTS one_time_codes ENABLE ROW LEVEL SECURITY;`);
    ensured = pool.query(`SELECT to_regclass('public.one_time_codes') IS NOT NULL AS present`)
      .then(({ rows }) => (rows[0]?.present ? null : create().catch(() => new Promise((r) => setTimeout(r, 250)).then(create))))
      .catch((err) => { ensured = null; throw err; });
  }
  return ensured;
}

async function dbPool() {
  if (!getPool) return null;
  try {
    const pool = getPool();
    if (!pool) return null;
    await ensureTable(pool);
    return pool;
  } catch (err) {
    console.error('[oneTimeCodes] database unavailable, using memory:', err.message);
    return null;
  }
}

function sweep(now = Date.now()) {
  for (const [k, v] of store) if (v.expiresAt <= now) store.delete(k);
}

async function issue(key, code, data, ttlMs) {
  sweep();
  const pool = await dbPool();
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO one_time_codes (key, hash, data, expires_at, attempts)
         VALUES ($1, $2, $3, now() + ($4 * interval '1 millisecond'), 0)
         ON CONFLICT (key) DO UPDATE SET hash = EXCLUDED.hash, data = EXCLUDED.data,
           expires_at = EXCLUDED.expires_at, attempts = 0, created_at = now()`,
        [key, sha(code), JSON.stringify(data ?? {}), ttlMs]);
      store.delete(key);
      if (Date.now() - lastSweep > 10 * 60 * 1000) {
        lastSweep = Date.now();
        pool.query(`DELETE FROM one_time_codes WHERE expires_at < now() - interval '1 hour'`).catch(() => {});
      }
      return;
    } catch (err) {
      console.error('[oneTimeCodes] issue failed, using memory:', err.message);
    }
  }
  store.set(key, { hash: sha(code), data, expiresAt: Date.now() + ttlMs, attempts: 0 });
}

function consumeMemory(key, code, maxAttempts) {
  const e = store.get(key);
  if (!e) return undefined;
  if (e.expiresAt <= Date.now()) { store.delete(key); return null; }
  const a = Buffer.from(sha(code)), b = Buffer.from(e.hash);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) { store.delete(key); return e.data; }
  e.attempts += 1;
  if (e.attempts >= maxAttempts) store.delete(key);
  return null;
}

/** Returns the stored data once, or null. maxAttempts wrong codes burn the key. */
async function consume(key, code, { maxAttempts = 5 } = {}) {
  // A code issued while the database was unreachable is still in memory.
  const local = consumeMemory(key, code, maxAttempts);
  if (local !== undefined) return local;
  const pool = await dbPool();
  if (!pool) return null;
  try {
    // Deleting the matching row is what makes the code single-use, even when
    // two requests race.
    const hit = await pool.query(
      `DELETE FROM one_time_codes WHERE key = $1 AND hash = $2 AND expires_at > now() RETURNING data`,
      [key, sha(code)]);
    if (hit.rows[0]) return hit.rows[0].data;
    const miss = await pool.query(
      `UPDATE one_time_codes SET attempts = attempts + 1 WHERE key = $1 RETURNING attempts, expires_at <= now() AS expired`,
      [key]);
    const row = miss.rows[0];
    if (row && (row.expired || row.attempts >= maxAttempts)) {
      await pool.query(`DELETE FROM one_time_codes WHERE key = $1`, [key]);
    }
    return null;
  } catch (err) {
    console.error('[oneTimeCodes] consume failed:', err.message);
    return null;
  }
}

/** Drops an open code without checking it. */
async function discard(key) {
  store.delete(key);
  const pool = await dbPool();
  if (pool) await pool.query(`DELETE FROM one_time_codes WHERE key = $1`, [key]).catch(() => {});
}

module.exports = { issue, consume, discard, useDatabase, _store: store };
