'use strict';
// Organization single sign-on with OpenID Connect (Okta, Microsoft Entra ID,
// Google Workspace, Auth0, Keycloak, OneLogin, JumpCloud …).
//
// Setup (an organization admin):
//   1. Save the identity provider's issuer URL, client ID and secret. Starlane
//      reads the issuer's discovery document; every endpoint must be https
//      and public (lib/connectors/safeHttp).
//   2. Claim email domains. A domain counts only after a DNS TXT record at
//      _starlane-verification.<domain> holds starlane-verification=<token>,
//      so nobody can point another company's emails at their own provider.
//      A verified domain belongs to one organization. Public mail domains
//      (gmail.com and the like) cannot be claimed.
//   3. Run a test sign-in. Only after one succeeds is the connection active.
//   4. Optionally enforce it: people with an email on a verified domain then
//      cannot sign in with a password, Google, Apple or a phone code. The
//      organization's owner keeps their other sign-in methods so a broken
//      provider cannot lock the organization out.
//
// Sign-in: authorization code flow with PKCE (S256), a nonce and a single-use
// state stored by hash for 10 minutes. The ID token's signature is checked
// against the provider's JWKS (RS256, PS256 or ES256), then its issuer,
// audience, expiry and nonce. The email must be on one of the organization's
// verified domains and must not be marked unverified by the provider. An
// account is created on first sign-in and added to the organization with the
// configured role (never owner). The browser gets a 60-second single-use code
// in a URL fragment, never a session token.
//
// Not built: SAML 2.0 and SCIM provisioning.

const crypto = require('crypto');
const dns = require('dns').promises;
const creds = require('../domain/outbound/credentials');
const { safeRequest, checkUrl } = require('../connectors/safeHttp');
const audit = require('../platform/audit');
const { PlatformError, badRequest, notFound, conflict } = require('../platform/errors');

const STATE_TTL_MS = 10 * 60 * 1000;
const JWKS_TTL_MS = 60 * 60 * 1000;
const PUBLIC_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'yahoo.co.in', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'zoho.com', 'zohomail.in', 'gmx.com', 'gmx.net', 'mail.com', 'yandex.com', 'rediffmail.com', 'qq.com', '163.com', 'fastmail.com', 'hey.com', 'tutanota.com']);
const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ROLES = ['viewer', 'member', 'admin'];

// Tests point the provider at a local server and stub DNS; production never sets these.
let testHttp = null;
let resolveTxt = (name) => dns.resolveTxt(name);
function __setTestOptions({ http = null, txt = null } = {}) { testHttp = http; if (txt) resolveTxt = txt; }
const httpOpts = () => testHttp || {};

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const b64url = (buf) => buf.toString('base64url');
const emailDomain = (email) => String(email || '').trim().toLowerCase().split('@')[1] || '';

function cleanDomain(raw) {
  const d = String(raw || '').trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
  if (!DOMAIN_RE.test(d)) throw badRequest('Enter a domain like example.com.');
  if (PUBLIC_MAIL.has(d)) throw badRequest(`${d} is a public email service, so no single company can claim it.`);
  return d;
}

// ── Provider metadata ───────────────────────────────────────────────────

async function getJson(url) {
  let r;
  try { r = await safeRequest(url, { method: 'GET', headers: { Accept: 'application/json' }, maxBytes: 512 * 1024, ...httpOpts() }); } catch (err) { throw badRequest(`Could not reach ${new URL(url).host}: ${err.message}`); }
  if (r.status >= 400 || !r.json) throw badRequest(`${new URL(url).host} answered HTTP ${r.status} without JSON.`);
  return r.json;
}

/** Reads and checks the issuer's discovery document. */
async function discover(issuerRaw) {
  let issuerUrl;
  try { issuerUrl = checkUrl(String(issuerRaw || '').trim(), httpOpts()); } catch (err) { throw badRequest(`Issuer URL: ${err.message}`); }
  const issuer = issuerUrl.toString().replace(/\/+$/, '');
  const doc = await getJson(`${issuer}/.well-known/openid-configuration`);
  if (String(doc.issuer || '').replace(/\/+$/, '') !== issuer) throw badRequest(`The discovery document names a different issuer (${String(doc.issuer || 'none').slice(0, 120)}). Use exactly that URL.`);
  const out = { issuer: doc.issuer };
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    try { out[k] = checkUrl(String(doc[k] || ''), httpOpts()).toString(); } catch { throw badRequest(`The provider's ${k.replace(/_/g, ' ')} is missing or not a public https URL.`); }
  }
  const methods = Array.isArray(doc.code_challenge_methods_supported) ? doc.code_challenge_methods_supported : null;
  out.pkce = !methods || methods.includes('S256');
  out.tokenAuth = Array.isArray(doc.token_endpoint_auth_methods_supported) && !doc.token_endpoint_auth_methods_supported.includes('client_secret_post') ? 'client_secret_basic' : 'client_secret_post';
  return out;
}

