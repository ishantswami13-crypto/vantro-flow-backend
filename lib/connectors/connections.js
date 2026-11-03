'use strict';
// lib/connectors/connections.js — connect any software.
//
// Two generic connection kinds cover tools Starlane has no dedicated
// connector for:
//
//   webhook_in  An address any tool can POST JSON to (Zapier, Make, n8n,
//               Stripe, Shopify, a CRM's webhook settings, a script).
//               Starlane gives a secret URL once; only its SHA-256 is kept.
//               Optionally the sender signs the body (HMAC-SHA256 with a
//               signing secret) and Starlane rejects unsigned requests.
//               Each POST is stored as an event and starts the workflows
//               listening to that webhook.
//
//   http_api    A REST API Starlane can call from a workflow step: a base
//               URL plus auth (none, bearer token, API key header, basic,
//               or OAuth2 client credentials). The preset "slack" is a
//               Slack incoming-webhook URL. Secrets are encrypted at rest
//               and never returned. Requests go through safeHttp (https
//               only, no private addresses, no redirects).
//
// Every function takes userId and filters by it.

const crypto = require('crypto');
const creds = require('../domain/outbound/credentials');
const { safeRequest, checkUrl } = require('./safeHttp');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ['webhook_in', 'http_api'];
const AUTH = ['none', 'bearer', 'header', 'basic', 'oauth2_client_credentials'];
const PRESETS = ['custom', 'slack'];
const MAX_CONNECTIONS = 50;
const MAX_EVENT_BYTES = 256 * 1024;

