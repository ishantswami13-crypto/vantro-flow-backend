'use strict';
// lib/connectors/syncRuns.js — closing connector_sync_runs rows.
//
// A sync attempt is a row that starts 'running' and must end 'succeeded' or
// 'failed'. Every failure path closes it with an error code, stored in the
// existing `error` column as "<code>: <message>" (no extra column needed).
// A run still 'running' after SYNC_RUN_TIMEOUT_MS is treated as failed when
// read and closed lazily (per tenant, on read or on the next sync start) —
// never by a bulk update at deploy.

const SYNC_RUN_TIMEOUT_MS = 15 * 60 * 1000;
const CODE_RE = /^[a-z][a-z0-9_]{0,39}$/;
const TIMED_OUT = 'sync_timed_out';
const TIMED_OUT_MESSAGE = 'The sync did not finish. The computer may have gone to sleep or lost its connection; it will retry.';

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/** "<code>: <message>" when the code is a plain identifier, else the message alone. */
function formatError(code, message) {
  const msg = clip(message, 450) || null;
  if (code && CODE_RE.test(String(code))) return msg ? `${code}: ${msg}` : String(code);
  return msg;
}

/** Inverse of formatError: { code, message } (code null for free text). */
function parseError(text) {
  if (!text) return { code: null, message: null };
  const m = String(text).match(/^([a-z][a-z0-9_]{0,39}):\s*([\s\S]*)$/);
  if (m) return { code: m[1], message: m[2] || null };
  return CODE_RE.test(String(text)) && String(text).includes('_') ? { code: String(text), message: null } : { code: null, message: String(text) };
}

function isStaleRunning(run, now = Date.now()) {
  return !!run && run.status === 'running' && run.started_at != null
    && now - new Date(run.started_at).getTime() >= SYNC_RUN_TIMEOUT_MS;
}

/** A run as it should be read: a stale 'running' row reads as a timed-out failure. */
function normalizeRun(run, now = Date.now()) {
  if (!isStaleRunning(run, now)) return run;
  return { ...run, status: 'failed', finished_at: run.finished_at || null, error: formatError(TIMED_OUT, TIMED_OUT_MESSAGE) };
}

// Legacy production tables were missing result columns (see migrations
// 063/064). If the full update hits an undefined column, the status is still
// closed so a run can never stay 'running' because bookkeeping failed.
async function withFallback(pool, attempts) {
  for (let i = 0; i < attempts.length; i++) {
    try {
      return await pool.query(attempts[i].sql, attempts[i].params);
    } catch (e) {
      if (e.code !== '42703' || i === attempts.length - 1) throw e;
      console.error('[sync runs] column missing, closing with fewer fields:', e.message);
    }
  }
  return { rows: [], rowCount: 0 };
}

/**
 * Close one run. `deviceId` (when given) must match; only a 'running' row is
 * changed. Returns the closed row ids.
 */
async function closeRun(pool, { id, userId = null, deviceId = null, status, imported = 0, rejected = 0, code = null, message = null }) {
  if (!['succeeded', 'failed'].includes(status)) throw new Error(`closeRun: bad status ${status}`);
  const error = status === 'failed' ? formatError(code, message) : (rejected ? formatError(null, message) : null);
  const scope = `id = $1 AND status = 'running' AND ($3::uuid IS NULL OR user_id = $3) AND ($4::uuid IS NULL OR device_id = $4)`;
  const r = await withFallback(pool, [
    { sql: `UPDATE connector_sync_runs SET status = $2, finished_at = now(), records_imported = $5, records_rejected = $6, error = $7 WHERE ${scope} RETURNING id`,
      params: [id, status, userId, deviceId, imported || 0, rejected || 0, error] },
    { sql: `UPDATE connector_sync_runs SET status = $2, finished_at = now() WHERE ${scope} RETURNING id`, params: [id, status, userId, deviceId] },
    { sql: `UPDATE connector_sync_runs SET status = $2 WHERE ${scope} RETURNING id`, params: [id, status, userId, deviceId] },
  ]);
  return r.rows.map((x) => x.id);
}

/** Close this tenant's runs left 'running' past the timeout. Returns how many. */
async function closeStaleRuns(pool, userId, { connectorId = null } = {}) {
  if (!userId) return 0;
  const scope = `user_id = $1 AND status = 'running' AND started_at < now() - ($2::int * interval '1 millisecond') AND ($3::text IS NULL OR connector_id = $3)`;
  const r = await withFallback(pool, [
    { sql: `UPDATE connector_sync_runs SET status = 'failed', finished_at = now(), error = $4 WHERE ${scope} RETURNING id`,
      params: [userId, SYNC_RUN_TIMEOUT_MS, connectorId, formatError(TIMED_OUT, TIMED_OUT_MESSAGE)] },
    { sql: `UPDATE connector_sync_runs SET status = 'failed', finished_at = now() WHERE ${scope} RETURNING id`, params: [userId, SYNC_RUN_TIMEOUT_MS, connectorId] },
    { sql: `UPDATE connector_sync_runs SET status = 'failed' WHERE ${scope} RETURNING id`, params: [userId, SYNC_RUN_TIMEOUT_MS, connectorId] },
  ]);
  return r.rowCount || 0;
}

module.exports = { SYNC_RUN_TIMEOUT_MS, TIMED_OUT, formatError, parseError, isStaleRunning, normalizeRun, closeRun, closeStaleRuns };
