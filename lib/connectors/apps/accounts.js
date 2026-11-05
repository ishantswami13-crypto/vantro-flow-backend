'use strict';
// lib/connectors/apps/accounts.js — connecting an app and keeping its access.
//
//   OAuth apps (Zoho Books, QuickBooks): connectUrl() signs a 10-minute state
//   that names the tenant and the app; the vendor sends the browser back to
//   GET /api/connectors/:id/callback, completeOAuth() checks that state,
//   exchanges the code and stores the refresh token encrypted.
//   API-key apps (Razorpay, WhatsApp Business): saveApiKey() checks the key
//   with one read before storing it encrypted.
//
// clientFor() hands a sync an authorized GET function. Access tokens are
// refreshed under a row lock, because Intuit rotates refresh tokens and two
// refreshes racing would lose the newer one. A refused refresh marks the
// account AUTH_REQUIRED, which the Sources page shows as "Reconnect".
//
// Every query filters by user_id. Credentials are never returned.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const creds = require('../../domain/outbound/credentials');
const { provider, isLive } = require('./index');

const REFRESH_MARGIN_MS = 2 * 60 * 1000;

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

function apiBase() {
  return String(process.env.PUBLIC_API_URL || '').replace(/\/+$/, '');
}

function redirectUri(id) {
  return `${apiBase()}/api/connectors/${id}/callback`;
}

function requireLive(id) {
  const p = provider(id);
  if (!p) throw httpError(404, 'Unknown connector');
  if (!isLive(id)) throw httpError(409, `${id.replace(/_/g, ' ')} is not switched on on this server yet.`, { code: 'CONNECTOR_NOT_LIVE' });
  if (!creds.available()) throw httpError(503, 'OUTBOUND_CREDENTIALS_KEY is not set, so access cannot be stored safely.');
  return p;
}

function view(row) {
  if (!row) return null;
  return {
    id: row.id,
    connectorId: row.connector_id,
    status: row.status,
    statusReason: row.status_reason,
    label: row.account_label,
    lastSyncAt: row.last_sync_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    connectedAt: row.created_at,
  };
}

async function getAccount(pool, userId, id) {
  const r = await pool.query('SELECT * FROM app_connector_accounts WHERE user_id = $1 AND connector_id = $2', [userId, id]);
  return r.rows[0] || null;
}

async function upsertAccount(pool, userId, id, { credentials, config, externalAccountId, label }) {
  try {
    const r = await pool.query(
      `INSERT INTO app_connector_accounts (user_id, connector_id, status, account_label, external_account_id, config, credentials_enc)
       VALUES ($1,$2,'CONNECTED',$3,$4,$5,$6)
       ON CONFLICT (user_id, connector_id) DO UPDATE SET status = 'CONNECTED', status_reason = NULL, account_label = EXCLUDED.account_label,
         external_account_id = EXCLUDED.external_account_id, config = EXCLUDED.config, credentials_enc = EXCLUDED.credentials_enc,
         last_error = NULL, updated_at = now()
       RETURNING *`,
      [userId, id, String(label || '').slice(0, 200) || null, externalAccountId ? String(externalAccountId).slice(0, 200) : null, JSON.stringify(config || {}), creds.encrypt(credentials)]
    );
    return r.rows[0];
  } catch (err) {
    if (err.code === '23505') throw httpError(409, 'That WhatsApp number is already connected to another Starlane account.');
    throw err;
  }
}

/** The vendor's consent page for this tenant. */
function connectUrl(userId, id, { returnTo = 'sources' } = {}) {
  const p = requireLive(id);
  if (p.authKind !== 'oauth') throw httpError(400, `${id} connects with an API key, not a sign-in.`);
  const state = jwt.sign({ sub: userId, app: id, returnTo: ['sources', 'access', 'onboarding'].includes(returnTo) ? returnTo : 'sources', n: crypto.randomBytes(8).toString('hex') },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '10m', audience: `app-connector:${id}` });
  return { url: p.authorizeUrl({ state, redirectUri: redirectUri(id) }), scopes: p.scopes || [] };
}

