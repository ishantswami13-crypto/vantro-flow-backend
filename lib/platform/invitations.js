'use strict';
// Organization invitations (migration 073). An admin invites an email
// address with a role; the person may not have a Starlane account yet. The
// invite token is random, shown once in the link, and stored only as a
// SHA-256 hash. Accepting needs a signed-in account whose verified email is
// the invited one, so a forwarded link is useless to anyone else. Email is
// sent only when the admin asks and a provider is configured; the answer
// says honestly whether it went.

const crypto = require('crypto');
const audit = require('./audit');
const { badRequest, forbidden, notFound, conflict, assertUuid } = require('./errors');

const ASSIGNABLE = ['admin', 'member', 'viewer'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const TOKEN_RE = /^[A-Za-z0-9_-]{40,64}$/;

function appUrl(env = process.env) {
  return String(env.FRONTEND_URL || env.PUBLIC_APP_URL || 'https://vantro-flow-frontend.vercel.app').replace(/\/+$/, '');
}

function shape(r) {
  const status = r.accepted_at ? 'accepted' : r.revoked_at ? 'revoked' : new Date(r.expires_at) < new Date() ? 'expired' : 'pending';
  return {
    id: r.id, email: r.email, role: r.role, status, emailSent: r.email_sent, invitedByEmail: r.invited_by_email || null,
    createdAt: r.created_at, expiresAt: r.expires_at, acceptedAt: r.accepted_at, revokedAt: r.revoked_at,
  };
}

async function create(db, org, actor, { email, memberRole, sendEmail = false } = {}, { send = null, env = process.env } = {}) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || e.length > 254 || !EMAIL_RE.test(e)) throw badRequest('Enter a valid email address');
  if (!ASSIGNABLE.includes(memberRole)) throw badRequest('Role must be admin, member or viewer');
  if (memberRole === 'admin' && org.role !== 'owner') throw forbidden('Only the owner can invite an admin.');
  const existing = await db.query(
    `SELECT 1 FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 AND lower(u.email) = $2`, [org.id, e]);
  if (existing.rows[0]) throw conflict('That person is already a member of this organization.', 'ALREADY_MEMBER');

  const token = crypto.randomBytes(32).toString('base64url');
  let row;
  try {
    ({ rows: [row] } = await db.query(
      `INSERT INTO platform_invitations (organization_id, email, role, token_hash, invited_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [org.id, e, memberRole, hash(token), actor],
    ));
  } catch (err) {
    if (err.code === '23505') throw conflict('There is already an open invitation for that email. Revoke it to send a new one.', 'ALREADY_INVITED');
    throw err;
  }
  const url = `${appUrl(env)}/invite/${token}`;
  let emailSent = false;
  let emailNote = null;
  if (sendEmail) {
    if (!env.RESEND_API_KEY) emailNote = 'Email is not set up on this server (RESEND_API_KEY), so nothing was sent. Share the link yourself.';
    else {
      const deliver = send || require('../access/notify').sendAccessEmail;
      const orgName = org.name || 'an organization';
      emailSent = await deliver({
        to: e,
        subject: `You're invited to ${orgName} on Starlane`,
        text: `You have been invited to join ${orgName} on Starlane as ${memberRole === 'admin' ? 'an admin' : `a ${memberRole}`}.\n\nOpen this link and sign in (or create an account) with ${e} to accept:\n${url}\n\nThe link expires in 7 days.`,
      }).catch(() => false);
      if (emailSent) await db.query('UPDATE platform_invitations SET email_sent = TRUE WHERE id = $1', [row.id]);
      else emailNote = 'The email provider did not accept the message. Share the link yourself.';
    }
  }
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: actor, action: 'member.invited', resourceType: 'invitation', resourceId: row.id, detail: { role: memberRole, emailSent } });
  return { invitation: shape({ ...row, email_sent: emailSent }), url, emailSent, emailNote };
}

