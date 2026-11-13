'use strict';
// Organization context for every platform request.
//
// The JWT says who the caller is (req.user.userId). Which organization they
// act in is resolved here, never trusted from the client: a client may name
// one with the X-Starlane-Org header, and it is used only if the caller holds
// a membership in it. Without a header the caller's own organization is used
// (created on first use, exactly as the legacy getOrCreate does), then any
// other membership.
//
// The result is req.org = { id, role, ownerUserId, name, industry, onboarded }.

const { forbidden, badRequest, UUID_RE } = require('./errors');
const { can } = require('./roles');

async function ensureOwnOrganization(db, userId) {
  const existing = await db.query('SELECT id FROM organizations WHERE owner_user_id = $1', [userId]);
  let orgId = existing.rows[0]?.id;
  if (!orgId) {
    const ins = await db.query(
      `INSERT INTO organizations (owner_user_id, display_name, industry)
       SELECT u.id, NULLIF(btrim(u.business_name), ''), NULLIF(btrim(u.industry), '') FROM users u WHERE u.id = $1
       ON CONFLICT (owner_user_id) DO UPDATE SET updated_at = organizations.updated_at
       RETURNING id`,
      [userId],
    );
    orgId = ins.rows[0]?.id;
  }
  if (!orgId) return null;
  await db.query(
    `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')
     ON CONFLICT (organization_id, user_id) DO NOTHING`,
    [orgId, userId],
  );
  return orgId;
}

const ORG_SELECT = `SELECT o.id, o.owner_user_id, COALESCE(NULLIF(o.display_name, ''), NULLIF(o.legal_name, ''), u.business_name) AS name,
       o.legal_name, o.industry, o.operating_context, o.preferences, o.home_country, o.base_currency, o.timezone, o.onboarded_at, m.role
  FROM organization_members m
  JOIN organizations o ON o.id = m.organization_id
  JOIN users u ON u.id = o.owner_user_id`;

function shape(row) {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name || null,
    legalName: row.legal_name || null,
    industry: row.industry || null,
    operatingContext: row.operating_context || null,
    preferences: row.preferences || {},
    country: row.home_country || null,
    currency: row.base_currency || null,
    timezone: row.timezone || null,
    onboarded: !!row.onboarded_at,
    role: row.role,
  };
}

async function resolveOrganization(db, userId, requestedOrgId = null) {
  if (!userId) throw forbidden('Sign in again.', 'UNAUTHENTICATED');
  await ensureOwnOrganization(db, userId);
  if (requestedOrgId) {
    if (!UUID_RE.test(String(requestedOrgId))) throw badRequest('X-Starlane-Org must be an organization id');
    const { rows } = await db.query(`${ORG_SELECT} WHERE m.user_id = $1 AND m.organization_id = $2`, [userId, requestedOrgId]);
    if (!rows[0]) throw forbidden('You are not a member of that organization.', 'NOT_A_MEMBER');
    return shape(rows[0]);
  }
  const { rows } = await db.query(
    `${ORG_SELECT} WHERE m.user_id = $1 ORDER BY (o.owner_user_id = $1) DESC, m.created_at ASC LIMIT 1`,
    [userId],
  );
  if (!rows[0]) throw forbidden('No organization is available for this account.', 'NO_ORGANIZATION');
  return shape(rows[0]);
}

async function listMemberships(db, userId) {
  const { rows } = await db.query(`${ORG_SELECT} WHERE m.user_id = $1 ORDER BY (o.owner_user_id = $1) DESC, m.created_at ASC`, [userId]);
  return rows.map(shape);
}

/** Express middleware: sets req.org or answers 403. */
function orgContext(pool) {
  return async (req, res, next) => {
    try {
      const userId = req.user && (req.user.userId || req.user.id);
      req.org = await resolveOrganization(pool, userId, req.get('x-starlane-org') || null);
      next();
    } catch (err) {
      if (err.code === '42P01') {
        return res.status(503).json({ success: false, code: 'PLATFORM_NOT_READY', error: 'The workspace platform is not set up on this server yet (migration 072).' });
      }
      const status = err.status || 500;
      if (status === 500) console.error('[platform org context]', err.message);
      res.status(status).json({ success: false, code: err.code || 'INTERNAL', error: status === 500 ? 'Could not load your organization.' : err.message });
    }
  };
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.org || !can(req.org.role, permission)) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', error: 'Your role in this organization does not allow that.' });
    }
    next();
  };
}

/** User id of the authenticated caller. */
function actorId(req) {
  return req.user && (req.user.userId || req.user.id);
}

module.exports = { resolveOrganization, ensureOwnOrganization, listMemberships, orgContext, requirePermission, actorId };
