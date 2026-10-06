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
const { OPEN_AMOUNT_SQL, liveDaysOverdue, n } = require('../features/core');
const { DEFAULT_DEFINITIONS } = require('../domain/decisions/definitions');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const inr = (v) => `₹${Math.round(n(v)).toLocaleString('en-IN')}`;
const day = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null);
const PAID_RE = /^(paid|cancelled)$/i;

function authenticatedUserId(req) {
  return req.user?.userId || req.user?.id || null;
}

/**
 * Why-now and evidence for an action about one invoice, read from the
 * invoice as it is today. Days overdue are worked out live from the due date
 * (features/core liveDaysOverdue, the same rule the Bridge and Scan use), so
 * a card prepared days ago never shows the count frozen into its description.
 */
function invoiceContext(row, inv, now = Date.now()) {
  if (!inv) return null;
  const live = liveDaysOverdue(inv, now);
  const prepared = row.reason_json?.facts?.days_overdue;
  const owed = inv.open_amount != null ? n(inv.open_amount) : n(inv.invoice_amount);
  const due = day(inv.due_date);
  const closed = PAID_RE.test(String(inv.payment_status || ''));
  const lines = [];
  if (closed) {
    lines.push(`This invoice is now marked ${String(inv.payment_status).toLowerCase()} in your books.`);
  } else {
    lines.push(`${inr(owed)} owed${inv.customer_name ? ` by ${inv.customer_name}` : ''}, ${live} day${live === 1 ? '' : 's'} overdue today${due ? ` (due ${due})` : ''}.`);
  }
  if (row.action_type === 'FLAG_BAD_DEBT' && !closed) {
    const line = n(row.reason_json?.stage?.band_days?.[0]) || DEFAULT_DEFINITIONS.bad_debt_threshold_days;
    if (live >= line) lines.push(`Why now: it is past the ${line}-day line where an unpaid invoice is treated as a likely bad debt.`);
  }
  if (!closed) {
    lines.push(inv.last_reminder_sent ? `Last reminder recorded ${day(inv.last_reminder_sent)}.` : 'No reminder is recorded on this invoice.');
    if (inv.dunning_paused) lines.push('Collection is paused on this invoice (marked disputed).');
  }
  const evidence = {
    ...(row.reason_json || {}),
    facts: {
      ...(row.reason_json?.facts || {}),
      invoice_amount_open: owed,
      days_overdue: live,
      ...(prepared != null && Number(prepared) !== live ? { days_overdue_when_prepared: Number(prepared) } : {}),
      due_date: due,
      last_reminder_sent: inv.last_reminder_sent || null,
      payment_status: inv.payment_status || null,
    },
    live_as_of: new Date(now).toISOString(),
  };
  return { detail: lines.join(' '), evidence, daysOverdue: live };
}

// What approving and rejecting really do for an action whose approval only
// records the owner's decision (PATCH /api/ai-actions/:id sets the status and
// writes an audit row; nothing is executed or sent for these types).
const DECISION_EFFECT = {
  FLAG_BAD_DEBT: 'Approve records that you reviewed this invoice as a likely bad debt. Nothing is sent to the customer and the invoice is not changed or written off. Reject dismisses this flag; the invoice stays open in your books.',
};

function actionCard(row, invoice = null, now = Date.now()) {
  const ctx = invoiceContext(row, invoice, now);
  return {
    id: row.id,
    trigger: row.action_type,
    timestamp: row.created_at,
    summary: row.title,
    detail: ctx ? ctx.detail : (row.description || null),
    relates: {
      type: row.related_entity_type || null,
      id: row.related_entity_id || null,
      customerId: row.customer_id || null,
      supplierId: row.supplier_id || null,
    },
    evidence: ctx ? ctx.evidence : (row.reason_json || null),
    approve_does: DECISION_EFFECT[row.action_type] || row.recommended_message || `Marks this ${row.action_type} action approved and, where automatable, executes it.`,
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

      // Invoices the actions are about, read now, so each card's days overdue
      // and amount are live rather than what was true when it was prepared.
      const allActions = [...pendingRes.rows, ...approvedRes.rows, ...rejectedRes.rows];
      const invoiceIds = [...new Set(allActions.filter((a) => a.related_entity_type === 'invoice' && UUID_RE.test(String(a.related_entity_id || ''))).map((a) => String(a.related_entity_id)))];
      const invoiceRows = invoiceIds.length ? (await pool.query(
        `SELECT id, customer_name, invoice_amount, ${OPEN_AMOUNT_SQL} AS open_amount, due_date, days_overdue, last_reminder_sent, payment_status, dunning_paused
           FROM invoices WHERE user_id = $1 AND id = ANY($2::uuid[])`, [userId, invoiceIds])).rows : [];
      const invoiceById = new Map(invoiceRows.map((i) => [String(i.id), i]));
      const card = (row) => actionCard(row, row.related_entity_type === 'invoice' ? invoiceById.get(String(row.related_entity_id)) || null : null);
      const needsYou = pendingRes.rows.map(card);
      const completed = approvedRes.rows.map(card);
      const dismissed = rejectedRes.rows.map(card);

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

module.exports = { preparedRouter, actionCard };
