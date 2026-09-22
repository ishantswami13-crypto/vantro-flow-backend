'use strict';
// lib/routes/prepared.js — Priority 6: Prepared V1.
//
// This is deliberately NOT a "trigger generates a draft work product"
// pipeline (that capability does not exist anywhere in this codebase, was
// re-confirmed absent during this priority, and is out of scope). It is a
// real-time, read-only CURATION view over primitives that already exist and
// are already real, scoped strictly to the authenticated tenant:
//   - needs_you: real pending ai_actions (the same rows Control's
//     /api/ai-actions queue serves) — items genuinely awaiting a decision.
//   - for_you: real triggered+active watches, real BOUNDED_OPPORTUNITY
//     chains (same computation as /api/intelligence/opportunities), and the
//     tenant's most recent persisted cash-forecast prediction when its
//     lower_bound has crossed into negative territory (a real risk signal
//     written by GET /api/intelligence/forecast/v2/:userId).
//   - completed: real decided ai_actions (status='approved').
//   - dismissed: real decided ai_actions (status='rejected').
//   - upcoming: no real backing exists for "work Starlane expects to
//     prepare ahead of a known future event" — honest empty, always.
// Every field in every card traces back to a real DB row or a real
// deterministic computation already used elsewhere (opportunityPropagation).
// No fabricated summary, reasoning, or score is generated here.
const express = require('express');
const { buildOpportunityChain } = require('../domain/intelligence/opportunityPropagation');

function authenticatedUserId(req) {
  return req.user?.userId || req.user?.id || null;
}

function actionCard(row) {
  return {
    id: row.id,
    trigger: row.action_type,
    timestamp: row.created_at,
    summary: row.title,
    detail: row.description || null,
    relates: {
      type: row.related_entity_type || null,
      id: row.related_entity_id || null,
      customerId: row.customer_id || null,
      supplierId: row.supplier_id || null,
    },
    evidence: row.reason_json || null,
    approve_does: row.recommended_message || `Marks this ${row.action_type} action approved and, where automatable, executes it.`,
    secondary: 'Reject',
    priority: row.priority || null,
    status: row.status,
    source: 'ai_actions',
  };
}

function preparedRouter({ pool, authMiddleware }) {
  const router = express.Router();
  router.use(authMiddleware);

  // GET /api/intelligence/prepared/:userId
  router.get('/:userId', async (req, res) => {
    try {
      const authedUserId = authenticatedUserId(req);
      const { userId } = req.params;
      if (!authedUserId) return res.status(401).json({ error: 'unauthenticated' });
      if (userId !== authedUserId) {
        return res.status(403).json({ error: 'cannot request prepared items for another tenant' });
      }

      const [pendingRes, approvedRes, rejectedRes, watchesRes, predictionRes, suppliersRes] = await Promise.all([
        pool.query(`SELECT * FROM ai_actions WHERE user_id = $1 AND status = 'pending' ORDER BY created_at DESC`, [userId]),
        pool.query(`SELECT * FROM ai_actions WHERE user_id = $1 AND status = 'approved' ORDER BY approved_at DESC NULLS LAST, created_at DESC LIMIT 50`, [userId]),
        pool.query(`SELECT * FROM ai_actions WHERE user_id = $1 AND status = 'rejected' ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 50`, [userId]),
        pool.query(
          `SELECT * FROM watches WHERE user_id = $1 AND status = 'active' AND last_triggered_at IS NOT NULL ORDER BY last_triggered_at DESC`,
          [userId]
        ),
        pool.query(
          `SELECT * FROM predictions WHERE user_id = $1 AND target LIKE 'cash_position_%' ORDER BY created_at DESC LIMIT 1`,
          [userId]
        ),
        pool.query(`SELECT id, name FROM suppliers WHERE user_id = $1`, [userId]),
      ]);

      const needsYou = pendingRes.rows.map(actionCard);
      const completed = approvedRes.rows.map(actionCard);
      const dismissed = rejectedRes.rows.map(actionCard);

      const forYou = [];

      watchesRes.rows.forEach((w) => {
        forYou.push({
          id: `watch_${w.id}`,
          trigger: 'watch_triggered',
          timestamp: w.last_triggered_at,
          summary: `Watch "${w.name}" triggered on ${w.metric_key}`,
          detail: w.description || null,
          relates: { type: 'watch', id: w.id },
          evidence: { metric_key: w.metric_key, condition_config: w.condition_config, severity: w.severity },
          approve_does: 'Opens the watch detail to review the condition that fired.',
          secondary: 'Dismiss',
          priority: w.severity,
          source: 'watches',
        });
      });

      // Real forecast risk: only surfaced when a persisted forecast exists
      // and its own pessimistic-scenario lower bound has gone negative —
      // no threshold is invented beyond "runs out of cash" itself.
      const pred = predictionRes.rows[0];
      if (pred && pred.lower_bound !== null && Number(pred.lower_bound) < 0) {
        forYou.push({
          id: `forecast_${pred.id}`,
          trigger: 'forecast_risk',
          timestamp: pred.created_at,
          summary: `${pred.horizon_days}-day cash forecast's pessimistic scenario goes negative`,
          detail: `Point estimate ${pred.point_estimate}, range [${pred.lower_bound}, ${pred.upper_bound}].`,
          relates: { type: 'forecast', id: pred.id },
          evidence: { model: pred.model_name, version: pred.model_version, data_quality: pred.data_quality, assumptions: pred.assumptions },
          approve_does: 'Opens Forecast to review the underlying cash projection.',
          secondary: 'Dismiss',
          priority: 'high',
          source: 'predictions',
        });
      }

      let opportunitiesChecked = 0;
      if (suppliersRes.rows.length > 0) {
        const chains = await Promise.all(
          suppliersRes.rows.map((s) => buildOpportunityChain(userId, { supplierId: s.id }).catch((e) => ({ status: 'ERROR', statement: e.message })))
        );
        opportunitiesChecked = chains.length;
        chains.forEach((chain, idx) => {
          if (chain.status !== 'BOUNDED_OPPORTUNITY') return;
          const supplier = suppliersRes.rows[idx];
          forYou.push({
            id: `opportunity_${supplier.id}`,
            trigger: 'opportunity_detected',
            timestamp: chain.generatedAt,
            summary: `Rising demand with a stable supplier: ${supplier.name}`,
            detail: chain.statement,
            relates: { type: 'supplier', id: supplier.id, supplierName: supplier.name },
            evidence: chain.steps,
            approve_does: 'Opens Opportunities to review the full evidence chain.',
            secondary: 'Dismiss',
            priority: 'medium',
            source: 'opportunityPropagation',
          });
        });
      }

      forYou.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

      res.json({
        for_you: forYou,
        needs_you: needsYou,
        // Honest: no capability exists that schedules ahead-of-time
        // preparation for a known future event.
        upcoming: [],
        completed,
        dismissed,
        counts: { for_you: forYou.length, needs_you: needsYou.length, upcoming: 0, completed: completed.length, dismissed: dismissed.length },
        generatedAt: new Date().toISOString(),
        sourcesChecked: { pendingActions: pendingRes.rows.length, triggeredWatches: watchesRes.rows.length, suppliersEvaluatedForOpportunities: opportunitiesChecked, hasForecast: !!pred },
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { preparedRouter };
