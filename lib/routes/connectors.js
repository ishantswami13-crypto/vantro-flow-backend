'use strict';
// lib/routes/connectors.js — the connector platform API.
//
//   GET  /api/connectors/catalog   public   manifests only (no tenant state):
//                                           what Starlane can connect to today,
//                                           and what it honestly cannot yet.
//   GET  /api/connectors           auth     manifests + this tenant's live state
//   POST /api/connectors/:id/pairing auth   short-lived pairing code for a
//                                           local-bridge connector
//   GET  /api/connectors/:id/bridge  auth   the bridge program itself (with SHA-256)
//
//
// Live app connectors (lib/connectors/apps), each only while it is Live:
//   GET    /api/connectors/:id/connect-url  auth   OAuth consent URL (Zoho Books, QuickBooks)
//   GET    /api/connectors/:id/callback     none   vendor redirect; tenant from signed state
//   POST   /api/connectors/:id/credentials  auth   API key (Razorpay, WhatsApp Business), checked before saving
//   POST   /api/connectors/:id/sync         auth   read the app now
//   DELETE /api/connectors/:id/connection   auth   forget the stored access
//   GET|POST /api/connectors/whatsapp_business/webhook  none  Meta handshake / signed deliveries
//
// The pre-existing /api/connectors/tally/{enrollment,claim,devices,...}
// routes in server.js stay as they are (the bridge CLI calls claim).
const express = require('express');
const { listManifests, getManifest } = require('../connectors/registry');
const { getConnectorStates } = require('../connectors/state');
const { createEnrollment } = require('../domain/ingestion/deviceEnrollment');
const { artifactPayload } = require('../access/artifacts');
const { track, EVENTS } = require('../observability/productEvents');
const appAccounts = require('../connectors/apps/accounts');
const { syncApp } = require('../connectors/apps/sync');
const whatsappInbox = require('../connectors/apps/whatsappInbox');
const { provider: appProvider } = require('../connectors/apps');
const creds = require('../domain/outbound/credentials');
const { safeLog } = require('../observability/logger');

function appError(res, err, where) {
  // A vendor's own HTTP status (ConnectorError.status) is not ours to return.
  if (err && err.kind) return res.status(502).json({ success: false, error: creds.redact(err.message), code: err.kind });
  if (err && err.status && err.status < 600) return res.status(err.status).json({ success: false, error: err.message, code: err.code || null });
  if (err && err.code === '42P01') return res.status(503).json({ success: false, error: 'App connectors are not set up on this server yet (migration 070 is not applied).', code: 'NOT_MIGRATED' });
  safeLog('error', `[connectors ${where}]`, { error: creds.redact(String(err && err.message)) });
  return res.status(500).json({ success: false, error: 'Something went wrong on our side.' });
}

function publicManifest(m) {
  const { id, name, provider, category, authType, availability, syncMode, summary, unavailableReason, objects, access } = m;
  return { id, name, provider, category, authType, availability, syncMode, summary, unavailableReason: unavailableReason || null, objects, access };
}

