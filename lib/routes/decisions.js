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
const { intelligenceHealth, calibrationSummary, receivablesFreshness } = require('../domain/decisions/sourceHealth');
const { deriveReceivablesState } = require('../domain/decisions/snapshot');
const { discoverReceivableDecisions } = require('../domain/decisions/detectors/receivables');
const { detectDecisionContradictions } = require('../domain/decisions/contradictions');
const { findSimilarDecisions } = require('../domain/decisions/similar');
const { previewLedger, commitLedger, profileLedger } = require('../domain/decisions/ledgerImport');
const { appendEvent, humanActor } = require('../domain/decisions/store');
const multer = require('multer');
const missions = require('../domain/os/missions');

const ledgerUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

// What a pilot user can tell Starlane about a decision (PHASE 73). Stored as
// append-only decision_events so feedback is part of the audit trail.
const FEEDBACK_KINDS = {
  USEFUL: 'Useful',
  MATTERS: 'This decision matters',
  ALREADY_KNEW: 'Already knew this',
  NOT_IMPORTANT: 'Not important',
  WRONG: 'Wrong',
  MISSING_CONTEXT: 'Missing context',
  OPTION_IMPOSSIBLE: 'This option is impossible',
};

function parseImportOptions(req) {
  if (!req.body || req.body.options == null || req.body.options === '') return null;
  if (typeof req.body.options === 'object') return req.body.options;
  try { return JSON.parse(req.body.options); } catch { const e = new Error('options must be JSON'); e.status = 400; throw e; }
}

