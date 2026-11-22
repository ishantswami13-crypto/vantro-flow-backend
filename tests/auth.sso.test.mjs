// Organization single sign-on (OpenID Connect) against a local mock identity
// provider: domain verification by DNS TXT, configuration, the test sign-in
// that activates it, a real sign-in through the HTTP routes (callback ->
// single-use code -> session marked sso), and every ID token check (signature,
// issuer, audience, expiry, nonce, state replay, unverified domain). Also the
// enforcement rule and the owner's exemption.
// Needs DATABASE_URL with migrations 072 to 076.
import { createRequire } from 'node:module';
import http from 'node:http';
import crypto from 'node:crypto';
import { makeChecker, openPool, seedUser, deleteUsers } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
process.env.OUTBOUND_CREDENTIALS_KEY = crypto.randomBytes(32).toString('base64');
const express = require('express');
const jwt = require('jsonwebtoken');
const sso = require('../lib/auth/sso');
const { accountSecurityRouter } = require('../lib/routes/accountSecurity');
const { ensureOwnOrganization } = require('../lib/platform/context');

const { check, done } = makeChecker();
const pool = openPool();
const ready = await pool.query(`SELECT to_regclass('public.platform_sso_connections') AS t`);
if (!ready.rows[0].t) { console.log('SKIP migration 076 not applied'); process.exit(0); }

