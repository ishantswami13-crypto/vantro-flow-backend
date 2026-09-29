// FILE: lib/domain/os/objectiveStore.js
// WATCH: persistence for objectives and their autopilot.
//
// An autopilot is an objective plus a workflow. It never deploys a workflow
// by itself: when the objective is at risk and its mode is PREPARE or
// EXECUTE_WITH_APPROVAL, it runs the linked workflow only if a person has
// already deployed that workflow, and only if no stop is on.
// EXECUTE_WITHIN_POLICY is refused: no connector can act on its own yet.

const { evaluateObjective, autopilotTemplates, METRICS, AUTOPILOT_MODES } = require('./objectives');
const { getSettings, checkStops } = require('../decisions/controls');
const { receivablesFreshness } = require('../decisions/sourceHealth');
const { loadRawReceivables } = require('../decisions/discovery');
const { deriveReceivablesState } = require('../decisions/snapshot');
const { buildBehaviorModel } = require('../decisions/behavior');
const { appendEvent, humanActor } = require('../decisions/store');
const { proposeWorkflow, runWorkflow, assertUuid, LIVE_STATUSES } = require('./workflows');

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

function validate(input) {
  const metricKey = String(input.metricKey || input.metric_key || '');
  if (!METRICS[metricKey]) throw httpError(400, `metric must be one of ${Object.keys(METRICS).join(', ')}`);
  const operator = input.operator === '>=' ? '>=' : input.operator === '<=' ? '<=' : null;
  if (!operator) throw httpError(400, 'operator must be <= or >=');
  const target = Number(input.target);
  if (!Number.isFinite(target) || target < 0) throw httpError(400, 'target must be a non-negative number');
  if (metricKey === 'overdue_share_pct' && target > 100) throw httpError(400, 'a percentage target must be at most 100');
  const horizonDays = input.horizonDays == null ? 30 : Math.round(Number(input.horizonDays));
  if (!(horizonDays >= 7 && horizonDays <= 180)) throw httpError(400, 'horizonDays must be between 7 and 180');
  const autopilotMode = input.autopilotMode || 'WATCH';
  if (!AUTOPILOT_MODES.includes(autopilotMode)) throw httpError(400, `autopilotMode must be one of ${AUTOPILOT_MODES.join(', ')}`);
  if (autopilotMode === 'EXECUTE_WITHIN_POLICY') throw httpError(409, 'Execute within policy is not available: Starlane never moves to full autonomy on its own, and no connected system can act without a person yet.');
  const name = String(input.name || METRICS[metricKey].label).trim().slice(0, 120);
  return { metricKey, operator, target, horizonDays, autopilotMode, name };
}

