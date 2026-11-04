// More ways to sign in, all landing on the same account (one per email):
//   GET  /api/auth/providers                 which options are switched on
//   POST /api/auth/oauth/:provider           { credential }  Google / Apple ID token -> web session
//   POST /api/auth/phone/start               { phone }       texts a code to an existing account's phone
//   POST /api/auth/phone/verify              { phone, code } -> web session
//   POST /api/auth/desktop/handoff  (auth)   { state }       one-time code for the desktop app
//   POST /api/auth/native/exchange           { code, state, client, platform, deviceName, appVersion } -> app session
//   POST /api/auth/web/handoff      (app)    {}              one-time code that signs the app's own window in to the website
//   POST /api/auth/web/exchange              { id, code }    -> web session
//
// The desktop and mobile apps sign in through the website: they open
// /login?app=<state> in the browser, the person signs in any way they like, the
// website asks for a 2-minute single-use code bound to that state, and hands it
// back over starlane://auth/<state>/<code>. Tokens never travel in a URL.
//
// The reverse: the desktop app shows the live website in its own window. A
// signed-in app session asks for a 60-second single-use code and opens
// /auth/desktop#id=..&code=.. (a fragment, so it never reaches a server or a
// log); the page trades it for a normal web session. Only app sessions (tokens
// that carry a session id) may ask, so a web token cannot mint more of itself.
'use strict';
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const sessions = require('../auth/sessions');
const { verifyIdToken, isConfigured, IdTokenError } = require('../auth/idToken');
const codes = require('../auth/oneTimeCodes');
const { normalizePhone, smsConfigured, sendSignInCode } = require('../auth/phone');

const STATE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const USER_COLS = 'id, email, phone, business_name, plan, created_at';

