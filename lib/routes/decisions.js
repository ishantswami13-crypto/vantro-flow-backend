'use strict';
// lib/routes/decisions.js — the Starlane decision loop over HTTP.
//
//   discover -> inbox/today -> decision detail (evidence, options, futures,
//   stress, sensitivity, unknowns) -> what-if -> request information /
//   observations -> select (contract) -> approve -> execute (shadow or live,
//   through the Action Fabric) -> verify -> track record / backtest.
//
// Mounted from server.js with its pool and authMiddleware. Every handler
// takes the tenant from the verified JWT (req.user.userId) and never from
// the request body or query.

const express = require('express');
const { isEnabled } = require('../featureFlags');
const { safeLog } = require('../observability/logger');
const { runDiscovery, loadRawReceivables } = require('../domain/decisions/discovery');
const { getDecision, listDecisions, listEvents, AGENT, ACTIVE_STATUSES } = require('../domain/decisions/store');
const lifecycle = require('../domain/decisions/lifecycle');
const { verifyContract, trackRecord } = require('../domain/decisions/verification');
const { runBacktest } = require('../domain/decisions/backtest');
const controls = require('../domain/decisions/controls');
const { intelligenceHealth, calibrationSummary } = require('../domain/decisions/sourceHealth');
const { deriveReceivablesState } = require('../domain/decisions/snapshot');
const { discoverReceivableDecisions } = require('../domain/decisions/detectors/receivables');
const { detectDecisionContradictions } = require('../domain/decisions/contradictions');

function authenticatedUserId(req) {
  return req.user?.userId || req.user?.id || null;
}

function externalSendEnabled() {
  return isEnabled('external_message_sending_enabled');
}

function signalImpactLoader() {
  try {
    return require('../domain/intelligence/supplyChainOrchestrator').getSignalImpact;
  } catch {
    return null;
  }
}

const PUBLIC_EXTRA = ['blockedBy', 'checks', 'replanRequired', 'failedStep', 'compensated', 'decisionStatus'];

function sendError(res, req, err) {
  if (err && err.status && err.status < 500 && err.status >= 400) {
    const body = { error: err.message };
    for (const k of PUBLIC_EXTRA) if (err[k] !== undefined) body[k] = err[k];
    return res.status(err.status).json(body);
  }
  if (err && err.status === 502) {
    const body = { error: err.message };
    for (const k of PUBLIC_EXTRA) if (err[k] !== undefined) body[k] = err[k];
    return res.status(502).json(body);
  }
  safeLog('error', '[decisions] request failed', { path: req.path, requestId: req.requestId, error: err && err.message });
  return res.status(500).json({ error: 'Something went wrong on our side. Nothing was changed by this request unless the decision history shows it.', requestId: req.requestId || null });
}

function ctxOf(req) {
  return { correlationId: req.requestId || null };
}

function decisionView(d) {
  if (!d) return null;
  return {
    id: d.id,
    kind: d.kind,
    title: d.title,
    description: d.description,
    status: d.status,
    revision: d.revision,
    currency: d.currency,
    asOf: d.as_of,
    discoveredAt: d.discovered_at,
    updatedAt: d.updated_at,
    window: d.decision_window,
    deadline: d.decision_deadline,
    whyNow: d.why_now,
    whatIfIgnored: d.what_if_ignored,
    triggers: d.trigger_signals,
    affectedEntities: d.affected_entities,
    affectedProcesses: d.affected_processes,
    objectives: d.objectives,
    constraints: d.constraints,
    options: d.options,
    doNothingKey: d.do_nothing_option,
    evidence: d.evidence,
    unknowns: d.unknowns,
    assumptions: d.assumptions,
    contradictions: d.contradictions,
    expectedValue: d.expected_value == null ? null : Number(d.expected_value),
    downsideRisk: d.downside_risk == null ? null : Number(d.downside_risk),
    upsidePotential: d.upside_potential == null ? null : Number(d.upside_potential),
    reversibility: d.reversibility,
    blastRadius: d.blast_radius,
    urgency: d.urgency == null ? null : Number(d.urgency),
    materiality: d.materiality,
    confidence: d.confidence,
    attentionScore: d.attention_score == null ? null : Number(d.attention_score),
    recommendation: d.recommendation,
    approvalPolicy: d.approval_policy,
    selectedOption: d.selected_option,
    informationRequests: d.information_requests,
    collisions: d.collisions,
    analysis: d.analysis,
    definitions: d.definitions,
    modelVersions: d.model_versions,
    resolutionReason: d.resolution_reason,
    resolvedAt: d.resolved_at,
  };
}

