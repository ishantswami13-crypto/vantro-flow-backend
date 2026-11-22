'use strict';
// Connections from an organization to any software: create (OpenAPI import,
// catalog, MCP server), authorize (API key, bearer, basic, OAuth 2.0 client
// credentials or authorization code with PKCE), call an operation, log it.
//
// Rules every path follows:
//   * The organization comes from req.org (membership checked upstream); every
//     query filters by organization_id.
//   * Credentials are AES-256-GCM encrypted (lib/domain/outbound/credentials)
//     and never returned, logged or put in an error.
//   * Requests go through safeHttp: https only, public addresses only, no
//     redirects, a timeout and a size cap. A call can only reach the
//     connection's own base URL: path parameters are URL-encoded and the
//     final URL's origin and base path are checked.
//   * Only declared operations and declared parameters can be sent.
//   * Every call is written to platform_connector_calls (no bodies). Calls
//     that change something in the other system are also audited.

const crypto = require('crypto');
const creds = require('../../domain/outbound/credentials');
const { safeRequest, checkUrl } = require('../../connectors/safeHttp');
const audit = require('../audit');
const { badRequest, notFound, conflict, forbidden, PlatformError, UUID_RE } = require('../errors');
const { importSpec, OP_ID } = require('./openapi');
const { getCatalogEntry } = require('./catalog');
const mcp = require('./mcp');

const AUTH_TYPES = ['none', 'api_key', 'bearer', 'basic', 'oauth2_client_credentials', 'oauth2_authorization_code'];
const MAX_CONNECTIONS = 100;
const MAX_BODY_BYTES = 100 * 1024;
const CALLS_PER_MINUTE = Number(process.env.CONNECTOR_CALLS_PER_MINUTE || 60);
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

// Tests point requests at a local server; production never sets this.
let testHttp = null;
function __setTestHttpOptions(o) { testHttp = o; }
const httpOpts = () => testHttp || {};

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const b64url = (buf) => buf.toString('base64url');

// ── Views ───────────────────────────────────────────────────────────────

function opView(o) {
  return { id: o.id, method: o.method, path: o.path, summary: o.summary, risk: o.risk, parameters: o.parameters || [], body: o.body || null, readOnlyHint: o.readOnlyHint, inputSchema: o.inputSchema };
}

function view(row, { withOperations = false } = {}) {
  if (!row) return null;
  const ops = Array.isArray(row.operations) ? row.operations : [];
  const a = row.auth_config || {};
  const out = {
    id: row.id, name: row.name, source: row.source, catalogKey: row.catalog_key, baseUrl: row.base_url,
    auth: { type: row.auth_type, in: a.in || null, name: a.name || null, clientId: a.clientId || null, scopes: a.scopes || [], authorizeUrl: a.authorizeUrl || null, tokenUrl: a.tokenUrl || null },
    hasCredentials: !!row.credentials_enc, status: row.status,
    operationCounts: { read: ops.filter((o) => o.risk === 'read').length, external: ops.filter((o) => o.risk !== 'read').length },
    spec: row.spec_meta || {}, lastUsedAt: row.last_used_at, lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at,
  };
  if (withOperations) out.operations = ops.map(opView);
  return out;
}

// ── Validation ──────────────────────────────────────────────────────────

function cleanName(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  if (!n) throw badRequest('Give the connection a name.');
  if (n.length > 80) throw badRequest('Keep the name under 80 characters.');
  return n;
}

function cleanBaseUrl(raw) {
  if (!raw) throw badRequest('Enter the API base URL (https://…).');
  let u;
  try { u = checkUrl(String(raw).trim(), httpOpts()); } catch (err) { throw badRequest(err.message); }
  if (u.search || u.hash) throw badRequest('The base URL cannot have a query string or fragment.');
  return u.toString().replace(/\/+$/, '');
}