function authProvidersRouter({ pool, authMiddleware, issueWebSession, isAccessGateOn, hasApprovedApplication, track = () => {} }) {
  const router = express.Router();
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many sign-in attempts. Try again in a few minutes.' } });
  const smsLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many codes requested. Try again in a few minutes.' } });

  // The account for a provider-verified email; created on first use unless the
  // private-rollout gate says this email has not been approved yet.
  async function accountFor(email, name) {
    const found = (await pool.query(`SELECT ${USER_COLS} FROM users WHERE lower(email) = $1 LIMIT 1`, [email])).rows[0];
    if (found) return { user: found, created: false };
    if (isAccessGateOn() && !(await hasApprovedApplication(pool, email))) {
      const err = new Error('Starlane is in a private rollout. Request access first — you can sign in once your application is approved.');
      err.status = 403; err.code = 'ACCESS_NOT_APPROVED';
      throw err;
    }
    const businessName = (name && name.trim()) || email.split('@')[0];
    const { rows } = await pool.query(
      `INSERT INTO users (email, business_name, plan, created_at) VALUES ($1, $2, 'free', now())
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING ${USER_COLS}`, [email, businessName]);
    // The provider has verified this mailbox, so the account starts verified.
    await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [rows[0].id]).catch(() => {});
    return { user: rows[0], created: true };
  }

  router.get('/auth/providers', (req, res) => {
    res.json({
      success: true,
      google: isConfigured('google') ? { clientId: process.env.GOOGLE_CLIENT_ID } : null,
      apple: isConfigured('apple') ? { clientId: process.env.APPLE_CLIENT_ID } : null,
      phone: smsConfigured(),
    });
  });

  router.post('/auth/oauth/:provider', limiter, async (req, res) => {
    const provider = req.params.provider;
    if (provider !== 'google' && provider !== 'apple') return res.status(404).json({ error: 'Unknown sign-in option' });
    if (!isConfigured(provider)) return res.status(503).json({ error: `${provider === 'google' ? 'Google' : 'Apple'} sign-in is not switched on yet.`, code: 'PROVIDER_OFF' });
    try {
      const id = await verifyIdToken(provider, req.body?.credential);
      // Apple sends the name only in the browser response on first sign-in, not in the token.
      const { user, created } = await accountFor(id.email, id.name || (typeof req.body?.name === 'string' ? req.body.name.slice(0, 120) : null));
      track(`auth.${provider}_login`, { req, userId: user.id, props: { outcome: created ? 'created' : 'existing' } });
      res.json({ success: true, ...issueWebSession(res, user), user });
    } catch (e) {
      if (e instanceof IdTokenError) return res.status(401).json({ error: 'That sign-in could not be verified. Try again.' });
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error(`[oauth ${provider}]`, e.message);
      res.status(500).json({ error: 'Sign-in failed. Try again.' });
    }
  });

  router.post('/auth/phone/start', smsLimiter, async (req, res) => {
    if (!smsConfigured()) return res.status(503).json({ error: 'Phone sign-in is not switched on yet.', code: 'PROVIDER_OFF' });
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'Enter a mobile number with its country code, like +91 98765 43210.' });
    const generic = { success: true, message: 'If that number belongs to a Starlane account, a code is on its way.' };
    try {
      const { rows } = await pool.query(
        `SELECT id, phone FROM users WHERE phone IS NOT NULL AND right(regexp_replace(phone, '\\D', '', 'g'), 10) = right($1, 10) LIMIT 5`, [phone]);
      // The full number, country code included, must match: +1 555… never reaches a +91 555… account.
      const matches = rows.filter((r) => normalizePhone(r.phone) === phone);
      if (matches.length !== 1) return res.json(generic); // unknown or ambiguous: say nothing either way
      const code = String(crypto.randomInt(100000, 1000000));
      codes.issue(`phone:${phone}`, code, { userId: matches[0].id }, 10 * 60 * 1000);
      await sendSignInCode(phone, code);
      res.json(generic);
    } catch (e) {
      console.error('[phone start]', e.message);
      res.status(502).json({ error: 'The code could not be sent. Try again, or sign in with email.' });
    }
  });

  router.post('/auth/phone/verify', limiter, async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    const code = String(req.body?.code || '').trim();
    if (!phone || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code.' });
    const hit = codes.consume(`phone:${phone}`, code);
    if (!hit) return res.status(401).json({ error: 'That code is wrong or has expired.' });
    const user = (await pool.query(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [hit.userId])).rows[0];
    if (!user) return res.status(401).json({ error: 'That code is wrong or has expired.' });
    track('auth.phone_login', { req, userId: user.id });
    res.json({ success: true, ...issueWebSession(res, user), user });
  });

  router.post('/auth/desktop/handoff', authMiddleware, (req, res) => {
    const state = String(req.body?.state || '');
    if (!STATE_RE.test(state)) return res.status(400).json({ error: 'Invalid sign-in request. Start again from the app.' });
    const code = crypto.randomBytes(24).toString('base64url');
    codes.issue(`handoff:${state}`, code, { userId: req.user.userId || req.user.id }, 2 * 60 * 1000);
    res.json({ success: true, code });
  });

  router.post('/auth/native/exchange', limiter, async (req, res) => {
    const { code, state, client, platform, deviceName, appVersion } = req.body || {};
    if (!STATE_RE.test(String(state || '')) || typeof code !== 'string') return res.status(400).json({ error: 'Invalid sign-in link.' });
    const hit = codes.consume(`handoff:${state}`, code, { maxAttempts: 1 });
    if (!hit) return res.status(401).json({ error: 'That sign-in link has expired. Sign in again.' });
    try {
      const user = (await pool.query('SELECT id, email, business_name FROM users WHERE id = $1', [hit.userId])).rows[0];
      if (!user) return res.status(401).json({ error: 'That sign-in link has expired. Sign in again.' });
      const s = await sessions.createSession(pool, user, { client, platform, deviceName, appVersion });
      track('auth.native_login', { req, userId: user.id, props: { client, platform, client_version: appVersion, via: 'browser' } });
      res.json({ success: true, ...s, user: { id: user.id, email: user.email, businessName: user.business_name } });
    } catch (e) {
      console.error('[native exchange]', e.message);
      res.status(500).json({ error: 'Sign-in failed. Try again.' });
    }
  });

  router.post('/auth/web/handoff', authMiddleware, (req, res) => {
    if (!req.user?.sid) return res.status(403).json({ error: 'Only the Starlane app can do this.' });
    const id = crypto.randomBytes(16).toString('base64url');
    const code = crypto.randomBytes(24).toString('base64url');
    codes.issue(`web:${id}`, code, { userId: req.user.userId || req.user.id }, 60 * 1000);
    res.json({ success: true, id, code });
  });

  router.post('/auth/web/exchange', limiter, async (req, res) => {
    const { id, code } = req.body || {};
    if (!STATE_RE.test(String(id || '')) || typeof code !== 'string') return res.status(400).json({ error: 'Invalid sign-in link.' });
    const hit = codes.consume(`web:${id}`, code, { maxAttempts: 1 });
    if (!hit) return res.status(401).json({ error: 'That sign-in link has expired. Sign in again.' });
    try {
      const user = (await pool.query(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [hit.userId])).rows[0];
      if (!user) return res.status(401).json({ error: 'That sign-in link has expired. Sign in again.' });
      track('auth.web_from_app', { req, userId: user.id });
      res.json({ success: true, ...issueWebSession(res, user), user });
    } catch (e) {
      console.error('[web exchange]', e.message);
      res.status(500).json({ error: 'Sign-in failed. Try again.' });
    }
  });

  return router;
}

module.exports = { authProvidersRouter };