function listView(d) {
  return {
    id: d.id,
    kind: d.kind,
    title: d.title,
    description: d.description,
    status: d.status,
    currency: d.currency,
    deadline: d.decision_deadline,
    window: d.decision_window,
    whyNow: d.why_now,
    expectedValue: d.expected_value == null ? null : Number(d.expected_value),
    urgency: d.urgency == null ? null : Number(d.urgency),
    materiality: d.materiality,
    confidence: d.confidence,
    attentionScore: d.attention_score == null ? null : Number(d.attention_score),
    recommendation: d.recommendation ? { key: d.recommendation.key, label: d.recommendation.label, informationFirst: !!d.recommendation.informationFirst } : null,
    selectedOption: d.selected_option,
    collisions: d.collisions,
    discoveredAt: d.discovered_at,
    updatedAt: d.updated_at,
    revision: d.revision,
  };
}

async function lastDiscovery(pool, userId) {
  const r = await pool.query(
    `SELECT status, finished_at, output_json, error_text FROM agent_runs WHERE user_id = $1 AND agent_key = $2 ORDER BY started_at DESC LIMIT 1`,
    [userId, AGENT.key]
  );
  const row = r.rows[0];
  if (!row) return null;
  return { at: row.finished_at, status: row.status, summary: row.output_json, degraded: row.error_text ? true : false };
}