/** Splits auth input into non-secret config and the secret to encrypt. */
function normalizeAuth(input = {}, suggested = {}) {
  const type = AUTH_TYPES.includes(input.type) ? input.type : (suggested.type || 'none');
  const config = {};
  let secret = null;
  if (type === 'api_key') {
    const where = input.in || suggested.in || 'header';
    if (!['header', 'query'].includes(where)) throw badRequest('An API key goes in a header or a query parameter.');
    const name = String(input.name || suggested.name || '').trim();
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw badRequest('Enter the header or parameter name the API expects for its key, such as X-API-Key.');
    if (where === 'header' && /^(host|cookie|content-length|content-type)$/i.test(name)) throw badRequest('That header cannot carry an API key.');
    Object.assign(config, { in: where, name });
    if (input.secret) secret = { secret: String(input.secret) };
  } else if (type === 'bearer') {
    if (input.secret) secret = { secret: String(input.secret) };
  } else if (type === 'basic') {
    if (input.secret) {
      if (!String(input.secret).includes(':')) throw badRequest('Basic auth is entered as username:password.');
      secret = { secret: String(input.secret) };
    }
  } else if (type === 'oauth2_client_credentials' || type === 'oauth2_authorization_code') {
    const tokenUrl = input.tokenUrl || suggested.tokenUrl;
    try { config.tokenUrl = checkUrl(String(tokenUrl || ''), httpOpts()).toString(); } catch { throw badRequest('Enter the OAuth token URL (https://…).'); }
    if (type === 'oauth2_authorization_code') {
      const authorizeUrl = input.authorizeUrl || suggested.authorizeUrl;
      try { config.authorizeUrl = checkUrl(String(authorizeUrl || ''), httpOpts()).toString(); } catch { throw badRequest('Enter the OAuth authorization URL (https://…).'); }
      if (suggested.extraAuthorizeParams) config.extraAuthorizeParams = suggested.extraAuthorizeParams;
    }
    config.clientId = String(input.clientId || '').trim().slice(0, 300);
    if (!config.clientId) throw badRequest('Enter the OAuth client ID.');
    const scopes = Array.isArray(input.scopes) ? input.scopes : Array.isArray(suggested.scopes) ? suggested.scopes : String(input.scopes || '').split(/[\s,]+/);
    config.scopes = scopes.map((s) => String(s).trim()).filter(Boolean).slice(0, 30).map((s) => s.slice(0, 200));
    if (input.clientSecret) secret = { clientSecret: String(input.clientSecret) };
  }
  if (secret && Object.values(secret).some((v) => String(v).length > 8000)) throw badRequest('That credential is too long.');
  return { type, config, secret };
}

function needsSecret(type) { return ['api_key', 'bearer', 'basic', 'oauth2_client_credentials', 'oauth2_authorization_code'].includes(type); }

// ── Reads ───────────────────────────────────────────────────────────────

async function loadRow(db, org, id) {
  if (!UUID_RE.test(String(id || ''))) throw notFound('That connection');
  const { rows } = await db.query('SELECT * FROM platform_app_connections WHERE organization_id = $1 AND id = $2', [org.id, id]);
  if (!rows[0]) throw notFound('That connection');
  return rows[0];
}

async function list(db, org) {
  const { rows } = await db.query('SELECT * FROM platform_app_connections WHERE organization_id = $1 ORDER BY created_at DESC', [org.id]);
  return rows.map((r) => view(r));
}

async function get(db, org, id) {
  return view(await loadRow(db, org, id), { withOperations: true });
}

async function activeCount(db, orgId) {
  const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM platform_app_connections WHERE organization_id = $1 AND status = 'active'`, [orgId]);
  return rows[0].n;
}

// ── Create ──────────────────────────────────────────────────────────────

async function insert(db, org, userId, { name, source, catalogKey = null, baseUrl, auth, operations, specMeta }) {
  const count = await db.query('SELECT COUNT(*)::int AS n FROM platform_app_connections WHERE organization_id = $1', [org.id]);
  if (count.rows[0].n >= MAX_CONNECTIONS) throw conflict(`An organization can keep up to ${MAX_CONNECTIONS} connections.`, 'LIMIT');
  if (auth.secret && !creds.available()) throw new PlatformError(503, 'KEY_MISSING', 'OUTBOUND_CREDENTIALS_KEY is not set on this server, so credentials cannot be stored safely.');
  const status = auth.type === 'oauth2_authorization_code' ? 'authorization_required' : (needsSecret(auth.type) && !auth.secret ? 'authorization_required' : 'active');
  const meta = { ...specMeta, operations: { read: operations.filter((o) => o.risk === 'read').length, external: operations.filter((o) => o.risk !== 'read').length } };
  try {
    const { rows } = await db.query(
      `INSERT INTO platform_app_connections (organization_id, created_by, name, source, catalog_key, base_url, auth_type, auth_config, credentials_enc, status, operations, spec_meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [org.id, userId, name, source, catalogKey, baseUrl, auth.type, JSON.stringify(auth.config), auth.secret ? creds.encrypt(auth.secret) : null, status, JSON.stringify(operations), JSON.stringify(meta)],
    );
    await audit.recordSoft(db, { organizationId: org.id, actorUserId: userId, action: 'connection.created', resourceType: 'connection', resourceId: rows[0].id, detail: { name, source, catalogKey, authType: auth.type, operations: meta.operations, baseHost: new URL(baseUrl).hostname } });
    return view(rows[0], { withOperations: true });
  } catch (err) {
    if (err.code === '23505') throw conflict('A connection with that name already exists.');
    throw err;
  }
}