// Tests point requests at a local server; production never sets this.
let testHttpOptions = null;
function __setTestHttpOptions(o) { testHttpOptions = o; }

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function view(row) {
  if (!row) return null;
  const c = row.config || {};
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    preset: c.preset || 'custom',
    baseUrl: row.kind === 'http_api' ? (c.preset === 'slack' ? 'https://hooks.slack.com/…' : c.baseUrl || null) : null,
    authType: row.kind === 'http_api' ? c.authType || 'none' : null,
    headerName: c.headerName || null,
    signed: row.kind === 'webhook_in' ? !!c.signed : null,
    hasSecret: !!row.secret_enc,
    lastUsedAt: row.last_used_at,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

function cleanName(name) {
  const n = String(name || '').trim();
  if (!n) throw httpError(400, 'Give the connection a name.');
  if (n.length > 80) throw httpError(400, 'Keep the name under 80 characters.');
  return n;
}

async function listConnections(pool, userId) {
  const r = await pool.query('SELECT * FROM starlane_connections WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
  return r.rows.map(view);
}

async function getConnectionRow(pool, userId, id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  const r = await pool.query('SELECT * FROM starlane_connections WHERE id = $1 AND user_id = $2', [id, userId]);
  return r.rows[0] || null;
}

/**
 * Creates a connection. For webhook_in returns { connection, token } where
 * token is shown once (the URL is /api/hooks/<token>), plus signingSecret when
 * signed. Secrets for http_api are encrypted before they are stored.
 */
async function createConnection(pool, userId, input = {}) {
  const kind = String(input.kind || '');
  if (!KINDS.includes(kind)) throw httpError(400, 'A connection is an incoming webhook or an HTTP API.');
  const name = cleanName(input.name);
  const count = await pool.query('SELECT COUNT(*)::int AS n FROM starlane_connections WHERE user_id = $1', [userId]);
  if (count.rows[0].n >= MAX_CONNECTIONS) throw httpError(409, `You can keep up to ${MAX_CONNECTIONS} connections.`);

  if (kind === 'webhook_in') {
    const token = crypto.randomBytes(24).toString('base64url');
    const signed = input.signed === true;
    const signingSecret = signed ? crypto.randomBytes(24).toString('base64url') : null;
    if (signed && !creds.available()) throw httpError(503, 'OUTBOUND_CREDENTIALS_KEY is not set, so a signing secret cannot be stored safely.');
    const r = await pool.query(
      `INSERT INTO starlane_connections (user_id, kind, name, config, secret_enc, inbound_token_hash)
       VALUES ($1,'webhook_in',$2,$3,$4,$5) RETURNING *`,
      [userId, name, JSON.stringify({ signed }), signed ? creds.encrypt({ signingSecret }) : null, sha256(token)]
    );
    return { connection: view(r.rows[0]), token, signingSecret };
  }

  const preset = PRESETS.includes(input.preset) ? input.preset : 'custom';
  const config = { preset };
  let secret = null;
  if (preset === 'slack') {
    const u = checkUrl(input.webhookUrl || input.baseUrl, testHttpOptions || {});
    if (u.hostname !== 'hooks.slack.com' && !testHttpOptions) throw httpError(400, 'A Slack incoming webhook starts with https://hooks.slack.com/');
    config.authType = 'none';
    secret = { webhookUrl: u.toString() }; // the URL itself is the credential
  } else {
    const u = checkUrl(input.baseUrl, testHttpOptions || {});
    config.baseUrl = u.toString().replace(/\/+$/, '');
    const authType = AUTH.includes(input.authType) ? input.authType : 'none';
    config.authType = authType;
    if (authType === 'header') {
      const h = String(input.headerName || '').trim();
      if (!/^[A-Za-z0-9-]{1,64}$/.test(h)) throw httpError(400, 'Enter the header name your API expects, such as X-API-Key.');
      config.headerName = h;
    }
    if (authType === 'oauth2_client_credentials') {
      config.tokenUrl = checkUrl(input.tokenUrl, testHttpOptions || {}).toString();
      config.clientId = String(input.clientId || '').trim().slice(0, 300);
      config.scope = input.scope ? String(input.scope).slice(0, 500) : null;
      if (!config.clientId) throw httpError(400, 'Enter the OAuth client ID.');
    }
    if (authType !== 'none') {
      const s = String(input.secret || '');
      if (!s) throw httpError(400, authType === 'basic' ? 'Enter the username:password.' : authType === 'oauth2_client_credentials' ? 'Enter the OAuth client secret.' : 'Enter the API key or token.');
      if (authType === 'basic' && !s.includes(':')) throw httpError(400, 'Basic auth is entered as username:password.');
      secret = { secret: s };
    }
  }
  if (secret && !creds.available()) throw httpError(503, 'OUTBOUND_CREDENTIALS_KEY is not set, so the secret cannot be stored safely.');
  const r = await pool.query(
    `INSERT INTO starlane_connections (user_id, kind, name, config, secret_enc) VALUES ($1,'http_api',$2,$3,$4) RETURNING *`,
    [userId, name, JSON.stringify(config), secret ? creds.encrypt(secret) : null]
  );
  return { connection: view(r.rows[0]) };
}

async function deleteConnection(pool, userId, id) {
  if (!UUID_RE.test(String(id || ''))) throw httpError(404, 'connection not found');
  const r = await pool.query('DELETE FROM starlane_connections WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!r.rowCount) throw httpError(404, 'connection not found');
}

async function setConnectionStatus(pool, userId, id, status) {
  if (!['ACTIVE', 'DISABLED'].includes(status)) throw httpError(400, 'unknown status');
  if (!UUID_RE.test(String(id || ''))) throw httpError(404, 'connection not found');
  const r = await pool.query('UPDATE starlane_connections SET status = $3, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING *', [id, userId, status]);
  if (!r.rows[0]) throw httpError(404, 'connection not found');
  return view(r.rows[0]);
}

/** A new URL token for an incoming webhook; the old URL stops working at once. */
async function rotateWebhookToken(pool, userId, id) {
  const row = await getConnectionRow(pool, userId, id);
  if (!row || row.kind !== 'webhook_in') throw httpError(404, 'connection not found');
  const token = crypto.randomBytes(24).toString('base64url');
  await pool.query('UPDATE starlane_connections SET inbound_token_hash = $3, updated_at = now() WHERE id = $1 AND user_id = $2', [id, userId, sha256(token)]);
  return { token };
}

// ── Incoming webhooks ──────────────────────────────────────────────────

function timingSafeEqualHex(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Accepts one POST to /api/hooks/:token. The tenant comes only from the
 * token. Returns { connection, event, duplicate } or throws with a status.
 */
async function receiveWebhook(pool, token, { rawBody, body, signature, eventId }) {
  if (!token || String(token).length < 20 || String(token).length > 100) throw httpError(404, 'unknown webhook');
  const r = await pool.query(`SELECT * FROM starlane_connections WHERE inbound_token_hash = $1 AND kind = 'webhook_in'`, [sha256(token)]);
  const conn = r.rows[0];
  if (!conn) throw httpError(404, 'unknown webhook');
  if (conn.status !== 'ACTIVE') throw httpError(410, 'This webhook is turned off.');
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody ? String(rawBody) : JSON.stringify(body || {}), 'utf8');
  if (raw.length > MAX_EVENT_BYTES) throw httpError(413, 'The payload is larger than 256 KB.');
  if (conn.config?.signed) {
    const secret = creds.decrypt(conn.secret_enc)?.signingSecret;
    if (!secret) throw httpError(503, 'This webhook’s signing secret cannot be read on this server.');
    const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    const given = String(signature || '').replace(/^sha256=/i, '').trim().toLowerCase();
    if (!timingSafeEqualHex(expected, given)) throw httpError(401, 'The X-Starlane-Signature header does not match the body.');
  }
  let payload = body;
  if (payload === undefined || payload === null || typeof payload !== 'object') {
    try { payload = JSON.parse(raw.toString('utf8') || '{}'); } catch { throw httpError(400, 'Send the body as JSON.'); }
  }
  // The sender's own delivery id makes its retries safe; otherwise the body hash.
  const externalId = `${conn.id}:${eventId ? String(eventId).slice(0, 200) : sha256(raw)}`;
  const ins = await pool.query(
    `INSERT INTO starlane_connection_events (user_id, connection_id, source, external_id, payload)
     VALUES ($1,$2,'webhook',$3,$4) ON CONFLICT (user_id, source, external_id) DO NOTHING RETURNING *`,
    [conn.user_id, conn.id, externalId, JSON.stringify(payload)]
  );
  await pool.query('UPDATE starlane_connections SET last_used_at = now() WHERE id = $1', [conn.id]);
  return { connection: conn, event: ins.rows[0] || null, duplicate: !ins.rows.length };
}

async function listEvents(pool, userId, { limit = 20, connectionId = null } = {}) {
  const n = Math.max(1, Math.min(100, Number(limit) || 20));
  const r = await pool.query(
    `SELECT id, connection_id, source, external_id, payload, received_at, dispatched_at FROM starlane_connection_events
      WHERE user_id = $1 AND ($2::uuid IS NULL OR connection_id = $2) ORDER BY received_at DESC LIMIT $3`,
    [userId, connectionId && UUID_RE.test(connectionId) ? connectionId : null, n]
  );
  return r.rows;
}

// ── Outgoing HTTP ──────────────────────────────────────────────────────

const tokenCache = new Map(); // connection id -> { token, exp }

async function oauthToken(conn, secret) {
  const c = tokenCache.get(conn.id);
  if (c && c.exp > Date.now() + 30000) return c.token;
  const cfg = conn.config || {};
  const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: secret, ...(cfg.scope ? { scope: cfg.scope } : {}) }).toString();
  const r = await safeRequest(cfg.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form, ...(testHttpOptions || {}) });
  const tok = r.json?.access_token;
  if (r.status >= 400 || !tok) throw httpError(502, `The OAuth token request failed (HTTP ${r.status}).`);
  tokenCache.set(conn.id, { token: tok, exp: Date.now() + Number(r.json.expires_in || 3600) * 1000 });
  return tok;
}