function humanDate(iso) {
  if (!iso) return '';
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// "What Starlane found", written only from counts and decisions that exist.
// When a blocking gap exists it leads, because "nothing needs you" would be
// a claim Starlane cannot support (insufficient information, not all clear).
function firstLook(profile, discovery, active) {
  const lines = [];
  const c = profile.counts;
  if (c.invoices) {
    lines.push(`I read ${c.invoices} invoice${c.invoices === 1 ? '' : 's'} from ${c.customers} customer${c.customers === 1 ? '' : 's'}${profile.period.historyDays ? `, covering ${profile.period.historyDays} days (${humanDate(profile.period.from)} to ${humanDate(profile.period.to)})` : ''}.`);
  }
  const needYou = active.filter((d) => ['OPEN', 'NEEDS_INFORMATION'].includes(d.status));
  const watchedItems = discovery && Array.isArray(discovery.watched) ? discovery.watched : [];
  const balances = watchedItems.filter((w) => w.customer);
  const blocking = profile.limitations.filter((l) => l.severity === 'blocking');
  if (!discovery) lines.push('Decision discovery did not run, so nothing has been analysed yet.');
  else if (discovery.status === 'DEGRADED') lines.push('Part of the analysis failed, so these results may be incomplete.');
  if (blocking.length && needYou.length === 0) {
    lines.push(`I don't have enough information to say whether anything needs a decision. ${blocking.map((l) => l.message).join(' ')}`);
  } else if (discovery && needYou.length === 0) {
    lines.push('No material decision currently requires attention.');
  } else if (needYou.length) {
    lines.push(`${needYou.length} decision${needYou.length === 1 ? ' needs' : 's need'} you.`);
  }
  if (balances.length) lines.push(`I'm watching ${balances.length} balance${balances.length === 1 ? '' : 's'} that ${balances.length === 1 ? 'is' : 'are'} too small or disputed to act on.`);
  if (blocking.length && needYou.length) lines.push(`Some things are hidden from me: ${blocking.map((l) => l.message).join(' ')}`);
  return { lines, needYou: needYou.length, watched: watchedItems.length, watchedBalances: balances.length, insufficientInformation: blocking.length > 0 && needYou.length === 0, top: needYou.slice(0, 3).map(listView), limitations: profile.limitations };
}

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

const PUBLIC_EXTRA = ['staleData', 'freshness', 'blockedBy', 'checks', 'replanRequired', 'failedStep', 'compensated', 'decisionStatus'];

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

  // ── Bring your own data: ledger import + data profile ─────────────────
  // Preview writes nothing and returns the proposed column mapping, what
  // needs a human's confirmation, and what the file would give Starlane.
  router.post('/import/preview', ledgerUpload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Attach the file as "file".' });
      const settings = await controls.getSettings(pool, authenticatedUserId(req));
      const out = previewLedger(req.file.buffer, req.file.originalname, { baseCurrency: settings.definitions.base_currency, mappingInput: parseImportOptions(req) });
      if (!out.ok) return res.status(400).json({ error: out.error });
      res.json(out);
    } catch (err) {
      sendError(res, req, err);
    }
  });

  // Commit uses only the mapping the caller sends (the one a human saw and
  // confirmed), then runs discovery so the first answer is a finding, not
  // "import successful".
  router.post('/import/commit', ledgerUpload.single('file'), async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      if (!req.file) return res.status(400).json({ error: 'Attach the file as "file".' });
      const options = parseImportOptions(req);
      if (!options) return res.status(400).json({ error: 'Send the confirmed column mapping as "options".' });
      const settings = await controls.getSettings(pool, userId);
      const imported = await commitLedger(pool, userId, req.file.buffer, req.file.originalname, options, { baseCurrency: settings.definitions.base_currency });
      if (!imported.ok) return res.status(imported.status || 400).json({ error: imported.error, errors: imported.errors || [] });
      let discovery = null;
      let discoveryError = null;
      try {
        discovery = await runDiscovery(pool, userId, {
          onBehalfOf: userId,
          correlationId: req.requestId || null,
          externalSendEnabled: externalSendEnabled(),
          getSignalImpact: signalImpactLoader(),
        });
        if (discovery.status === 'STOPPED') { discoveryError = 'Decision discovery is stopped by a kill switch.'; discovery = null; }
      } catch (err) {
        discoveryError = 'Decision discovery failed after the import. The data was saved; run discovery again from Decisions.';
        safeLog('error', '[decisions] discovery after import failed', { userId, error: err.message });
      }
      const raw = await loadRawReceivables(pool, userId);
      const profile = profileLedger(raw.invoices, { baseCurrency: settings.definitions.base_currency });
      const active = await listDecisions(pool, userId, { statuses: ACTIVE_STATUSES, limit: 50 });
      res.json({
        import: { batchId: imported.batchId, alreadyImported: imported.alreadyImported, counts: imported.counts, fileProfile: imported.profile || null },
        profile,
        discovery: discovery ? { status: discovery.status, discovered: discovery.discovered, revised: discovery.revised, resolved: discovery.resolved, watched: discovery.watched, degraded: discovery.degraded } : null,
        discoveryError,
        firstLook: firstLook(profile, discovery, active),
      });
    } catch (err) {
      sendError(res, req, err);
    }
  });

  // What Starlane has for this tenant right now, and what that limits.
  router.get('/data-profile', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const settings = await controls.getSettings(pool, userId);
      const [raw, freshness, batches] = await Promise.all([
        loadRawReceivables(pool, userId),
        receivablesFreshness(pool, userId, settings.definitions),
        pool.query(`SELECT filename, status, completed_at, rows_total, rows_accepted, rows_rejected FROM file_import_batches WHERE user_id = $1 AND source_system = 'ledger_import' ORDER BY created_at DESC LIMIT 5`, [userId]),
      ]);
      const profile = profileLedger(raw.invoices, { baseCurrency: settings.definitions.base_currency });
      const bySource = {};
      for (const inv of raw.invoices) { const k = inv.source_type || 'manual'; bySource[k] = (bySource[k] || 0) + 1; }
      res.json({ ...profile, freshness, sources: bySource, recentImports: batches.rows });
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
  // Product funnel (directive §131): the first time a person opens a decision
  // or inspects its evidence is recorded on the append-only trail. Only the
  // first time, so the trail stays readable. A failure is logged and never
  // fails the request.
  function recordFirst(userId, decisionId, type) {
    return pool.query(
      `INSERT INTO decision_events (user_id, decision_id, event_type, actor_type, actor_id, payload)
       SELECT $1::uuid, $2::uuid, $3::text, 'human', $4::text, '{}'::jsonb
       WHERE NOT EXISTS (SELECT 1 FROM decision_events WHERE user_id = $1::uuid AND decision_id = $2::uuid AND event_type = $3::text)`,
      [userId, decisionId, type, String(userId)]
    ).catch((err) => safeLog('warn', '[decisions] funnel event not recorded', { type, error: err.message }));
  }

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
      await recordFirst(userId, d.id, 'DECISION_OPENED');
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
      await recordFirst(authenticatedUserId(req), d.id, 'EVIDENCE_VIEWED');
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

  // Similar-decision memory: earlier decisions like this one and how they ended.
  router.get('/:id/similar', async (req, res) => {
    try {
      const d = await loadOr404(req, res);
      if (!d) return;
      res.json(await findSimilarDecisions(pool, authenticatedUserId(req), d));
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
  router.post('/:id/feedback', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const kind = String(req.body?.kind || '');
      if (!FEEDBACK_KINDS[kind]) return res.status(400).json({ error: `kind must be one of ${Object.keys(FEEDBACK_KINDS).join(', ')}` });
      const decision = await getDecision(pool, userId, req.params.id);
      if (!decision) return res.status(404).json({ error: 'Decision not found' });
      const note = req.body?.note == null ? null : String(req.body.note).slice(0, 1000);
      const optionKey = req.body?.optionKey == null ? null : String(req.body.optionKey).slice(0, 60);
      if (optionKey && !(decision.options || []).some((o) => o.key === optionKey)) return res.status(400).json({ error: 'optionKey is not an option on this decision' });
      await appendEvent(pool, { userId, decisionId: decision.id, type: 'HUMAN_FEEDBACK', actor: humanActor(userId), payload: { kind, label: FEEDBACK_KINDS[kind], note, optionKey, revision: decision.revision }, correlationId: req.requestId || null });
      res.status(201).json({ recorded: true, kind, label: FEEDBACK_KINDS[kind] });
    } catch (err) {
      sendError(res, req, err);
    }
  });

  router.get('/:id/feedback', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const decision = await getDecision(pool, userId, req.params.id);
      if (!decision) return res.status(404).json({ error: 'Decision not found' });
      const r = await pool.query(
        `SELECT payload, created_at FROM decision_events WHERE user_id = $1 AND decision_id = $2 AND event_type = 'HUMAN_FEEDBACK' ORDER BY created_at DESC LIMIT 50`,
        [userId, decision.id]
      );
      res.json({ kinds: FEEDBACK_KINDS, feedback: r.rows.map((x) => ({ ...x.payload, at: x.created_at })) });
    } catch (err) {
      sendError(res, req, err);
    }
  });

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
      await appendEvent(pool, { userId, decisionId: d.id, type: 'SIMULATION_RUN', actor: humanActor(userId), correlationId: req.requestId || null, payload: { assumptions: fixedParams, paymentSpeed: fixedShock, recommendationChanged: draft.recommendation.key !== d.recommendation?.key } })
        .catch((err) => safeLog('warn', '[decisions] simulation event not recorded', { error: err.message }));
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

  // "Handle it": the one button that turns a decision into a mission.
  // It walks the same server-enforced steps a person could take one by one
  // (select -> approve -> execute), so no policy, kill switch, precondition
  // or idempotency check is skipped. Approval is only recorded when the
  // person explicitly asks for it (approve: true); otherwise the mission
  // stops at WAITING_FOR_APPROVAL. Execution runs in the tenant's pilot mode
  // (Shadow by default): nothing changes outside Starlane unless the tenant
  // is live.
  router.post('/:id/handle', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const d = await loadOr404(req, res);
      if (!d) return;
      const body = req.body || {};
      const ctx = ctxOf(req);
      const steps = [];
      let current = d;
      if (['OPEN', 'NEEDS_INFORMATION'].includes(current.status) || (current.status === 'SELECTED' && body.optionKey && body.optionKey !== current.selected_option)) {
        const optionKey = typeof body.optionKey === 'string' ? body.optionKey : current.recommendation?.key;
        if (!optionKey) return res.status(400).json({ error: 'Choose an option first: this decision has no recommendation.' });
        await lifecycle.selectOption(pool, userId, d.id, { optionKey, note: body.note || 'Handle it' }, ctx);
        steps.push({ step: 'SELECTED', optionKey });
        current = await getDecision(pool, userId, d.id);
      }
      const option = (current.options || []).find((o) => o.key === current.selected_option);
      if (current.status === 'SELECTED' && !(option && option.isDoNothing)) {
        if (body.approve !== true) {
          return res.status(202).json({ steps, mission: await missions.getMission(pool, userId, `decision:${d.id}`), next: 'This option needs your approval before Starlane runs it.' });
        }
        await lifecycle.approveDecision(pool, userId, d.id, { note: body.note || 'Approved from Handle it' }, ctx);
        steps.push({ step: 'APPROVED' });
        current = await getDecision(pool, userId, d.id);
      }
      if (current.status === 'APPROVED' || (current.status === 'SELECTED' && option && option.isDoNothing)) {
        const exec = await lifecycle.executeDecision(pool, userId, d.id, { authorizeLive: false }, ctx);
        steps.push({ step: 'EXECUTED', mode: exec.mode, status: exec.status });
      } else if (!steps.length) {
        return res.status(409).json({ error: `This decision is ${current.status.toLowerCase().replace('_', ' ')}; there is nothing more to handle.`, decisionStatus: current.status, mission: await missions.getMission(pool, userId, `decision:${d.id}`) });
      }
      res.json({ steps, mission: await missions.getMission(pool, userId, `decision:${d.id}`) });
    } catch (err) {
      sendError(res, req, err);
    }
  });

  return router;
}

module.exports = { decisionsRouter, decisionView };