/** Preview of an OpenAPI import, nothing saved. */
async function previewSpec({ spec, specUrl, readOnly = false }) {
  let text = spec;
  if (!text && specUrl) {
    let r;
    try { r = await safeRequest(String(specUrl), { method: 'GET', headers: { Accept: 'application/json, application/yaml, text/yaml, */*' }, maxBytes: 3 * 1024 * 1024, ...httpOpts() }); } catch (err) { throw badRequest(`The document could not be fetched: ${err.message}`); }
    if (r.status >= 400) throw badRequest(`The document URL answered HTTP ${r.status}.`);
    text = r.body;
  }
  return importSpec(text, { readOnly });
}

async function createFromSpec(db, org, userId, input = {}) {
  const parsed = await previewSpec(input);
  const baseUrl = cleanBaseUrl(input.baseUrl || parsed.baseUrl);
  const auth = normalizeAuth(input.auth || {}, parsed.auth);
  return insert(db, org, userId, {
    name: cleanName(input.name || parsed.title), source: 'openapi', baseUrl, auth, operations: parsed.operations,
    specMeta: { title: parsed.title, version: parsed.version, format: parsed.format, readOnly: !!input.readOnly, skipped: parsed.skipped.length, totalOperations: parsed.totalOperations },
  });
}

async function createFromCatalog(db, org, userId, input = {}) {
  const entry = getCatalogEntry(input.catalogKey);
  if (!entry) throw badRequest('There is no catalog entry with that key.');
  let base = entry.baseUrl;
  for (const f of entry.baseUrlFields || []) {
    const v = String(input.baseUrlFields?.[f.name] || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(v)) throw badRequest(`Enter the ${f.label}.`);
    base = base.replace(`{${f.name}}`, v);
  }
  const auth = normalizeAuth({ ...(input.auth || {}), type: entry.auth.type, in: entry.auth.in, name: entry.auth.name }, entry.auth);
  if (entry.staticHeaders) auth.config.staticHeaders = entry.staticHeaders;
  const operations = input.readOnly ? entry.operations.filter((o) => o.risk === 'read') : entry.operations;
  return insert(db, org, userId, {
    name: cleanName(input.name || entry.name), source: 'catalog', catalogKey: entry.key, baseUrl: cleanBaseUrl(base), auth,
    operations: JSON.parse(JSON.stringify(operations)), specMeta: { title: entry.name, format: 'Starlane catalog', readOnly: !!input.readOnly, verified: false, docs: entry.docs },
  });
}

function mcpHeaders(row, secret) {
  if (row.auth_type === 'bearer' && secret?.secret) return { Authorization: `Bearer ${secret.secret}` };
  if (row.auth_type === 'api_key' && secret?.secret && row.auth_config?.in === 'header') return { [row.auth_config.name]: secret.secret };
  return {};
}