/**
 * Calls an http_api connection. `path` is appended to the base URL (it
 * cannot change the host). Returns { status, ok, json, bodyPreview }.
 */
async function callConnection(pool, userId, connectionId, { method = 'POST', path = '', body = null, idempotencyKey = null } = {}) {
  const conn = await getConnectionRow(pool, userId, connectionId);
  if (!conn || conn.kind !== 'http_api') throw httpError(404, 'The connection for this step no longer exists.');
  if (conn.status !== 'ACTIVE') throw httpError(409, `The connection "${conn.name}" is turned off.`);
  const cfg = conn.config || {};
  const s = conn.secret_enc ? creds.decrypt(conn.secret_enc) : null;
  if (conn.secret_enc && !s) throw httpError(503, 'This connection’s secret cannot be read on this server (OUTBOUND_CREDENTIALS_KEY changed or missing).');
  const headers = { Accept: 'application/json' };
  let url;
  if (cfg.preset === 'slack') {
    url = s?.webhookUrl;
  } else {
    const p = String(path || '').trim();
    if (p && (!p.startsWith('/') || p.startsWith('//') || /[\s\\]/.test(p))) throw httpError(400, 'The path starts with / and has no spaces.');
    url = `${cfg.baseUrl}${p}`;
    if (cfg.authType === 'bearer') headers.Authorization = `Bearer ${s.secret}`;
    if (cfg.authType === 'header') headers[cfg.headerName] = s.secret;
    if (cfg.authType === 'basic') headers.Authorization = `Basic ${Buffer.from(s.secret).toString('base64')}`;
    if (cfg.authType === 'oauth2_client_credentials') headers.Authorization = `Bearer ${await oauthToken(conn, s.secret)}`;
  }
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 200);
  const m = String(method || 'POST').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) throw httpError(400, 'Pick GET, POST, PUT, PATCH or DELETE.');
  if (body !== null && m !== 'GET') headers['Content-Type'] = 'application/json';
  try {
    const r = await safeRequest(url, { method: m, headers, body: m === 'GET' ? null : body, ...(testHttpOptions || {}) });
    const ok = r.status >= 200 && r.status < 300;
    await pool.query('UPDATE starlane_connections SET last_used_at = now(), last_error = $3 WHERE id = $1 AND user_id = $2',
      [conn.id, userId, ok ? null : `HTTP ${r.status}`]);
    return { status: r.status, ok, json: r.json, bodyPreview: creds.redact(r.body.slice(0, 500)) };
  } catch (err) {
    await pool.query('UPDATE starlane_connections SET last_error = $3 WHERE id = $1 AND user_id = $2', [conn.id, userId, creds.redact(err.message).slice(0, 300)]);
    throw err;
  }
}

module.exports = {
  KINDS, AUTH, PRESETS, MAX_EVENT_BYTES,
  listConnections, getConnectionRow, createConnection, deleteConnection, setConnectionStatus, rotateWebhookToken,
  receiveWebhook, listEvents, callConnection, view, sha256, __setTestHttpOptions,
};
