'use strict';
// Data subject rights (GDPR Art. 15/17/20, CCPA right to know and to delete).
//
// Export ("right of access / portability")
//   scope 'me'            every row in any table that has a user_id column
//                         equal to the caller. Any member can ask for this.
//   scope 'organization'  every row for the organization's owner account
//                         (user_id) and every row with organization_id equal
//                         to the organization. Owner only.
//   The table list is read from the database catalog at request time, so a
//   new table is included without anyone remembering to add it. Columns that
//   hold secrets or secret hashes are replaced with "[withheld]".
//
// Erasure ("right to be forgotten")
//   Deletes the caller's account and the organization they own. It is
//   scheduled ERASURE_GRACE_DAYS ahead (default 7) and can be cancelled until
//   then. It only runs when FEATURE_PRIVACY_ERASURE_ENABLED is on, because
//   business records may be under a legal duty to be kept (tax and accounting
//   rules); the operator decides that before switching it on. A receipt (no
//   personal data: an email hash and per-table counts) is kept.

const crypto = require('crypto');
const audit = require('../audit');
const { badRequest, forbidden, notFound, conflict, UUID_RE } = require('../errors');

const SECRET_COLUMN = /(_enc$|_hash$|password|secret|token|^otp|code_verifier|api_key|private_key)/i;
const MAX_ROWS_PER_TABLE = 5000;
const SKIP_TABLES = new Set(['schema_migrations', 'platform_privacy_requests']);

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;

function graceDays(env = process.env) {
  const n = Number(env.ERASURE_GRACE_DAYS);
  return Number.isFinite(n) && n >= 0 && n <= 30 ? n : 7;
}

function erasureEnabled() {
  try { return require('../../featureFlags').isEnabled('privacy_erasure_enabled') === true; } catch { return false; }
}

async function tablesWith(db, column) {
  const { rows } = await db.query(
    `SELECT c.table_name::text AS table_name, array_agg(c2.column_name::text ORDER BY c2.ordinal_position) AS columns
       FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
       JOIN information_schema.columns c2 ON c2.table_schema = c.table_schema AND c2.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = $1
      GROUP BY c.table_name ORDER BY c.table_name`,
    [column],
  );
  return rows.filter((r) => !SKIP_TABLES.has(r.table_name));
}

async function dumpTable(db, table, columns, column, value) {
  const select = columns.map((c) => (SECRET_COLUMN.test(c) ? `CASE WHEN ${ident(c)} IS NULL THEN NULL ELSE '[withheld]' END AS ${ident(c)}` : ident(c))).join(', ');
  const { rows } = await db.query(`SELECT ${select} FROM ${ident(table)} WHERE ${ident(column)} = $1 LIMIT ${MAX_ROWS_PER_TABLE + 1}`, [value]);
  return { rows: rows.slice(0, MAX_ROWS_PER_TABLE), truncated: rows.length > MAX_ROWS_PER_TABLE };
}

async function exportData(db, org, userId, { scope = 'me' } = {}) {
  if (!['me', 'organization'].includes(scope)) throw badRequest('scope must be me or organization');
  if (scope === 'organization' && org.role !== 'owner') throw forbidden('Only the organization\'s owner can export all of its data.');
  const subjectUserId = scope === 'me' ? userId : org.ownerUserId;
  const tables = {};
  for (const t of await tablesWith(db, 'user_id')) {
    const out = await dumpTable(db, t.table_name, t.columns, 'user_id', subjectUserId).catch((err) => ({ error: err.code || 'unreadable' }));
    if (out.error || out.rows.length) tables[t.table_name] = out;
  }
  if (scope === 'organization') {
    for (const t of await tablesWith(db, 'organization_id')) {
      const out = await dumpTable(db, t.table_name, t.columns, 'organization_id', org.id).catch((err) => ({ error: err.code || 'unreadable' }));
      if (out.error || out.rows.length) tables[t.table_name] = out;
    }
  }
  const account = await db.query('SELECT id, email, business_name, created_at FROM users WHERE id = $1', [subjectUserId]).then((r) => r.rows[0] || null).catch(() => null);
  const counts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.rows ? v.rows.length : 0]));
  await db.query(
    `INSERT INTO platform_privacy_requests (organization_id, requested_by, kind, scope, status, completed_at, subject_email_hash, result)
     VALUES ($1,$2,'export',$3,'completed',NOW(),$4,$5)`,
    [org.id, userId, scope, account?.email ? sha256(String(account.email).toLowerCase()) : null, JSON.stringify({ tables: counts })],
  );
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: userId, action: 'privacy.export', resourceType: 'privacy', detail: { scope, tables: Object.keys(counts).length } });
  return {
    format: 'starlane-data-export/1',
    generatedAt: new Date().toISOString(),
    scope,
    organization: scope === 'organization' ? { id: org.id, name: org.name } : undefined,
    account,
    note: 'Columns holding secrets (encrypted credentials, password and token hashes) are withheld. Tables with more than 5,000 rows for you are cut at 5,000 and marked truncated; ask support for the full set.',
    tables,
  };
}

async function listRequests(db, org, userId, { all = false } = {}) {
  const { rows } = await db.query(
    `SELECT id, kind, scope, status, scheduled_for, completed_at, result, created_at, requested_by = $2 AS mine
       FROM platform_privacy_requests WHERE organization_id = $1 AND ($3 OR requested_by = $2) ORDER BY created_at DESC LIMIT 50`,
    [org.id, userId, all],
  );
  return rows;
}

