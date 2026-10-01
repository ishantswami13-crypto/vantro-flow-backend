// More ways to sign in: Google/Apple ID-token checks, phone sign-in codes and
// the browser-to-desktop handoff. No database: a fake pool stands in for users.
import { createRequire } from 'module';
import crypto from 'crypto';
import express from 'express';
const require = createRequire(import.meta.url);

let failed = 0;
const check = (name, ok, extra) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(extra ?? '')}`}`); if (!ok) failed += 1; };

process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
delete process.env.APPLE_CLIENT_ID;
const { verifyIdToken, isConfigured, _keyCache } = require('../lib/auth/idToken');
const { normalizePhone } = require('../lib/auth/phone');
const codes = require('../lib/auth/oneTimeCodes');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
let fetches = 0;
const fetchImpl = async () => { fetches += 1; return { ok: true, json: async () => ({ keys: [jwk] }) }; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Date.now();
function sign(payload, { key = privateKey, kid = 'k1', alg = 'RS256' } = {}) {
  const head = `${b64({ alg, kid, typ: 'JWT' })}.${b64(payload)}`;
  return `${head}.${crypto.sign('RSA-SHA256', Buffer.from(head), key).toString('base64url')}`;
}
const good = { iss: 'https://accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID, sub: '123', email: 'Owner@Example.com', email_verified: true, name: 'Owner', iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 600 };
const rejects = async (token) => { try { await verifyIdToken('google', token, { fetchImpl }); return false; } catch { return true; } };

async function main() {
  check('google is configured, apple is not', isConfigured('google') && !isConfigured('apple'));
  const id = await verifyIdToken('google', sign(good), { fetchImpl });
  check('a valid Google token gives the lowercased email', id.email === 'owner@example.com' && id.sub === '123', id);
  check('signed by another key is rejected', await rejects(sign(good, { key: other.privateKey })));
  check('another app (audience) is rejected', await rejects(sign({ ...good, aud: 'someone-else' })));
  check('another issuer is rejected', await rejects(sign({ ...good, iss: 'https://evil.example' })));
  check('expired is rejected', await rejects(sign({ ...good, exp: Math.floor(now / 1000) - 600 })));
  check('unverified email is rejected', await rejects(sign({ ...good, email_verified: false })));
  check('alg none / HS256 is rejected', await rejects(sign(good, { alg: 'HS256' })));
  check('garbage is rejected', await rejects('not.a.token') && await rejects(undefined));
  _keyCache?.clear?.(); fetches = 0;
  await verifyIdToken('google', sign(good), { fetchImpl });
  await verifyIdToken('google', sign(good), { fetchImpl });
  check('keys are cached between sign-ins', fetches === 1, fetches);

  check('bare 10 digits are Indian', normalizePhone('98765 43210') === '919876543210');
  check('+91 and 0-prefixed forms agree', normalizePhone('+91 98765-43210') === '919876543210' && normalizePhone('098765 43210') === '919876543210');
  check('too short is empty', normalizePhone('12345') === '');

  codes.issue('t:a', '111111', { userId: 'u1' }, 60000);
  check('a wrong code fails', codes.consume('t:a', '222222') === null);
  check('the right code works once', codes.consume('t:a', '111111')?.userId === 'u1' && codes.consume('t:a', '111111') === null);
  codes.issue('t:b', '333333', { userId: 'u2' }, 60000);
  codes.consume('t:b', 'x', { maxAttempts: 1 });
  check('one wrong guess burns a single-attempt code', codes.consume('t:b', '333333', { maxAttempts: 1 }) === null);

  // Router with a fake pool.
  const users = [{ id: 'u-owner', email: 'owner@example.com', phone: '9876543210', business_name: 'Owner Co', plan: 'free', created_at: new Date() }];
  const pool = { query: async (sql, params) => {
    if (/FROM users WHERE lower\(email\)/.test(sql)) return { rows: users.filter((u) => u.email === params[0]) };
    if (/FROM users WHERE id = \$1/.test(sql)) return { rows: users.filter((u) => u.id === params[0]) };
    if (/INSERT INTO users/.test(sql)) { const u = { id: `u-${users.length}`, email: params[0], business_name: params[1], plan: 'free' }; users.push(u); return { rows: [u] }; }
    if (/UPDATE users SET email_verified/.test(sql)) return { rows: [] };
    return { rows: [] };
  } };
  const sessions = require('../lib/auth/sessions');
  sessions.createSession = async (_p, user) => ({ token: `native-${user.id}`, refreshToken: 'r', expiresAt: 'x' });
  let gateOn = false;
  const { authProvidersRouter } = require('../lib/routes/authProviders');
  const app = express();
  app.use(express.json());
  const authMiddleware = (req, res, next) => (req.headers.authorization === 'Bearer web-u-owner' ? ((req.user = { userId: 'u-owner' }), next()) : res.status(401).json({}));
  app.use('/api', authProvidersRouter({ pool, authMiddleware, issueWebSession: (_res, u) => ({ token: `web-${u.id}`, csrf_token: null }),
    isAccessGateOn: () => gateOn, hasApprovedApplication: async () => false }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const post = async (path, body, headers = {}) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    const providers = await (await fetch(`${base}/auth/providers`)).json();
    check('providers lists Google only', providers.google?.clientId === process.env.GOOGLE_CLIENT_ID && providers.apple === null && providers.phone === false, providers);
    // The router verifies with the real fetch; give it our test keys.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => (String(url).includes('googleapis') ? fetchImpl() : realFetch(url, opts));
    _keyCache?.clear?.();
    let r = await post('/auth/oauth/google', { credential: sign(good) });
    check('Google sign-in reaches the existing account', r.status === 200 && r.body.user.id === 'u-owner' && r.body.token === 'web-u-owner', r);
    r = await post('/auth/oauth/google', { credential: sign(good, { key: other.privateKey }) });
    check('a forged Google token gets 401', r.status === 401, r);
    gateOn = true;
    r = await post('/auth/oauth/google', { credential: sign({ ...good, email: 'new@example.com' }) });
    check('a new email is refused while the access gate is on', r.status === 403 && r.body.code === 'ACCESS_NOT_APPROVED', r);
    gateOn = false;
    r = await post('/auth/oauth/google', { credential: sign({ ...good, email: 'new@example.com' }) });
    check('a new email gets an account when the gate is off', r.status === 200 && r.body.user.email === 'new@example.com', r);
    globalThis.fetch = realFetch;
    r = await post('/auth/oauth/apple', { credential: 'x' });
    check('Apple answers "not switched on" without a key', r.status === 503 && r.body.code === 'PROVIDER_OFF', r);
    r = await post('/auth/phone/start', { phone: '9876543210' });
    check('phone sign-in answers "not switched on" without SMS', r.status === 503, r);

    const state = crypto.randomBytes(18).toString('base64url');
    r = await post('/auth/desktop/handoff', { state });
    check('handoff needs a signed-in browser', r.status === 401, r);
    r = await post('/auth/desktop/handoff', { state: 'short' }, { authorization: 'Bearer web-u-owner' });
    check('handoff rejects a malformed state', r.status === 400, r);
    r = await post('/auth/desktop/handoff', { state }, { authorization: 'Bearer web-u-owner' });
    const code = r.body.code;
    check('handoff issues a code', r.status === 200 && typeof code === 'string' && code.length >= 30, r);
    r = await post('/auth/native/exchange', { code, state: crypto.randomBytes(18).toString('base64url'), client: 'desktop' });
    check('the code does not work with another state', r.status === 401, r);
    r = await post('/auth/native/exchange', { code, state, client: 'desktop', platform: 'windows' });
    check('the app exchanges the code for its own session', r.status === 200 && r.body.token === 'native-u-owner' && r.body.user.email === 'owner@example.com', r);
    r = await post('/auth/native/exchange', { code, state, client: 'desktop' });
    check('the code works only once', r.status === 401, r);
    r = await post('/auth/desktop/handoff', { state }, { authorization: 'Bearer web-u-owner' });
    await post('/auth/native/exchange', { code: 'wrong', state, client: 'desktop' });
    r = await post('/auth/native/exchange', { code: r.body.code, state, client: 'desktop' });
    check('one wrong guess burns the handoff', r.status === 401, r);
  } finally { server.close(); }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
