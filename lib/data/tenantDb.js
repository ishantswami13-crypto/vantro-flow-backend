'use strict';
// lib/data/tenantDb.js — the one way the data access layer opens a database
// transaction on behalf of a tenant.
//
// withTenant(userId, fn) runs fn(db) inside BEGIN/COMMIT on the shared pg pool
// (lib/db/pg.js) and, before fn runs, sets two transaction-local settings:
//
//   app.user_id        the tenant. Row-level security policies (a later PR) and
//                      triggers can read it with current_setting('app.user_id').
//   statement_timeout  so one slow query cannot hold a pooled connection.
//
// Both are set with set_config(..., is_local => true), i.e. SET LOCAL. They end
// with the transaction, so nothing leaks onto a pooled server connection. This
// matters: on 6 Oct 2026 a session-level SET search_path through the pooler
// broke production until the connection was recycled. Never use plain SET here.
//
// The userId must come from the verified JWT (req.user.id), never the request body.
//
// Row-level security: with STARLANE_DB_TENANT_ROLE=starlane_app (migration 095)
// the transaction also runs SET LOCAL ROLE starlane_app. That role cannot
// bypass RLS, so the data-layer tables' policies limit every statement to
// app.user_id even if its WHERE clause forgets the tenant. SET LOCAL ends with
// the transaction like the settings above.

const { getPool } = require('../db/pg');

const DEFAULT_TIMEOUT_MS = 15000;
const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;

function tenantRole(opts) {
  const role = opts.role !== undefined ? opts.role : process.env.STARLANE_DB_TENANT_ROLE;
  if (!role) return null;
  if (!ROLE.test(role)) throw new Error('withTenant: STARLANE_DB_TENANT_ROLE is not a valid role name');
  return role;
}
const MAX_TIMEOUT_MS = 120000;

function assertTenantId(userId) {
  if (userId === null || userId === undefined) throw new TypeError('withTenant: userId is required');
  const s = String(userId).trim();
  if (!s || s === 'undefined' || s === 'null') throw new TypeError('withTenant: userId is required');
  if (s.length > 128) throw new TypeError('withTenant: userId is too long');
  return s;
}

function clampTimeout(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.round(n), MAX_TIMEOUT_MS);
}

// A thin wrapper so callers get the tenant id alongside query(), and cannot
// release or end the underlying client themselves.
function tenantHandle(client, userId) {
  return Object.freeze({
    userId,
    query: (text, params) => client.query(text, params),
  });
}

async function withTenant(userId, fn, opts = {}) {
  const tenant = assertTenantId(userId);
  if (typeof fn !== 'function') throw new TypeError('withTenant: fn must be a function');
  const pool = opts.pool || getPool();
  const client = await pool.connect();
  try {
    const role = tenantRole(opts);
    await client.query(opts.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    if (role) await client.query(`SET LOCAL ROLE "${role}"`);
    await client.query(
      "SELECT set_config('app.user_id', $1, true), set_config('statement_timeout', $2, true)",
      [tenant, String(clampTimeout(opts.timeoutMs))]
    );
    const result = await fn(tenantHandle(client, tenant));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Read-only convenience: same guarantees, and Postgres refuses any write.
function readTenant(userId, fn, opts = {}) {
  return withTenant(userId, fn, { ...opts, readOnly: true });
}

module.exports = { withTenant, readTenant, assertTenantId, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS };
