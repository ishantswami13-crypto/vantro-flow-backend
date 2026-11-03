'use strict';
// lib/routes/connections.js — connect any software, over HTTP.
//
//   GET    /api/integrations                  this tenant's connections, Gmail status, recent events
//   POST   /api/integrations                  add an incoming webhook or an HTTP API
//                                            (an incoming webhook's URL is returned once)
//   POST   /api/integrations/:id/enable|disable
//   POST   /api/integrations/:id/rotate       new URL for an incoming webhook
//   DELETE /api/integrations/:id
//   GET    /api/integrations/events           what arrived (webhooks, Gmail)
//   POST   /api/integrations/gmail/check      read new Gmail messages now and start workflows
//
//   POST   /api/hooks/:token                 public: any tool posts JSON here.
//                                            The tenant comes only from the token.
//
// Every authenticated handler takes the tenant from the verified JWT.
// Secrets are never returned.

const express = require('express');
const rateLimit = require('express-rate-limit');
const conns = require('../connectors/connections');
const gmail = require('../connectors/gmailInbox');
const cw = require('../domain/workflows/customWorkflows');
const { publicApiBase } = require('./connectors');
const { safeLog } = require('../observability/logger');
const { redact } = require('../domain/outbound/credentials');

function uid(req) { return req.user?.userId || req.user?.id || null; }

function wrapWith(tag) {
  return (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
      if (err && err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
      if (err && err.status === 503) return res.status(503).json({ error: err.message });
      if (err && err.code === '42P01') return res.status(503).json({ error: 'Connections are not set up on this server yet (migration 069).' });
      if (err && err.code === 'URL_REFUSED') return res.status(400).json({ error: err.message });
      safeLog('error', `[${tag}] request failed`, { path: req.path, requestId: req.requestId, error: redact(err && err.message) });
      res.status(500).json({ error: 'Something went wrong on our side.', requestId: req.requestId || null });
    }
  };
}

function eventView(e) {
  const p = e.payload || {};
  return {
    id: e.id, source: e.source, connectionId: e.connection_id, receivedAt: e.received_at, dispatchedAt: e.dispatched_at,
    preview: e.source === 'gmail' ? { from: p.from, subject: p.subject } : { eventType: p.event || p.type || p.event_type || null, keys: Object.keys(p).slice(0, 12) },
  };
}

function connectionsRouter({ pool, authMiddleware, dispatch = null }) {
  const router = express.Router();
  const wrap = wrapWith('connections');
  const run = dispatch || ((p, userId, ev) => cw.dispatchEvent(p, userId, ev));
  router.use(authMiddleware);

  router.get('/', wrap(async (req, res) => {
    const userId = uid(req);
    const [connections, gmailStatus] = await Promise.all([conns.listConnections(pool, userId), gmail.gmailStatus(pool, userId)]);
    const base = publicApiBase(req);
    res.json({
      connections: connections.map((c) => (c.kind === 'webhook_in' ? { ...c, urlHint: `${base}/api/hooks/…` } : c)),
      gmail: gmailStatus,
      webhookBase: `${base}/api/hooks/`,
    });
  }));

  router.post('/', wrap(async (req, res) => {
    const out = await conns.createConnection(pool, uid(req), req.body || {});
    const body = { connection: out.connection };
    if (out.token) body.webhookUrl = `${publicApiBase(req)}/api/hooks/${out.token}`;
    if (out.signingSecret) body.signingSecret = out.signingSecret;
    res.status(201).json(body);
  }));

  router.get('/events', wrap(async (req, res) => {
    const rows = await conns.listEvents(pool, uid(req), { limit: req.query.limit, connectionId: req.query.connectionId || null });
    res.json({ events: rows.map(eventView) });
  }));

  router.post('/gmail/check', wrap(async (req, res) => {
    const userId = uid(req);
    const r = await gmail.pollInbox(pool, userId);
    let ran = 0;
    for (const ev of r.events) ran += (await run(pool, userId, ev)).ran || 0;
    res.json({ status: r.status, newMessages: r.events.length, workflowsRun: ran });
  }));

  router.post('/:id/:action(enable|disable)', wrap(async (req, res) => {
    res.json({ connection: await conns.setConnectionStatus(pool, uid(req), req.params.id, req.params.action === 'enable' ? 'ACTIVE' : 'DISABLED') });
  }));

  router.post('/:id/rotate', wrap(async (req, res) => {
    const { token } = await conns.rotateWebhookToken(pool, uid(req), req.params.id);
    res.json({ webhookUrl: `${publicApiBase(req)}/api/hooks/${token}` });
  }));

  router.delete('/:id', wrap(async (req, res) => {
    await conns.deleteConnection(pool, uid(req), req.params.id);
    res.json({ deleted: true });
  }));

  return router;
}

/** The public receiving end. Mounted with its own raw body parser. */
function hooksRouter({ pool, dispatch = null }) {
  const router = express.Router();
  const wrap = wrapWith('hooks');
  const run = dispatch || ((p, userId, ev) => cw.dispatchEvent(p, userId, ev));
  const limiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `hook:${String(req.params.token || '').slice(0, 16)}` });
  // Backstop per sender IP, wide enough for a shared sender (Stripe, Zapier)
  // posting for many tenants, tight enough to stop token guessing at scale.
  const ipLimiter = rateLimit({ windowMs: 60 * 1000, max: Number(process.env.WEBHOOK_RATE_LIMIT_PER_IP_PER_MINUTE || 1200), standardHeaders: true, legacyHeaders: false });

  router.post('/:token', ipLimiter, limiter, express.raw({ type: () => true, limit: conns.MAX_EVENT_BYTES }), wrap(async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    let body;
    const ct = String(req.headers['content-type'] || '');
    if (/x-www-form-urlencoded/.test(ct)) body = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
    const out = await conns.receiveWebhook(pool, req.params.token, {
      rawBody: raw, body,
      signature: req.headers['x-starlane-signature'],
      eventId: req.headers['x-starlane-event-id'] || req.headers['idempotency-key'] || req.headers['x-request-id'] || null,
    });
    if (out.duplicate) return res.status(200).json({ received: true, duplicate: true });
    // Answer the sender at once; workflows run after.
    res.status(202).json({ received: true, eventId: out.event.id });
    Promise.resolve(run(pool, out.connection.user_id, out.event)).catch((err) => safeLog('warn', '[hooks] dispatch failed', { error: redact(err.message) }));
  }));

  return router;
}

module.exports = { connectionsRouter, hooksRouter, eventView };