// ── Mock identity provider ───────────────────────────────────────────────
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const rogue = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const idp = { nonce: null, claims: {}, alg: 'RS256', key: rsa.privateKey, kid: 'rsa1', issuerOverride: null, lastTokenRequest: null };
const signToken = (claims) => {
  const header = { alg: idp.alg, kid: idp.kid, typ: 'JWT' };
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc(header)}.${enc(claims)}`;
  const sig = idp.alg === 'ES256'
    ? crypto.sign('sha256', Buffer.from(data), { key: idp.key, dsaEncoding: 'ieee-p1363' })
    : crypto.sign('RSA-SHA256', Buffer.from(data), idp.key);
  return `${data}.${sig.toString('base64url')}`;
};
const server = http.createServer((req, res) => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url === '/.well-known/openid-configuration') {
    return json({ issuer: idp.issuerOverride || base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks`, code_challenge_methods_supported: ['S256'] });
  }
  if (req.url === '/jwks') {
    return json({ keys: [{ ...rsa.publicKey.export({ format: 'jwk' }), kid: 'rsa1', use: 'sig' }, { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec1', use: 'sig' }] });
  }
  if (req.url === '/token' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      idp.lastTokenRequest = new URLSearchParams(body);
      const now = Math.floor(Date.now() / 1000);
      json({ access_token: 'at', token_type: 'Bearer', id_token: signToken({ iss: base, aud: 'starlane-client', sub: 'u1', iat: now, exp: now + 300, nonce: idp.nonce, email_verified: true, ...idp.claims }) });
    });
    return undefined;
  }
  return json({ error: 'not found' }, 404);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const issuer = `http://127.0.0.1:${server.address().port}`;
const txt = new Map();
sso.__setTestOptions({ http: { allowHttp: true, allowPrivate: true }, txt: async (name) => { if (!txt.has(name)) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); return [[txt.get(name)]]; } });

// ── The Starlane side ────────────────────────────────────────────────────
const app = express();
app.use(express.json());
const fakeAuth = (req, res, next) => { req.user = { userId: 'none' }; next(); };
const signed = [];
app.use('/api', accountSecurityRouter({
  pool, authMiddleware: fakeAuth, jwtSecret: 'test-secret-test-secret-test-secret',
  signSession: (res, user, claims) => { signed.push({ user, claims }); return { token: jwt.sign({ userId: user.id, ...claims }, 'x'), csrf_token: 'c' }; },
  apiBase: () => 'https://api.starlane.test', appBase: () => 'https://app.starlane.test',
}));
const api = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const apiBase = `http://127.0.0.1:${api.address().port}`;
const redirectUri = 'https://api.starlane.test/api/auth/sso/callback';

const users = [];
const domain = `acme-${crypto.randomBytes(3).toString('hex')}.test`;
const otherDomain = `other-${crypto.randomBytes(3).toString('hex')}.test`;
const params = (url) => Object.fromEntries(new URL(url).searchParams);

try {
  const owner = await seedUser(pool, 'sso-owner'); users.push(owner.id);
  const rival = await seedUser(pool, 'sso-rival'); users.push(rival.id);
  const orgId = await ensureOwnOrganization(pool, owner.id);
  const rivalOrgId = await ensureOwnOrganization(pool, rival.id);
  const org = { id: orgId, role: 'owner' };
  const rivalOrg = { id: rivalOrgId, role: 'owner' };

  // Domains.
  let threw = null;
  try { await sso.addDomain(pool, org, owner.id, 'gmail.com'); } catch (e) { threw = e; }
  check('a public mail domain cannot be claimed', threw?.status === 400);
  await sso.addDomain(pool, org, owner.id, domain.toUpperCase());
  await sso.addDomain(pool, rivalOrg, rival.id, domain);
  let v = await sso.view(pool, org, { redirectUri });
  const rec = v.domains.find((d) => d.domain === domain);
  check('a claimed domain shows the TXT record to add', rec && !rec.verified && rec.dnsRecord.name === `_starlane-verification.${domain}` && rec.dnsRecord.value.startsWith('starlane-verification='), v.domains);
  threw = null;
  try { await sso.verifyDomain(pool, org, owner.id, domain); } catch (e) { threw = e; }
  check('verification fails without the TXT record', threw?.status === 400);
  txt.set(`_starlane-verification.${domain}`, rec.dnsRecord.value);
  await sso.verifyDomain(pool, org, owner.id, domain);
  threw = null;
  try { await sso.verifyDomain(pool, rivalOrg, rival.id, domain); } catch (e) { threw = e; }
  check('another organization cannot verify the same domain, even with its own token published', threw?.status === 400 || threw?.status === 409, threw?.message);
  await sso.addDomain(pool, org, owner.id, otherDomain); // left unverified

  // Configuration.
  threw = null;
  idp.issuerOverride = 'https://evil.example';
  try { await sso.save(pool, org, owner.id, { issuer, clientId: 'starlane-client', clientSecret: 's3cret' }); } catch (e) { threw = e; }
  check('a discovery document naming another issuer is refused', threw?.status === 400);
  idp.issuerOverride = null;
  threw = null;
  try { await sso.save(pool, org, owner.id, { issuer: 'http://169.254.169.254', clientId: 'x', clientSecret: 'y' }); } catch (e) { threw = e; }
  check('a cloud metadata address is not reached (outside test mode it must be https and public)', threw?.status === 400);
  await sso.save(pool, org, owner.id, { issuer, clientId: 'starlane-client', clientSecret: 's3cret', jitRole: 'member' });
  v = await sso.view(pool, org, { redirectUri });
  check('saved as draft, secret not returned', v.connection.status === 'draft' && v.connection.hasClientSecret === true && !JSON.stringify(v).includes('s3cret'), v.connection);
  const raw = (await pool.query('SELECT client_secret_enc FROM platform_sso_connections WHERE organization_id = $1', [orgId])).rows[0];
  check('the client secret is stored encrypted', raw.client_secret_enc && !raw.client_secret_enc.includes('s3cret'));
  threw = null;
  try { await sso.setEnforce(pool, org, owner.id, true); } catch (e) { threw = e; }
  check('cannot be required before a test sign-in passes', threw?.status === 409);
  let r = await fetch(`${apiBase}/api/auth/sso/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `x@${domain}` }) });
  check('sign-in is not offered while the connection is a draft', r.status === 404);

  // Test sign-in through the HTTP callback.
  let st = await sso.start(pool, { organizationId: orgId, mode: 'test', startedBy: owner.id, redirectUri });
  let p = params(st.authorizeUrl);
  check('authorize URL carries PKCE S256, state and nonce', p.code_challenge_method === 'S256' && p.code_challenge && p.state && p.nonce && p.client_id === 'starlane-client' && p.redirect_uri === redirectUri);
  idp.nonce = p.nonce; idp.claims = { email: `admin@${domain}`, name: 'Acme Admin' };
  r = await fetch(`${apiBase}/api/auth/sso/callback?code=c1&state=${p.state}`, { redirect: 'manual' });
  check('a test sign-in returns to the settings page', r.status === 303 && r.headers.get('location') === 'https://app.starlane.test/security-center?tab=sso&sso=tested', r.headers.get('location'));
  check('the code was exchanged with the PKCE verifier and the client secret', idp.lastTokenRequest?.get('code_verifier')?.length >= 43 && idp.lastTokenRequest.get('client_secret') === 's3cret');
  v = await sso.view(pool, org, { redirectUri });
  check('after the test sign-in the connection is active', v.connection.status === 'active' && !!v.connection.testedAt);

  // Real sign-in by email.
  r = await fetch(`${apiBase}/api/auth/sso/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `new.person@${domain}` }) });
  let j = await r.json();
  check('start by work email gives the provider URL', r.status === 200 && j.authorizeUrl.startsWith(`${issuer}/authorize`), j);
  p = params(j.authorizeUrl);
  idp.nonce = p.nonce; idp.claims = { email: `New.Person@${domain}`, name: 'New Person' };
  r = await fetch(`${apiBase}/api/auth/sso/callback?code=c2&state=${p.state}`, { redirect: 'manual' });
  const loc = r.headers.get('location') || '';
  check('the callback hands a single-use code in the URL fragment, not a token', r.status === 303 && loc.startsWith('https://app.starlane.test/login/sso#id=') && !loc.includes('token'), loc);
  r = await fetch(`${apiBase}/api/auth/sso/callback?code=c2&state=${p.state}`, { redirect: 'manual' });
  check('the same state cannot be used twice', (r.headers.get('location') || '').includes('sso_error='));
  const frag = new URLSearchParams(loc.split('#')[1]);
  r = await fetch(`${apiBase}/api/auth/sso/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: frag.get('id'), code: frag.get('code') }) });
  j = await r.json();
  check('the code exchanges for a session marked with the organization', r.status === 200 && j.organizationId === orgId && signed.at(-1).claims.sso === orgId, j);
  const newUser = j.user; users.push(newUser.id);
  check('the account was created with the email in lower case', newUser.email === `new.person@${domain}`);
  const mem = await pool.query('SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2', [orgId, newUser.id]);
  check('and added to the organization with the configured role', mem.rows[0]?.role === 'member');
  r = await fetch(`${apiBase}/api/auth/sso/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: frag.get('id'), code: frag.get('code') }) });
  check('the exchange code works once', r.status === 401);

  // ID token checks.
  const attempt = async (claims, tweak = () => {}) => {
    const s = await sso.start(pool, { organizationId: orgId, redirectUri });
    const q = params(s.authorizeUrl);
    idp.nonce = q.nonce; idp.claims = { email: `someone@${domain}`, ...claims };
    tweak(q);
    try { const out = await sso.complete(pool, { code: 'c', state: q.state, redirectUri }); return { ok: true, out }; } catch (e) { return { ok: false, e }; } finally { idp.alg = 'RS256'; idp.key = rsa.privateKey; idp.kid = 'rsa1'; }
  };
  let a = await attempt({ aud: 'someone-else' });
  check('an ID token for another client is refused', !a.ok && /another application/.test(a.e.message), a.e?.message);
  a = await attempt({ iss: 'https://evil.example' });
  check('an ID token from another issuer is refused', !a.ok && /another issuer/.test(a.e.message), a.e?.message);
  a = await attempt({ exp: Math.floor(Date.now() / 1000) - 600 });
  check('an expired ID token is refused', !a.ok && /expired/.test(a.e.message), a.e?.message);
  a = await attempt({ nonce: 'not-the-nonce' });
  check('an ID token with the wrong nonce is refused', !a.ok && /does not belong/.test(a.e.message), a.e?.message);
  a = await attempt({}, () => { idp.key = rogue.privateKey; });
  check('an ID token signed with an unpublished key is refused', !a.ok && /signature/.test(a.e.message), a.e?.message);
  a = await attempt({ email: `x@${otherDomain}` });
  check('an email on a claimed but unverified domain is refused', !a.ok && a.e.status === 403, a.e?.message);
  a = await attempt({ email_verified: false });
  check('an email the provider marks unverified is refused', !a.ok && /not verified/.test(a.e.message), a.e?.message);
  a = await attempt({}, () => { idp.alg = 'ES256'; idp.key = ec.privateKey; idp.kid = 'ec1'; });
  check('an ES256-signed ID token is accepted', a.ok && a.out.user.email === `someone@${domain}`, a.e?.message);
  if (a.ok) users.push(a.out.user.id);
  a = await attempt({}, () => { idp.alg = 'none'; });
  check('alg none is refused', !a.ok, a.e?.message);

  // Enforcement.
  await sso.setEnforce(pool, org, owner.id, true);
  check('enforced: password and other sign-ins are refused for a member on the domain', !!(await sso.requiredFor(pool, `new.person@${domain}`, newUser.id)));
  await pool.query('UPDATE users SET email = $2 WHERE id = $1', [owner.id, `owner-${owner.id.slice(0, 6)}@${domain}`]);
  check('the organization owner keeps other sign-in methods', (await sso.requiredFor(pool, `owner-${owner.id.slice(0, 6)}@${domain}`, owner.id)) === null);
  check('emails on other domains are unaffected', (await sso.requiredFor(pool, 'someone@elsewhere.test', null)) === null);
  await sso.removeDomain(pool, org, owner.id, domain);
  v = await sso.view(pool, org, { redirectUri });
  check('removing the last verified domain turns enforcement off', v.connection.enforce === false);
  const ev = await pool.query(`SELECT array_agg(DISTINCT action) AS a FROM platform_audit_events WHERE organization_id = $1 AND action LIKE 'sso.%'`, [orgId]);
  check('SSO changes and sign-ins are audited', ['sso.configured', 'sso.domain_verified', 'sso.tested', 'sso.signed_in', 'sso.enforced', 'sso.domain_removed'].every((x) => ev.rows[0].a.includes(x)), ev.rows[0].a);
} catch (err) {
  check('test ran without throwing', false, err.stack);
} finally {
  server.close(); api.close();
  await deleteUsers(pool, users);
  await pool.end();
  done();
}
