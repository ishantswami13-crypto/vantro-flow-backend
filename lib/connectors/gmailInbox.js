'use strict';
// lib/connectors/gmailInbox.js — Gmail as a workflow source.
//
// Gmail is connected once, through Google OAuth (the same account the
// outbound engine uses: outbound_provider_accounts, refresh token encrypted
// with OUTBOUND_CREDENTIALS_KEY, scopes gmail.readonly + gmail.send). This
// module reads new inbox messages for tenants that have an ACTIVE workflow
// listening for email, and stores each one as a connection event, which
// starts those workflows. Sending goes through workflow approvals, never
// from here.
//
// Every query is scoped by user_id. Message bodies are trimmed before they
// are stored, and tokens never leave the adapter.

const creds = require('../domain/outbound/credentials');
const { adapterFor } = require('../domain/outbound/providers');
const { safeLog } = require('../observability/logger');

const BODY_LIMIT = 4000;

async function gmailAccount(pool, userId, accountId = null) {
  const r = await pool.query(
    `SELECT * FROM outbound_provider_accounts WHERE user_id = $1 AND provider = 'gmail'
       AND ($2::uuid IS NULL OR id = $2) ORDER BY (status = 'HEALTHY') DESC, created_at ASC LIMIT 1`,
    [userId, accountId]
  );
  return r.rows[0] || null;
}

async function gmailStatus(pool, userId) {
  const configured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_OAUTH_REDIRECT_URI);
  let accounts = [];
  try {
    const r = await pool.query(
      `SELECT id, from_address, status, status_reason, last_success_at, created_at FROM outbound_provider_accounts
        WHERE user_id = $1 AND provider = 'gmail' ORDER BY created_at`, [userId]);
    accounts = r.rows.map((a) => ({ id: a.id, address: a.from_address, status: a.status, statusReason: a.status_reason, connectedAt: a.created_at, lastSuccessAt: a.last_success_at }));
  } catch (err) {
    if (err.code !== '42P01') throw err; // migration 062 not applied: no accounts
  }
  return { oauthConfigured: configured, credentialsKeyConfigured: creds.available(), accounts };
}

function adapterForAccount(account, opts = {}) {
  const credentials = creds.decrypt(account.credentials_enc);
  return adapterFor(account, { credentials, ...opts });
}

/** Pure: an inbox message, trimmed to what workflows use. */
function toEvent(m, account) {
  return {
    accountId: account.id,
    to: account.from_address,
    messageId: m.id,
    threadId: m.threadId,
    from: m.from || '',
    fromAddress: m.fromAddress || '',
    subject: (m.subject || '').slice(0, 300),
    body: (m.body || '').slice(0, BODY_LIMIT),
    inReplyTo: m.inReplyTo || null,
    receivedAt: m.receivedAt,
    isBounce: !!m.isBounce,
    autoReply: !!(m.headers && (m.headers['auto-submitted'] && m.headers['auto-submitted'] !== 'no' || m.headers['x-autoreply'])),
  };
}

/**
 * Reads new inbox messages for one tenant into connection events. `since`
 * is the newest event already stored (or 1 day back). Returns the new events.
 */
async function pollInbox(pool, userId, { accountId = null, adapter = null, now = Date.now() } = {}) {
  const account = await gmailAccount(pool, userId, accountId);
  if (!account) return { status: 'NOT_CONNECTED', events: [] };
  if (account.status === 'AUTH_REQUIRED') return { status: 'AUTH_REQUIRED', events: [] };
  const last = await pool.query(
    `SELECT MAX((payload->>'receivedAt')::timestamptz) AS at FROM starlane_connection_events WHERE user_id = $1 AND source = 'gmail' AND payload->>'accountId' = $2`,
    [userId, account.id]
  );
  const since = last.rows[0].at ? new Date(last.rows[0].at).getTime() - 60000 : now - 24 * 3600 * 1000;
  const a = adapter || adapterForAccount(account);
  let listed;
  try {
    listed = await a.listInbound({ since: new Date(since).toISOString() });
  } catch (err) {
    if (err.status === 401) {
      await pool.query(`UPDATE outbound_provider_accounts SET status = 'AUTH_REQUIRED', status_reason = $3, updated_at = now() WHERE id = $1 AND user_id = $2`,
        [account.id, userId, creds.redact(err.message).slice(0, 200)]);
      return { status: 'AUTH_REQUIRED', events: [] };
    }
    throw err;
  }
  const fresh = [];
  for (const m of listed.messages || []) {
    if (m.isBounce) continue; // bounces belong to the outbound engine
    const ev = toEvent(m, account);
    const ins = await pool.query(
      `INSERT INTO starlane_connection_events (user_id, source, external_id, payload) VALUES ($1,'gmail',$2,$3)
       ON CONFLICT (user_id, source, external_id) DO NOTHING RETURNING *`,
      [userId, `${account.id}:${m.id}`, JSON.stringify(ev)]
    );
    if (ins.rows[0]) fresh.push(ins.rows[0]);
  }
  return { status: 'OK', events: fresh };
}

/** Sends one approved email from the tenant's Gmail. Idempotent on `idempotencyKey`. */
async function sendFromGmail(pool, userId, { accountId = null, to, subject, body, threadId = null, inReplyTo = null, idempotencyKey, adapter = null }) {
  const account = await gmailAccount(pool, userId, accountId);
  if (!account) throw Object.assign(new Error('Connect Gmail first (Data sources › Gmail).'), { status: 409 });
  if (account.status === 'AUTH_REQUIRED') throw Object.assign(new Error('Gmail needs to be reconnected.'), { status: 409 });
  const a = adapter || adapterForAccount(account);
  const prior = await a.findSentByKey({ idempotencyKey, to, subject }).catch(() => ({ found: false }));
  if (prior.found) return { providerMessageId: prior.providerMessageId, threadId: prior.threadId, alreadySent: true, from: account.from_address };
  const r = await a.sendEmail({ to, subject, body, threadId, inReplyTo, idempotencyKey });
  await pool.query('UPDATE outbound_provider_accounts SET last_success_at = now() WHERE id = $1 AND user_id = $2', [account.id, userId]).catch(() => {});
  return { ...r, from: account.from_address };
}

/** Tenants with an ACTIVE workflow that listens for email. */
async function tenantsListeningForEmail(pool, { limit = 200 } = {}) {
  const r = await pool.query(
    `SELECT DISTINCT user_id FROM starlane_custom_workflows
      WHERE status = 'ACTIVE' AND definition->'trigger'->>'type' = 'email_received' LIMIT $1`, [limit]);
  return r.rows.map((x) => x.user_id);
}

async function pollAllInboxes(pool, { dispatch, limit = 200 } = {}) {
  const out = { tenants: 0, events: 0, notConnected: 0, authRequired: 0, failed: 0 };
  for (const userId of await tenantsListeningForEmail(pool, { limit })) {
    out.tenants++;
    try {
      const r = await pollInbox(pool, userId);
      if (r.status === 'NOT_CONNECTED') out.notConnected++;
      if (r.status === 'AUTH_REQUIRED') out.authRequired++;
      out.events += r.events.length;
      if (dispatch) for (const ev of r.events) await dispatch(pool, userId, ev);
    } catch (err) {
      out.failed++;
      safeLog('warn', '[gmail-inbox] poll failed', { userId, error: creds.redact(err.message) });
    }
  }
  return out;
}

module.exports = { gmailAccount, gmailStatus, pollInbox, pollAllInboxes, sendFromGmail, toEvent, tenantsListeningForEmail, BODY_LIMIT };
