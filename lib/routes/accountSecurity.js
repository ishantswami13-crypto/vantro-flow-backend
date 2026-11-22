'use strict';
// Two-step sign-in (authenticator app) and organization single sign-on.
//
//   POST /api/auth/mfa/verify            { mfaToken, code }  second step of a sign-in -> session
//   GET  /api/auth/mfa          (auth)   status for the signed-in account
//   POST /api/auth/mfa/setup    (auth)   new secret + otpauth URI (shown once)
//   POST /api/auth/mfa/confirm  (auth)   { code } turns it on -> recovery codes + a session that counts as MFA
//   POST /api/auth/mfa/disable  (auth)   { code }
//   POST /api/auth/mfa/recovery-codes (auth) { code } replaces the recovery codes
//   POST /api/auth/sso/start             { email } -> { authorizeUrl }
//   GET  /api/auth/sso/callback          the identity provider's redirect
//   POST /api/auth/sso/exchange          { id, code } single-use code from the callback -> session
//   GET  /api/auth/sso/saml/metadata     Starlane's SAML service provider metadata (XML)
//   POST /api/auth/sso/saml/acs          the SAML identity provider's POST (SAMLResponse, RelayState)
//
//   Passkeys (lib/auth/passkeys.js)
//   POST /api/auth/passkey/options               options for a passkey sign-in (no account named)
//   POST /api/auth/passkey/verify     { response } -> session (counts as two-step)
//   POST /api/auth/mfa/passkey/options { mfaToken } options for the second step
//   POST /api/auth/mfa/passkey/verify  { mfaToken, response } -> session
//   GET  /api/auth/passkeys            (auth) this account's passkeys
//   POST /api/auth/passkeys/options    (auth) start adding one
//   POST /api/auth/passkeys            (auth) { response, name } finish adding one
//   PATCH/DELETE /api/auth/passkeys/:id (auth)
//
//   Sessions (lib/auth/webSessions.js)
//   GET    /api/auth/account-sessions  (auth) where this account is signed in (web and apps)
//   DELETE /api/auth/account-sessions/:id (auth) end one
//   POST   /api/auth/account-sessions/sign-out-everywhere (auth) end all, then a fresh session here
//
// Adding or removing a second factor (authenticator, passkey) from an account
// that already has one needs a session that passed it (mfa) or came from SSO,
// so a password alone cannot swap out the account's second step.
//
// A sign-in that needs a second step gets { mfaRequired: true, mfaToken }
// instead of a session. The mfaToken is a 5-minute JWT signed with a key
// derived from JWT_SECRET for this purpose only, so it can never pass the
// normal session check; it only names the account waiting for its code.
// Sessions issued here carry mfa: true or sso: <organization id>, which
// an organization's MFA rule checks (lib/platform/security/mfaPolicy.js).

const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const mfa = require('../auth/mfa');
const sso = require('../auth/sso');
const codes = require('../auth/oneTimeCodes');
const passkeys = require('../auth/passkeys');
const webSessions = require('../auth/webSessions');
const saml = require('../auth/saml');

const USER_COLS = 'id, email, phone, business_name, plan, created_at';
const MFA_TOKEN_TTL = '5m';

function pendingKey(jwtSecret) {
  return crypto.createHmac('sha256', String(jwtSecret)).update('starlane:mfa-pending:v1').digest('hex');
}

/** Whether the account has any second factor: an authenticator app or a passkey. */
async function hasSecondFactor(pool, userId) {
  return (await mfa.isEnabled(pool, userId)) || (await passkeys.count(pool, userId)) > 0;
}

/** What a sign-in returns when the account has two-step sign-in on. */
function mfaChallenge(jwtSecret, user, method, methods = ['totp']) {
  return {
    mfaRequired: true,
    methods,
    mfaToken: jwt.sign({ sub: user.id, purpose: 'mfa', method: String(method || 'password').slice(0, 20) }, pendingKey(jwtSecret), { expiresIn: MFA_TOKEN_TTL, algorithm: 'HS256' }),
  };
}

function sendErr(res, err) {
  const status = err.status || 500;
  if (status >= 500 && status !== 503) console.error('[account security]', err.message);
  res.status(status).json({ success: false, code: err.code || 'INTERNAL', error: status >= 500 && status !== 503 ? 'Something went wrong. Try again.' : err.message });
}