async function createObjective(pool, userId, input, { actorId }) {
  const v = validate(input || {});
  let workflowId = null;
  const templateKey = input.templateKey || null;
  if (templateKey === 'COLLECTIONS_AUTOPILOT') {
    // Reuse the follow-up workflow Scan proposed (or the one already running); only create one if none exists.
    const live = await pool.query(`SELECT id FROM starlane_workflows WHERE user_id = $1 AND template_key = 'receivables_followup' AND status = ANY($2) LIMIT 1`, [userId, LIVE_STATUSES]);
    if (live.rows[0]) workflowId = live.rows[0].id;
    else {
      const p = await proposeWorkflow(pool, userId, { templateKey: 'receivables_followup', params: {}, source: 'TEMPLATE', createdBy: String(actorId) });
      workflowId = p.workflow ? p.workflow.id : null;
    }
  } else if (templateKey) {
    const t = autopilotTemplates({}).find((x) => x.key === templateKey);
    if (!t) throw httpError(400, 'unknown autopilot template');
    throw httpError(409, `${t.name} is not available: ${t.detail}`);
  }
  const r = await pool.query(
    `INSERT INTO starlane_objectives (user_id, name, metric_key, operator, target, horizon_days, autopilot_mode, template_key, workflow_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [userId, v.name, v.metricKey, v.operator, v.target, v.horizonDays, v.autopilotMode, templateKey, workflowId, actorId]
  );
  if (workflowId) await pool.query('UPDATE starlane_workflows SET objective_id = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2', [workflowId, userId, r.rows[0].id]);
  await appendEvent(pool, { userId, decisionId: null, type: 'OBJECTIVE_CREATED', actor: humanActor(actorId), payload: { objectiveId: r.rows[0].id, ...v, templateKey } }).catch(() => {});
  return r.rows[0];
}

async function updateObjective(pool, userId, id, input, { actorId }) {
  assertUuid(id, 'objective');
  const cur = (await pool.query('SELECT * FROM starlane_objectives WHERE id = $1 AND user_id = $2', [id, userId])).rows[0];
  if (!cur) throw httpError(404, 'objective not found');
  const merged = validate({ metricKey: cur.metric_key, operator: cur.operator, target: cur.target, horizonDays: cur.horizon_days, autopilotMode: cur.autopilot_mode, name: cur.name, ...input });
  const status = input.status && ['ACTIVE', 'PAUSED', 'ARCHIVED'].includes(input.status) ? input.status : cur.status;
  const r = await pool.query(
    `UPDATE starlane_objectives SET name = $3, operator = $4, target = $5, horizon_days = $6, autopilot_mode = $7, status = $8, updated_at = NOW()
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId, merged.name, merged.operator, merged.target, merged.horizonDays, merged.autopilotMode, status]
  );
  await appendEvent(pool, { userId, decisionId: null, type: 'OBJECTIVE_UPDATED', actor: humanActor(actorId), payload: { objectiveId: id, changes: input } }).catch(() => {});
  return r.rows[0];
}

async function latestEvaluations(pool, userId) {
  const r = await pool.query(
    `SELECT DISTINCT ON (objective_id) * FROM starlane_objective_evaluations WHERE user_id = $1 ORDER BY objective_id, evaluated_at DESC`,
    [userId]
  );
  return new Map(r.rows.map((e) => [e.objective_id, e]));
}

async function listObjectives(pool, userId) {
  const [rows, evals] = await Promise.all([
    pool.query(`SELECT * FROM starlane_objectives WHERE user_id = $1 AND status <> 'ARCHIVED' ORDER BY created_at`, [userId]).then((r) => r.rows),
    latestEvaluations(pool, userId),
  ]);
  return rows.map((o) => ({ ...o, latest: evals.get(o.id) || null }));
}

async function loadContext(pool, userId, asOfIso) {
  const settings = await getSettings(pool, userId);
  const defs = settings.definitions;
  const [raw, freshness] = await Promise.all([loadRawReceivables(pool, userId), receivablesFreshness(pool, userId, defs)]);
  const state = deriveReceivablesState(raw, asOfIso, { mode: 'live', baseCurrency: defs.base_currency });
  return { settings, defs, raw, freshness, state, behavior: buildBehaviorModel(state) };
}

/**
 * Evaluates one objective, stores the evaluation, and applies its autopilot.
 */