const jwksCache = new Map(); // jwks_uri -> { at, keys: Map(kid -> { key, alg }) }
async function loadKeys(uri, force = false) {
  const hit = jwksCache.get(uri);
  if (hit && !force && Date.now() - hit.at < JWKS_TTL_MS) return hit.keys;
  const { keys = [] } = await getJson(uri);
  const map = new Map();
  for (const jwk of keys) {
    if (!jwk || (jwk.use && jwk.use !== 'sig') || !['RSA', 'EC'].includes(jwk.kty)) continue;
    try { map.set(jwk.kid || '', { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), kty: jwk.kty }); } catch { /* skip malformed */ }
  }
  jwksCache.set(uri, { at: Date.now(), keys: map });
  return map;
}

const ALGS = {
  RS256: { kty: 'RSA', verify: (data, key, sig) => crypto.verify('RSA-SHA256', data, key, sig) },
  PS256: { kty: 'RSA', verify: (data, key, sig) => crypto.verify('sha256', data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig) },
  ES256: { kty: 'EC', verify: (data, key, sig) => crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig) },
};

/** Verifies an ID token from the organization's provider. Returns its claims. */
async function verifyIdToken(conn, idToken, { nonce, nowMs = Date.now() }) {
  const parts = typeof idToken === 'string' ? idToken.split('.') : [];
  if (parts.length !== 3) throw badRequest('The provider returned a malformed ID token.');
  let header; let claims;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { throw badRequest('The provider returned a malformed ID token.'); }
  const alg = ALGS[header.alg];
  if (!alg) throw badRequest(`The ID token uses ${String(header.alg).slice(0, 10)}; Starlane accepts RS256, PS256 or ES256.`);
  let keys = await loadKeys(conn.discovery.jwks_uri);
  let entry = keys.get(header.kid || '');
  if (!entry) { keys = await loadKeys(conn.discovery.jwks_uri, true); entry = keys.get(header.kid || ''); }
  if (!entry || entry.kty !== alg.kty) throw badRequest('The ID token was signed with a key the provider does not publish.');
  const ok = alg.verify(Buffer.from(`${parts[0]}.${parts[1]}`), entry.key, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw badRequest('The ID token signature is not valid.');
  const now = Math.floor(nowMs / 1000);
  if (String(claims.iss || '').replace(/\/+$/, '') !== String(conn.discovery.issuer).replace(/\/+$/, '')) throw badRequest('The ID token is from another issuer.');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(conn.client_id)) throw badRequest('The ID token is for another application.');
  if (aud.length > 1 && claims.azp && claims.azp !== conn.client_id) throw badRequest('The ID token was issued to another application.');
  if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw badRequest('The ID token has expired.');
  if (typeof claims.iat === 'number' && claims.iat > now + 300) throw badRequest('The ID token is dated in the future.');
  if (!claims.nonce || claims.nonce !== nonce) throw badRequest('The ID token does not belong to this sign-in.');
  return claims;
}

// ── Organization configuration ──────────────────────────────────────────

async function loadConnection(db, orgId) {
  const { rows } = await db.query('SELECT * FROM platform_sso_connections WHERE organization_id = $1', [orgId]);
  return rows[0] || null;
}

function txtName(domain) { return `_starlane-verification.${domain}`; }

async function view(db, org, { redirectUri }) {
  const c = await loadConnection(db, org.id);
  const { rows: domains } = await db.query('SELECT domain, verification_token, verified_at, created_at FROM platform_sso_domains WHERE organization_id = $1 ORDER BY domain', [org.id]);
  return {
    redirectUri,
    connection: c ? {
      protocol: c.protocol, issuer: c.issuer, clientId: c.client_id, hasClientSecret: !!c.client_secret_enc, scopes: c.scopes,
      jitRole: c.jit_role, enforce: c.enforce, status: c.status, testedAt: c.tested_at, updatedAt: c.updated_at,
    } : null,
    domains: domains.map((d) => ({
      domain: d.domain, verified: !!d.verified_at, verifiedAt: d.verified_at,
      dnsRecord: { type: 'TXT', name: txtName(d.domain), value: `starlane-verification=${d.verification_token}` },
    })),
    supports: { oidc: true, saml: false, scim: false },
  };
}