async function createMcp(db, org, userId, input = {}) {
  const url = cleanBaseUrl(input.url);
  const auth = normalizeAuth(input.auth || { type: 'none' });
  if (!['none', 'bearer', 'api_key'].includes(auth.type) || (auth.type === 'api_key' && auth.config.in !== 'header')) {
    throw badRequest('An MCP server connects with no auth, a bearer token, or an API key header.');
  }
  let found;
  try {
    found = await mcp.discover(url, { headers: mcpHeaders({ auth_type: auth.type, auth_config: auth.config }, auth.secret), http: httpOpts() });
  } catch (err) {
    if (err instanceof PlatformError && err.status < 500) throw err;
    throw badRequest(`Starlane could not list the server's tools: ${creds.redact(err.message).slice(0, 200)}`);
  }
  return insert(db, org, userId, {
    name: cleanName(input.name || found.info.serverName || 'MCP server'), source: 'mcp', baseUrl: url, auth, operations: found.operations,
    specMeta: { title: found.info.serverName, version: found.info.serverVersion, format: `MCP ${found.info.protocolVersion || ''}`.trim() },
  });
}

async function refreshMcpTools(db, org, userId, id) {
  const row = await loadRow(db, org, id);
  if (row.source !== 'mcp') throw badRequest('Only an MCP server connection lists its tools again.');
  const secret = row.credentials_enc ? creds.decrypt(row.credentials_enc) : null;
  const found = await mcp.discover(row.base_url, { headers: mcpHeaders(row, secret), http: httpOpts() });
  await db.query(`UPDATE platform_app_connections SET operations = $3, spec_meta = spec_meta || $4::jsonb, updated_at = NOW() WHERE organization_id = $1 AND id = $2`,
    [org.id, id, JSON.stringify(found.operations), JSON.stringify({ operations: { read: 0, external: found.operations.length } })]);
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: userId, action: 'connection.tools_refreshed', resourceType: 'connection', resourceId: id, detail: { tools: found.operations.length } });
  return get(db, org, id);
}

// ── Change ──────────────────────────────────────────────────────────────

async function setStatus(db, org, userId, id, enabled) {
  const row = await loadRow(db, org, id);
  if (enabled && row.status === 'authorization_required') throw conflict('Authorize this connection before turning it on.');
  const status = enabled ? 'active' : 'disabled';
  await db.query('UPDATE platform_app_connections SET status = $3, updated_at = NOW() WHERE organization_id = $1 AND id = $2', [org.id, id, status]);
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: userId, action: enabled ? 'connection.enabled' : 'connection.disabled', resourceType: 'connection', resourceId: id, detail: { name: row.name } });
  return { status };
}

/** Replaces the stored secret (rotation). Returns the new status. */
async function setCredentials(db, org, userId, id, input = {}) {
  const row = await loadRow(db, org, id);
  const auth = normalizeAuth({ ...input, type: row.auth_type, in: row.auth_config?.in, name: row.auth_config?.name, clientId: input.clientId || row.auth_config?.clientId, tokenUrl: row.auth_config?.tokenUrl, authorizeUrl: row.auth_config?.authorizeUrl, scopes: input.scopes || row.auth_config?.scopes }, row.auth_config);
  if (!auth.secret) throw badRequest('Enter the new credential.');
  if (!creds.available()) throw new PlatformError(503, 'KEY_MISSING', 'OUTBOUND_CREDENTIALS_KEY is not set on this server, so credentials cannot be stored safely.');
  const status = row.auth_type === 'oauth2_authorization_code' ? 'authorization_required' : (row.status === 'disabled' ? 'disabled' : 'active');
  await db.query(`UPDATE platform_app_connections SET credentials_enc = $3, auth_config = $4, status = $5, last_error = NULL, updated_at = NOW() WHERE organization_id = $1 AND id = $2`,
    [org.id, id, creds.encrypt(auth.secret), JSON.stringify({ ...row.auth_config, ...auth.config }), status]);
  tokenCache.delete(id);
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: userId, action: 'connection.credentials_updated', resourceType: 'connection', resourceId: id, detail: { name: row.name, authType: row.auth_type } });
  return { status };
}

async function remove(db, org, userId, id) {
  const row = await loadRow(db, org, id);
  await db.query('DELETE FROM platform_app_connections WHERE organization_id = $1 AND id = $2', [org.id, id]);
  tokenCache.delete(id);
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: userId, action: 'connection.deleted', resourceType: 'connection', resourceId: id, detail: { name: row.name } });
}

// ── OAuth 2.0 authorization code with PKCE ──────────────────────────────

