'use strict';
// lib/routes/opportunities.js — Priority 2: Opportunity Engine.
// Enumerates the authenticated tenant's real suppliers (same suppliers
// table/shape used elsewhere in server.js, e.g. the AI deep-analysis route)
// and runs buildOpportunityChain(userId, {supplierId}) from
// lib/domain/intelligence/opportunityPropagation.js per supplier. Only
// real BOUNDED_OPPORTUNITY chains are returned in full; NO_OPPORTUNITY_SIGNAL
// and INSUFFICIENT_DATA results are rolled into a summary count instead of
// being returned as noise. No fabricated data — every field here traces to
// a real DB row or a real deterministic comparison in opportunityPropagation.js.
const express = require('express');
const { buildOpportunityChain } = require('../domain/intelligence/opportunityPropagation');

function authenticatedUserId(req) {
  return req.user?.userId || req.user?.id || null;
}

function opportunitiesRouter({ pool, authMiddleware }) {
  const router = express.Router();
  router.use(authMiddleware);

  // GET /api/intelligence/opportunities/:userId
  router.get('/:userId', async (req, res) => {
    try {
      const authedUserId = authenticatedUserId(req);
      const { userId } = req.params;
      if (!authedUserId) return res.status(401).json({ error: 'unauthenticated' });
      if (userId !== authedUserId) {
        return res.status(403).json({ error: 'cannot request opportunities for another tenant' });
      }

      const { rows: suppliers } = await pool.query(
        `SELECT id, name FROM suppliers WHERE user_id = $1`,
        [userId]
      );

      if (suppliers.length === 0) {
        return res.json({
          opportunities: [],
          summary: { suppliersEvaluated: 0, boundedOpportunities: 0, noSignal: 0, insufficientData: 0 },
          generatedAt: new Date().toISOString(),
        });
      }

      const chains = await Promise.all(
        suppliers.map((s) => buildOpportunityChain(userId, { supplierId: s.id }).catch((e) => ({
          userId, supplierId: s.id, status: 'ERROR', statement: e.message, steps: [], generatedAt: new Date().toISOString(),
        })))
      );

      const bySupplier = new Map(suppliers.map((s) => [s.id, s]));

      const bounded = [];
      let noSignal = 0;
      let insufficientData = 0;

      chains.forEach((chain, idx) => {
        const supplier = bySupplier.get(suppliers[idx].id);
        if (chain.status === 'BOUNDED_OPPORTUNITY') {
          const demandStep = chain.steps.find((s) => s.step === 'demand_rising');
          bounded.push({
            opportunity: `Rising demand with a stable supplier: ${supplier.name}`,
            affectedEntities: { supplierId: supplier.id, supplierName: supplier.name },
            evidence: chain.steps,
            sourceState: chain.status,
            materiality: demandStep?.evidence?.pctChange ?? null,
            reasoning: chain.statement,
            timestamp: chain.generatedAt,
          });
        } else if (chain.status === 'INSUFFICIENT_DATA' || chain.status === 'ERROR') {
          insufficientData++;
        } else {
          noSignal++;
        }
      });

      res.json({
        opportunities: bounded,
        summary: {
          suppliersEvaluated: suppliers.length,
          boundedOpportunities: bounded.length,
          noSignal,
          insufficientData,
        },
        generatedAt: new Date().toISOString(),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { opportunitiesRouter };
