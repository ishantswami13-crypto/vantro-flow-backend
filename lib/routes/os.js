'use strict';
// lib/routes/os.js — the seven-surface operating system over HTTP.
//
//   Bridge    GET  /bridge, GET|POST /knowledge, POST /knowledge/:id/retire
//   Scan      POST /scan, GET /scan/latest
//   Watch     GET|POST /objectives, PATCH /objectives/:id, POST /objectives/:id/evaluate,
//             POST /objectives/evaluate, GET /objectives/templates, GET /watch/brief
//   Simulate  POST /workflows/:id/simulate
//   Prepared  GET /workflows?status=PROPOSED, GET /workflows/items?status=AWAITING_APPROVAL,
//             POST /workflows/items/:id/approve|reject
//   Missions  GET /workflows, POST /workflows/from-text, POST /workflows/:id/deploy|pause|reject|retire,
//             PUT /workflows/:id/permissions, POST /workflows/:id/run, GET /workflows/:id
//   Memory    GET /memory, POST /workflows/verify
//   Missions+ GET /missions (decisions being handled + deployed workflows, derived state)
//   Today     GET /today (what needs you, what is handled, what is watched)
//   Agents    GET /agents (real workers, permissions, runs, kill-switch state)
//   Funnel    GET /funnel (first time each value step happened, value metrics)
//   Map       GET /surfaces
//
// Mounted from server.js with its pool and authMiddleware. Every handler
// takes the tenant from the verified JWT and never from the request.

const express = require('express');
const { isEnabled } = require('../featureFlags');
const { safeLog } = require('../observability/logger');
const { getSettings } = require('../domain/decisions/controls');
const { bridgeOverview } = require('../domain/os/bridge');
const { addKnowledge, listKnowledge, retireKnowledge } = require('../domain/os/knowledge');
const { runScan, latestScan } = require('../domain/os/scan');
const objectives = require('../domain/os/objectiveStore');
const wf = require('../domain/os/workflows');
const { parseWorkflowText } = require('../domain/os/workflowLogic');
const { surfaces } = require('../domain/os/surfaces');
const { LEVELS } = require('../domain/os/workflowTemplates');
const missions = require('../domain/os/missions');
const { funnel: funnelOf } = require('../domain/os/funnel');
const { listAgents } = require('../domain/os/agents');
const { salesChangeWhatIf } = require('../domain/os/whatIf');

function uid(req) {
  return req.user?.userId || req.user?.id || null;
}

function sendError(res, req, err) {
  if (err && err.status && err.status >= 400 && err.status < 500) {
    const body = { error: err.message };
    for (const k of ['blockedBy', 'itemStatus', 'understood', 'safety']) if (err[k] !== undefined) body[k] = err[k];
    return res.status(err.status).json(body);
  }
  safeLog('error', '[os] request failed', { path: req.path, requestId: req.requestId, error: err && err.message });
  return res.status(500).json({ error: 'Something went wrong on our side. Nothing was changed unless the history shows it.', requestId: req.requestId || null });
}

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) { sendError(res, req, err); }
};

function workflowView(w) {
  if (!w) return null;
  return {
    id: w.id, templateKey: w.template_key, name: w.name, objective: w.objective, objectiveId: w.objective_id,
    trigger: w.trigger, conditions: w.conditions, steps: w.steps, approvals: w.approvals, policies: w.policies,
    agentPermissions: w.agent_permissions, budget: w.budget, successMetric: w.success_metric, expectedOutcome: w.expected_outcome,
    fallback: w.fallback, stopConditions: w.stop_conditions, status: w.status,
    automationLevel: { level: w.automation_level, label: LEVELS[w.automation_level] },
    source: w.source, discovery: w.discovery, simulation: w.simulation, version: w.version,
    deployedAt: w.deployed_at, decidedReason: w.decided_reason, createdAt: w.created_at, updatedAt: w.updated_at,
    awaiting: w.awaiting, met: w.met, notMet: w.not_met, lastRunAt: w.last_run_at,
  };
}