async function evaluateAndStore(pool, userId, id, { actorId = null, asOfIso = new Date().toISOString(), ctx = null } = {}) {
  assertUuid(id, 'objective');
  const o = (await pool.query('SELECT * FROM starlane_objectives WHERE id = $1 AND user_id = $2', [id, userId])).rows[0];
  if (!o) throw httpError(404, 'objective not found');
  const c = ctx || await loadContext(pool, userId, asOfIso);
  const ev = evaluateObjective(o, c.state, c.behavior, { overdueAfterDays: c.defs.overdue_after_days, freshness: c.freshness });
  const stored = (await pool.query(
    `INSERT INTO starlane_objective_evaluations (user_id, objective_id, health, current_value, forecast, confidence, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [userId, id, ev.health, ev.currentValue ?? null, JSON.stringify({ ...(ev.forecast || {}), breachProbability: ev.breachProbability ?? null, breachInDays: ev.breachInDays ?? null, explanation: ev.explanation }),
      JSON.stringify(ev.confidence), JSON.stringify(ev.evidence || [])]
  )).rows[0];
  await pool.query('UPDATE starlane_objectives SET last_health = $3, last_evaluated_at = NOW() WHERE id = $1 AND user_id = $2', [id, userId, ev.health]);

  // Autopilot.
  let autopilot = { action: 'NONE', why: `Mode is ${o.autopilot_mode.toLowerCase().replace(/_/g, ' ')}.` };
  const atRisk = ['AT_RISK', 'OFF_TRACK'].includes(ev.health);
  if (!atRisk) {
    autopilot = { action: 'NONE', why: ev.health === 'UNKNOWN' ? 'Health is unknown, so the autopilot does nothing.' : 'On track, nothing to do.' };
  } else if (['PREPARE', 'EXECUTE_WITH_APPROVAL'].includes(o.autopilot_mode) && o.workflow_id && o.status === 'ACTIVE') {
    const stops = await checkStops(pool, userId, { objectiveId: id });
    const wf = (await pool.query('SELECT status FROM starlane_workflows WHERE id = $1 AND user_id = $2', [o.workflow_id, userId])).rows[0];
    if (!stops.allowed) autopilot = { action: 'STOPPED', why: 'The autopilot stop is on.', blockedBy: stops.blockedBy };
    else if (!wf || !['SHADOW', 'WITH_APPROVAL'].includes(wf.status)) autopilot = { action: 'NEEDS_DEPLOYMENT', why: 'The follow-up workflow is not deployed yet. Deploy it from Prepared.', workflowId: o.workflow_id };
    else {
      const run = await runWorkflow(pool, userId, o.workflow_id, { actorId, source: 'OBJECTIVE', asOfIso });
      autopilot = { action: 'RAN_WORKFLOW', workflowId: o.workflow_id, runId: run.run.id, runStatus: run.run.status, counts: run.run.counts };
    }
  } else if (o.autopilot_mode === 'RECOMMEND' && o.workflow_id) {
    autopilot = { action: 'RECOMMENDED', why: 'The follow-up workflow would help; it is waiting in Prepared.', workflowId: o.workflow_id };
  }

  const related = atRisk
    ? (await pool.query(`SELECT id, title, status, expected_value FROM decisions WHERE user_id = $1 AND kind = 'RECEIVABLE_RISK' AND status IN ('OPEN','NEEDS_INFORMATION','SELECTED') ORDER BY attention_score DESC NULLS LAST LIMIT 3`, [userId]).catch(() => ({ rows: [] }))).rows
    : [];
  return { objective: o, evaluation: { ...ev, id: stored.id, evaluatedAt: stored.evaluated_at }, autopilot, relatedDecisions: related };
}

async function evaluateAll(pool, userId, { actorId = null, asOfIso = new Date().toISOString() } = {}) {
  const rows = (await pool.query(`SELECT id FROM starlane_objectives WHERE user_id = $1 AND status = 'ACTIVE'`, [userId])).rows;
  if (!rows.length) return [];
  const ctx = await loadContext(pool, userId, asOfIso);
  const out = [];
  for (const r of rows) out.push(await evaluateAndStore(pool, userId, r.id, { actorId, asOfIso, ctx }));
  return out;
}

async function templatesFor(pool, userId) {
  const [due, inv] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS n FROM invoices WHERE user_id = $1 AND due_date IS NOT NULL', [userId]).then((r) => r.rows[0].n).catch(() => 0),
    pool.query('SELECT COUNT(*)::int AS n FROM products WHERE user_id = $1', [userId]).then((r) => r.rows[0].n).catch(() => 0),
  ]);
  return autopilotTemplates({ hasDueDates: due > 0, hasInventory: inv > 0, hasBank: false });
}

module.exports = { createObjective, updateObjective, listObjectives, evaluateAndStore, evaluateAll, templatesFor, loadContext };