function decisionsRouter({ pool, authMiddleware }) {
  const router = express.Router();
  router.use(authMiddleware);

  // ── Discovery and inbox ───────────────────────────────────────────────
  router.post('/discover', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const result = await runDiscovery(pool, userId, {
        onBehalfOf: userId,
        correlationId: req.requestId || null,
        externalSendEnabled: externalSendEnabled(),
        getSignalImpact: signalImpactLoader(),
      });
      if (result.status === 'STOPPED') return res.status(423).json({ error: 'Decision discovery is stopped by a kill switch', blockedBy: result.blockedBy });
      res.json(result);
    } catch (err) {
      sendError(res, req, err);
    }
  });

  router.get('/', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const scope = String(req.query.scope || 'active');
      const statuses = scope === 'all' ? null : scope === 'closed' ? ['VERIFIED', 'REJECTED', 'EXPIRED', 'RESOLVED', 'SUPERSEDED'] : ACTIVE_STATUSES;
      const rows = await listDecisions(pool, userId, { statuses, limit: req.query.limit });
      res.json({ decisions: rows.map(listView), lastDiscovery: await lastDiscovery(pool, userId) });
    } catch (err) {
      sendError(res, req, err);
    }
  });

  router.get('/today', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const settings = await controls.getSettings(pool, userId);
      const [rows, stops, raw, last, contracts] = await Promise.all([
        listDecisions(pool, userId, { statuses: ACTIVE_STATUSES, limit: 100 }),
        controls.checkStops(pool, userId, { agentKey: AGENT.key }),
        loadRawReceivables(pool, userId),
        lastDiscovery(pool, userId),
        pool.query(`SELECT status, COUNT(*)::int AS n FROM decision_contracts WHERE user_id = $1 AND status IN ('ACTIVE','ON_TRACK','OFF_TRACK') GROUP BY status`, [userId]),
      ]);
      const state = deriveReceivablesState(raw, new Date().toISOString(), { mode: 'live', baseCurrency: settings.definitions.base_currency });
      const health = await intelligenceHealth(pool, userId, settings.definitions, { quality: state.quality, settings, stops, externalSendEnabled: externalSendEnabled() });
      const now = Date.now();
      const weekAhead = now + 7 * 86400000;
      const atStake = {};
      for (const d of rows) {
        const cur = d.currency || settings.definitions.base_currency;
        const v = Number(d.materiality?.expectedUncollected90 ?? d.materiality?.workingCapitalTiedUp ?? d.materiality?.revenueExposure ?? 0);
        if (['OPEN', 'NEEDS_INFORMATION', 'SELECTED', 'APPROVED'].includes(d.status)) atStake[cur] = Math.round((atStake[cur] || 0) + v);
      }
      const contractCounts = Object.fromEntries(contracts.rows.map((r) => [r.status, r.n]));
      res.json({
        asOf: new Date(now).toISOString(),
        lastDiscovery: last,
        command: {
          open: rows.filter((d) => d.status === 'OPEN').length,
          needsInformation: rows.filter((d) => d.status === 'NEEDS_INFORMATION').length,
          awaitingApproval: rows.filter((d) => d.status === 'SELECTED').length,
          readyToRun: rows.filter((d) => d.status === 'APPROVED').length,
          underWatch: rows.filter((d) => ['SHADOWED', 'EXECUTED'].includes(d.status)).length,
          deadlinesThisWeek: rows.filter((d) => d.decision_deadline && new Date(d.decision_deadline).getTime() <= weekAhead && ['OPEN', 'NEEDS_INFORMATION', 'SELECTED', 'APPROVED'].includes(d.status)).length,
          offTrack: contractCounts.OFF_TRACK || 0,
          expectedUncollectedIfIgnored: atStake,
        },
        top: rows.filter((d) => ['OPEN', 'NEEDS_INFORMATION', 'SELECTED', 'APPROVED'].includes(d.status)).slice(0, 5).map(listView),
        receivables: { totalsByCurrency: state.totalsByCurrency, invoices: state.quality.invoicesInScope },
        health,
        pilotMode: settings.pilotMode,
        externalSendEnabled: externalSendEnabled(),
        stops,
      });
    } catch (err) {
      sendError(res, req, err);
    }
  });

  // ── Control plane (declared before /:id) ──────────────────────────────
  router.get('/controls', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const [settings, list, stops] = await Promise.all([
        controls.getSettings(pool, userId),
        controls.listControls(pool, userId),
        controls.checkStops(pool, userId, { agentKey: AGENT.key }),
      ]);
      res.json({
        pilotMode: settings.pilotMode,
        pilotModeIsDefault: settings.pilotModeIsDefault,
        autonomyCeiling: settings.autonomyCeiling,
        externalSendEnabled: externalSendEnabled(),
        globalStop: String(process.env.STARLANE_GLOBAL_STOP || '').toLowerCase() === 'true',
        controls: list,
        effective: stops,
        agent: AGENT,
        scopes: controls.SCOPES,
      });
    } catch (err) {
      sendError(res, req, err);
    }
  });

  router.post('/controls', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const body = req.body || {};
      let out = {};
      if (body.pilotMode !== undefined) {
        out.settings = await controls.setPilotMode(pool, userId, String(body.pilotMode).toUpperCase(), userId);
        safeLog('info', '[decisions] pilot mode changed', { userId, pilotMode: out.settings.pilotMode, requestId: req.requestId });
      }
      if (body.scope !== undefined) {
        out.control = await controls.setControl(pool, userId, { scope: String(body.scope).toUpperCase(), scopeKey: body.scopeKey, stopped: body.stopped === true, reason: body.reason }, userId);
        safeLog('info', '[decisions] kill switch changed', { userId, scope: out.control.scope, key: out.control.scope_key, stopped: out.control.stopped, requestId: req.requestId });
      }
      if (!out.settings && !out.control) return res.status(400).json({ error: 'Send pilotMode and/or scope, scopeKey, stopped' });
      res.json(out);
    } catch (err) {
      sendError(res, req, err);
    }
  });

  router.get('/definitions', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const settings = await controls.getSettings(pool, userId);
      const versions = await pool.query('SELECT version, definitions, created_by, created_at FROM starlane_definition_versions WHERE user_id = $1 ORDER BY version DESC LIMIT 20', [userId]);
      res.json({ label: settings.definitionsLabel, effective: settings.definitions, overrides: settings.definitionsOverrides, history: versions.rows });
    } catch (err) {
      sendError(res, req, err);
    }
  });

  router.put('/definitions', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const settings = await controls.setDefinitions(pool, userId, req.body || {}, userId);
      res.json({ label: settings.definitionsLabel, effective: settings.definitions, overrides: settings.definitionsOverrides });
    } catch (err) {
      sendError(res, req, err);
    }
  });

  router.get('/calibration', async (req, res) => {
    try {
      res.json(await calibrationSummary(pool, authenticatedUserId(req)));
    } catch (err) {
      sendError(res, req, err);
    }
  });

  router.get('/track-record', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const [record, calibration] = await Promise.all([trackRecord(pool, userId), calibrationSummary(pool, userId)]);
      res.json({ ...record, calibration });
    } catch (err) {
      sendError(res, req, err);
    }
  });

  router.post('/backtest', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const body = req.body || {};
      const cutoffs = Array.isArray(body.cutoffs) ? body.cutoffs.map(String).slice(0, 12) : undefined;
      res.json(await runBacktest(pool, userId, { cutoffs, horizonDays: body.horizonDays }));
    } catch (err) {
      sendError(res, req, err);
    }
  });

  // ── One decision ──────────────────────────────────────────────────────
  async function loadOr404(req, res) {
    const d = await getDecision(pool, authenticatedUserId(req), req.params.id);
    if (!d) {
      res.status(404).json({ error: 'Decision not found' });
      return null;
    }
    return d;
  }

  router.get('/:id', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const d = await loadOr404(req, res);
      if (!d) return;
      const [events, contracts, runs] = await Promise.all([
        listEvents(pool, userId, d.id),
        pool.query('SELECT * FROM decision_contracts WHERE decision_id = $1 AND user_id = $2 ORDER BY created_at DESC', [d.id, userId]),
        pool.query('SELECT * FROM decision_action_runs WHERE decision_id = $1 AND user_id = $2 ORDER BY created_at ASC, step_index ASC', [d.id, userId]),
      ]);
      const settings = await controls.getSettings(pool, userId);
      res.json({
        decision: decisionView(d),
        contract: contracts.rows.find((c) => c.status !== 'SUPERSEDED') || null,
        contracts: contracts.rows,
        runs: runs.rows,
        observations: events.filter((e) => e.event_type === 'HUMAN_OBSERVATION').map((e) => ({ id: e.id, text: e.payload.text, confidence: e.payload.confidence, author: e.actor_id, at: e.created_at, trust: e.payload.trust })),
        events: events.map((e) => ({ id: e.id, type: e.event_type, actor: { type: e.actor_type, id: e.actor_id, onBehalfOf: e.on_behalf_of, agentKey: e.agent_key, agentVersion: e.agent_version, model: e.model }, payload: e.payload, policy: e.policy, at: e.created_at })),
        pilotMode: settings.pilotMode,
        externalSendEnabled: externalSendEnabled(),
      });
    } catch (err) {
      sendError(res, req, err);
    }
  });

  router.get('/:id/evidence', async (req, res) => {
    try {
      const d = await loadOr404(req, res);
      if (!d) return;
      const events = await listEvents(pool, authenticatedUserId(req), d.id);
      res.json({
        evidence: d.evidence,
        unknowns: d.unknowns,
        assumptions: d.assumptions,
        contradictions: d.contradictions,
        observations: events.filter((e) => e.event_type === 'HUMAN_OBSERVATION').map((e) => ({ text: e.payload.text, confidence: e.payload.confidence, at: e.created_at, trust: e.payload.trust })),
        definitions: d.definitions,
        modelVersions: d.model_versions,
        method: d.analysis?.method || null,
      });
    } catch (err) {
      sendError(res, req, err);
    }
  });

  router.get('/:id/outcomes', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const d = await loadOr404(req, res);
      if (!d) return;
      const contracts = await pool.query('SELECT id, selected_option, mode, status, expected_outcomes, success_criteria, failure_criteria, abort_conditions, review_at, activated_at, verification, regret, attribution FROM decision_contracts WHERE decision_id = $1 AND user_id = $2 ORDER BY created_at DESC', [d.id, userId]);
      const ids = contracts.rows.map((c) => c.id);
      const preds = ids.length
        ? await pool.query(`SELECT entity_id, target, horizon_days, point_estimate, lower_bound, upper_bound, evaluation_status, actual_value, coverage_hit, as_of, resolved_at FROM predictions WHERE user_id = $1 AND entity_type = 'decision_contract' AND entity_id = ANY($2) ORDER BY horizon_days, target`, [userId, ids])
        : { rows: [] };
      res.json({ contracts: contracts.rows, predictions: preds.rows });
    } catch (err) {
      sendError(res, req, err);
    }
  });

  router.get('/:id/audit', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const d = await loadOr404(req, res);
      if (!d) return;
      const [events, runs] = await Promise.all([
        listEvents(pool, userId, d.id),
        pool.query('SELECT id, step_index, intent_type, adapter, connector, mode, status, preconditions, would_have, result, postcondition, rollback, ai_action_id, delegation_chain, error, created_at, updated_at FROM decision_action_runs WHERE decision_id = $1 AND user_id = $2 ORDER BY created_at, step_index', [d.id, userId]),
      ]);
      res.json({ events, runs: runs.rows });
    } catch (err) {
      sendError(res, req, err);
    }
  });

  // What-if: re-run the simulation for this decision with some assumptions
  // pinned. Read-only; nothing is persisted.
  router.post('/:id/simulate', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const d = await loadOr404(req, res);
      if (!d) return;
      if (d.kind !== 'RECEIVABLE_RISK') return res.status(422).json({ error: 'What-if simulation is available for receivable decisions. Other kinds show their stress and sensitivity analysis instead.' });
      const body = req.body || {};
      const allowed = new Map();
      for (const o of d.options || []) for (const a of o.assumptions || []) allowed.set(a.key, a.range);
      const fixedParams = {};
      for (const [k, v] of Object.entries(body.assumptions || {})) {
        if (!allowed.has(k)) return res.status(400).json({ error: `Unknown assumption ${k}` });
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 5) return res.status(400).json({ error: `${k} must be a number between 0 and 5` });
        fixedParams[k] = n;
      }
      let fixedShock = null;
      if (body.paymentSpeed !== undefined) {
        fixedShock = Number(body.paymentSpeed);
        if (!Number.isFinite(fixedShock) || fixedShock < 0.1 || fixedShock > 3) return res.status(400).json({ error: 'paymentSpeed must be between 0.1 and 3' });
      }
      const settings = await controls.getSettings(pool, userId);
      const raw = await loadRawReceivables(pool, userId);
      const state = deriveReceivablesState(raw, new Date().toISOString(), { mode: 'live', baseCurrency: settings.definitions.base_currency });
      const customer = (d.affected_entities || []).find((e) => e.type === 'customer');
      const out = discoverReceivableDecisions(state, settings.definitions, {
        externalSendEnabled: externalSendEnabled(),
        contradictionsByInvoice: detectDecisionContradictions(state),
        fullAnalysis: false,
        only: { customerKey: customer?.key, currency: d.currency },
        whatIf: { fixedParams, fixedShock },
      });
      const draft = out.drafts[0];
      if (!draft) return res.status(409).json({ error: 'This situation no longer meets the decision criteria (it may have been paid or fallen below materiality). Refresh decisions.' });
      res.json({
        pinned: { assumptions: fixedParams, paymentSpeed: fixedShock },
        options: draft.options.map((o) => ({ key: o.key, label: o.label, valid: o.valid, futures: o.futures })),
        recommendation: { key: draft.recommendation.key, label: draft.recommendation.label, changed: draft.recommendation.key !== d.recommendation?.key },
        baselineRecommendation: d.recommendation?.key || null,
        persisted: false,
      });
    } catch (err) {
      sendError(res, req, err);
    }
  });

  router.post('/:id/request-information', async (req, res) => {
    try {
      const body = req.body || {};
      res.json(await lifecycle.requestInformation(pool, authenticatedUserId(req), req.params.id, { unknownKey: body.unknownKey, note: body.note }, ctxOf(req)));
    } catch (err) {
      sendError(res, req, err);
    }
  });

  router.post('/:id/observations', async (req, res) => {
    try {
      const body = req.body || {};
      res.status(201).json(await lifecycle.addObservation(pool, authenticatedUserId(req), req.params.id, { text: body.text, confidence: body.confidence }, ctxOf(req)));
    } catch (err) {
      sendError(res, req, err);
    }
  });

  router.post('/:id/select', async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.optionKey || typeof body.optionKey !== 'string') return res.status(400).json({ error: 'optionKey is required' });
      res.json(await lifecycle.selectOption(pool, authenticatedUserId(req), req.params.id, { optionKey: body.optionKey, note: body.note }, ctxOf(req)));
    } catch (err) {
      sendError(res, req, err);
    }
  });

  router.post('/:id/approve', async (req, res) => {
    try {
      res.json(await lifecycle.approveDecision(pool, authenticatedUserId(req), req.params.id, { note: (req.body || {}).note }, ctxOf(req)));
    } catch (err) {
      sendError(res, req, err);
    }
  });

  router.post('/:id/execute', async (req, res) => {
    try {
      res.json(await lifecycle.executeDecision(pool, authenticatedUserId(req), req.params.id, { authorizeLive: (req.body || {}).authorizeLive === true }, ctxOf(req)));
    } catch (err) {
      sendError(res, req, err);
    }
  });

  router.post('/:id/reject', async (req, res) => {
    try {
      res.json(await lifecycle.rejectDecision(pool, authenticatedUserId(req), req.params.id, { reason: (req.body || {}).reason }, ctxOf(req)));
    } catch (err) {
      sendError(res, req, err);
    }
  });

  router.post('/:id/verify', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const d = await loadOr404(req, res);
      if (!d) return;
      res.json(await verifyContract(pool, userId, d.id, { correlationId: req.requestId || null, onBehalfOf: userId }));
    } catch (err) {
      sendError(res, req, err);
    }
  });

  return router;
}

module.exports = { decisionsRouter, decisionView };
