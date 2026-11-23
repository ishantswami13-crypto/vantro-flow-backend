'use strict';
// lib/routes/feeds.js — data feeds (lib/connectors/feeds/feeds.js).
//
// Owner (signed in):
//   GET    /api/feeds                   feeds, their last run, the apps that can feed, push columns
//   POST   /api/feeds/preview           read a source once and preview the import (writes nothing)
//   POST   /api/feeds                   save a feed; runs it once now unless it is a push feed
//   PATCH  /api/feeds/:id               rename, schedule, pause/resume, confirm the mapping again
//   POST   /api/feeds/:id/preview       read a saved feed's source again (to reconfirm columns)
//   POST   /api/feeds/:id/run           run now
//   GET    /api/feeds/:id/runs          run history
//   POST   /api/feeds/:id/rotate-key    new push key (the old one stops working)
//   DELETE /api/feeds/:id               delete the feed (imported records stay)
//
// Any other software (no Starlane sign-in; the feed's own key):
//   POST   /api/feeds/in                Authorization: Bearer slf_…   body: JSON rows, CSV or .xlsx
//   POST   /api/feeds/in/:key           the same, for tools that can only set a URL
//
// The tenant is always the verified JWT's user id, or the push key's feed.
// Nothing here sends anything to anyone outside Starlane.

const express = require('express');
const rateLimit = require('express-rate-limit');
const feeds = require('../connectors/feeds/feeds');
const { runDiscovery } = require('../domain/decisions/discovery');
const { isEnabled } = require('../featureFlags');
const creds = require('../domain/outbound/credentials');
const { safeLog } = require('../observability/logger');

const PUSH_LIMIT_BYTES = 15 * 1024 * 1024;

function send(res, err, where) {
  if (err && err.status && err.status >= 400 && err.status < 600 && err.status !== 500) return res.status(err.status).json({ error: err.message });
  if (err && err.kind) return res.status(502).json({ error: creds.redact(err.message), code: err.kind });
  if (err && err.code === '42P01') return res.status(503).json({ error: 'Data feeds are not set up on this server yet (migration 079 is not applied).', code: 'NOT_MIGRATED' });
  safeLog('error', `[feeds ${where}]`, { error: creds.redact(String(err && err.message)) });
  return res.status(500).json({ error: 'Something went wrong on our side.' });
}

function userIdOf(req) {
  const id = req.user?.userId || req.user?.id || null;
  if (!id || !/^[0-9a-f-]{36}$/i.test(String(id))) throw Object.assign(new Error('Sign in again: this session does not identify a business.'), { status: 401 });
  return id;
}

function discoverFor(pool) {
  return (userId) => runDiscovery(pool, userId, {
    onBehalfOf: userId,
    externalSendEnabled: isEnabled('external_message_sending_enabled'),
    getSignalImpact: (() => { try { return require('../domain/intelligence/supplyChainOrchestrator').getSignalImpact; } catch { return null; } })(),
  }).then((r) => (r && r.status !== 'STOPPED' ? { status: r.status, discovered: r.discovered, revised: r.revised, resolved: r.resolved } : null));
}