/** Pure-ish: checks the signed state. Returns { userId, returnTo } or null. */
function readState(id, raw) {
  try {
    const s = jwt.verify(String(raw || ''), process.env.JWT_SECRET, { algorithms: ['HS256'], audience: `app-connector:${id}` });
    return s.app === id && s.sub ? { userId: s.sub, returnTo: s.returnTo || 'sources' } : null;
  } catch {
    return null;
  }
}

async function completeOAuth(pool, id, query = {}) {
  const p = requireLive(id);
  if (p.authKind !== 'oauth') throw httpError(404, 'Unknown connector');
  const state = readState(id, query.state);
  if (!state) throw httpError(400, 'This connect link has expired or is not valid. Start again from Sources in Starlane.', { code: 'BAD_STATE' });
  if (query.error || !query.code) return { ...state, result: 'cancelled' };
  const got = await p.exchangeCode({ query, redirectUri: redirectUri(id) });
  const row = await upsertAccount(pool, state.userId, id, got);
  return { ...state, result: 'connected', account: view(row) };
}

async function saveApiKey(pool, userId, id, input = {}) {
  const p = requireLive(id);
  if (p.authKind !== 'api_key') throw httpError(400, `${id} connects by signing in, not with a key.`);
  const got = await p.verify(input);
  return view(await upsertAccount(pool, userId, id, got));
}

async function deleteAccount(pool, userId, id) {
  const r = await pool.query('DELETE FROM app_connector_accounts WHERE user_id = $1 AND connector_id = $2', [userId, id]);
  if (!r.rowCount) throw httpError(404, 'Nothing is connected for this app.');
}

async function markAuthRequired(pool, userId, id, reason) {
  await pool.query(`UPDATE app_connector_accounts SET status = 'AUTH_REQUIRED', status_reason = $3, updated_at = now() WHERE user_id = $1 AND connector_id = $2`,
    [userId, id, creds.redact(String(reason || '')).slice(0, 300)]);
}

/**
 * An authorized GET for this account: (path, query) → JSON. Refreshes an
 * OAuth access token when it is close to expiry and saves the new tokens.
 */
async function clientFor(pool, account) {
  const p = provider(account.connector_id);
  if (!p) throw httpError(404, 'Unknown connector');
  const stored = creds.decrypt(account.credentials_enc);
  if (!stored) throw httpError(503, 'This app’s access cannot be read on this server (OUTBOUND_CREDENTIALS_KEY changed or missing). Connect it again.');
  let credentials = stored;
  let config = account.config || {};
  if (p.authKind === 'oauth' && !(credentials.accessToken && Number(credentials.expiresAt) > Date.now() + REFRESH_MARGIN_MS)) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = (await client.query('SELECT credentials_enc, config FROM app_connector_accounts WHERE id = $1 AND user_id = $2 FOR UPDATE', [account.id, account.user_id])).rows[0];
      if (!locked) throw httpError(404, 'This app was disconnected.');
      credentials = creds.decrypt(locked.credentials_enc) || credentials;
      config = locked.config || config;
      if (!(credentials.accessToken && Number(credentials.expiresAt) > Date.now() + REFRESH_MARGIN_MS)) {
        try {
          const next = await p.refresh(credentials, config);
          credentials = next.credentials;
          config = next.config || config;
          await client.query('UPDATE app_connector_accounts SET credentials_enc = $3, config = $4, updated_at = now() WHERE id = $1 AND user_id = $2',
            [account.id, account.user_id, creds.encrypt(credentials), JSON.stringify(config)]);
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          if (err.kind === 'AUTH_EXPIRED') await markAuthRequired(pool, account.user_id, account.connector_id, err.message);
          throw err;
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  const get = p.makeClient({ accessToken: credentials.accessToken, config, credentials });
  return { get, phoneNumberId: account.external_account_id };
}

module.exports = {
  view, getAccount, connectUrl, readState, completeOAuth, saveApiKey, deleteAccount, clientFor, markAuthRequired, redirectUri, requireLive,
};
