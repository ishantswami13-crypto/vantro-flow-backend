'use strict';
// lib/routes/dataLayer.js — read endpoints served from the L3 read models.
// Mounted at /api/data. Answers 404 unless STARLANE_DATA_LAYER_ENABLED=true.
//
//   GET /api/data/receivables            summary by currency + top customers
//   GET /api/data/receivables/customers  ?currency=&sort=overdue|open|age|name&limit=&offset=
//
// The tenant is always req.user (verified JWT), never a query parameter.

const express = require('express');
const { getReceivables, receivables } = require('../data/readModels');
const { isDataLayerEnabled, status } = require('../data/boot');

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

  // Background-work status for this server (no tenant data).
  router.get('/status', (req, res) => {
    res.json({ success: true, running: !!status(), status: status() });
  });

  return router;
}

module.exports = { dataLayerRouter };