function feedsRouter({ pool, authMiddleware }) {
  const router = express.Router();
  const discover = discoverFor(pool);

  // ── Push: any software sends rows with the feed's key ─────────────────
  const keyOf = (req) => {
    const h = String(req.headers.authorization || '');
    return req.params.key || (/^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : '');
  };
  const pushLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `feedpush:${keyOf(req).slice(0, 16)}` });
  const ipLimiter = rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
  const pushHandler = async (req, res) => {
    try {
      const feed = await feeds.feedForPushKey(pool, keyOf(req));
      if (!feed) return res.status(401).json({ error: 'That feed key is not valid. Copy it again from Starlane › Data feeds.' });
      if (feed.status === 'PAUSED') return res.status(423).json({ error: 'This feed is paused in Starlane.' });
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
      if (!body.length) return res.status(400).json({ error: 'Send the rows in the body: JSON (a list, or {"rows": [...]}), CSV, or an Excel file.' });
      const out = await feeds.runFeed(pool, feed, { trigger: 'push', pushed: body, contentType: req.headers['content-type'] || '', discover, correlationId: req.requestId || null });
      const status = out.status === 'imported' || out.status === 'unchanged' ? 200 : out.status === 'needs_attention' ? 422 : 400;
      res.status(status).json({
        status: out.status, runId: out.runId, batchId: out.batchId || null, error: out.error || null, errors: out.errors || [],
        counts: out.summary?.counts || null, rejected: out.summary?.rejectedByReason || [], note: out.note || null,
      });
    } catch (err) {
      send(res, err, 'push');
    }
  };
  const raw = express.raw({ type: () => true, limit: PUSH_LIMIT_BYTES });
  router.post('/in', ipLimiter, pushLimiter, raw, pushHandler);
  router.post('/in/:key', ipLimiter, pushLimiter, raw, pushHandler);

  // ── Owner ────────────────────────────────────────────────────────────
  router.use(authMiddleware);

  router.get('/', async (req, res) => {
    try {
      const userId = userIdOf(req);
      res.json({
        feeds: await feeds.listFeeds(pool, userId),
        apps: await feeds.appSources(pool, userId),
        intervals: feeds.INTERVALS,
        kinds: Object.entries(feeds.KIND_LABEL).map(([kind, label]) => ({ kind, label, columns: feeds.columnsFor(kind) })),
        scheduler: isEnabled('data_feeds_scheduler_enabled') ? 'on' : 'off',
      });
    } catch (err) { send(res, err, 'list'); }
  });

  router.post('/preview', async (req, res) => {
    try {
      res.json(await feeds.previewFeed(pool, userIdOf(req), req.body || {}));
    } catch (err) { send(res, err, 'preview'); }
  });

  router.post('/', async (req, res) => {
    try {
      const userId = userIdOf(req);
      const { feed, pushKey } = await feeds.createFeed(pool, userId, req.body || {});
      let firstRun = null;
      if (feed.sourceType !== 'push' && feed.sourceType !== 'tally') firstRun = await feeds.runFeed(pool, await feeds.getFeedRow(pool, userId, feed.id), { trigger: 'setup', discover, correlationId: req.requestId || null });
      const fresh = (await feeds.listFeeds(pool, userId)).find((f) => f.id === feed.id) || feed;
      res.status(201).json({ feed: fresh, firstRun, ...(pushKey ? { pushKey, pushUrl: `${publicApiBase(req)}/api/feeds/in` } : {}) });
    } catch (err) { send(res, err, 'create'); }
  });

  router.post('/:id/preview', async (req, res) => {
    try { res.json(await feeds.previewSavedFeed(pool, userIdOf(req), req.params.id)); } catch (err) { send(res, err, 'preview saved'); }
  });

  router.patch('/:id', async (req, res) => {
    try { res.json({ feed: await feeds.updateFeed(pool, userIdOf(req), req.params.id, req.body || {}) }); } catch (err) { send(res, err, 'update'); }
  });

  router.post('/:id/run', async (req, res) => {
    try {
      const userId = userIdOf(req);
      const row = await feeds.getFeedRow(pool, userId, req.params.id);
      if (row.source_type === 'push') return res.status(400).json({ error: 'A push feed runs when the other software sends rows.' });
      const out = await feeds.runFeed(pool, row, { trigger: 'manual', discover, correlationId: req.requestId || null });
      res.json({ run: out, feed: (await feeds.listFeeds(pool, userId)).find((f) => f.id === row.id) || null });
    } catch (err) { send(res, err, 'run'); }
  });

  router.get('/:id/runs', async (req, res) => {
    try { res.json({ runs: await feeds.listRuns(pool, userIdOf(req), req.params.id, { limit: req.query.limit }) }); } catch (err) { send(res, err, 'runs'); }
  });

  router.post('/:id/rotate-key', async (req, res) => {
    try {
      const out = await feeds.rotatePushKey(pool, userIdOf(req), req.params.id);
      res.json({ ...out, pushUrl: `${publicApiBase(req)}/api/feeds/in` });
    } catch (err) { send(res, err, 'rotate'); }
  });

  router.delete('/:id', async (req, res) => {
    try { await feeds.deleteFeed(pool, userIdOf(req), req.params.id); res.json({ deleted: true }); } catch (err) { send(res, err, 'delete'); }
  });

  return router;
}

function publicApiBase(req) {
  return (process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

module.exports = { feedsRouter, discoverFor };