// The API origin the bridge should talk to. PUBLIC_API_URL wins (set it in
// production); otherwise the request's own origin (trust proxy is on).
function publicApiBase(req) {
  return (process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

function connectorsRouter({ pool, authMiddleware }) {
  const router = express.Router();

  // ── Live app connectors ────────────────────────────────────────────
  // Meta's subscription handshake and deliveries. No bearer token: the
  // signature (META_APP_SECRET) proves Meta sent it; the tenant comes from
  // the phone number id in the body.
  router.get('/whatsapp_business/webhook', (req, res) => {
    try { res.type('text/plain').send(whatsappInbox.verifySubscription(req.query)); } catch (err) { res.sendStatus(err.status || 403); }
  });
  router.post('/whatsapp_business/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    try {
      const out = await whatsappInbox.receive(pool, req.body, req.get('x-hub-signature-256'));
      res.json({ success: true, ...out });
    } catch (err) {
      if (err.status) return res.sendStatus(err.status);
      safeLog('error', '[connectors whatsapp webhook]', { error: creds.redact(String(err.message)) });
      res.sendStatus(500); // Meta retries a 5xx
    }
  });

  router.get('/:id/callback', async (req, res) => {
    const id = req.params.id;
    const front = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
    if (!appProvider(id)) return res.status(404).send('Unknown connector');
    try {
      const r = await appAccounts.completeOAuth(pool, id, req.query);
      const back = { sources: '/sources', access: '/access', onboarding: '/onboarding' }[r.returnTo] || '/sources';
      if (r.result === 'connected') {
        // The first sync runs now so the owner lands on real numbers; a failure is shown on Sources.
        syncApp(pool, r.userId, id).catch((e) => safeLog('warn', '[connectors first sync]', { connectorId: id, error: creds.redact(String(e.message)) }));
      }
      return res.redirect(`${front}${back}?app=${encodeURIComponent(id)}&result=${r.result}`);
    } catch (err) {
      if (err.code === 'BAD_STATE') return res.status(400).send(err.message);
      safeLog('warn', '[connectors oauth callback]', { connectorId: id, error: creds.redact(String(err.message)) });
      const state = appAccounts.readState(id, req.query.state);
      const back = { sources: '/sources', access: '/access', onboarding: '/onboarding' }[state?.returnTo] || '/sources';
      return res.redirect(`${front}${back}?app=${encodeURIComponent(id)}&result=failed`);
    }
  });

  router.get('/:id/connect-url', authMiddleware, (req, res) => {
    try { res.json({ success: true, ...appAccounts.connectUrl(req.user.userId, req.params.id, { returnTo: String(req.query.returnTo || 'sources') }) }); } catch (err) { appError(res, err, 'connect-url'); }
  });

  router.post('/:id/credentials', authMiddleware, async (req, res) => {
    try {
      const account = await appAccounts.saveApiKey(pool, req.user.userId, req.params.id, req.body || {});
      let sync = null;
      if (appProvider(req.params.id)?.entities.length) {
        try { sync = await syncApp(pool, req.user.userId, req.params.id); } catch (e) { sync = { error: e.message }; }
      }
      res.status(201).json({ success: true, account, sync });
    } catch (err) { appError(res, err, 'credentials'); }
  });

  router.post('/:id/sync', authMiddleware, async (req, res) => {
    try { res.json({ success: true, ...(await syncApp(pool, req.user.userId, req.params.id)) }); } catch (err) { appError(res, err, 'sync'); }
  });

  router.delete('/:id/connection', authMiddleware, async (req, res) => {
    if (!appProvider(req.params.id)) return res.status(404).json({ success: false, error: 'Unknown connector' });
    try { await appAccounts.deleteAccount(pool, req.user.userId, req.params.id); res.json({ success: true }); } catch (err) { appError(res, err, 'disconnect'); }
  });

  router.get('/catalog', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ success: true, connectors: listManifests().map(publicManifest) });
  });

  router.get('/', authMiddleware, async (req, res) => {
    try {
      const connectors = await getConnectorStates(pool, req.user.userId);
      res.json({ success: true, connectors });
    } catch (err) {
      console.error('[connectors list]', err.message);
      res.status(500).json({ success: false, error: 'Could not load connector state' });
    }
  });

  router.post('/:id/pairing', authMiddleware, async (req, res) => {
    const manifest = getManifest(req.params.id);
    if (!manifest) return res.status(404).json({ success: false, error: 'Unknown connector' });
    if (manifest.authType !== 'local_bridge' || manifest.availability !== 'available') {
      return res.status(400).json({ success: false, error: `${manifest.name} is not paired through the local bridge` });
    }
    try {
      const { enrollmentCode, expiresAt } = await createEnrollment(req.user.userId, manifest.sourceType);
      track(EVENTS.PAIRING_CREATED, { req, connectorId: manifest.id });
      res.status(201).json({
        success: true,
        pairing: {
          connectorId: manifest.id,
          code: enrollmentCode,
          expiresAt,
          // The exact command the owner runs on the machine with Tally.
          command: `node tally-sync.mjs --api ${publicApiBase(req)} --enroll ${enrollmentCode}`,
        },
      });
    } catch (err) {
      console.error('[connectors pairing]', err.message);
      res.status(503).json({ success: false, error: 'Could not create a pairing code' });
    }
  });

  router.get('/:id/bridge', authMiddleware, (req, res) => {
    const manifest = getManifest(req.params.id);
    if (!manifest || manifest.authType !== 'local_bridge' || manifest.availability !== 'available') {
      return res.status(404).json({ success: false, error: 'No bridge for this connector' });
    }
    const file = artifactPayload('tally-bridge');
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('X-Content-SHA256', file.sha256);
    res.send(file.content);
  });

  return router;
}

module.exports = { connectorsRouter, publicManifest, publicApiBase };
