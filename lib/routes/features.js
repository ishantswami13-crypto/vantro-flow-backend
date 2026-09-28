'use strict';
// lib/routes/features.js — Starlane's seven features over one API, used by
// the desktop and mobile apps (and the web app where it has caught up).
// Every route is scoped to the signed-in company (req.user.userId).
//
//   GET  /api/client/bridge                  THE BRIDGE: state, attention, what Starlane is doing
//   GET  /api/client/scan/search?q=          SCAN: find a customer or invoice
//   GET  /api/client/scan/customer/:key      SCAN: why a customer matters, with evidence
//   GET  /api/client/scan/invoice/:id        SCAN: why an invoice matters, with evidence
//   GET  /api/client/watch?state=            WATCH: events (refreshes detection, throttled)
//   GET  /api/client/watch/:id               WATCH: one event with evidence and links
//   POST /api/client/watch/:id/state         WATCH: { state: acknowledged|dismissed|open }
//   GET  /api/client/missions                MISSIONS: list with progress
//   POST /api/client/missions/preview        MISSIONS: validate a draft without saving
//   POST /api/client/missions                MISSIONS: create a draft
//   GET  /api/client/missions/:id            MISSIONS: detail, progress, actions, blockers
//   POST /api/client/missions/:id/:verb      MISSIONS: activate | pause | cancel
//   POST /api/client/simulate                SIMULATE: { horizonDays, rates, missionId?, invoiceIds? }
//   GET  /api/client/memory                  MEMORY: records with provenance
//   POST /api/client/memory                  MEMORY: owner note { subject?, statement }
//   POST /api/client/memory/:id/:verb        MEMORY: confirm | correct {statement} | remove
//   GET  /api/client/prepared                PREPARED: 24h / 7d / 30d

const express = require('express');
const { guardRouter, failed } = require('./guardAsync');
const { lifecycleOf, fact, evidence, OPEN_SQL, customerKey, n, ageing } = require('../features/core');
const watch = require('../features/watch');
const missions = require('../features/missions');
const { simulate } = require('../features/simulate');
const memory = require('../features/memory');
const prepared = require('../features/prepared');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFRESH_EVERY_MS = 2 * 60 * 1000;
const FORCED_REFRESH_MIN_MS = Number(process.env.WATCH_FORCED_REFRESH_MIN_MS ?? 30 * 1000);

function actionOut(a) {
  const lc = lifecycleOf(a);
  return {
    id: a.id, type: a.action_type, title: a.title, description: a.description, status: a.status,
    lifecycle: lc.state, lifecycleNote: lc.note, canDecide: lc.canDecide,
    riskLevel: a.risk_level, requiresApproval: !!a.requires_approval, missionId: a.mission_id || null,
    relates: a.related_entity_type ? { type: a.related_entity_type, id: a.related_entity_id } : null,
    draft: a.recommended_message || null, createdAt: a.created_at, updatedAt: a.updated_at,
  };
}