async function ownOrganizationId(db, userId) {
  const { rows } = await db.query('SELECT id FROM organizations WHERE owner_user_id = $1', [userId]);
  return rows[0]?.id || null;
}

/**
 * Schedules erasure of the caller's own account and the organization they
 * own. `confirmEmail` must equal the account's email.
 */
async function requestErasure(db, userId, { confirmEmail } = {}) {
  const u = await db.query('SELECT email FROM users WHERE id = $1', [userId]);
  const email = u.rows[0]?.email;
  if (!email) throw notFound('Your account');
  if (String(confirmEmail || '').trim().toLowerCase() !== String(email).toLowerCase()) throw badRequest('Type your account email exactly to confirm.');
  const orgId = await ownOrganizationId(db, userId);
  if (!orgId) throw notFound('Your organization');
  const existing = await db.query(`SELECT id FROM platform_privacy_requests WHERE requested_by = $1 AND kind = 'erasure' AND status = 'scheduled'`, [userId]);
  if (existing.rows[0]) throw conflict('An erasure is already scheduled for this account.');
  const when = new Date(Date.now() + graceDays() * 86400000);
  const { rows } = await db.query(
    `INSERT INTO platform_privacy_requests (organization_id, requested_by, kind, scope, status, scheduled_for, subject_email_hash)
     VALUES ($1,$2,'erasure','me','scheduled',$3,$4) RETURNING id, kind, scope, status, scheduled_for, created_at`,
    [orgId, userId, when, sha256(String(email).toLowerCase())],
  );
  await audit.recordSoft(db, { organizationId: orgId, actorUserId: userId, action: 'privacy.erasure_scheduled', resourceType: 'privacy', resourceId: rows[0].id, detail: { scheduledFor: when.toISOString() } });
  return { request: rows[0], willRun: erasureEnabled(), note: erasureEnabled() ? null : 'Erasure is not switched on for this server yet (FEATURE_PRIVACY_ERASURE_ENABLED). The request is kept and runs once it is.' };
}

async function cancelErasure(db, userId, id) {
  if (!UUID_RE.test(String(id || ''))) throw notFound('That request');
  const { rows } = await db.query(
    `UPDATE platform_privacy_requests SET status = 'cancelled', completed_at = NOW()
      WHERE id = $1 AND requested_by = $2 AND kind = 'erasure' AND status = 'scheduled' RETURNING organization_id`, [id, userId]);
  if (!rows[0]) throw notFound('A scheduled erasure with that id');
  await audit.recordSoft(db, { organizationId: rows[0].organization_id, actorUserId: userId, action: 'privacy.erasure_cancelled', resourceType: 'privacy', resourceId: id });
  return { cancelled: true };
}

/** Deletes one account and its organization in a single transaction. */
async function eraseAccount(pool, req) {
  const client = await pool.connect();
  const counts = {};
  try {
    await client.query('BEGIN');
    const userId = req.requested_by;
    // Rows that point at the user without ON DELETE CASCADE.
    for (const t of await tablesWith(client, 'user_id')) {
      if (t.table_name === 'users') continue;
      await client.query('SAVEPOINT t');
      try {
        const r = await client.query(`DELETE FROM ${ident(t.table_name)} WHERE user_id = $1`, [userId]);
        if (r.rowCount) counts[t.table_name] = r.rowCount;
        await client.query('RELEASE SAVEPOINT t');
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT t');
      }
    }
    const org = await client.query('DELETE FROM organizations WHERE owner_user_id = $1 RETURNING id', [userId]);
    counts.organizations = org.rowCount;
    const u = await client.query('DELETE FROM users WHERE id = $1', [userId]);
    counts.users = u.rowCount;
    await client.query(
      `UPDATE platform_privacy_requests SET status = 'completed', completed_at = NOW(), result = $2 WHERE id = $1`,
      [req.id, JSON.stringify({ deleted: counts })],
    );
    await client.query('COMMIT');
    return { ok: true, counts };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await pool.query(`UPDATE platform_privacy_requests SET status = 'failed', result = $2 WHERE id = $1`, [req.id, JSON.stringify({ error: String(err.code || err.message).slice(0, 200) })]).catch(() => {});
    return { ok: false, error: err.message };
  } finally {
    client.release();
  }
}

/** Runs erasures whose grace period has passed. Called by the scheduler. */
async function runDueErasures(pool, { now = new Date(), enabled = erasureEnabled() } = {}) {
  if (!enabled) return { ran: 0, skipped: 'FEATURE_PRIVACY_ERASURE_ENABLED is off' };
  const { rows } = await pool.query(
    `SELECT * FROM platform_privacy_requests WHERE kind = 'erasure' AND status = 'scheduled' AND scheduled_for <= $1 ORDER BY scheduled_for LIMIT 20`, [now]);
  const results = [];
  for (const r of rows) results.push({ id: r.id, ...(await eraseAccount(pool, r)) });
  return { ran: results.length, results };
}

module.exports = { exportData, listRequests, requestErasure, cancelErasure, runDueErasures, erasureEnabled, graceDays, SECRET_COLUMN };