function accountSecurityRouter({ pool, authMiddleware, jwtSecret, signSession, apiBase, appBase }) {
  const r = express.Router();
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Try again in a few minutes.' } });
  const uid = (req) => req.user && (req.user.userId || req.user.id);
  const redirectUri = (req) => `${apiBase(req)}/api/auth/sso/callback`;
  const loadUser = async (id) => (await pool.query(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id])).rows[0] || null;

  // ── Second step of a sign-in ───────────────────────────────────────────
  r.post('/auth/mfa/verify', limiter, async (req, res) => {
    let claims;
    try { claims = jwt.verify(String(req.body?.mfaToken || ''), pendingKey(jwtSecret), { algorithms: ['HS256'] }); } catch {
      return res.status(401).json({ success: false, code: 'MFA_TOKEN_INVALID', error: 'The sign-in took too long. Start again.' });
    }
    if (claims.purpose !== 'mfa') return res.status(401).json({ success: false, code: 'MFA_TOKEN_INVALID', error: 'Start the sign-in again.' });
    try {
      const out = await mfa.verify(pool, claims.sub, req.body?.code);
      const user = await loadUser(claims.sub);
      if (!user) return res.status(401).json({ success: false, error: 'This account no longer exists.' });
      res.json({ success: true, ...(await signSession(res, user, { mfa: true, method: claims.method })), user, method: out.method, recoveryCodesLeft: out.recoveryCodesLeft });
    } catch (err) { sendErr(res, err); }
  });

  // ── Managing your own second factor ────────────────────────────────────
  r.get('/auth/mfa', authMiddleware, async (req, res) => {
    try { res.json({ success: true, ...(await mfa.status(pool, uid(req))), passkeys: await passkeys.count(pool, uid(req)), sessionVerified: req.user.mfa === true || !!req.user.sso }); } catch (err) { sendErr(res, err); }
  });
  r.post('/auth/mfa/setup', authMiddleware, limiter, async (req, res) => {
    try { await requireSecondStep(req); res.json({ success: true, ...(await mfa.beginSetup(pool, uid(req), req.user.email)) }); } catch (err) { sendErr(res, err); }
  });
  // A new session for this browser that replaces the one making the request,
  // so the device list shows one row for it, not two.
  async function upgradeSession(req, res, user, claims) {
    const out = await signSession(res, user, claims);
    if (req.user?.wsid) await webSessions.revoke(pool, user.id, req.user.wsid).catch(() => {});
    return out;
  }
  r.post('/auth/mfa/confirm', authMiddleware, limiter, async (req, res) => {
    try {
      const out = await mfa.confirmSetup(pool, uid(req), req.body?.code);
      const user = await loadUser(uid(req));
      // The person just proved the factor, so this session counts as MFA.
      res.json({ success: true, recoveryCodes: out.recoveryCodes, ...(await upgradeSession(req, res, user, { mfa: true, method: 'password' })), user });
    } catch (err) { sendErr(res, err); }
  });
  r.post('/auth/mfa/disable', authMiddleware, limiter, async (req, res) => {
    try { res.json({ success: true, ...(await mfa.disable(pool, uid(req), req.body?.code)) }); } catch (err) { sendErr(res, err); }
  });
  r.post('/auth/mfa/recovery-codes', authMiddleware, limiter, async (req, res) => {
    try { res.json({ success: true, ...(await mfa.regenerateRecoveryCodes(pool, uid(req), req.body?.code)) }); } catch (err) { sendErr(res, err); }
  });

  // ── Single sign-on ─────────────────────────────────────────────────────
  r.post('/auth/sso/start', limiter, async (req, res) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (!email.includes('@') || email.length > 254) return res.status(400).json({ success: false, error: 'Enter your work email.' });
      res.json({ success: true, ...(await sso.start(pool, { email, redirectUri: redirectUri(req) })) });
    } catch (err) { sendErr(res, err); }
  });

  const backTo = (path, params) => {
    const u = new URL(`${appBase()}${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  };
  const finishSso = async (res, out) => {
    if (out.mode === 'test') return res.redirect(303, backTo('/security-center', { tab: 'sso', sso: 'tested' }));
    const id = crypto.randomBytes(16).toString('base64url');
    const code = crypto.randomBytes(24).toString('base64url');
    await codes.issue(`sso:${id}`, code, { userId: out.user.id, organizationId: out.organizationId }, 60_000);
    // A fragment never reaches a server or a log.
    return res.redirect(303, `${appBase()}/login/sso#id=${id}&code=${code}`);
  };

  r.get('/auth/sso/callback', limiter, async (req, res) => {
    const back = backTo;
    // A failed test sign-in goes back to the settings page, not to sign-in.
    const pending = req.query.state ? await pool.query('SELECT mode FROM platform_sso_states WHERE state_hash = $1', [crypto.createHash('sha256').update(String(req.query.state)).digest('hex')]).catch(() => ({ rows: [] })) : { rows: [] };
    const failPath = pending.rows[0]?.mode === 'test' ? ['/security-center', { tab: 'sso' }] : ['/login', {}];
    let out;
    try {
      out = await sso.complete(pool, { code: req.query.code, state: req.query.state, error: req.query.error, redirectUri: redirectUri(req) });
    } catch (err) {
      if (!err.status || err.status >= 500) console.error('[sso callback]', err.message);
      return res.redirect(303, back(failPath[0], { ...failPath[1], sso_error: err.status && err.status < 500 ? err.message : 'Single sign-on failed. Try again.' }));
    }
    return finishSso(res, out);
  });

  // ── SAML ────────────────────────────────────────────────────────────────
  r.get('/auth/sso/saml/metadata', (req, res) => {
    res.type('application/samlmetadata+xml').send(saml.metadata(redirectUri(req)));
  });

  r.post('/auth/sso/saml/acs', limiter, async (req, res) => {
    const relay = String(req.body?.RelayState || '');
    const pending = relay ? await pool.query('SELECT mode FROM platform_sso_states WHERE state_hash = $1', [crypto.createHash('sha256').update(relay).digest('hex')]).catch(() => ({ rows: [] })) : { rows: [] };
    const failPath = pending.rows[0]?.mode === 'test' ? ['/security-center', { tab: 'sso' }] : ['/login', {}];
    let out;
    try {
      out = await sso.completeSaml(pool, { SAMLResponse: req.body?.SAMLResponse, RelayState: relay, redirectUri: redirectUri(req) });
    } catch (err) {
      if (!err.status || err.status >= 500) console.error('[saml acs]', err.message);
      return res.redirect(303, backTo(failPath[0], { ...failPath[1], sso_error: err.status && err.status < 500 ? err.message : 'Single sign-on failed. Try again.' }));
    }
    return finishSso(res, out);
  });

  // ── Passkeys ────────────────────────────────────────────────────────────
  const rp = () => passkeys.relyingParty(appBase());
  const pendingClaims = (req) => {
    try {
      const c = jwt.verify(String(req.body?.mfaToken || ''), pendingKey(jwtSecret), { algorithms: ['HS256'] });
      return c.purpose === 'mfa' ? c : null;
    } catch { return null; }
  };
  // Changing an account's second factors needs a session that already passed one.
  const requireSecondStep = async (req) => {
    if (req.user.mfa === true || typeof req.user.sso === 'string') return;
    if (await hasSecondFactor(pool, uid(req))) {
      const err = new Error('Sign out and sign in again with your second step before changing it.');
      err.status = 403; err.code = 'REAUTH_REQUIRED';
      throw err;
    }
  };

  r.post('/auth/passkey/options', limiter, async (req, res) => {
    try { res.json({ success: true, options: await passkeys.authenticationOptions(pool, rp(), { purpose: 'signin' }) }); } catch (err) { sendErr(res, err); }
  });

  r.post('/auth/passkey/verify', limiter, async (req, res) => {
    try {
      const userId = await passkeys.finishAuthentication(pool, rp(), req.body?.response, { purpose: 'signin' });
      const user = await loadUser(userId);
      if (!user) return res.status(401).json({ success: false, error: 'This account no longer exists.' });
      if (await sso.requiredFor(pool, user.email, user.id)) return res.status(403).json({ success: false, code: 'SSO_REQUIRED', error: 'Your organization requires single sign-on. Use "Sign in with SSO".' });
      res.json({ success: true, ...(await signSession(res, user, { mfa: true, method: 'passkey' })), user });
    } catch (err) { sendErr(res, err); }
  });

  r.post('/auth/mfa/passkey/options', limiter, async (req, res) => {
    const claims = pendingClaims(req);
    if (!claims) return res.status(401).json({ success: false, code: 'MFA_TOKEN_INVALID', error: 'The sign-in took too long. Start again.' });
    try { res.json({ success: true, options: await passkeys.authenticationOptions(pool, rp(), { purpose: 'second_step', userId: claims.sub }) }); } catch (err) { sendErr(res, err); }
  });

  r.post('/auth/mfa/passkey/verify', limiter, async (req, res) => {
    const claims = pendingClaims(req);
    if (!claims) return res.status(401).json({ success: false, code: 'MFA_TOKEN_INVALID', error: 'The sign-in took too long. Start again.' });
    try {
      await passkeys.finishAuthentication(pool, rp(), req.body?.response, { purpose: 'second_step', userId: claims.sub });
      const user = await loadUser(claims.sub);
      if (!user) return res.status(401).json({ success: false, error: 'This account no longer exists.' });
      res.json({ success: true, ...(await signSession(res, user, { mfa: true, method: claims.method })), user, method: 'passkey' });
    } catch (err) { sendErr(res, err); }
  });

  r.get('/auth/passkeys', authMiddleware, async (req, res) => {
    try {
      const items = await passkeys.list(pool, uid(req));
      res.json({ success: true, available: items !== null, passkeys: items || [], rpID: rp().rpID });
    } catch (err) { sendErr(res, err); }
  });

  r.post('/auth/passkeys/options', authMiddleware, limiter, async (req, res) => {
    try {
      await requireSecondStep(req);
      const user = await loadUser(uid(req));
      res.json({ success: true, options: await passkeys.registrationOptions(pool, rp(), user) });
    } catch (err) { sendErr(res, err); }
  });

  r.post('/auth/passkeys', authMiddleware, limiter, async (req, res) => {
    try {
      await requireSecondStep(req);
      const user = await loadUser(uid(req));
      const out = await passkeys.finishRegistration(pool, rp(), user, req.body?.response, req.body?.name);
      // The passkey just proved the second step, so this browser's new session counts as two-step.
      res.status(201).json({ success: true, passkey: out, ...(await upgradeSession(req, res, user, { mfa: true, sso: req.user.sso, method: 'passkey' })), user });
    } catch (err) { sendErr(res, err); }
  });

  r.patch('/auth/passkeys/:id', authMiddleware, async (req, res) => {
    try { await passkeys.rename(pool, uid(req), req.params.id, req.body?.name); res.json({ success: true }); } catch (err) { sendErr(res, err); }
  });

  r.delete('/auth/passkeys/:id', authMiddleware, async (req, res) => {
    try { await requireSecondStep(req); await passkeys.remove(pool, uid(req), req.params.id); res.json({ success: true }); } catch (err) { sendErr(res, err); }
  });

  // ── Sessions ────────────────────────────────────────────────────────────
  r.get('/auth/account-sessions', authMiddleware, async (req, res) => {
    try { res.json({ success: true, sessions: await webSessions.list(pool, uid(req), { currentWsid: req.user.wsid || null, currentSid: req.user.sid || null }) }); } catch (err) { sendErr(res, err); }
  });

  r.delete('/auth/account-sessions/:id', authMiddleware, async (req, res) => {
    try {
      const ended = await webSessions.revoke(pool, uid(req), req.params.id);
      if (!ended) return res.status(404).json({ success: false, error: 'That session is not open.' });
      res.json({ success: true, endedCurrent: req.params.id === req.user.wsid || req.params.id === req.user.sid });
    } catch (err) { sendErr(res, err); }
  });

  r.post('/auth/account-sessions/sign-out-everywhere', authMiddleware, limiter, async (req, res) => {
    try {
      await webSessions.revokeAll(pool, uid(req));
      const user = await loadUser(uid(req));
      res.json({ success: true, ...(await signSession(res, user, { mfa: req.user.mfa === true, sso: req.user.sso, method: 'password' })), user });
    } catch (err) { sendErr(res, err); }
  });

  r.post('/auth/sso/exchange', limiter, async (req, res) => {
    try {
      const id = String(req.body?.id || '');
      if (!/^[A-Za-z0-9_-]{10,40}$/.test(id)) return res.status(400).json({ success: false, error: 'This sign-in link is not valid.' });
      const data = await codes.consume(`sso:${id}`, String(req.body?.code || ''), { maxAttempts: 1 });
      if (!data) return res.status(401).json({ success: false, error: 'This sign-in link expired. Sign in again.' });
      const user = await loadUser(data.userId);
      if (!user) return res.status(401).json({ success: false, error: 'This account no longer exists.' });
      res.json({ success: true, ...(await signSession(res, user, { sso: data.organizationId, method: 'sso' })), user, organizationId: data.organizationId });
    } catch (err) { sendErr(res, err); }
  });

  return r;
}

/**
 * Before a sign-in method other than SSO issues a session: refuses it when
 * the email's organization requires SSO, and returns an MFA challenge when the
 * account has two-step sign-in on. Returns null when a session may be issued.
 */
async function signInGate(pool, jwtSecret, user, method) {
  const need = await sso.requiredFor(pool, user.email, user.id);
  if (need) {
    const err = new Error('Your organization requires single sign-on. Use "Sign in with SSO".');
    err.status = 403; err.code = 'SSO_REQUIRED';
    throw err;
  }
  const methods = [];
  if (await mfa.isEnabled(pool, user.id)) methods.push('totp');
  if ((await passkeys.count(pool, user.id)) > 0) methods.push('passkey');
  if (methods.length) return mfaChallenge(jwtSecret, user, method, methods);
  return null;
}

module.exports = { accountSecurityRouter, signInGate, mfaChallenge, pendingKey, hasSecondFactor };
