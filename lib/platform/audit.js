'use strict';
// Append-only audit trail for administrative changes, agent lifecycle and
// approval decisions. Decision paths call record() with their transaction
// client so the decision and its audit row commit together.

const { safeLog } = require('../observability/logger');

const SECRET_KEY = /(secret|token|password|api[_-]?key|authorization)/i;

function scrub(value, depth = 0) {
  if (depth > 4 || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : scrub(v, depth + 1);
    return out;
  }
  if (typeof value === 'string') return value.slice(0, 2000);
  return value;
}

async function record(db, { organizationId, actorUserId = null, actorKind = 'user', action, resourceType, resourceId = null, detail = {} }) {
  await db.query(
    `INSERT INTO platform_audit_events (organization_id, actor_user_id, actor_kind, action, resource_type, resource_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [organizationId, actorUserId, actorKind, action, resourceType, resourceId == null ? null : String(resourceId), JSON.stringify(scrub(detail))],
  );
}

/** Best-effort audit for paths where the main write already committed. */
async function recordSoft(db, entry) {
  try { await record(db, entry); } catch (err) { safeLog('error', '[platform audit] not recorded', { action: entry.action, error: err.message }); }
}

async function list(db, organizationId, { cursor = null, limit = 50, resourceType = null, resourceId = null, actions = null } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const params = [organizationId];
  let where = 'a.organization_id = $1';
  if (cursor && /^\d+$/.test(String(cursor))) { params.push(Number(cursor)); where += ` AND a.id < $${params.length}`; }
  if (resourceType) { params.push(resourceType); where += ` AND a.resource_type = $${params.length}`; }
  if (resourceId) { params.push(String(resourceId)); where += ` AND a.resource_id = $${params.length}`; }
  if (actions) { params.push(actions); where += ` AND a.action = ANY($${params.length}::text[])`; }
  params.push(lim + 1);
  const { rows } = await db.query(
    `SELECT a.id, a.actor_user_id, a.actor_kind, a.action, a.resource_type, a.resource_id, a.detail, a.created_at, u.email AS actor_email
       FROM platform_audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE ${where} ORDER BY a.id DESC LIMIT $${params.length}`,
    params,
  );
  const more = rows.length > lim;
  const events = rows.slice(0, lim).map((r) => ({ ...r, id: String(r.id) }));
  return { events, nextCursor: more ? events[events.length - 1].id : null };
}

module.exports = { record, recordSoft, list, scrub };