function featuresRouter({ pool, authMiddleware, notifyFn = null, isEnabled = () => false }) {
  // Every route below answers 500 with a reference (and is logged) instead of hanging.
  const router = guardRouter(express.Router());
  // Only these paths: /api/client/telemetry (clientApi.js) must keep its optional auth.
  router.use(['/client/bridge', '/client/scan', '/client/watch', '/client/missions', '/client/simulate', '/client/memory', '/client/prepared'], authMiddleware);
  const lastRefresh = new Map(); // userId -> ms; per-process throttle for on-read detection
  const uid = (req) => req.user.userId;
  const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);
  const soft = (sql, p) => pool.query(sql, p).then((r) => r.rows).catch((e) => { console.error('[features]', e.message); return null; });
  const notifier = (userId) => (notifyFn ? (payload) => notifyFn(pool, userId, payload) : null);

  async function refreshIfDue(userId, force = false) {
    const last = lastRefresh.get(userId) || 0;
    // Forced refreshes ("Check now") are still capped, so a client cannot turn
    // Watch into a full re-scan on every request.
    if (Date.now() - last < (force ? FORCED_REFRESH_MIN_MS : REFRESH_EVERY_MS)) return null;
    lastRefresh.set(userId, Date.now());
    const [w] = await Promise.all([
      watch.refresh(pool, userId, { notifyFn: notifier(userId) }).catch((e) => { console.error('[watch refresh]', JSON.stringify({ userId, error: e.message })); return null; }),
      memory.refresh(pool, userId).catch((e) => { console.error('[memory refresh]', JSON.stringify({ userId, error: e.message })); return null; }),
      evaluateMissions(userId).catch((e) => { console.error('[missions evaluate]', JSON.stringify({ userId, error: e.message })); return null; }),
    ]);
    return w;
  }

  const openInvoices = (userId) => q(
    `SELECT id, customer_name, customer_phone, invoice_number, invoice_amount, days_overdue, due_date, invoice_date,
            dunning_paused, last_reminder_sent, source_type, customer_id
       FROM invoices WHERE user_id = $1 AND ${OPEN_SQL}`, [userId]);

  async function dataAsOf(userId) {
    const r = await soft(`SELECT MAX(finished_at) AS at FROM connector_sync_runs WHERE user_id = $1 AND status = 'succeeded'`, [userId]);
    const f = await soft(`SELECT MAX(completed_at) AS at FROM file_import_batches WHERE user_id = $1 AND status = 'COMPLETED'`, [userId]);
    const all = [r?.[0]?.at, f?.[0]?.at].filter(Boolean).map((d) => new Date(d).toISOString()).sort();
    return all.pop() || null;
  }

  // ── Missions: evaluation + progress ───────────────────────────────────
  async function missionContext(userId, m, asOf) {
    const ids = m.baseline?.invoices?.map((i) => i.id) || m.target?.invoiceIds || [];
    const current = ids.length ? await q(
      `SELECT id, invoice_amount, dunning_paused, customer_phone FROM invoices WHERE user_id = $1 AND id = ANY($2::uuid[]) AND ${OPEN_SQL}`, [userId, ids]) : [];
    const actions = await q(`SELECT * FROM ai_actions WHERE user_id = $1 AND mission_id = $2 ORDER BY created_at`, [userId, m.id]);
    const progress = missions.progressOf({ mission: m, current, actions, externalMessaging: isEnabled('external_message_sending_enabled'), dataAsOf: asOf === undefined ? await dataAsOf(userId) : asOf });
    return { progress, actions };
  }

  async function transition(userId, m, to, extra = {}) {
    if (!missions.canTransition(m.status, to)) { const e = new Error(`A ${m.status} mission cannot become ${to}`); e.status = 409; throw e; }
    const sets = ['status = $3', 'updated_at = now()'];
    const params = [m.id, userId, to];
    for (const [col, val] of Object.entries(extra)) { params.push(val); sets.push(`${col} = $${params.length}`); }
    if (['completed', 'failed', 'cancelled'].includes(to)) sets.push('closed_at = now()');
    params.push(m.status);
    const { rows } = await pool.query(`UPDATE missions SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 AND status = $${params.length} RETURNING *`, params);
    if (!rows.length) { const e = new Error('The mission changed while you were looking at it. Reload.'); e.status = 409; throw e; }
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_value_json, new_value_json) VALUES ($1, $2, 'mission', $3, $4, $5)`,
      [userId, `mission_${to}`, m.id, JSON.stringify({ status: m.status }), JSON.stringify({ status: to, ...(extra.outcome ? { outcome: JSON.parse(extra.outcome) } : {}) })]).catch(() => {});
    return rows[0];
  }

  async function evaluateMissions(userId) {
    const active = await q(`SELECT * FROM missions WHERE user_id = $1 AND status = 'active'`, [userId]);
    const asOf = active.length ? await dataAsOf(userId) : null;
    for (const m of active) {
      const { progress } = await missionContext(userId, m, asOf);
      const v = missions.verdict({ mission: m, progress });
      if (!v) continue;
      const outcome = { result: v, collected: progress.collected, target: progress.targetAmount, decidedAt: new Date().toISOString(),
        text: v === 'completed' ? 'Target reached.' : `Horizon passed with ₹${Math.round(progress.remaining).toLocaleString('en-IN')} still to collect.` };
      const closed = await transition(userId, m, v, { outcome: JSON.stringify(outcome) }).catch(() => null);
      if (!closed) continue;
      await pool.query(`UPDATE ai_actions SET status = 'cancelled', updated_at = now() WHERE user_id = $1 AND mission_id = $2 AND status = 'pending'`, [userId, m.id]);
      await pool.query(
        `INSERT INTO memory_records (user_id, subject_type, subject_key, subject_label, topic, statement, value, status, provenance)
         VALUES ($1, 'business', $2, 'Your business', 'mission_result', $3, $4, 'inferred', $5)
         ON CONFLICT (user_id, subject_type, subject_key, topic) DO NOTHING`,
        [userId, `mission:${m.id}`, `Mission “${m.title}” ${v === 'completed' ? 'reached its target' : 'missed its target'}: collected ₹${Math.round(progress.collected).toLocaleString('en-IN')} of ₹${Math.round(progress.targetAmount).toLocaleString('en-IN')} (horizon ${m.horizon_days} days).`,
          JSON.stringify(outcome), JSON.stringify({ source: 'mission', table: 'missions', ids: [m.id], method: 'Mission outcome at close' })]).catch(() => {});
      if (notifyFn) await notifyFn(pool, userId, { type: 'business_change', severity: 'normal', title: v === 'completed' ? 'A mission reached its target' : 'A mission ended short of its target', body: 'Open Missions to see the result.', entity: { type: 'mission', id: m.id }, route: `/missions/${m.id}`, dedupeKey: `mission-close:${m.id}` }).catch(() => null);
    }
  }

  // ── THE BRIDGE ────────────────────────────────────────────────────────
  router.get('/client/bridge', async (req, res) => {
    const userId = uid(req);
    try {
      await refreshIfDue(userId);
      await evaluateMissions(userId).catch(() => null);
      const [invoices, pending, events, active, asOf, prep] = await Promise.all([
        openInvoices(userId).catch(() => null),
        soft(`SELECT * FROM ai_actions WHERE user_id = $1 AND status = 'pending'
               ORDER BY requires_approval DESC, CASE risk_level WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC LIMIT 50`, [userId]),
        soft(`SELECT * FROM watch_events WHERE user_id = $1 AND state IN ('open','acknowledged')
               ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, last_seen_at DESC LIMIT 200`, [userId]),
        soft(`SELECT * FROM missions WHERE user_id = $1 AND status IN ('active','paused','draft') ORDER BY updated_at DESC LIMIT 10`, [userId]),
        dataAsOf(userId),
        preparedFor(userId).catch(() => null),
      ]);
      const { getConnectorStates } = require('../connectors/state');
      const connectors = await getConnectorStates(pool, userId).catch(() => []);
      const inv = invoices || [];
      const overdue = inv.filter((i) => n(i.days_overdue) > 0);
      const byCustomer = new Map();
      for (const i of overdue) {
        const k = customerKey(i.customer_name);
        const c = byCustomer.get(k) || { key: k, name: i.customer_name, amount: 0, count: 0, oldestDays: 0 };
        c.amount += n(i.invoice_amount); c.count++; c.oldestDays = Math.max(c.oldestDays, n(i.days_overdue));
        byCustomer.set(k, c);
      }
      const missionCards = [];
      for (const m of active || []) {
        const { progress } = await missionContext(userId, m, asOf);
        missionCards.push(missions.shape(m, { progress: { collected: progress.collected, targetAmount: progress.targetAmount, ratio: progress.ratio, daysLeft: progress.daysLeft, blockers: progress.blockers.length } }));
      }
      const ageMs = asOf ? Date.now() - Date.parse(asOf) : null;
      const openTotal = inv.reduce((s, i) => s + n(i.invoice_amount), 0);
      const overdueTotal = overdue.reduce((s, i) => s + n(i.invoice_amount), 0);
      const ev = events || [];
      res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        dataAsOf: asOf,
        freshness: !asOf ? 'none' : ageMs < 2 * 3600e3 ? 'fresh' : ageMs < 24 * 3600e3 ? 'delayed' : 'stale',
        hasData: inv.length > 0,
        state: invoices === null ? null : {
          currency: 'INR', openReceivables: Math.round(openTotal), overdueReceivables: Math.round(overdueTotal),
          openInvoiceCount: inv.length, overdueInvoiceCount: overdue.length,
          ageing: ageing(inv).map((b) => ({ ...b, amount: Math.round(b.amount) })),
          topOverdue: [...byCustomer.values()].sort((a, b) => b.amount - a.amount).slice(0, 5).map((c) => ({ ...c, amount: Math.round(c.amount) })),
          evidence: evidence({ summary: 'Totals over open invoices in Starlane.', facts: [
            fact('Open invoices', inv.length, { source: 'invoices' }),
            fact('Owed to you', Math.round(openTotal), { kind: 'calculated', unit: 'INR', source: 'invoices' }),
            fact('Overdue', Math.round(overdueTotal), { kind: 'calculated', unit: 'INR', source: 'invoices', note: 'Invoices past their due date.' }),
          ], sources: ['invoices'] }),
        },
        attention: {
          decisions: (pending || []).length,
          topDecisions: (pending || []).slice(0, 3).map(actionOut),
          watch: { open: ev.filter((e) => e.state === 'open').length, acknowledged: ev.filter((e) => e.state === 'acknowledged').length,
            urgent: ev.filter((e) => ['critical', 'high'].includes(e.severity)).length, latest: ev.slice(0, 4).map(watch.shapeEvent) },
        },
        missions: missionCards,
        prepared: prep ? prep.map((h) => ({ horizon: h.horizon, label: h.label, status: h.status, count: h.items.length, first: h.items[0] || null })) : null,
        sources: connectors.filter((c) => c.availability === 'available' && c.authType !== 'public_feed')
          .map((c) => ({ id: c.id, name: c.name, health: c.state.health, lastSuccessAt: c.state.lastSuccessAt || null })),
        partial: [invoices, pending, events, active].some((x) => x === null),
      });
    } catch (e) {
      failed(req, res, 'GET /client/bridge', e, 'Could not load the Bridge');
    }
  });

  // ── SCAN ──────────────────────────────────────────────────────────────
  router.get('/client/scan/search', async (req, res) => {
    const term = String(req.query.q || '').trim().slice(0, 80);
    if (term.length < 2) return res.json({ success: true, customers: [], invoices: [] });
    const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const customers = await q(
      `SELECT customer_name AS name, COUNT(*)::int AS open_count, COALESCE(SUM(invoice_amount),0)::numeric AS open_total, MAX(COALESCE(days_overdue,0))::int AS oldest
         FROM invoices WHERE user_id = $1 AND ${OPEN_SQL} AND customer_name ILIKE $2 GROUP BY customer_name ORDER BY open_total DESC LIMIT 10`, [uid(req), like]);
    const invoices = await q(
      `SELECT id, customer_name, invoice_number, invoice_amount, days_overdue FROM invoices
        WHERE user_id = $1 AND ${OPEN_SQL} AND invoice_number ILIKE $2 ORDER BY days_overdue DESC NULLS LAST LIMIT 10`, [uid(req), like]);
    res.json({ success: true,
      customers: customers.map((c) => ({ key: customerKey(c.name), name: c.name, openCount: c.open_count, openTotal: Math.round(n(c.open_total)), oldestDays: c.oldest })),
      invoices: invoices.map((i) => ({ id: i.id, customer: i.customer_name, invoiceNumber: i.invoice_number, amount: Math.round(n(i.invoice_amount)), daysOverdue: n(i.days_overdue) })) });
  });

  async function scanCustomer(userId, key) {
    const all = await openInvoices(userId);
    const mine = all.filter((i) => customerKey(i.customer_name) === key);
    if (!mine.length) return null;
    const name = mine[0].customer_name;
    const ids = mine.map((i) => String(i.id));
    const [actions, events, mems, ms] = await Promise.all([
      q(`SELECT * FROM ai_actions WHERE user_id = $1 AND related_entity_type = 'invoice' AND related_entity_id = ANY($2::text[]) ORDER BY created_at DESC LIMIT 20`, [userId, ids]),
      q(`SELECT * FROM watch_events WHERE user_id = $1 AND entity_type = 'invoice' AND entity_id = ANY($2::text[]) ORDER BY last_seen_at DESC LIMIT 20`, [userId, ids]),
      q(`SELECT * FROM memory_records WHERE user_id = $1 AND subject_type = 'customer' AND subject_key = $2 AND status <> 'removed'`, [userId, key]),
      q(`SELECT * FROM missions WHERE user_id = $1 AND status IN ('draft','active','paused') AND target->'invoiceIds' ?| $2::text[]`, [userId, ids]),
    ]);
    const owed = mine.reduce((s, i) => s + n(i.invoice_amount), 0);
    const overdue = mine.filter((i) => n(i.days_overdue) > 0);
    const oldest = mine.reduce((a, b) => (n(b.days_overdue) > n(a.days_overdue) ? b : a), mine[0]);
    const timing = mems.find((m) => m.topic === 'payment_timing');
    const { getStage } = require('../services/agents/collectionsAgent');
    const disputed = mine.filter((i) => i.dunning_paused);
    const next = n(oldest.days_overdue) > 0 && !oldest.dunning_paused ? getStage(n(oldest.days_overdue)).type : null;
    const why = [];
    if (overdue.length) why.push(`${overdue.length} of ${mine.length} open invoice${mine.length > 1 ? 's are' : ' is'} overdue; the oldest by ${n(oldest.days_overdue)} days.`);
    else why.push('Nothing from this customer is overdue yet.');
    if (timing) why.push(`${timing.statement}${timing.status === 'inferred' ? ' (inferred — confirm or correct it in Memory)' : ''}`);
    if (disputed.length) why.push(`${disputed.length} invoice${disputed.length > 1 ? 's are' : ' is'} disputed; Starlane will not chase ${disputed.length > 1 ? 'them' : 'it'}.`);
    if (!mine.some((i) => i.customer_phone)) why.push('No phone number on file, so reminders cannot be sent from Starlane.');
    return {
      subject: { type: 'customer', key, name },
      headline: overdue.length
        ? `${name} owes ₹${Math.round(owed).toLocaleString('en-IN')}; ₹${Math.round(overdue.reduce((s, i) => s + n(i.invoice_amount), 0)).toLocaleString('en-IN')} of it is overdue.`
        : `${name} owes ₹${Math.round(owed).toLocaleString('en-IN')}, none of it overdue.`,
      why,
      nextStep: next ? { stage: next, text: 'This is the collections stage for the oldest invoice by days overdue. A mission sends reminders only unless you allow escalation, and nothing goes out without your approval.' } : null,
      evidence: evidence({ summary: 'From this customer’s open invoices.', facts: [
        fact('Open invoices', mine.length, { source: 'invoices', ids }),
        fact('Owed', Math.round(owed), { kind: 'calculated', unit: 'INR', source: 'invoices', ids }),
        fact('Oldest overdue', n(oldest.days_overdue), { kind: 'calculated', unit: 'days', source: 'invoices', ids: [oldest.id] }),
        ...(timing ? [fact('Payment timing', timing.value?.medianDaysLate ?? null, { kind: timing.status === 'inferred' ? 'model' : 'fact', unit: 'days late (median)', source: 'memory_records', ids: [timing.id], note: timing.status })] : []),
      ], sources: ['invoices', ...(timing ? ['memory_records'] : [])] }),
      invoices: mine.sort((a, b) => n(b.days_overdue) - n(a.days_overdue)).map((i) => ({
        id: i.id, invoiceNumber: i.invoice_number, amount: Math.round(n(i.invoice_amount)), daysOverdue: n(i.days_overdue), dueDate: i.due_date, disputed: !!i.dunning_paused })),
      actions: actions.map(actionOut),
      watch: events.map(watch.shapeEvent),
      missions: ms.map((m) => missions.shape(m)),
      memory: mems.map((m) => memory.shape(m)),
    };
  }

  router.get('/client/scan/customer/:key', async (req, res) => {
    let out;
    try { out = await scanCustomer(uid(req), customerKey(req.params.key)); }
    catch (e) { return failed(req, res, 'GET /client/scan/customer/:key', e, 'Scan failed'); }
    if (!out) return res.status(404).json({ error: 'No open invoices for that customer' });
    res.json({ success: true, scan: out });
  });

  router.get('/client/scan/invoice/:id', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Invoice not found' });
    const inv = (await q(`SELECT * FROM invoices WHERE id = $1 AND user_id = $2`, [req.params.id, uid(req)]))[0];
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    const paid = /^paid$/i.test(inv.payment_status || '');
    const customer = paid ? null : await scanCustomer(uid(req), customerKey(inv.customer_name));
    const d = n(inv.days_overdue);
    res.json({ success: true, scan: {
      subject: { type: 'invoice', id: inv.id, invoiceNumber: inv.invoice_number, customer: inv.customer_name, customerKey: customerKey(inv.customer_name) },
      headline: paid ? `Paid${inv.payment_date ? ` on ${String(inv.payment_date).slice(0, 10)}` : ''}.`
        : d > 0 ? `${d} days overdue: ₹${Math.round(n(inv.invoice_amount)).toLocaleString('en-IN')} from ${inv.customer_name}.`
          : `Not yet due: ₹${Math.round(n(inv.invoice_amount)).toLocaleString('en-IN')} from ${inv.customer_name}.`,
      evidence: evidence({ summary: 'This invoice as recorded.', facts: [
        fact('Amount', n(inv.invoice_amount), { unit: 'INR', source: 'invoices', ids: [inv.id] }),
        fact('Invoice date', inv.invoice_date || null, { source: 'invoices', ids: [inv.id] }),
        fact('Due date', inv.due_date || null, { source: 'invoices', ids: [inv.id] }),
        fact('Days overdue', d, { kind: 'calculated', source: 'invoices', ids: [inv.id] }),
        fact('Reminders sent', n(inv.reminder_count), { source: 'invoices', ids: [inv.id] }),
        fact('Last reminder', inv.last_reminder_sent || null, { source: 'invoices', ids: [inv.id] }),
        fact('Collection paused (dispute)', !!inv.dunning_paused, { source: 'invoices', ids: [inv.id] }),
        fact('Came from', inv.source_type || 'entered in Starlane', { source: 'invoices', ids: [inv.id] }),
      ], sources: ['invoices'] }),
      customer,
    } });
  });

  // ── WATCH ─────────────────────────────────────────────────────────────
  router.get('/client/watch', async (req, res) => {
    const userId = uid(req);
    const refreshed = await refreshIfDue(userId, req.query.refresh === '1');
    const states = { active: ['open', 'acknowledged'], open: ['open'], acknowledged: ['acknowledged'], closed: ['resolved', 'dismissed'] }[req.query.state || 'active'] || ['open', 'acknowledged'];
    const rows = await q(
      `SELECT * FROM watch_events WHERE user_id = $1 AND state = ANY($2::text[])
        ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, last_seen_at DESC LIMIT 200`, [userId, states]);
    const counts = (await q(`SELECT state, COUNT(*)::int n FROM watch_events WHERE user_id = $1 GROUP BY state`, [userId]))
      .reduce((m, r) => ({ ...m, [r.state]: r.n }), {});
    res.json({ success: true, events: rows.map(watch.shapeEvent), counts, refreshed: refreshed ? { at: new Date().toISOString(), created: refreshed.created, resolved: refreshed.resolved } : null });
  });

  router.get('/client/watch/:id', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const e = (await q(`SELECT * FROM watch_events WHERE id = $1 AND user_id = $2`, [req.params.id, uid(req)]))[0];
    if (!e) return res.status(404).json({ error: 'Not found' });
    let actions = [], mission = null;
    if (e.entity_type === 'invoice') {
      actions = (await q(`SELECT * FROM ai_actions WHERE user_id = $1 AND related_entity_type = 'invoice' AND related_entity_id = $2 ORDER BY created_at DESC LIMIT 5`, [uid(req), e.entity_id])).map(actionOut);
      mission = (await q(`SELECT * FROM missions WHERE user_id = $1 AND status IN ('draft','active','paused') AND target->'invoiceIds' ? $2 LIMIT 1`, [uid(req), e.entity_id]))[0] || null;
    }
    res.json({ success: true, event: watch.shapeEvent(e), actions, mission: mission && missions.shape(mission),
      next: e.entity_type === 'invoice' ? { scan: `/scan/invoice/${e.entity_id}`, mission: mission ? `/missions/${mission.id}` : `/missions/new?invoice=${e.entity_id}` } : null });
  });

  router.post('/client/watch/:id/state', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const to = req.body?.state;
    if (!['acknowledged', 'dismissed', 'open'].includes(to)) return res.status(400).json({ error: 'state must be acknowledged, dismissed or open' });
    const e = (await q(`SELECT id, state FROM watch_events WHERE id = $1 AND user_id = $2`, [req.params.id, uid(req)]))[0];
    if (!e) return res.status(404).json({ error: 'Not found' });
    if (!watch.canMove(e.state, to)) return res.status(409).json({ error: `A ${e.state} event cannot become ${to}`, state: e.state });
    const { rows } = await pool.query(
      `UPDATE watch_events SET state = $3, acknowledged_at = CASE WHEN $3 = 'acknowledged' THEN now() ELSE acknowledged_at END,
              resolved_at = CASE WHEN $3 = 'dismissed' THEN now() WHEN $3 = 'open' THEN NULL ELSE resolved_at END,
              resolution = CASE WHEN $3 = 'dismissed' THEN 'dismissed_by_owner' WHEN $3 = 'open' THEN NULL ELSE resolution END
        WHERE id = $1 AND user_id = $2 AND state = $4 RETURNING *`, [e.id, uid(req), to, e.state]);
    if (!rows.length) return res.status(409).json({ error: 'The event changed; reload.' });
    res.json({ success: true, event: watch.shapeEvent(rows[0]) });
  });

  // ── MISSIONS ──────────────────────────────────────────────────────────
  router.get('/client/missions', async (req, res) => {
    const userId = uid(req);
    await refreshIfDue(userId);
    await evaluateMissions(userId).catch(() => null);
    const rows = await q(`SELECT * FROM missions WHERE user_id = $1 ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, updated_at DESC LIMIT 100`, [userId]);
    const out = [];
    const asOf = rows.length ? await dataAsOf(userId) : null;
    for (const m of rows) {
      const { progress } = await missionContext(userId, m, asOf);
      out.push(missions.shape(m, { progress: { collected: progress.collected, targetAmount: progress.targetAmount, ratio: progress.ratio, daysLeft: progress.daysLeft, blockers: progress.blockers.length, actions: progress.actions } }));
    }
    res.json({ success: true, missions: out });
  });

  async function plan(req) {
    const invoices = await openInvoices(uid(req));
    return missions.planDraft({ invoices, input: { ...(req.body || {}), type: 'collections' } });
  }

  router.post('/client/missions/preview', async (req, res) => {
    const { errors, draft } = await plan(req);
    const invoices = await openInvoices(uid(req));
    const chosen = invoices.filter((i) => draft.target.invoiceIds.includes(String(i.id)));
    const history = await q(`SELECT due_date, payment_date FROM invoices WHERE user_id = $1 AND payment_status IN ('Paid','paid','PAID') AND due_date IS NOT NULL AND payment_date IS NOT NULL LIMIT 5000`, [uid(req)]);
    res.json({ success: true, errors, draft, simulation: chosen.length ? simulate({ invoices: chosen, horizonDays: draft.horizonDays, history, targetAmount: draft.target.amount }) : null });
  });

  router.post('/client/missions', async (req, res) => {
    if ((req.body?.type || 'collections') !== 'collections') return res.status(400).json({ error: 'Only collections missions exist today' });
    const { errors, draft } = await plan(req);
    if (errors.length) return res.status(400).json({ error: errors[0], errors });
    const { rows } = await pool.query(
      `INSERT INTO missions (user_id, type, title, objective, target, horizon_days, constraints) VALUES ($1,'collections',$2,$3,$4,$5,$6) RETURNING *`,
      [uid(req), draft.title, draft.objective, JSON.stringify(draft.target), draft.horizonDays, JSON.stringify(draft.constraints)]);
    await pool.query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_value_json) VALUES ($1,'mission_draft','mission',$2,$3)`,
      [uid(req), rows[0].id, JSON.stringify({ status: 'draft', target: draft.target })]).catch(() => {});
    res.status(201).json({ success: true, mission: missions.shape(rows[0]), excluded: draft.excluded });
  });

  router.get('/client/missions/:id', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Mission not found' });
    const userId = uid(req);
    await refreshIfDue(userId);
    // Evaluating open missions is cheap and must never lag behind a payment.
    await evaluateMissions(userId).catch(() => null);
    const m = (await q(`SELECT * FROM missions WHERE id = $1 AND user_id = $2`, [req.params.id, userId]))[0];
    if (!m) return res.status(404).json({ error: 'Mission not found' });
    const { progress, actions } = await missionContext(userId, m);
    const history = await q(`SELECT action, created_at, new_value_json FROM audit_logs WHERE user_id = $1 AND entity_type = 'mission' AND entity_id = $2 ORDER BY created_at`, [userId, m.id]).catch(() => []);
    const targetInvoices = m.baseline ? null : await q(
      `SELECT id, customer_name, invoice_number, invoice_amount, days_overdue FROM invoices WHERE user_id = $1 AND id = ANY($2::uuid[])`, [userId, m.target.invoiceIds || []]);
    res.json({ success: true, mission: missions.shape(m, {
      progress, actions: actions.map(actionOut),
      history: history.map((h) => ({ event: h.action.replace(/^mission_/, ''), at: h.created_at })),
      allowed: Object.entries(missions.CLIENT_TRANSITIONS).filter(([, from]) => from.includes(m.status)).map(([verb]) => verb),
      targetInvoices: targetInvoices && targetInvoices.map((i) => ({ id: i.id, customer: i.customer_name, invoiceNumber: i.invoice_number, amount: Math.round(n(i.invoice_amount)), daysOverdue: n(i.days_overdue) })),
    }) });
  });

  router.post('/client/missions/:id/:verb', async (req, res) => {
    const { id, verb } = req.params;
    if (!UUID_RE.test(id) || !missions.CLIENT_TRANSITIONS[verb]) return res.status(404).json({ error: 'Not found' });
    const userId = uid(req);
    const m = (await q(`SELECT * FROM missions WHERE id = $1 AND user_id = $2`, [id, userId]))[0];
    if (!m) return res.status(404).json({ error: 'Mission not found' });
    if (!missions.CLIENT_TRANSITIONS[verb].includes(m.status)) return res.status(409).json({ error: `A ${m.status} mission cannot be ${verb === 'activate' ? 'activated' : `${verb}d`}`, status: m.status });
    try {
      let updated, proposed = null;
      if (verb === 'activate' && m.status === 'draft') {
        const all = await openInvoices(userId);
        const chosen = all.filter((i) => (m.target.invoiceIds || []).includes(String(i.id)) && !i.dunning_paused);
        if (!chosen.length) return res.status(409).json({ error: 'None of this mission’s invoices are still open and undisputed.' });
        const baseline = { at: new Date().toISOString(), outstanding: chosen.reduce((s, i) => s + n(i.invoice_amount), 0),
          invoices: chosen.map((i) => ({ id: String(i.id), customer: i.customer_name, invoiceNumber: i.invoice_number, amount: n(i.invoice_amount), daysOverdue: n(i.days_overdue) })) };
        updated = await transition(userId, m, 'active', { baseline: JSON.stringify(baseline), activated_at: new Date().toISOString(), ends_at: new Date(Date.now() + m.horizon_days * 86400000).toISOString() });
        proposed = await proposeForMission(userId, updated, chosen);
      } else {
        updated = await transition(userId, m, verb === 'activate' ? 'active' : verb === 'pause' ? 'paused' : 'cancelled');
        if (verb === 'cancel') await pool.query(`UPDATE ai_actions SET status = 'cancelled', updated_at = now() WHERE user_id = $1 AND mission_id = $2 AND status = 'pending'`, [userId, id]);
      }
      const { progress, actions } = await missionContext(userId, updated);
      res.json({ success: true, mission: missions.shape(updated, { progress, actions: actions.map(actionOut) }), proposed });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      failed(req, res, `POST /client/missions/:id/${req.params.verb}`, e, 'Could not update the mission');
    }
  });

  async function proposeForMission(userId, m, invoices) {
    const { getStage, buildMessage } = require('../services/agents/collectionsAgent');
    const { validate } = require('../services/orchestrator/policyGuard.service');
    const ids = invoices.map((i) => String(i.id));
    // An invoice that already has an open action keeps it; the mission adopts it.
    const open = await q(`SELECT id, related_entity_id FROM ai_actions WHERE user_id = $1 AND related_entity_type = 'invoice' AND related_entity_id = ANY($2::text[]) AND status IN ('pending','approved','executing')`, [userId, ids]);
    if (open.length) await pool.query(`UPDATE ai_actions SET mission_id = $3 WHERE user_id = $1 AND id = ANY($2::uuid[]) AND mission_id IS NULL`, [userId, open.map((a) => a.id), m.id]);
    const { out, skipped } = missions.proposals({ invoices, constraints: m.constraints || missions.DEFAULT_CONSTRAINTS, activeActionInvoiceIds: new Set(open.map((a) => String(a.related_entity_id))), getStage, buildMessage });
    let created = 0, blocked = 0;
    for (const { invoice: inv, stage } of out) {
      const d = n(inv.days_overdue);
      const spec = {
        action_type: stage.type,
        title: `${stage.type === 'SEND_POLITE_REMINDER' ? 'Reminder' : stage.type === 'SEND_FIRM_REMINDER' ? 'Firm reminder' : stage.type === 'FLAG_BAD_DEBT' ? 'Review for bad debt' : 'Escalate'}: ${inv.customer_name}`,
        description: `₹${Math.round(n(inv.invoice_amount)).toLocaleString('en-IN')} — ${d} days overdue · for “${m.title}”`,
        priority: stage.priority, risk_level: stage.riskLevel,
        recommended_message: stage.type !== 'FLAG_BAD_DEBT' ? buildMessage(inv.customer_name, n(inv.invoice_amount), d, stage) : null,
        related_entity_type: 'invoice', related_entity_id: String(inv.id), customer_id: inv.customer_id || null,
        requires_approval: true,
        reason_json: {
          rule: 'mission_collections_stage', source: { table: 'invoices', id: inv.id },
          facts: { invoice_amount: n(inv.invoice_amount), days_overdue: d, due_date: inv.due_date || null, last_reminder_sent: inv.last_reminder_sent || null },
          stage: { chosen: stage.type, by_days: getStage(d).type, band_days: [getStage(d).minDays, getStage(d).maxDays === Infinity ? null : getStage(d).maxDays] },
          adjustments: stage.capped ? { mission_constraint: 'Escalation not allowed by this mission; capped at a firm reminder.' } : null,
          mission: { id: m.id, title: m.title }, computed_at: new Date().toISOString(),
        },
      };
      const guard = await validate(spec, userId);
      if (guard.status === 'system_blocked') { blocked++; continue; }
      await pool.query(
        `INSERT INTO ai_actions (user_id, action_type, title, description, priority, risk_level, recommended_message, related_entity_type, related_entity_id,
                                 customer_id, suggested_by, requires_approval, reason_json, mission_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'collections_agent',$11,$12,$13,'pending')`,
        [userId, spec.action_type, spec.title, spec.description, spec.priority, spec.risk_level, spec.recommended_message, 'invoice', spec.related_entity_id,
          spec.customer_id, guard.requires_approval !== false, JSON.stringify(spec.reason_json), m.id]);
      created++;
    }
    if (created && notifyFn) await notifyFn(pool, userId, { type: 'approval_required', severity: 'normal', title: `${created} action${created > 1 ? 's' : ''} ready for your approval`, body: 'Proposed by a mission. Nothing is sent until you approve.', entity: { type: 'mission', id: m.id }, route: `/missions/${m.id}`, dedupeKey: `mission-proposed:${m.id}` }).catch(() => null);
    return { created, adopted: open.length, blocked, skipped };
  }

  // ── SIMULATE ──────────────────────────────────────────────────────────
  router.post('/client/simulate', async (req, res) => {
    const userId = uid(req);
    const body = req.body || {};
    let invoices = await openInvoices(userId);
    let target = null, scope = 'all_open';
    if (body.missionId) {
      if (!UUID_RE.test(body.missionId)) return res.status(404).json({ error: 'Mission not found' });
      const m = (await q(`SELECT * FROM missions WHERE id = $1 AND user_id = $2`, [body.missionId, userId]))[0];
      if (!m) return res.status(404).json({ error: 'Mission not found' });
      const ids = new Set((m.baseline?.invoices?.map((i) => i.id) || m.target.invoiceIds || []).map(String));
      invoices = invoices.filter((i) => ids.has(String(i.id)));
      const { progress } = await missionContext(userId, m);
      target = Math.max(0, n(m.target.amount) - progress.collected);
      scope = 'mission';
    } else if (Array.isArray(body.invoiceIds) && body.invoiceIds.length) {
      const ids = new Set(body.invoiceIds.map(String));
      invoices = invoices.filter((i) => ids.has(String(i.id)));
      scope = 'selected';
    } else if (body.targetAmount != null) target = n(body.targetAmount);
    const history = await q(`SELECT due_date, payment_date FROM invoices WHERE user_id = $1 AND payment_status IN ('Paid','paid','PAID') AND due_date IS NOT NULL AND payment_date IS NOT NULL LIMIT 5000`, [userId]);
    const rates = body.rates && typeof body.rates === 'object' ? body.rates : {};
    res.json({ success: true, scope, invoiceCount: invoices.length,
      simulation: invoices.length ? simulate({ invoices, horizonDays: body.horizonDays, rates, history, targetAmount: target }) : null,
      emptyReason: invoices.length ? null : 'There are no open invoices to simulate. Connect Tally or import a sheet first.' });
  });

  // ── MEMORY ────────────────────────────────────────────────────────────
  router.get('/client/memory', async (req, res) => {
    const userId = uid(req);
    await refreshIfDue(userId);
    const show = req.query.status === 'removed' ? ['removed'] : ['inferred', 'confirmed', 'corrected'];
    const rows = await q(`SELECT * FROM memory_records WHERE user_id = $1 AND status = ANY($2::text[]) ORDER BY CASE status WHEN 'inferred' THEN 0 ELSE 1 END, updated_at DESC LIMIT 300`, [userId, show]);
    res.json({ success: true, records: rows.map((r) => memory.shape(r)) });
  });

  router.post('/client/memory', async (req, res) => {
    const statement = String(req.body?.statement || '').trim().slice(0, 400);
    if (statement.length < 3) return res.status(400).json({ error: 'Write what Starlane should remember' });
    const label = String(req.body?.subject || '').trim().slice(0, 120);
    const key = label ? customerKey(label) : 'self';
    const { rows } = await pool.query(
      `INSERT INTO memory_records (user_id, subject_type, subject_key, subject_label, topic, statement, status, provenance, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', $7, now()) RETURNING *`,
      [uid(req), label ? 'customer' : 'business', key, label || 'Your business', `note:${Date.now()}`, statement, JSON.stringify({ source: 'you', method: 'Written by you' })]);
    res.status(201).json({ success: true, record: memory.shape(rows[0]) });
  });

  router.post('/client/memory/:id/:verb', async (req, res) => {
    const { id, verb } = req.params;
    if (!UUID_RE.test(id) || !['confirm', 'correct', 'remove'].includes(verb)) return res.status(404).json({ error: 'Not found' });
    const cur = (await q(`SELECT * FROM memory_records WHERE id = $1 AND user_id = $2`, [id, uid(req)]))[0];
    if (!cur) return res.status(404).json({ error: 'Not found' });
    if (cur.status === 'removed') return res.status(409).json({ error: 'This was removed.' });
    let rows;
    if (verb === 'correct') {
      const statement = String(req.body?.statement || '').trim().slice(0, 400);
      if (statement.length < 3) return res.status(400).json({ error: 'Write the corrected statement' });
      ({ rows } = await pool.query(`UPDATE memory_records SET status = 'corrected', statement = $3, decided_at = now(), updated_at = now(),
        provenance = provenance || jsonb_build_object('correctedFrom', $4::text) WHERE id = $1 AND user_id = $2 RETURNING *`, [id, uid(req), statement, cur.statement]));
    } else {
      const to = verb === 'confirm' ? 'confirmed' : 'removed';
      // Confirming freezes the current value; removing keeps the row so it is never re-inferred.
      ({ rows } = await pool.query(`UPDATE memory_records SET status = $3, decided_at = now(), updated_at = now(),
        value = CASE WHEN $3 = 'confirmed' THEN COALESCE(value, '{}'::jsonb) - 'latest' ELSE value END WHERE id = $1 AND user_id = $2 RETURNING *`, [id, uid(req), to]));
    }
    await pool.query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_value_json, new_value_json) VALUES ($1,$2,'memory_record',$3,$4,$5)`,
      [uid(req), `memory_${verb}`, id, JSON.stringify({ status: cur.status, statement: cur.statement }), JSON.stringify({ status: rows[0].status, statement: rows[0].statement })]).catch(() => {});
    res.json({ success: true, record: memory.shape(rows[0]) });
  });

  // ── PREPARED ──────────────────────────────────────────────────────────
  async function preparedFor(userId) {
    const [invoices, promises, ms, pending] = await Promise.all([
      openInvoices(userId),
      soft(`SELECT p.id, p.promised_amount, p.promised_date, c.name AS customer_name FROM promises p LEFT JOIN customers c ON c.id = p.customer_id AND c.user_id = p.user_id
             WHERE p.user_id = $1 AND p.status = 'active' AND p.promised_date >= CURRENT_DATE AND p.promised_date <= CURRENT_DATE + 31`, [userId]),
      soft(`SELECT id, title, ends_at FROM missions WHERE user_id = $1 AND status = 'active'`, [userId]),
      soft(`SELECT id FROM ai_actions WHERE user_id = $1 AND status = 'pending'`, [userId]),
    ]);
    return prepared.build({ invoices, promises: promises || [], missions: ms || [], pending: pending || [] });
  }

  router.get('/client/prepared', async (req, res) => {
    try { res.json({ success: true, generatedAt: new Date().toISOString(), horizons: await preparedFor(uid(req)) }); }
    catch (e) { failed(req, res, 'GET /client/prepared', e, 'Could not prepare'); }
  });

  router.refreshFor = (userId) => { lastRefresh.delete(userId); return refreshIfDue(userId, true); };
  return router;
}

/** Approvals of a mission's actions are held while the mission is not active. */
async function missionHoldsDecision(pool, userId, missionId) {
  if (!missionId) return null;
  const m = (await pool.query('SELECT status, title FROM missions WHERE id = $1 AND user_id = $2', [missionId, userId])).rows[0];
  if (!m || m.status === 'active') return null;
  return m.status === 'paused' ? `The mission “${m.title}” is paused. Resume it to approve its actions.` : `The mission “${m.title}” is ${m.status}.`;
}

module.exports = { featuresRouter, missionHoldsDecision, actionOut };
