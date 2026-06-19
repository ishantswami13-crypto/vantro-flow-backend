// FILE: lib/health/deepReadiness.js
// ─────────────────────────────────────────────────────────────────────────────
// Phase 2C.31T — Deep readiness probe (strictly additive, read-only).
//
// Reports three independent checks for staging readiness proof — Node liveness, real DB
// connectivity (a single `SELECT 1` with a short timeout), and Node->Rust `/health`
// connectivity (via the existing fail-closed rustAutomationClient). It returns ONLY
// safe booleans/status — no secrets, no env values, no customer/tenant data, no table
// reads, no schema mutation, no migration, no agent/workflow execution, no external
// send. It never throws and never blocks: every check is fail-closed and time-bounded.
//
// IMPORTANT (Phase 2C.31T / 2C.31U): the DB check runs over the SAME shared application
// `pgPool` that auto-migration and every business query use. It deliberately does NOT
// create a separate "sanitized" readiness-only connection — doing so could report db:ok
// while the real pool still fails the PgBouncer `ESTARTUPPACKETTOOLARGE` startup-packet
// limit, i.e. a false green. This probe reflects the real pool's health, so it honestly
// reports `db:fail` until the pool-wide startup-packet fix lands (env-normalize the
// DATABASE_URL query string and/or a sanitized config applied to BOTH pools — a separate,
// owner/Codex-reviewed change; see docs/deployment/phase-2c-31t-node-deep-readiness.md).
//
// `safe_to_load_data` is ALWAYS false — this probe never authorizes any data load.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { isEnabled } = require('../featureFlags');
const { checkRustHealth, isRustEnabled } = require('../services/rustAutomation/rustAutomationClient');

const DB_TIMEOUT_MS = 2000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label || 'timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// DB connectivity: a single `SELECT 1`, short-timeout, fail-closed.
// Returns 'ok' | 'fail' | 'skipped'. No table read, no schema write, no data exposure.
// Uses the SHARED application pool passed in — never opens a side connection.
async function checkDb(pool) {
  if (!pool) return 'skipped'; // DATABASE_URL not configured
  try {
    await withTimeout(pool.query('SELECT 1'), DB_TIMEOUT_MS, 'db_timeout');
    return 'ok';
  } catch (e) {
    return 'fail';
  }
}

// Node->Rust connectivity: reuse the existing safe client (GET Rust /health only).
// Returns 'ok' | 'fail' | 'disabled' | 'missing_url'. Never throws, never sends payload.
async function checkRust() {
  if (!isEnabled('rust_automation_api_enabled')) return 'disabled';
  if (!isRustEnabled()) return 'missing_url'; // flag on but RUST_AUTOMATION_BASE_URL absent
  try {
    const res = await checkRustHealth(); // null on any failure, { ok:true, ... } on success
    return res && res.ok === true ? 'ok' : 'fail';
  } catch (e) {
    return 'fail';
  }
}

// Build the safe readiness report. `requestId` is an opaque request correlation id only.
async function deepReadiness(pool, requestId) {
  const node = 'ok'; // if this code runs, the Node process is live
  const [db, rust] = await Promise.all([checkDb(pool), checkRust()]);

  // Ready when Node + DB are ok and Rust is not in a configured-but-broken state.
  // 'disabled' (sidecar intentionally off) is acceptable; 'fail'/'missing_url' is not.
  const success = node === 'ok' && db === 'ok' && (rust === 'ok' || rust === 'disabled');

  return {
    success,
    checks: { node, db, rust },
    safe_to_load_data: false, // this probe NEVER authorizes a data load
    timestamp: new Date().toISOString(),
    request_id: requestId || null,
  };
}

module.exports = { deepReadiness, checkDb, checkRust, DB_TIMEOUT_MS };
