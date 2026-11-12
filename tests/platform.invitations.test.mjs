// Organization invitations (migration 073) through the real /api/platform
// router: invite someone without an account, the link works only for the
// invited and verified email, it is single use, revocable and expires;
// email is sent only when asked and reported honestly. Needs DATABASE_URL.
import { createRequire } from 'node:module';
import { makeChecker, openPool, seedUser, deleteUsers } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');
const { platformRouter } = require('../lib/routes/platform');

const { check, done } = makeChecker();
const pool = openPool();
const ready = await pool.query(`SELECT to_regclass('public.platform_invitations') AS t`);
if (!ready.rows[0].t) { console.log('SKIP migration 073 not applied'); process.exit(0); }

const sent = [];
const fakeSend = async (m) => { sent.push(m); return true; };
function testAuth(req, res, next) {
  try { req.user = jwt.verify((req.get('authorization') || '').replace(/^Bearer /, ''), process.env.JWT_SECRET); next(); } catch { res.status(401).json({ error: 'auth' }); }
}
const app = express();
app.use(express.json());
app.use('/api/platform', platformRouter({ pool, authMiddleware: testAuth, sendEmail: fakeSend }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/platform`;
const api = async (u, method, path, body, org) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.token}`, ...(org ? { 'X-Starlane-Org': org } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch { /* empty */ }
  return { http: r.status, ...j };
};
const created = [];
const user = async (label, { verified = true, email = null } = {}) => {
  const u = await seedUser(pool, label); created.push(u.id);
  if (email) { await pool.query('UPDATE users SET email = $2 WHERE id = $1', [u.id, email]); u.email = email; }
  await pool.query('UPDATE users SET email_verified = $2 WHERE id = $1', [u.id, verified]);
  return u;
};
const tokenOf = (url) => url.split('/invite/')[1];
const savedKey = process.env.RESEND_API_KEY;

try {
  const owner = await user('inv-owner');
  const ws = await api(owner, 'GET', '/workspace');
  const orgId = ws.organization.id;
  const newEmail = `newcomer-${randomUUID().slice(0, 8)}@test.starlane.invalid`;

  delete process.env.RESEND_API_KEY;
  const inv = await api(owner, 'POST', '/invitations', { email: newEmail.toUpperCase(), memberRole: 'member', sendEmail: true });
  check('owner invites an email with no account yet', inv.http === 201 && inv.url.includes('/invite/') && inv.invitation.email === newEmail, inv);
  check('without an email provider nothing is sent, and it says so', inv.emailSent === false && /not set up/.test(inv.emailNote) && sent.length === 0, inv);
  check('only the token hash is stored', (await pool.query('SELECT token_hash FROM platform_invitations WHERE id = $1', [inv.invitation.id])).rows[0].token_hash !== tokenOf(inv.url));
  check('a second open invite for the same email is refused', (await api(owner, 'POST', '/invitations', { email: newEmail, memberRole: 'viewer' })).code === 'ALREADY_INVITED');
  const listed = await api(owner, 'GET', '/invitations');
  check('pending invitations are listed without the token', listed.invitations.some((i) => i.id === inv.invitation.id && i.status === 'pending') && !JSON.stringify(listed).includes(tokenOf(inv.url)));

  const stranger = await user('inv-stranger');
  const peek = await api(stranger, 'GET', `/invitations/by-token/${tokenOf(inv.url)}`);
  check('another account sees the organization but not the invited email', peek.http === 200 && peek.invitation.emailMatches === false && peek.invitation.invitedEmail === null, peek);
  check('another account cannot accept a forwarded link', (await api(stranger, 'POST', `/invitations/by-token/${tokenOf(inv.url)}/accept`, {})).code === 'WRONG_ACCOUNT');
  check('a made-up token is not found', (await api(stranger, 'GET', `/invitations/by-token/${'x'.repeat(43)}`)).http === 404);

  const unverified = await user('inv-unverified', { verified: false, email: newEmail });
  check('an unverified account with the email cannot accept', (await api(unverified, 'POST', `/invitations/by-token/${tokenOf(inv.url)}/accept`, {})).code === 'EMAIL_NOT_VERIFIED');
  await pool.query('UPDATE users SET email_verified = TRUE WHERE id = $1', [unverified.id]);
  const ok = await api(unverified, 'POST', `/invitations/by-token/${tokenOf(inv.url)}/accept`, {});
  check('the invited, verified account joins with the invited role', ok.http === 200 && ok.organizationId === orgId && ok.role === 'member', ok);
  const theirWs = await api(unverified, 'GET', '/workspace', undefined, orgId);
  check('they now work in the organization as a member', theirWs.http === 200 && theirWs.role === 'member', theirWs);
  check('the link is single use', (await api(unverified, 'POST', `/invitations/by-token/${tokenOf(inv.url)}/accept`, {})).code === 'INVITATION_USED');
  check('inviting an existing member is refused', (await api(owner, 'POST', '/invitations', { email: newEmail, memberRole: 'viewer' })).code === 'ALREADY_MEMBER');
  check('a member cannot invite', (await api(unverified, 'POST', '/invitations', { email: 'x@test.starlane.invalid', memberRole: 'viewer' }, orgId)).http === 403);

  process.env.RESEND_API_KEY = 'test-key-not-real';
  const mailed = await api(owner, 'POST', '/invitations', { email: `mailed-${randomUUID().slice(0, 6)}@test.starlane.invalid`, memberRole: 'viewer', sendEmail: true });
  check('with a provider and the box ticked, the invite is emailed with the link', mailed.emailSent === true && sent.length === 1 && sent[0].text.includes(mailed.url), { mailed, sent });
  const quiet = await api(owner, 'POST', '/invitations', { email: `quiet-${randomUUID().slice(0, 6)}@test.starlane.invalid`, memberRole: 'viewer' });
  check('nothing is emailed unless asked', quiet.emailSent === false && sent.length === 1);

  check('revoke', (await api(owner, 'DELETE', `/invitations/${quiet.invitation.id}`)).http === 200);
  const quietUser = await user('inv-quiet', { email: quiet.invitation.email });
  check('a revoked link cannot be used', (await api(quietUser, 'POST', `/invitations/by-token/${tokenOf(quiet.url)}/accept`, {})).code === 'INVITATION_REVOKED');
  await pool.query(`UPDATE platform_invitations SET expires_at = NOW() - interval '1 minute' WHERE id = $1`, [mailed.invitation.id]);
  const mailedUser = await user('inv-mailed', { email: mailed.invitation.email });
  check('an expired link cannot be used', (await api(mailedUser, 'POST', `/invitations/by-token/${tokenOf(mailed.url)}/accept`, {})).code === 'INVITATION_EXPIRED');

  const other = await user('inv-other');
  check('another organization cannot revoke or list these invitations', (await api(other, 'DELETE', `/invitations/${inv.invitation.id}`)).http === 404 && (await api(other, 'GET', '/invitations')).invitations.length === 0);
  const adminInvite = await api(owner, 'POST', '/invitations', { email: `adm-${randomUUID().slice(0, 6)}@test.starlane.invalid`, memberRole: 'admin' });
  check('the owner can invite an admin', adminInvite.http === 201);
  const audits = await pool.query(`SELECT action FROM platform_audit_events WHERE organization_id = $1 AND action LIKE 'member.%'`, [orgId]);
  check('invites, revokes and joins are audited', ['member.invited', 'member.invitation_revoked', 'member.joined'].every((a) => audits.rows.some((r) => r.action === a)), audits.rows);
} catch (err) {
  check('threw', false, err.stack);
} finally {
  if (savedKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = savedKey;
  server.close();
  await pool.query('DELETE FROM platform_invitations WHERE invited_by = ANY($1::uuid[])', [created]).catch(() => {});
  await deleteUsers(pool, created);
  await pool.end();
  done();
}