async function save(db, org, userId, input = {}) {
  if (!creds.available()) throw new PlatformError(503, 'KEY_MISSING', 'Single sign-on cannot be saved: this server has no encryption key (OUTBOUND_CREDENTIALS_KEY) for the client secret.');
  const existing = await loadConnection(db, org.id);
  const clientId = String(input.clientId || '').trim();
  if (!clientId || clientId.length > 300) throw badRequest('Enter the client ID from your identity provider.');
  const secret = typeof input.clientSecret === 'string' && input.clientSecret.trim() ? input.clientSecret.trim() : null;
  if (!secret && !existing?.client_secret_enc) throw badRequest('Enter the client secret from your identity provider.');
  if (secret && secret.length > 4000) throw badRequest('That client secret is too long.');
  const jitRole = ROLES.includes(input.jitRole) ? input.jitRole : (existing?.jit_role || 'member');
  const discovery = await discover(input.issuer);
  const changedProvider = !existing || existing.issuer !== discovery.issuer || existing.client_id !== clientId || !!secret;
  await db.query(
    `INSERT INTO platform_sso_connections (organization_id, issuer, client_id, client_secret_enc, discovery, jit_role, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (organization_id) DO UPDATE SET issuer = EXCLUDED.issuer, client_id = EXCLUDED.client_id,
       client_secret_enc = COALESCE($4, platform_sso_connections.client_secret_enc), discovery = EXCLUDED.discovery, jit_role = EXCLUDED.jit_role,
       status = CASE WHEN $8 THEN 'draft' ELSE platform_sso_connections.status END,
       enforce = CASE WHEN $8 THEN FALSE ELSE platform_sso_connections.enforce END,
       tested_at = CASE WHEN $8 THEN NULL ELSE platform_sso_connections.tested_at END,
       updated_at = NOW()`,
    [org.id, discovery.issuer, clientId, secret ? creds.encrypt({ secret }) : null, JSON.stringify(discovery), jitRole, userId, changedProvider],
  );
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: userId, action: 'sso.configured', resourceType: 'sso', detail: { issuerHost: new URL(discovery.issuer).host, jitRole, needsTest: changedProvider } });
}

async function setEnforce(db, org, userId, enforce) {
  const c = await loadConnection(db, org.id);
  if (!c) throw notFound('Single sign-on');
  if (enforce) {
    if (c.status !== 'active') throw conflict('Run a successful test sign-in before requiring single sign-on.');
    const v = await db.query('SELECT 1 FROM platform_sso_domains WHERE organization_id = $1 AND verified_at IS NOT NULL LIMIT 1', [org.id]);
    if (!v.rows[0]) throw conflict('Verify at least one email domain before requiring single sign-on.');
  }
  await db.query('UPDATE platform_sso_connections SET enforce = $2, updated_at = NOW() WHERE organization_id = $1', [org.id, !!enforce]);
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: userId, action: enforce ? 'sso.enforced' : 'sso.not_enforced', resourceType: 'sso' });
}

async function remove(db, org, userId) {
  await db.query('DELETE FROM platform_sso_connections WHERE organization_id = $1', [org.id]);
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: userId, action: 'sso.removed', resourceType: 'sso' });
}

async function addDomain(db, org, userId, raw) {
  const domain = cleanDomain(raw);
  const taken = await db.query('SELECT organization_id FROM platform_sso_domains WHERE domain = $1 AND verified_at IS NOT NULL', [domain]);
  if (taken.rows[0] && taken.rows[0].organization_id !== org.id) throw conflict(`${domain} is already verified by another organization.`);
  const n = await db.query('SELECT COUNT(*)::int AS n FROM platform_sso_domains WHERE organization_id = $1', [org.id]);
  if (n.rows[0].n >= 20) throw conflict('An organization can claim up to 20 domains.');
  await db.query(
    `INSERT INTO platform_sso_domains (organization_id, domain, verification_token) VALUES ($1,$2,$3) ON CONFLICT (organization_id, domain) DO NOTHING`,
    [org.id, domain, b64url(crypto.randomBytes(18))]);
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: userId, action: 'sso.domain_added', resourceType: 'sso', detail: { domain } });
}