// pg returns DATE columns as a local-midnight Date; send the calendar date.
function calendarDate(d) {
  if (!d) return null;
  if (!(d instanceof Date)) return String(d).slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function itemView(i) {
  return {
    id: i.id, workflowId: i.workflow_id, workflowName: i.workflow_name, workflowVersion: i.workflow_version, target: i.target_label,
    invoiceIds: i.invoice_ids, amount: Number(i.amount), currency: i.currency, priority: i.priority == null ? null : Number(i.priority),
    context: i.context, draft: i.draft, status: i.status, statusReason: i.status_reason, approval: i.approval, action: i.action,
    agent: i.agent, policy: i.policy, expectedOutcome: i.expected_outcome, actedAt: i.acted_at, verifyAfter: calendarDate(i.verify_after),
    outcomeStatus: i.outcome_status, outcome: i.outcome, verifiedAt: i.verified_at, expiresAt: i.expires_at, createdAt: i.created_at,
  };
}

function objectiveView(o) {
  const e = o.latest || null;
  return {
    id: o.id, name: o.name, metric: o.metric_key, operator: o.operator, target: Number(o.target), horizonDays: o.horizon_days,
    autopilotMode: o.autopilot_mode, templateKey: o.template_key, workflowId: o.workflow_id, status: o.status,
    health: o.last_health || 'UNKNOWN', lastEvaluatedAt: o.last_evaluated_at,
    latest: e ? { health: e.health, currentValue: e.current_value == null ? null : Number(e.current_value), forecast: e.forecast, confidence: e.confidence, evidence: e.evidence, evaluatedAt: e.evaluated_at } : null,
  };
}

function osRouter({ pool, authMiddleware }) {
  const router = express.Router();
  router.use(authMiddleware);

  router.get('/surfaces', wrap(async (req, res) => {
    res.json(await surfaces(pool, uid(req)));
  }));

  // ── Bridge ───────────────────────────────────────────────────────────
  router.get('/bridge', wrap(async (req, res) => {
    const settings = await getSettings(pool, uid(req));
    res.json(await bridgeOverview(pool, uid(req), settings.definitions, {
      externalSendEnabled: isEnabled('external_message_sending_enabled'),
      whatsappConfigured: !!process.env.TWILIO_WHATSAPP_NUMBER,
    }));
  }));

  router.get('/knowledge', wrap(async (req, res) => {
    const rows = await listKnowledge(pool, uid(req), { kind: req.query.kind });
    res.json({ knowledge: rows });
  }));

  router.post('/knowledge', wrap(async (req, res) => {
    const row = await addKnowledge(pool, uid(req), req.body || {}, { actorId: uid(req) });
    res.status(201).json({ knowledge: row, note: row.status === 'QUARANTINED' ? 'Saved but quarantined: it reads like an instruction to Starlane, so it will not be used.' : 'Saved as evidence. Starlane treats it as something a person said, not as a fact.' });
  }));

  router.post('/knowledge/:id/retire', wrap(async (req, res) => {
    wf.assertUuid(req.params.id, 'knowledge item');
    res.json({ knowledge: await retireKnowledge(pool, uid(req), req.params.id, { actorId: uid(req) }) });
  }));

  // ── Scan ─────────────────────────────────────────────────────────────
  router.post('/scan', wrap(async (req, res) => {
    let getSignalImpact = null;
    try { getSignalImpact = require('../domain/intelligence/supplyChainOrchestrator').getSignalImpact; } catch { /* optional */ }
    const result = await runScan(pool, uid(req), { actorId: uid(req), externalSendEnabled: isEnabled('external_message_sending_enabled'), getSignalImpact });
    if (result.status === 'STOPPED') return res.status(423).json({ error: 'Scan is stopped by a kill switch', blockedBy: result.blockedBy });
    res.json(result);
  }));

  router.get('/scan/latest', wrap(async (req, res) => {
    res.json({ scan: await latestScan(pool, uid(req)) });
  }));

  // ── Watch ────────────────────────────────────────────────────────────
  router.get('/objectives/templates', wrap(async (req, res) => {
    res.json({ templates: await objectives.templatesFor(pool, uid(req)) });
  }));

  router.get('/objectives', wrap(async (req, res) => {
    res.json({ objectives: (await objectives.listObjectives(pool, uid(req))).map(objectiveView) });
  }));

  router.post('/objectives', wrap(async (req, res) => {
    const o = await objectives.createObjective(pool, uid(req), req.body || {}, { actorId: uid(req) });
    const evaluated = await objectives.evaluateAndStore(pool, uid(req), o.id, { actorId: uid(req) });
    res.status(201).json(evaluated);
  }));

  router.patch('/objectives/:id', wrap(async (req, res) => {
    res.json({ objective: await objectives.updateObjective(pool, uid(req), req.params.id, req.body || {}, { actorId: uid(req) }) });
  }));

  router.post('/objectives/evaluate', wrap(async (req, res) => {
    res.json({ results: await objectives.evaluateAll(pool, uid(req), { actorId: uid(req) }) });
  }));

  router.post('/objectives/:id/evaluate', wrap(async (req, res) => {
    res.json(await objectives.evaluateAndStore(pool, uid(req), req.params.id, { actorId: uid(req) }));
  }));

  // Morning brief: only what changed or needs someone, each line counted.
  router.get('/watch/brief', wrap(async (req, res) => {
    const userId = uid(req);
    // No catch: if a count cannot be read, the brief fails loudly rather
    // than saying "Nothing needs you" on missing data.
    const one = (sql) => pool.query(sql, [userId]).then((r) => r.rows[0]);
    const [objs, dec, appr, handled, verified] = await Promise.all([
      objectives.listObjectives(pool, userId),
      one(`SELECT COUNT(*)::int AS n FROM decisions WHERE user_id = $1 AND status IN ('OPEN','NEEDS_INFORMATION')`),
      one(`SELECT COUNT(*)::int AS n FROM starlane_workflow_items WHERE user_id = $1 AND status = 'AWAITING_APPROVAL'`),
      one(`SELECT COUNT(*)::int AS n FROM starlane_workflow_items WHERE user_id = $1 AND status = 'SHADOWED' AND created_at > NOW() - INTERVAL '24 hours'`),
      one(`SELECT COUNT(*) FILTER (WHERE outcome_status = 'MET')::int AS met, COUNT(*)::int AS n FROM starlane_workflow_items WHERE user_id = $1 AND verified_at > NOW() - INTERVAL '7 days' AND outcome_status IN ('MET','NOT_MET')`),
    ]);
    const lines = [];
    const flagged = objs.filter((o) => ['AT_RISK', 'OFF_TRACK'].includes(o.last_health));
    for (const o of flagged) lines.push({ kind: 'objective', tone: o.last_health === 'OFF_TRACK' ? 'negative' : 'attention', text: o.latest?.forecast?.explanation || `${o.name} is ${o.last_health.toLowerCase().replace('_', ' ')}.`, objectiveId: o.id });
    const onTrack = objs.filter((o) => o.last_health === 'ON_TRACK').length;
    if (onTrack) lines.push({ kind: 'objective', tone: 'positive', text: `${onTrack} objective${onTrack === 1 ? ' is' : 's are'} on track.` });
    if (handled.n) lines.push({ kind: 'handled', tone: 'neutral', text: `${handled.n} overdue follow-up${handled.n === 1 ? ' was' : 's were'} prepared in shadow mode in the last day. Nothing was sent.` });
    if (verified.n) lines.push({ kind: 'learned', tone: 'neutral', text: `${verified.met} of ${verified.n} follow-ups checked this week ended in a payment.` });
    const needs = (dec.n || 0) + (appr.n || 0);
    lines.push({ kind: 'needs_you', tone: needs ? 'attention' : 'positive', text: needs ? `${dec.n || 0} decision${dec.n === 1 ? '' : 's'} and ${appr.n || 0} reminder approval${appr.n === 1 ? '' : 's'} need you.` : 'Nothing needs you right now.' });
    res.json({ lines, suppressed: { onTrackObjectives: onTrack }, generatedAt: new Date().toISOString() });
  }));

  // ── Simulate: business-level what-if (read-only, never stored) ────────
  router.get('/what-if/sales', wrap(async (req, res) => {
    res.json(await salesChangeWhatIf(pool, uid(req), { changePct: req.query.changePct, days: req.query.days }));
  }));

  // ── Workflows (Prepared + Missions + Simulate) ────────────────────────
  router.get('/workflows', wrap(async (req, res) => {
    const statuses = req.query.status ? String(req.query.status).split(',').map((s) => s.trim().toUpperCase()) : null;
    res.json({ workflows: (await wf.listWorkflows(pool, uid(req), { statuses })).map(workflowView) });
  }));

  router.get('/workflows/items', wrap(async (req, res) => {
    const status = req.query.status ? String(req.query.status).toUpperCase() : undefined;
    const rows = await wf.listItems(pool, uid(req), { status, workflowId: req.query.workflowId, limit: req.query.limit });
    res.json({ items: rows.map(itemView) });
  }));

  router.post('/workflows/items/:id/approve', wrap(async (req, res) => {
    res.json({ item: itemView(await wf.decideItem(pool, uid(req), req.params.id, 'approve', { actorId: uid(req) })) });
  }));

  router.post('/workflows/items/:id/reject', wrap(async (req, res) => {
    res.json({ item: itemView(await wf.decideItem(pool, uid(req), req.params.id, 'reject', { actorId: uid(req) })) });
  }));

  router.post('/workflows/verify', wrap(async (req, res) => {
    res.json(await wf.verifyOutcomes(pool, uid(req), {}));
  }));

  router.post('/workflows/from-text', wrap(async (req, res) => {
    const parsed = parseWorkflowText(req.body?.text);
    if (!parsed.ok) return res.status(422).json({ error: parsed.why, understood: parsed.understood || [], safety: parsed.safety });
    const p = await wf.proposeWorkflow(pool, uid(req), { templateKey: 'receivables_followup', params: parsed.params, source: 'TEXT', sourceRef: { text: String(req.body.text).slice(0, 500) }, createdBy: String(uid(req)) });
    if (p.outcome === 'ALREADY_DEPLOYED') return res.status(409).json({ error: 'An overdue follow-up workflow is already running. Pause or retire it first to replace it.', workflow: workflowView(p.workflow) });
    const simulation = await wf.simulateWorkflow(pool, uid(req), p.workflow.id);
    res.status(201).json({ workflow: workflowView({ ...p.workflow, simulation }), understood: parsed.understood, notes: parsed.notes });
  }));

  router.get('/workflows/:id', wrap(async (req, res) => {
    const w = await wf.getWorkflow(pool, uid(req), req.params.id);
    if (!w) return res.status(404).json({ error: 'workflow not found' });
    const runs = await pool.query('SELECT * FROM starlane_workflow_runs WHERE workflow_id = $1 AND user_id = $2 ORDER BY started_at DESC LIMIT 20', [w.id, uid(req)]);
    res.json({ workflow: workflowView(w), runs: runs.rows, outcomes: await wf.outcomeSummary(pool, uid(req), w.id) });
  }));

  router.post('/workflows/:id/simulate', wrap(async (req, res) => {
    const lookback = Math.min(365, Math.max(30, Number(req.body?.lookbackDays) || 180));
    res.json({ simulation: await wf.simulateWorkflow(pool, uid(req), req.params.id, { lookbackDays: lookback }) });
  }));

  router.post('/workflows/:id/deploy', wrap(async (req, res) => {
    const mode = String(req.body?.mode || '').toUpperCase();
    const action = mode === 'SHADOW' ? 'deploy_shadow' : mode === 'WITH_APPROVAL' ? 'deploy_with_approval' : null;
    if (!action) return res.status(400).json({ error: 'mode must be SHADOW or WITH_APPROVAL. Execute within policy is not available.' });
    res.json({ workflow: workflowView(await wf.transitionWorkflow(pool, uid(req), req.params.id, action, { actorId: uid(req) })) });
  }));

  for (const action of ['pause', 'reject', 'retire']) {
    router.post(`/workflows/:id/${action}`, wrap(async (req, res) => {
      res.json({ workflow: workflowView(await wf.transitionWorkflow(pool, uid(req), req.params.id, action, { actorId: uid(req), reason: req.body?.reason })) });
    }));
  }

  router.put('/workflows/:id/permissions', wrap(async (req, res) => {
    res.json({ workflow: workflowView(await wf.setAgentPermissions(pool, uid(req), req.params.id, req.body?.permissions, { actorId: uid(req) })) });
  }));

  router.post('/workflows/:id/run', wrap(async (req, res) => {
    const out = await wf.runWorkflow(pool, uid(req), req.params.id, { actorId: uid(req), source: 'MANUAL' });
    res.json({ run: out.run, items: out.items.map(itemView) });
  }));

  // ── Missions: everything Starlane is handling, decisions and workflows ──
  router.get('/missions', wrap(async (req, res) => {
    res.json(await missions.listMissions(pool, uid(req)));
  }));

  // ── Today: the few lines a person needs, counted from real rows ───────
  router.get('/today', wrap(async (req, res) => {
    const userId = uid(req);
    const one = (sql) => pool.query(sql, [userId]).then((r) => r.rows[0]?.n ?? 0);
    const settings = await getSettings(pool, userId);
    const [bridge, m, decisionsNeed, approvals, proposals, objectivesActive, objectivesFlagged, watchesActive, invoices] = await Promise.all([
      bridgeOverview(pool, userId, settings.definitions, { externalSendEnabled: isEnabled('external_message_sending_enabled'), whatsappConfigured: !!process.env.TWILIO_WHATSAPP_NUMBER }),
      missions.listMissions(pool, userId),
      one(`SELECT COUNT(*)::int AS n FROM decisions WHERE user_id = $1 AND status IN ('OPEN','NEEDS_INFORMATION')`),
      one(`SELECT COUNT(*)::int AS n FROM starlane_workflow_items WHERE user_id = $1 AND status = 'AWAITING_APPROVAL'`),
      one(`SELECT COUNT(*)::int AS n FROM starlane_workflows WHERE user_id = $1 AND status = 'PROPOSED'`),
      one(`SELECT COUNT(*)::int AS n FROM starlane_objectives WHERE user_id = $1 AND status = 'ACTIVE'`),
      one(`SELECT COUNT(*)::int AS n FROM starlane_objectives WHERE user_id = $1 AND status = 'ACTIVE' AND last_health IN ('AT_RISK','OFF_TRACK')`),
      one(`SELECT COUNT(*)::int AS n FROM watches WHERE user_id = $1 AND status = 'active'`),
      one('SELECT COUNT(*)::int AS n FROM invoices WHERE user_id = $1'),
    ]);
    const plural = (n, one1, many) => `${n} ${n === 1 ? one1 : many}`;
    const needsYou = (decisionsNeed || 0) + (approvals || 0) + (proposals || 0);
    const running = m.missions.filter((x) => ['PLANNING', 'RUNNING', 'VERIFYING', 'WAITING_FOR_APPROVAL', 'WAITING_FOR_INFORMATION', 'BLOCKED'].includes(x.state));
    const blocked = m.missions.filter((x) => ['BLOCKED', 'FAILED'].includes(x.state));
    const sourcesAttention = bridge.connectors.filter((c) => ['STALE', 'DEGRADED', 'FAILED', 'AUTH_EXPIRED', 'DISCONNECTED', 'RATE_LIMITED'].includes(c.health));
    const watching = (objectivesActive || 0) + (watchesActive || 0);
    const lines = [];
    if (!invoices) {
      lines.push({ key: 'connect', tone: 'attention', text: 'Starlane has no business data yet. Upload a receivables file or connect Tally to begin.', href: '/bridge' });
    } else {
      const parts = [];
      if (decisionsNeed) parts.push(plural(decisionsNeed, 'decision', 'decisions'));
      if (approvals) parts.push(plural(approvals, 'prepared reminder', 'prepared reminders'));
      if (proposals) parts.push(plural(proposals, 'automation proposal', 'automation proposals'));
      lines.push(needsYou
        ? { key: 'needs_you', tone: 'attention', text: `${parts.join(', ')} ${needsYou === 1 ? 'needs' : 'need'} you.`, href: '/prepared' }
        : { key: 'needs_you', tone: 'positive', text: 'Nothing needs you right now.', href: '/prepared' });
      if (running.length) lines.push({ key: 'missions', tone: blocked.length ? 'attention' : 'neutral', text: `${plural(running.length, 'mission is', 'missions are')} being handled${blocked.length ? `; ${blocked.length} ${blocked.length === 1 ? 'is' : 'are'} blocked` : ''}.`, href: '/missions' });
      if (sourcesAttention.length) lines.push({ key: 'sources', tone: 'attention', text: `${plural(sourcesAttention.length, 'source needs', 'sources need')} attention: ${sourcesAttention.map((c) => `${c.name} is ${c.health.toLowerCase().replace('_', ' ')}`).join('; ')}.`, href: '/bridge' });
      if (watching) lines.push({ key: 'watching', tone: objectivesFlagged ? 'attention' : 'neutral', text: `${plural(watching, 'thing is', 'things are')} being watched${objectivesFlagged ? `; ${plural(objectivesFlagged, 'objective is', 'objectives are')} at risk or off track` : ''}.`, href: '/watch' });
      lines.push({ key: 'stable', tone: 'neutral', text: 'Everything else is stable.' });
    }
    res.json({
      lines,
      counts: { decisionsNeedYou: decisionsNeed, approvals, proposals, missionsActive: running.length, missionsBlocked: blocked.length, sourcesNeedAttention: sourcesAttention.length, watching, objectivesFlagged, invoices },
      pilotMode: settings.pilotMode,
      generatedAt: new Date().toISOString(),
    });
  }));

  // ── Agents: the workers that really run, with permissions and results ─
  router.get('/agents', wrap(async (req, res) => {
    res.json(await listAgents(pool, uid(req)));
  }));

  // ── Funnel and value metrics (read from rows the product writes) ──────
  router.get('/funnel', wrap(async (req, res) => {
    res.json(await funnelOf(pool, uid(req)));
  }));

  // ── Memory ───────────────────────────────────────────────────────────
  router.get('/memory', wrap(async (req, res) => {
    const userId = uid(req);
    const workflows = await wf.listWorkflows(pool, userId);
    const outcomes = [];
    for (const w of workflows) {
      const s = await wf.outcomeSummary(pool, userId, w.id);
      if (Object.keys(s).length) outcomes.push({ workflowId: w.id, name: w.name, status: w.status, byMode: s });
    }
    const [resolved, knowledge, decisions] = await Promise.all([
      wf.listItems(pool, userId, { limit: 50 }).then((rows) => rows.filter((r) => ['MET', 'NOT_MET', 'UNKNOWN'].includes(r.outcome_status)).map(itemView)),
      listKnowledge(pool, userId, {}),
      pool.query(`SELECT status, COUNT(*)::int AS n FROM decision_contracts WHERE user_id = $1 GROUP BY status`, [userId]).then((r) => r.rows).catch(() => []),
    ]);
    const byKind = {};
    for (const k of knowledge) (byKind[k.kind] = byKind[k.kind] || []).push(k);
    res.json({ outcomes, recentOutcomes: resolved, knowledge: byKind, decisionContracts: decisions });
  }));

  return router;
}

module.exports = { osRouter };
