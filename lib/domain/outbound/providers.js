'use strict';
// lib/domain/outbound/providers.js
// One interface over email providers:
//
//   sendEmail({ from, fromName, to, subject, body, threadId, inReplyTo, idempotencyKey })
//        -> { providerMessageId, threadId, rfc822MessageId }
//   findSentByKey({ idempotencyKey, to, subject, sentAfter }) -> { found, providerMessageId, threadId } | { found:false }
//   getMessage(id), getThread(id)
//   getDeliveryState(id)   -> what the provider can honestly say (Gmail: nothing beyond "accepted")
//   priorThreads(address)  -> threads with this address, for thread awareness before a cold send
//   listInbound({ since }) -> new inbound messages (replies and bounce reports), parsed
//   checkAuth()            -> { ok, reason }
//
// Adapters:
//   gmail  REAL. Gmail REST API with an OAuth refresh token (stored encrypted)
//          and GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Not exercised against a
//          live mailbox from CI; covered by tests with a recorded HTTP double.
//   sink   Delivers nowhere. Used in SHADOW mode and tests; it records what
//          would have been sent. Fault injection for chaos tests.
//   outlook NOT IMPLEMENTED. Registering an Outlook account is refused.
//
// Errors thrown by adapters carry { status, code, retryAfterMs, message }
// with tokens scrubbed, and are classified by classify.classifyProviderError.

const crypto = require('crypto');
const { redact } = require('./credentials');

const SUPPORTED = { gmail: true, sink: true, outlook: false };

function providerError(status, message, extra = {}) {
  return Object.assign(new Error(redact(message)), { status, ...extra });
}

function rfc822Id(idempotencyKey) {
  const h = crypto.createHash('sha256').update(String(idempotencyKey)).digest('hex').slice(0, 32);
  return `<${h}@outbound.starlane>`;
}

function keyHash(idempotencyKey) {
  return crypto.createHash('sha256').update(String(idempotencyKey)).digest('hex').slice(0, 32);
}