async function startOAuth(db, org, userId, id, { redirectUri, returnTo = null }) {
  const row = await loadRow(db, org, id);
  if (row.auth_type !== 'oauth2_authorization_code') throw badRequest('This connection does not sign in with OAuth.');
  if (!row.credentials_enc) throw badRequest('Enter the OAuth client secret first.');
  if (!creds.available()) throw new PlatformError(503, 'KEY_MISSING', 'OUTBOUND_CREDENTIALS_KEY is not set on this server.');
  const state = b64url(crypto.randomBytes(32));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const safeReturn = typeof returnTo === 'string' && /^\/[A-Za-z0-9/_?=&.-]{0,200}$/.test(returnTo) && !returnTo.startsWith('//') ? returnTo : '/connectors';
  await db.query('DELETE FROM platform_oauth_states WHERE expires_at < NOW()');
  await db.query(
    `INSERT INTO platform_oauth_states (state_hash, organization_id, connection_id, user_id, code_verifier_enc, redirect_uri, return_to, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [sha256(state), org.id, id, userId, creds.encrypt({ verifier }), redirectUri, safeReturn, new Date(Date.now() + OAUTH_STATE_TTL_MS)],
  );
  const cfg = row.auth_config || {};
  const u = new URL(cfg.authorizeUrl);
  const params = { response_type: 'code', client_id: cfg.clientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256', ...(cfg.scopes?.length ? { scope: cfg.scopes.join(' ') } : {}), ...(cfg.extraAuthorizeParams || {}) };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return { authorizeUrl: u.toString(), expiresInSeconds: OAUTH_STATE_TTL_MS / 1000 };
}

function tokenExpiry(json) {
  const s = Number(json?.expires_in);
  return Number.isFinite(s) && s > 0 ? Date.now() + s * 1000 : null;
}

/**
 * The provider redirected back. The state is the only credential: it was
 * issued to one signed-in member for one connection, is single-use and
 * expires after 10 minutes. Returns { returnTo, ok, message }.
 */
async function completeOAuth(db, { state, code, error }) {
  if (!state || String(state).length > 200) return { ok: false, returnTo: '/connectors', message: 'The sign-in link is not valid.' };
  const { rows } = await db.query(
    `UPDATE platform_oauth_states SET used_at = NOW() WHERE state_hash = $1 AND used_at IS NULL AND expires_at > NOW() RETURNING *`, [sha256(state)]);
  const st = rows[0];
  if (!st) return { ok: false, returnTo: '/connectors', message: 'The sign-in link expired or was already used. Start again.' };
  const orgRef = { id: st.organization_id };
  const returnTo = st.return_to || '/connectors';
  if (error || !code) {
    await audit.recordSoft(db, { organizationId: st.organization_id, actorUserId: st.user_id, action: 'connection.authorization_failed', resourceType: 'connection', resourceId: st.connection_id, detail: { reason: String(error || 'no code').slice(0, 100) } });
    return { ok: false, returnTo, message: 'The app did not grant access.' };
  }
  const row = await loadRow(db, orgRef, st.connection_id);
  const secret = creds.decrypt(row.credentials_enc) || {};
  const verifier = creds.decrypt(st.code_verifier_enc)?.verifier;
  const cfg = row.auth_config || {};
  const form = new URLSearchParams({ grant_type: 'authorization_code', code: String(code).slice(0, 2000), redirect_uri: st.redirect_uri, client_id: cfg.clientId, client_secret: secret.clientSecret || '', code_verifier: verifier || '' }).toString();
  let r;
  try {
    r = await safeRequest(cfg.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form, ...httpOpts() });
  } catch (err) {
    await db.query('UPDATE platform_app_connections SET last_error = $3 WHERE organization_id = $1 AND id = $2', [st.organization_id, row.id, creds.redact(err.message).slice(0, 300)]);
    return { ok: false, returnTo, message: 'Starlane could not reach the app to finish signing in.' };
  }
  const tok = r.json?.access_token;
  if (r.status >= 400 || !tok) {
    await db.query('UPDATE platform_app_connections SET last_error = $3 WHERE organization_id = $1 AND id = $2', [st.organization_id, row.id, `Token exchange failed (HTTP ${r.status})`]);
    return { ok: false, returnTo, message: `The app refused the sign-in (HTTP ${r.status}).` };
  }
  const next = { clientSecret: secret.clientSecret, accessToken: tok, refreshToken: r.json.refresh_token || null, expiresAt: tokenExpiry(r.json) };
  await db.query(`UPDATE platform_app_connections SET credentials_enc = $3, status = 'active', last_error = NULL, updated_at = NOW() WHERE organization_id = $1 AND id = $2`,
    [st.organization_id, row.id, creds.encrypt(next)]);
  await audit.recordSoft(db, { organizationId: st.organization_id, actorUserId: st.user_id, action: 'connection.authorized', resourceType: 'connection', resourceId: row.id, detail: { name: row.name, refreshable: !!next.refreshToken } });
  return { ok: true, returnTo, message: `${row.name} is connected.` };
}

// ── Calling an operation ────────────────────────────────────────────────

const tokenCache = new Map(); // client-credentials tokens by connection id
const rate = new Map(); // connection id -> [timestamps]

function takeRateSlot(id) {
  const now = Date.now();
  const recent = (rate.get(id) || []).filter((t) => now - t < 60000);
  if (recent.length >= CALLS_PER_MINUTE) throw new PlatformError(429, 'RATE_LIMITED', `This connection made ${CALLS_PER_MINUTE} calls in the last minute. Try again shortly.`);
  recent.push(now);
  rate.set(id, recent);
}

async function accessToken(db, row, secret) {
  const cfg = row.auth_config || {};
  if (row.auth_type === 'oauth2_client_credentials') {
    const c = tokenCache.get(row.id);
    if (c && c.exp > Date.now() + 30000) return c.token;
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: secret.clientSecret || '', ...(cfg.scopes?.length ? { scope: cfg.scopes.join(' ') } : {}) }).toString();
    const r = await safeRequest(cfg.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form, ...httpOpts() });
    if (r.status >= 400 || !r.json?.access_token) throw new PlatformError(502, 'AUTH_FAILED', `The OAuth token request failed (HTTP ${r.status}).`);
    tokenCache.set(row.id, { token: r.json.access_token, exp: tokenExpiry(r.json) || Date.now() + 3600 * 1000 });
    return r.json.access_token;
  }
  // Authorization code: refresh when it expires within a minute.
  if (secret.accessToken && (!secret.expiresAt || secret.expiresAt > Date.now() + 60000)) return secret.accessToken;
  if (!secret.refreshToken) {
    await db.query(`UPDATE platform_app_connections SET status = 'authorization_required', last_error = 'The sign-in expired. Authorize again.' WHERE id = $1`, [row.id]);
    throw new PlatformError(409, 'AUTHORIZATION_REQUIRED', 'The sign-in to this app expired. An admin needs to authorize it again.');
  }
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: secret.refreshToken, client_id: cfg.clientId, client_secret: secret.clientSecret || '' }).toString();
  const r = await safeRequest(cfg.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form, ...httpOpts() });
  if (r.status >= 400 || !r.json?.access_token) {
    await db.query(`UPDATE platform_app_connections SET status = 'authorization_required', last_error = $2 WHERE id = $1`, [row.id, `Token refresh failed (HTTP ${r.status})`]);
    throw new PlatformError(409, 'AUTHORIZATION_REQUIRED', 'The app refused to renew the sign-in. An admin needs to authorize it again.');
  }
  const next = { ...secret, accessToken: r.json.access_token, refreshToken: r.json.refresh_token || secret.refreshToken, expiresAt: tokenExpiry(r.json) };
  await db.query('UPDATE platform_app_connections SET credentials_enc = $2, updated_at = NOW() WHERE id = $1', [row.id, creds.encrypt(next)]);
  return next.accessToken;
}

function scalar(v, name) {
  if (v == null) return null;
  if (!['string', 'number', 'boolean'].includes(typeof v)) throw badRequest(`"${name}" must be text, a number or true/false.`);
  const s = String(v);
  if (s.length > 2000) throw badRequest(`"${name}" is too long.`);
  return s;
}

/** Builds the request URL and headers for an operation. Exported for tests. */
function buildRequest(baseUrl, op, params = {}) {
  if (params == null || typeof params !== 'object' || Array.isArray(params)) throw badRequest('params must be an object');
  const declared = new Map((op.parameters || []).map((p) => [p.name, p]));
  for (const k of Object.keys(params)) if (!declared.has(k)) throw badRequest(`The operation ${op.id} has no parameter "${k}".`);
  let path = op.path;
  const query = [];
  const headers = {};
  for (const p of declared.values()) {
    const v = scalar(params[p.name], p.name);
    if (v == null || v === '') { if (p.required) throw badRequest(`The operation ${op.id} needs "${p.name}".`); continue; }
    if (p.in === 'path' && (v === '.' || v === '..')) throw badRequest(`"${p.name}" cannot be . or ..`);
    if (p.in === 'path') path = path.split(`{${p.name}}`).join(encodeURIComponent(v));
    else if (p.in === 'query') query.push([p.name, v]);
    else if (p.in === 'header') { if (/[\r\n]/.test(v)) throw badRequest(`"${p.name}" cannot contain line breaks.`); headers[p.name] = v; }
  }
  if (/\{[^}]+\}/.test(path)) throw badRequest(`The operation ${op.id} is missing a path value.`);
  const base = new URL(baseUrl);
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}${path}`);
  const basePath = base.pathname.replace(/\/+$/, '');
  if (url.origin !== base.origin || (basePath && !url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath)) {
    throw badRequest('That request would leave the connection\'s own address.');
  }
  for (const [k, v] of query) url.searchParams.append(k, v);
  return { url, headers };
}