async function verifyDomain(db, org, userId, raw) {
  const domain = cleanDomain(raw);
  const { rows } = await db.query('SELECT * FROM platform_sso_domains WHERE organization_id = $1 AND domain = $2', [org.id, domain]);
  const d = rows[0];
  if (!d) throw notFound('That domain');
  if (d.verified_at) return { verified: true };
  let records = [];
  try { records = (await resolveTxt(txtName(domain))).map((chunks) => chunks.join('')); } catch (err) {
    if (!['ENOTFOUND', 'ENODATA'].includes(err.code)) throw badRequest(`DNS lookup failed (${err.code || 'error'}). Try again in a few minutes.`);
  }
  if (!records.includes(`starlane-verification=${d.verification_token}`)) {
    throw badRequest(`The TXT record was not found at ${txtName(domain)}. DNS changes can take a while to appear.`);
  }
  try {
    await db.query('UPDATE platform_sso_domains SET verified_at = NOW() WHERE organization_id = $1 AND domain = $2', [org.id, domain]);
  } catch (err) {
    if (err.code === '23505') throw conflict(`${domain} was verified by another organization first.`);
    throw err;
  }
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: userId, action: 'sso.domain_verified', resourceType: 'sso', detail: { domain } });
  return { verified: true };
}

async function removeDomain(db, org, userId, raw) {
  const domain = String(raw || '').toLowerCase();
  await db.query('DELETE FROM platform_sso_domains WHERE organization_id = $1 AND domain = $2', [org.id, domain]);
  const left = await db.query('SELECT 1 FROM platform_sso_domains WHERE organization_id = $1 AND verified_at IS NOT NULL LIMIT 1', [org.id]);
  if (!left.rows[0]) await db.query('UPDATE platform_sso_connections SET enforce = FALSE WHERE organization_id = $1', [org.id]);
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: userId, action: 'sso.domain_removed', resourceType: 'sso', detail: { domain } });
}

// ── Sign-in ─────────────────────────────────────────────────────────────

/** The organization whose verified domain covers this email, with its connection. */
async function forEmail(db, email) {
  const domain = emailDomain(email);
  if (!domain) return null;
  try {
    const { rows } = await db.query(
      `SELECT c.*, o.owner_user_id FROM platform_sso_domains d
         JOIN platform_sso_connections c ON c.organization_id = d.organization_id
         JOIN organizations o ON o.id = d.organization_id
        WHERE d.domain = $1 AND d.verified_at IS NOT NULL LIMIT 1`, [domain]);
    return rows[0] || null;
  } catch (err) {
    if (err.code === '42P01') return null; // migration 076 not applied
    throw err;
  }
}

/**
 * Whether another sign-in method is refused for this email because its
 * organization requires SSO. The organization's owner is exempt.
 */
async function requiredFor(db, email, userId = null) {
  const c = await forEmail(db, email);
  if (!c || !c.enforce || c.status !== 'active') return null;
  if (userId && c.owner_user_id === userId) return null;
  return { organizationId: c.organization_id };
}