function encodeHeader(v) {
  // RFC 2047 for non-ASCII; plain otherwise. Strip CR/LF (header injection).
  const s = String(v || '').replace(/[\r\n]+/g, ' ').trim();
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function buildMime({ from, fromName, to, subject, body, inReplyTo, idempotencyKey, unsubscribeMailto }) {
  const headers = [
    `From: ${fromName ? `${encodeHeader(fromName)} <${from}>` : from}`,
    `To: ${String(to).replace(/[\r\n]/g, '')}`,
    `Subject: ${encodeHeader(subject)}`,
    `Message-ID: ${rfc822Id(idempotencyKey)}`,
    `X-Starlane-Key: ${keyHash(idempotencyKey)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  if (unsubscribeMailto) headers.push(`List-Unsubscribe: <mailto:${unsubscribeMailto}?subject=unsubscribe>`);
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`);
  const b64 = Buffer.from(String(body), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${b64}`;
}

// ---------------------------------------------------------------- sink
const sinkStore = new Map(); // idempotencyKey -> record (per process)

function sinkAdapter(account, opts = {}) {
  const faults = opts.faults || (() => { try { return JSON.parse(process.env.OUTBOUND_SINK_FAULTS || '{}'); } catch { return {}; } })();
  return {
    name: 'sink',
    real: false,
    async checkAuth() { return { ok: true, reason: 'sink delivers nowhere' }; },
    async sendEmail(m) {
      const f = faults[String(m.to).toLowerCase()] || faults['*'];
      if (f === '429') throw providerError(429, 'sink: rate limited', { retryAfterMs: 120000 });
      if (f === '503') throw providerError(503, 'sink: unavailable');
      if (f === 'timeout') throw Object.assign(new Error('sink: timeout'), { code: 'ETIMEDOUT' });
      if (f === 'auth') throw providerError(401, 'sink: invalid_grant');
      if (f === 'invalid') throw providerError(400, 'sink: Invalid To header');
      const existing = sinkStore.get(m.idempotencyKey);
      if (existing) return existing; // provider-side idempotency, like a real dedupe
      const rec = { providerMessageId: `sink-${crypto.randomUUID()}`, threadId: m.threadId || `sink-thread-${crypto.randomUUID()}`, rfc822MessageId: rfc822Id(m.idempotencyKey), to: m.to, subject: m.subject, at: new Date().toISOString() };
      sinkStore.set(m.idempotencyKey, rec);
      return rec;
    },
    async findSentByKey({ idempotencyKey }) {
      const r = sinkStore.get(idempotencyKey);
      return r ? { found: true, providerMessageId: r.providerMessageId, threadId: r.threadId } : { found: false, conclusive: true };
    },
    async getMessage(id) { return [...sinkStore.values()].find((r) => r.providerMessageId === id) || null; },
    async getThread(id) { return { id, messages: [...sinkStore.values()].filter((r) => r.threadId === id) }; },
    async getDeliveryState() { return { state: 'ACCEPTED_BY_SINK', note: 'sink delivers nowhere' }; },
    async priorThreads() { return []; },
    async listInbound() { return { messages: [], cursor: null }; },
  };
}

// ---------------------------------------------------------------- gmail
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const tokenCache = new Map(); // account id -> { token, exp }

function gmailAdapter(account, { credentials, fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  async function http(url, init = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: ctl.signal });
    } catch (err) {
      if (err.name === 'AbortError') throw Object.assign(new Error('gmail: request timed out'), { code: 'TIMEOUT' });
      throw Object.assign(new Error(`gmail: network error ${redact(err.message)}`), { code: err.code || err.cause?.code || 'NETWORK' });
    } finally { clearTimeout(t); }
  }

  async function accessToken() {
    const c = tokenCache.get(account.id);
    if (c && c.exp > Date.now() + 60000) return c.token;
    if (!credentials || !credentials.refreshToken) throw providerError(401, 'gmail: no refresh token stored for this account');
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw providerError(401, 'gmail: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured');
    const r = await http('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: credentials.refreshToken, grant_type: 'refresh_token' }).toString(),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw providerError(r.status === 400 ? 401 : r.status, `gmail: token refresh failed (${j.error || r.status})`);
    tokenCache.set(account.id, { token: j.access_token, exp: Date.now() + (Number(j.expires_in || 3600) * 1000) });
    return j.access_token;
  }

  async function api(path, init = {}) {
    const token = await accessToken();
    const r = await http(`${GMAIL}${path}`, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    if (r.status === 401) tokenCache.delete(account.id);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const ra = r.headers.get('retry-after');
      const retryAfterMs = ra ? (Number.isFinite(Number(ra)) ? Number(ra) * 1000 : Math.max(0, Date.parse(ra) - Date.now())) : null;
      throw providerError(r.status, `gmail: ${j.error?.message || r.statusText || r.status}`, { retryAfterMs });
    }
    return r.status === 204 ? {} : r.json();
  }

  const header = (msg, name) => (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || null;
  function textBody(part) {
    if (!part) return '';
    if (part.mimeType === 'text/plain' && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8');
    for (const p of part.parts || []) { const t = textBody(p); if (t) return t; }
    if (part.mimeType === 'message/delivery-status' && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8');
    return '';
  }
  function dsnOf(msg) {
    const all = [];
    (function walk(p) { if (!p) return; if (p.body?.data) all.push(Buffer.from(p.body.data, 'base64url').toString('utf8')); (p.parts || []).forEach(walk); })(msg.payload);
    const text = all.join('\n');
    const status = (/^Status:\s*([245]\.\d{1,3}\.\d{1,3})/mi.exec(text) || [])[1] || null;
    const diagnostic = (/^Diagnostic-Code:\s*(.+)$/mi.exec(text) || [])[1] || text.slice(0, 500);
    const recipient = (/^Final-Recipient:\s*rfc822;\s*(\S+)/mi.exec(text) || [])[1] || null;
    const originalMessageId = (/^Message-ID:\s*(<[^>]+@outbound\.starlane>)/mi.exec(text) || [])[1] || null;
    return { status, diagnostic, recipient, originalMessageId };
  }

  return {
    name: 'gmail',
    real: true,
    async checkAuth() {
      try { const p = await api('/profile'); return { ok: true, reason: `authorised as ${p.emailAddress}`, emailAddress: p.emailAddress }; } catch (err) { return { ok: false, reason: redact(err.message), status: err.status }; }
    },
    async sendEmail(m) {
      const raw = Buffer.from(buildMime({ ...m, from: account.from_address, fromName: account.display_name })).toString('base64url');
      const j = await api('/messages/send', { method: 'POST', body: JSON.stringify(m.threadId ? { raw, threadId: m.threadId } : { raw }) });
      return { providerMessageId: j.id, threadId: j.threadId, rfc822MessageId: rfc822Id(m.idempotencyKey) };
    },
    async findSentByKey({ idempotencyKey, to, subject }) {
      const q1 = `in:sent rfc822msgid:${rfc822Id(idempotencyKey).slice(1, -1)}`;
      const a = await api(`/messages?q=${encodeURIComponent(q1)}&maxResults=5`);
      if (a.messages?.length) return { found: true, providerMessageId: a.messages[0].id, threadId: a.messages[0].threadId };
      // Gmail may rewrite Message-ID; fall back to recipient + subject and
      // confirm by our X-Starlane-Key header.
      const q2 = `in:sent to:${to} subject:"${String(subject || '').replace(/"/g, '')}" newer_than:3d`;
      const b = await api(`/messages?q=${encodeURIComponent(q2)}&maxResults=10`);
      for (const m of b.messages || []) {
        const full = await api(`/messages/${m.id}?format=metadata&metadataHeaders=X-Starlane-Key`);
        if (header(full, 'X-Starlane-Key') === keyHash(idempotencyKey)) return { found: true, providerMessageId: m.id, threadId: m.threadId };
      }
      return { found: false, conclusive: true };
    },
    async getMessage(id) { return api(`/messages/${encodeURIComponent(id)}?format=full`); },
    async getThread(id) { return api(`/threads/${encodeURIComponent(id)}?format=metadata`); },
    async getDeliveryState() { return { state: 'ACCEPTED', note: 'Gmail does not report delivery; bounces arrive as mailer-daemon messages and are read by the poller' }; },
    async priorThreads(address) {
      const j = await api(`/threads?q=${encodeURIComponent(`(from:${address} OR to:${address}) newer_than:365d`)}&maxResults=10`);
      return (j.threads || []).map((t) => ({ id: t.id, snippet: t.snippet }));
    },
    async listInbound({ since }) {
      const after = Math.floor((since ? new Date(since).getTime() : Date.now() - 86400000) / 1000);
      const j = await api(`/messages?q=${encodeURIComponent(`in:inbox after:${after}`)}&maxResults=50`);
      const messages = [];
      for (const m of j.messages || []) {
        const full = await api(`/messages/${m.id}?format=full`);
        const from = header(full, 'From') || '';
        const isBounce = /mailer-daemon|postmaster/i.test(from) || /delivery status notification|undeliverable|delivery failure|returned mail/i.test(header(full, 'Subject') || '');
        messages.push({
          id: m.id,
          threadId: m.threadId,
          from,
          fromAddress: (/<([^>]+)>/.exec(from) || [null, from])[1].trim().toLowerCase(),
          subject: header(full, 'Subject'),
          inReplyTo: header(full, 'In-Reply-To'),
          headers: { 'auto-submitted': header(full, 'Auto-Submitted'), 'x-autoreply': header(full, 'X-Autoreply') },
          body: textBody(full.payload).slice(0, 8000),
          receivedAt: full.internalDate ? new Date(Number(full.internalDate)).toISOString() : new Date().toISOString(),
          isBounce,
          dsn: isBounce ? dsnOf(full) : null,
        });
      }
      return { messages, cursor: new Date().toISOString() };
    },
  };
}

function adapterFor(account, opts = {}) {
  if (account.provider === 'sink') return sinkAdapter(account, opts);
  if (account.provider === 'gmail') return gmailAdapter(account, opts);
  throw providerError(501, `${account.provider} is not supported yet`);
}

module.exports = { SUPPORTED, adapterFor, sinkAdapter, gmailAdapter, buildMime, rfc822Id, keyHash, sinkStore, providerError };