async function logCall(db, entry) {
  await db.query(
    `INSERT INTO platform_connector_calls (organization_id, connection_id, operation_id, method, risk, actor_kind, actor_user_id, execution_id, status_code, ok, duration_ms, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [entry.orgId, entry.connectionId, entry.operationId, entry.method, entry.risk, entry.actorKind, entry.actorUserId || null, entry.executionId || null, entry.status ?? null, !!entry.ok, entry.durationMs ?? null, entry.error ? String(entry.error).slice(0, 300) : null],
  ).catch(() => {});
}

/**
 * Calls one operation. `allowRisk` is the highest risk the caller may use:
 * 'read' refuses any operation that changes something in the other system.
 * Returns { status, ok, json, text, bodyPreview, operation }.
 */
async function callOperation(db, org, { connectionId, operationId, params = {}, body = null, actorKind = 'user', actorUserId = null, executionId = null, idempotencyKey = null, allowRisk = 'external' }) {
  const row = await loadRow(db, org, connectionId);
  if (row.status !== 'active') throw conflict(row.status === 'authorization_required' ? `"${row.name}" needs to be authorized first.` : `"${row.name}" is turned off.`);
  if (!OP_ID.test(String(operationId || ''))) throw badRequest('Name the operation to call.');
  const op = (row.operations || []).find((o) => o.id === operationId);
  if (!op) throw badRequest(`"${row.name}" has no operation called ${operationId}.`);
  if (allowRisk === 'read' && op.risk !== 'read') throw forbidden(`${operationId} changes something in ${row.name}; it cannot be called as a read.`, 'RISK_NOT_ALLOWED');
  takeRateSlot(row.id);

  const secret = row.credentials_enc ? creds.decrypt(row.credentials_enc) : null;
  if (row.credentials_enc && !secret) throw new PlatformError(503, 'KEY_MISSING', 'This connection\'s credentials cannot be read on this server (OUTBOUND_CREDENTIALS_KEY changed or missing).');
  const t0 = Date.now();
  const log = { orgId: org.id, connectionId: row.id, operationId: op.id, method: op.method, risk: op.risk === 'read' ? 'read' : 'external', actorKind, actorUserId, executionId };
  try {
    let result;
    if (row.source === 'mcp') {
      if (body != null) throw badRequest('MCP tools take their arguments in params.');
      const r = await mcp.callTool(row.base_url, op.id, params || {}, { headers: mcpHeaders(row, secret), http: httpOpts() });
      result = { status: 200, ok: !r.isError, json: r.structured, text: r.text, bodyPreview: r.text ? creds.redact(r.text.slice(0, 500)) : null };
    } else {
      const { url, headers } = buildRequest(row.base_url, op, params || {});
      const h = { Accept: 'application/json', ...(row.auth_config?.staticHeaders || {}), ...headers };
      const cfg = row.auth_config || {};
      if (row.auth_type === 'bearer') h.Authorization = `Bearer ${secret.secret}`;
      if (row.auth_type === 'basic') h.Authorization = `Basic ${Buffer.from(secret.secret).toString('base64')}`;
      if (row.auth_type === 'api_key' && cfg.in === 'header') h[cfg.name] = secret.secret;
      if (row.auth_type === 'api_key' && cfg.in === 'query') url.searchParams.set(cfg.name, secret.secret);
      if (row.auth_type.startsWith('oauth2_')) h.Authorization = `Bearer ${await accessToken(db, row, secret)}`;
      if (idempotencyKey && op.risk !== 'read') h['Idempotency-Key'] = String(idempotencyKey).slice(0, 200);
      let payload = null;
      if (body != null) {
        if (!op.body) throw badRequest(`${op.id} does not take a body.`);
        if (typeof body !== 'object') throw badRequest('The body must be a JSON object.');
        payload = JSON.stringify(body);
        if (Buffer.byteLength(payload) > MAX_BODY_BYTES) throw badRequest('The body is larger than 100 KB.');
        h['Content-Type'] = 'application/json';
      } else if (op.body?.required) {
        throw badRequest(`${op.id} needs a JSON body.`);
      }
      const r = await safeRequest(url.toString(), { method: op.method, headers: h, body: payload, ...httpOpts() });
      result = { status: r.status, ok: r.status >= 200 && r.status < 300, json: r.json, text: null, bodyPreview: r.json ? null : creds.redact(String(r.body || '').slice(0, 500)) };
    }
    await logCall(db, { ...log, status: result.status, ok: result.ok, durationMs: Date.now() - t0, error: result.ok ? null : `HTTP ${result.status}` });
    await db.query('UPDATE platform_app_connections SET last_used_at = NOW(), last_error = $3 WHERE organization_id = $1 AND id = $2', [org.id, row.id, result.ok ? null : `HTTP ${result.status} on ${op.id}`]);
    if (op.risk !== 'read') {
      await audit.recordSoft(db, { organizationId: org.id, actorUserId, actorKind: actorKind === 'agent' ? 'agent' : 'user', action: 'connection.external_call', resourceType: 'connection', resourceId: row.id, detail: { operation: op.id, method: op.method, status: result.status, executionId } });
    }
    return { ...result, operation: { id: op.id, method: op.method, risk: op.risk, summary: op.summary } };
  } catch (err) {
    const message = creds.redact(err.message || 'The call failed').slice(0, 300);
    await logCall(db, { ...log, ok: false, durationMs: Date.now() - t0, error: message });
    if (!(err instanceof PlatformError)) await db.query('UPDATE platform_app_connections SET last_error = $3 WHERE organization_id = $1 AND id = $2', [org.id, row.id, message]).catch(() => {});
    if (err instanceof PlatformError) throw err;
    throw new PlatformError(502, 'CALL_FAILED', `The call to ${row.name} failed: ${message}`);
  }
}

async function listCalls(db, org, { connectionId = null, limit = 50 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const { rows } = await db.query(
    `SELECT c.id, c.connection_id, a.name AS connection_name, c.operation_id, c.method, c.risk, c.actor_kind, u.email AS actor_email, c.execution_id, c.status_code, c.ok, c.duration_ms, c.error, c.created_at
       FROM platform_connector_calls c
       LEFT JOIN platform_app_connections a ON a.id = c.connection_id
       LEFT JOIN users u ON u.id = c.actor_user_id
      WHERE c.organization_id = $1 AND ($2::uuid IS NULL OR c.connection_id = $2)
      ORDER BY c.id DESC LIMIT $3`,
    [org.id, connectionId && UUID_RE.test(connectionId) ? connectionId : null, lim],
  );
  return rows.map((r) => ({ ...r, id: String(r.id) }));
}

module.exports = {
  AUTH_TYPES, list, get, previewSpec, createFromSpec, createFromCatalog, createMcp, refreshMcpTools, setStatus, setCredentials, remove,
  startOAuth, completeOAuth, callOperation, listCalls, buildRequest, activeCount, view, __setTestHttpOptions,
};
