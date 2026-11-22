'use strict';
// An organization's rule for who must sign in with a second factor.
//
//   none       no requirement (default)
//   admins     owners and admins
//   everyone   every member
//
// "Signed in with a second factor" means the session came from a sign-in that
// passed an authenticator code or recovery code (claim mfa: true), or from
// this organization's single sign-on (claim sso: <organization id>), where
// the identity provider is responsible for its own factors.
//
// A member whose session does not satisfy the rule can still load the
// workspace (to see why) and manage their own sign-in methods under
// /api/auth/mfa, but every other platform request answers 403 MFA_REQUIRED.

const audit = require('../audit');
const { atLeast } = require('../roles');
const { badRequest, forbidden } = require('../errors');

const VALUES = ['none', 'admins', 'everyone'];
const cache = new Map(); // orgId -> { at, value }
const TTL_MS = 30_000;

async function getPolicy(db, orgId, { fresh = false } = {}) {
  const hit = cache.get(orgId);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value = 'none';
  try {
    const { rows } = await db.query('SELECT mfa_required_for FROM organizations WHERE id = $1', [orgId]);
    value = rows[0]?.mfa_required_for || 'none';
  } catch (err) {
    if (err.code !== '42703') throw err; // column missing: migration 076 not applied
  }
  cache.set(orgId, { at: Date.now(), value });
  return value;
}

const applies = (policy, role) => policy === 'everyone' || (policy === 'admins' && atLeast(role, 'admin'));
const satisfied = (claims, orgId) => !!claims && (claims.mfa === true || (typeof claims.sso === 'string' && claims.sso === orgId));

async function setPolicy(db, org, userId, claims, value) {
  if (!VALUES.includes(value)) throw badRequest('Choose none, admins or everyone.');
  // Whoever turns the rule on must already meet it, so they cannot lock themselves out.
  if (value !== 'none' && applies(value, org.role) && !satisfied(claims, org.id)) {
    throw forbidden('Turn on two-step sign-in for your own account and sign in with it first.', 'MFA_REQUIRED');
  }
  await db.query('UPDATE organizations SET mfa_required_for = $2, updated_at = NOW() WHERE id = $1', [org.id, value]);
  cache.delete(org.id);
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: userId, action: 'security.mfa_policy_changed', resourceType: 'organization', resourceId: org.id, detail: { requiredFor: value } });
  return { requiredFor: value };
}

/** Express middleware for the platform router, after orgContext. */
function gate(pool, { allow = (req) => req.method === 'GET' && req.path === '/workspace' } = {}) {
  return async (req, res, next) => {
    try {
      const policy = await getPolicy(pool, req.org.id);
      req.mfaPolicy = policy;
      req.mfaSatisfied = !applies(policy, req.org.role) || satisfied(req.user, req.org.id);
      if (req.mfaSatisfied || allow(req)) return next();
      return res.status(403).json({ success: false, code: 'MFA_REQUIRED', error: 'This organization requires two-step sign-in. Turn it on for your account and sign in again.' });
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { VALUES, getPolicy, setPolicy, applies, satisfied, gate };