async function start(db, { email = null, organizationId = null, mode = 'signin', startedBy = null, redirectUri }) {
  let conn;
  if (organizationId) conn = await loadConnection(db, organizationId);
  else {
    conn = await forEmail(db, email);
    if (!conn || conn.status !== 'active') throw new PlatformError(404, 'NO_SSO', 'Single sign-on is not set up for this email address.');
  }
  if (!conn) throw notFound('Single sign-on');
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(18));
  const verifier = b64url(crypto.randomBytes(32));
  await db.query(`DELETE FROM platform_sso_states WHERE expires_at < NOW()`);
  await db.query(
    `INSERT INTO platform_sso_states (state_hash, organization_id, nonce, code_verifier, mode, started_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [sha256(state), conn.organization_id, nonce, verifier, mode, startedBy, new Date(Date.now() + STATE_TTL_MS)]);
  const u = new URL(conn.discovery.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', conn.client_id);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', (conn.scopes?.length ? conn.scopes : ['openid', 'email', 'profile']).join(' '));
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  if (conn.discovery.pkce !== false) { u.searchParams.set('code_challenge', b64url(crypto.createHash('sha256').update(verifier).digest())); u.searchParams.set('code_challenge_method', 'S256'); }
  if (email) u.searchParams.set('login_hint', String(email).slice(0, 200));
  return { authorizeUrl: u.toString() };
}

/**
 * Completes a sign-in from the provider's redirect. Returns
 * { mode, organizationId, user } where user is the Starlane account (created
 * if new) and already a member of the organization.
 */
async function complete(db, { code, state, error, redirectUri, nowMs = Date.now() }) {
  if (!state || String(state).length > 200) throw badRequest('The sign-in link is not valid. Start again.');
  const { rows } = await db.query('DELETE FROM platform_sso_states WHERE state_hash = $1 RETURNING *', [sha256(state)]);
  const st = rows[0];
  if (!st || new Date(st.expires_at).getTime() < nowMs) throw badRequest('The sign-in expired or was already used. Start again.');
  if (error) throw badRequest(`The identity provider refused the sign-in (${String(error).slice(0, 80)}).`);
  if (!code) throw badRequest('The identity provider did not return a code.');
  const conn = await loadConnection(db, st.organization_id);
  if (!conn) throw notFound('Single sign-on');
  const secret = conn.client_secret_enc ? creds.decrypt(conn.client_secret_enc)?.secret : null;
  if (!secret) throw new PlatformError(503, 'KEY_MISSING', 'The single sign-on client secret cannot be read on this server.');

  const form = new URLSearchParams({ grant_type: 'authorization_code', code: String(code), redirect_uri: redirectUri, code_verifier: st.code_verifier });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (conn.discovery.tokenAuth === 'client_secret_basic') headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(conn.client_id)}:${encodeURIComponent(secret)}`).toString('base64')}`;
  else { form.set('client_id', conn.client_id); form.set('client_secret', secret); }
  let r;
  try { r = await safeRequest(conn.discovery.token_endpoint, { method: 'POST', headers, body: form.toString(), ...httpOpts() }); } catch (err) { throw badRequest(`Could not reach the identity provider: ${err.message}`); }
  if (r.status >= 400 || !r.json?.id_token) throw badRequest(`The identity provider refused the code (HTTP ${r.status}).`);
  const claims = await verifyIdToken(conn, r.json.id_token, { nonce: st.nonce, nowMs });

  const email = String(claims.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) throw badRequest('The identity provider did not share an email address. Add the email scope or claim.');
  if (claims.email_verified === false || claims.email_verified === 'false') throw badRequest('The identity provider says this email address is not verified.');
  const dom = await db.query('SELECT 1 FROM platform_sso_domains WHERE organization_id = $1 AND domain = $2 AND verified_at IS NOT NULL', [conn.organization_id, emailDomain(email)]);
  if (!dom.rows[0]) throw new PlatformError(403, 'DOMAIN_NOT_VERIFIED', `${emailDomain(email)} is not a verified domain of this organization.`);

  if (st.mode === 'test') {
    await db.query(`UPDATE platform_sso_connections SET status = 'active', tested_at = NOW(), updated_at = NOW() WHERE organization_id = $1`, [conn.organization_id]);
    await audit.recordSoft(db, { organizationId: conn.organization_id, actorUserId: st.started_by, action: 'sso.tested', resourceType: 'sso', detail: { emailDomain: emailDomain(email) } });
  } else if (conn.status !== 'active') {
    throw conflict('Single sign-on for this organization has not passed its test sign-in yet.');
  }

  let user = (await db.query('SELECT id, email, business_name, plan, created_at FROM users WHERE lower(email) = $1 LIMIT 1', [email])).rows[0];
  let created = false;
  if (!user) {
    const name = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 120) : email.split('@')[0];
    user = (await db.query(
      `INSERT INTO users (email, business_name, plan, created_at) VALUES ($1, $2, 'free', NOW())
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id, email, business_name, plan, created_at`, [email, name])).rows[0];
    await db.query('UPDATE users SET email_verified = true WHERE id = $1', [user.id]).catch(() => {});
    created = true;
  }
  const mem = await db.query(
    `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (organization_id, user_id) DO NOTHING RETURNING role`,
    [conn.organization_id, user.id, conn.jit_role]);
  await audit.recordSoft(db, { organizationId: conn.organization_id, actorUserId: user.id, action: 'sso.signed_in', resourceType: 'sso', detail: { mode: st.mode, newAccount: created, addedAsMember: !!mem.rows[0], role: mem.rows[0]?.role || null } });
  return { mode: st.mode, organizationId: conn.organization_id, user };
}

module.exports = {
  discover, verifyIdToken, view, save, setEnforce, remove, addDomain, verifyDomain, removeDomain,
  forEmail, requiredFor, start, complete, cleanDomain, __setTestOptions, PUBLIC_MAIL,
};
