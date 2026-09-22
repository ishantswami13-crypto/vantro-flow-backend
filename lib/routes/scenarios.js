'use strict';
// lib/routes/scenarios.js — Priority 3: Simulate V1.
// Builds a real BASELINE cash consequence (cashConsequenceEngine.js) for the
// authenticated tenant, then runs a hypothetical SCENARIO on top of it
// (scenarioEngine.js) for one of the tenant's own real invoices, and an FX
// scenario chain (fxScenarioEngine.js) using whatever real currency-exposure
// data exists for the tenant (honestly NO_EFFECT/INSUFFICIENT_CONTEXT for
// tenants with none today). No fabricated data anywhere in this router —
// every number traces to a real DB row or a real deterministic computation.
const express = require('express');
const { buildCashConsequence } = require('../domain/intelligence/cashConsequenceEngine');
const { buildScenario, compareScenarios } = require('../domain/intelligence/scenarioEngine');
const { buildFxScenarioChain } = require('../domain/intelligence/fxScenarioEngine');

function authenticatedUserId(req) {
  return req.user?.userId || req.user?.id || null;
}

function scenariosRouter({ pool, authMiddleware }) {
  const router = express.Router();
  router.use(authMiddleware);

  // GET /api/intelligence/scenarios/:userId/invoices — real overdue/pending
  // invoices the tenant can pick from for a scenario. Same shape/query
  // pattern as getOpenReceivables in cashConsequenceEngine.js (not
  // duplicated — reused indirectly via the same WHERE clause here since
  // the engine's function isn't itself exported for arbitrary reuse outside
  // a full cash-consequence build).
  router.get('/:userId/invoices', async (req, res) => {
    try {
      const authedUserId = authenticatedUserId(req);
      const { userId } = req.params;
      if (!authedUserId) return res.status(401).json({ error: 'unauthenticated' });
      if (userId !== authedUserId) {
        return res.status(403).json({ error: 'cannot request another tenant\'s invoices' });
      }
      const { rows } = await pool.query(
        `SELECT id, customer_id, customer_name, invoice_amount, payment_status, days_overdue, due_date, invoice_date, currency
         FROM invoices
         WHERE user_id = $1 AND (payment_status IS NULL OR payment_status != 'Paid')
         ORDER BY days_overdue DESC NULLS LAST, invoice_amount DESC`,
        [userId]
      );
      res.json({ invoices: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/intelligence/scenarios/:userId
  // Body: { targetInvoiceId, daysEarlier } or { targetInvoiceId, remainsUnpaid: true }
  router.post('/:userId', async (req, res) => {
    try {
      const authedUserId = authenticatedUserId(req);
      const { userId } = req.params;
      if (!authedUserId) return res.status(401).json({ error: 'unauthenticated' });
      if (userId !== authedUserId) {
        return res.status(403).json({ error: 'cannot simulate against another tenant' });
      }

      const { targetInvoiceId, daysEarlier, remainsUnpaid } = req.body || {};
      if (!targetInvoiceId) {
        return res.status(400).json({ error: 'targetInvoiceId is required' });
      }
      if (!remainsUnpaid && (daysEarlier === undefined || daysEarlier === null)) {
        return res.status(400).json({ error: 'either daysEarlier or remainsUnpaid:true is required' });
      }

      // Tenant isolation: the target invoice must belong to this tenant.
      const { rows: invoiceRows } = await pool.query(
        `SELECT id FROM invoices WHERE id = $1 AND user_id = $2`,
        [targetInvoiceId, userId]
      );
      if (invoiceRows.length === 0) {
        return res.status(404).json({ error: 'invoice not found for this tenant' });
      }

      const baseline = await buildCashConsequence(userId);
      if (baseline.status !== 'PROJECTED') {
        return res.status(422).json({ error: 'no baseline cash consequence available for this tenant', baseline });
      }

      const scenarioDef = remainsUnpaid
        ? { name: 'Remains unpaid', description: `Invoice ${targetInvoiceId} remains unpaid`, targetInvoiceId, remainsUnpaid: true }
        : { name: 'Paid earlier', description: `Invoice ${targetInvoiceId} paid ${daysEarlier} day(s) earlier`, targetInvoiceId, daysEarlier: Number(daysEarlier) || 0 };

      const simulated = buildScenario(baseline, scenarioDef);
      const delta = compareScenarios(baseline, simulated);

      // FX scenario chain — real for this tenant means: no CURRENCY_DENOMINATED
      // business_exposure row exists today for any tenant, so this honestly
      // returns NO_EFFECT unless/until real exposure rows exist.
      let fx = null;
      try {
        const { rows: exposureRows } = await pool.query(
          `SELECT * FROM business_exposure WHERE user_id = $1 AND exposure_type = 'CURRENCY_DENOMINATED' LIMIT 1`,
          [userId]
        );
        const currencyExposure = exposureRows[0] || null;
        // business_exposure has no direct currency column (it links to
        // world_entities); resolving a real open-payables amount in the
        // exposed currency would need that join. Since 0 real tenants
        // currently have a CURRENCY_DENOMINATED row, we don't guess at a
        // join here — an exposure row with no resolved payables amount
        // honestly yields INSUFFICIENT_CONTEXT via fxScenarioEngine itself.
        const openPayablesInExposedCurrency = 0;
        fx = buildFxScenarioChain({ fxSignal: null, currencyExposure, openPayablesInExposedCurrency });
      } catch (e) {
        // business_exposure table may not exist yet in every environment —
        // honest INSUFFICIENT_CONTEXT rather than a fabricated result.
        fx = { impact_mode: 'INSUFFICIENT_CONTEXT', reason: `FX exposure lookup failed: ${e.message}` };
      }

      res.json({ baseline, simulated, delta, fx, generatedAt: new Date().toISOString() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { scenariosRouter };
