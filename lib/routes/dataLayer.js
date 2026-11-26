'use strict';
// lib/routes/dataLayer.js — read endpoints served from the L3 read models.
// Mounted at /api/data. Answers 404 unless STARLANE_DATA_LAYER_ENABLED=true.
//
//   GET /api/data/receivables            summary by currency + top customers
//   GET /api/data/receivables/customers  ?currency=&sort=overdue|open|age|name&limit=&offset=
//   GET /api/data/cube                   ?fact=&measures=&by=&time=&from=&to=&currency=&customer=&status=&limit=
//   GET /api/data/cube/schema            facts, dimensions and measures the cube accepts
//   GET /api/data/search                 ?q=&types=customer,supplier,product&limit=
//   GET /api/data/search/duplicates      ?type=customer|supplier|product&minScore=0.6
//
// The tenant is always req.user (verified JWT), never a query parameter.

const express = require('express');
const { getReceivables, receivables } = require('../data/readModels');
const { isDataLayerEnabled, status } = require('../data/boot');
const analytics = require('../data/analytics');
const searchLayer = require('../data/search');

function tenantOf(req) {
  return req.user?.userId || req.user?.id || null;
}

function dataLayerRouter({ authMiddleware, isEnabled = isDataLayerEnabled }) {
  const router = express.Router();
  router.use((req, res, next) => (isEnabled() ? next() : res.status(404).json({ error: 'Not found' })));
  router.use(authMiddleware);

  function parseList(q) {
    const sort = q.sort === undefined ? 'overdue' : String(q.sort);
    if (!receivables.SORTS[sort]) return { error: `sort must be one of ${Object.keys(receivables.SORTS).join(', ')}` };
    const currency = q.currency === undefined ? undefined : String(q.currency).slice(0, 8);
    if (currency !== undefined && !/^[A-Za-z]{0,8}$/.test(currency)) return { error: 'currency must be a currency code' };
    return { sort, currency, limit: q.limit, offset: q.offset };
  }

  router.get('/receivables', async (req, res) => {
    const userId = tenantOf(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const out = await getReceivables(userId, { sort: 'overdue', limit: 10 });
      res.json({ success: true, summary: out.summary, topOverdueCustomers: out.customers.customers, customerCount: out.customers.total });
    } catch (err) {
      res.status(500).json({ error: 'Could not load receivables' });
    }
  });

  router.get('/receivables/customers', async (req, res) => {
    const userId = tenantOf(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const opts = parseList(req.query || {});
    if (opts.error) return res.status(400).json({ error: opts.error });
    try {
      const out = await getReceivables(userId, opts);
      res.json({ success: true, asOf: out.summary.asOf, refreshedAt: out.summary.refreshedAt, total: out.customers.total, customers: out.customers.customers });
    } catch (err) {
      res.status(500).json({ error: 'Could not load customers' });
    }
  });

  router.get('/cube/schema', (req, res) => res.json({ success: true, facts: analytics.describe() }));

  router.get('/cube', async (req, res) => {
    const userId = tenantOf(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const q = req.query || {};
    const one = (v) => (Array.isArray(v) ? v[0] : v);
    const filters = {};
    for (const k of ['currency', 'customer', 'status']) if (q[k] !== undefined) filters[k] = String(one(q[k])).slice(0, 200);
    const spec = {
      fact: one(q.fact), measures: one(q.measures), by: one(q.by), time: one(q.time),
      from: one(q.from), to: one(q.to), limit: one(q.limit), filters,
    };
    try {
      analytics.parseSpec(spec);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    try {
      res.json({ success: true, ...(await analytics.cube(userId, spec)) });
    } catch (err) {
      res.status(500).json({ error: 'Could not run the query' });
    }
  });

  router.get('/search', async (req, res) => {
    const userId = tenantOf(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const q = req.query || {};
    const one = (v) => (Array.isArray(v) ? v[0] : v);
    try {
      const results = await searchLayer.search(userId, one(q.q), { types: one(q.types), limit: one(q.limit) });
      res.json({ success: true, results });
    } catch (err) {
      if (err instanceof RangeError) return res.status(400).json({ error: err.message });
      res.status(500).json({ error: 'Search failed' });
    }
  });

  router.get('/search/duplicates', async (req, res) => {
    const userId = tenantOf(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const q = req.query || {};
    const one = (v) => (Array.isArray(v) ? v[0] : v);
    try {
      const pairs = await searchLayer.duplicates(userId, { type: one(q.type), minScore: one(q.minScore), limit: one(q.limit) });
      res.json({ success: true, pairs });
    } catch (err) {
      if (err instanceof RangeError) return res.status(400).json({ error: err.message });
      res.status(500).json({ error: 'Could not check duplicates' });
    }
  });

  // Background-work status for this server (no tenant data).
  router.get('/status', (req, res) => {
    res.json({ success: true, running: !!status(), status: status() });
  });

  return router;
}

module.exports = { dataLayerRouter };