async function list(db, org) {
  const { rows } = await db.query(
    `SELECT i.*, u.email AS invited_by_email FROM platform_invitations i LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.organization_id = $1 AND (i.accepted_at IS NULL OR i.accepted_at > NOW() - interval '30 days')
      ORDER BY i.created_at DESC LIMIT 100`, [org.id]);
  return rows.map(shape);
}

async function revoke(db, org, actor, id) {
  assertUuid(id, 'invitationId');
  const { rows } = await db.query(
    'SELECT role FROM platform_invitations WHERE organization_id = $1 AND id = $2 AND accepted_at IS NULL AND revoked_at IS NULL', [org.id, id]);
  if (!rows[0]) throw notFound('That open invitation');
  if (rows[0].role === 'admin' && org.role !== 'owner') throw forbidden('Only the owner can revoke an admin invitation.');
  await db.query('UPDATE platform_invitations SET revoked_at = NOW() WHERE organization_id = $1 AND id = $2 AND accepted_at IS NULL', [org.id, id]);
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: actor, action: 'member.invitation_revoked', resourceType: 'invitation', resourceId: id });
}

async function lookup(db, token) {
  if (!TOKEN_RE.test(String(token || ''))) throw notFound('That invitation');
  const { rows } = await db.query(
    `SELECT i.*, COALESCE(NULLIF(o.display_name, ''), NULLIF(o.legal_name, ''), u.business_name) AS organization_name
       FROM platform_invitations i JOIN organizations o ON o.id = i.organization_id JOIN users u ON u.id = o.owner_user_id WHERE i.token_hash = $1`, [hash(token)]);
  if (!rows[0]) throw notFound('That invitation');
  return rows[0];
}

async function accountOf(db, userId) {
  const { rows } = await db.query('SELECT id, lower(email) AS email, email_verified FROM users WHERE id = $1', [userId]);
  return rows[0] || null;
}

/** What the accept page shows. Requires sign-in; never reveals the email to someone else. */
async function preview(db, userId, token) {
  const inv = await lookup(db, token);
  const me = await accountOf(db, userId);
  const emailMatches = !!me && me.email === inv.email;
  return {
    organizationName: inv.organization_name, role: inv.role, status: shape(inv).status, expiresAt: inv.expires_at,
    emailMatches, emailVerified: !!me?.email_verified, invitedEmail: emailMatches ? inv.email : null,
  };
}

async function accept(db, userId, token) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (!TOKEN_RE.test(String(token || ''))) throw notFound('That invitation');
    const { rows: [inv] } = await client.query('SELECT * FROM platform_invitations WHERE token_hash = $1 FOR UPDATE', [hash(token)]);
    if (!inv) throw notFound('That invitation');
    const status = shape(inv).status;
    if (status === 'accepted') throw conflict('This invitation was already used.', 'INVITATION_USED');
    if (status === 'revoked') throw conflict('This invitation was revoked. Ask for a new one.', 'INVITATION_REVOKED');
    if (status === 'expired') throw conflict('This invitation expired. Ask for a new one.', 'INVITATION_EXPIRED');
    const me = await accountOf(client, userId);
    if (!me || me.email !== inv.email) throw forbidden('This invitation is for a different email address. Sign in with the invited email to accept it.', 'WRONG_ACCOUNT');
    if (me.email_verified !== true) throw forbidden('Verify your email address first, then open the invitation again.', 'EMAIL_NOT_VERIFIED');
    const ins = await client.query(
      `INSERT INTO organization_members (organization_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, user_id) DO NOTHING RETURNING user_id`, [inv.organization_id, userId, inv.role, inv.invited_by]);
    await client.query('UPDATE platform_invitations SET accepted_at = NOW(), accepted_by = $2 WHERE id = $1', [inv.id, userId]);
    await audit.record(client, { organizationId: inv.organization_id, actorUserId: userId, action: 'member.joined', resourceType: 'member', resourceId: userId, detail: { role: inv.role, invitationId: inv.id, alreadyMember: !ins.rows[0] } });
    await client.query('COMMIT');
    return { organizationId: inv.organization_id, role: inv.role, alreadyMember: !ins.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { create, list, revoke, preview, accept, appUrl };
