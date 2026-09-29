// FILE: lib/domain/os/workflows.js
// MISSIONS: workflow persistence and the engine that runs deployed
// workflows, handles approvals and verifies business outcomes.
//
// Safety properties, each enforced here in the backend:
//   - A workflow runs only after a human deployed it (SHADOW or WITH_APPROVAL).
//   - Every run checks kill switches (tenant, agent, workflow, action class),
//     the agent's PREPARE permission and data freshness before doing anything.
//   - Items carry an idempotency key, so a repeated trigger is a no-op.
//   - Approval is a compare-and-set on the item, rechecks expiry, workflow
//     state, policy version, stops and the invoices themselves.
//   - Nothing is sent. SHADOW records what would have been sent; LIVE marks
//     the reminder ready for a person to send (manual completion required).
//   - Success is verified from the ledger (payment arrived), never from
//     "the step completed".
// Every query is scoped by user_id; no function takes an id without it.

const { appendEvent, humanActor } = require('../decisions/store');
const { getSettings, checkStops } = require('../decisions/controls');
const { receivablesFreshness } = require('../decisions/sourceHealth');
const { loadRawReceivables } = require('../decisions/discovery');
const { deriveReceivablesState } = require('../decisions/snapshot');
const { buildBehaviorModel } = require('../decisions/behavior');
const { toIsoDate, addDays, startOfUtcDay, DAY_MS } = require('../decisions/dates');
const { TEMPLATES, AGENT_KEY, ENGINE_KEY, AGENT_VERSION, MODEL, DEFAULTS, PERMISSIONS } = require('./workflowTemplates');
const { selectTargets, idempotencyKey, episodeKey, draftReminder, replayWorkflow } = require('./workflowLogic');
const { recordLearnedPattern } = require('./knowledge');
const { safeLog } = require('../../observability/logger');

const LIVE_STATUSES = ['PROPOSED', 'SHADOW', 'WITH_APPROVAL', 'PAUSED'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

function assertUuid(id, what = 'id') {
  if (!UUID_RE.test(String(id || ''))) throw httpError(404, `${what} not found`);
}

function engineActor(onBehalfOf) {
  return { type: 'agent', id: ENGINE_KEY, onBehalfOf: onBehalfOf || null, agentKey: AGENT_KEY, agentVersion: AGENT_VERSION, model: MODEL };
}

async function audit(pool, userId, type, actor, payload, policy = null) {
  return appendEvent(pool, { userId, decisionId: null, type, actor, payload, policy }).catch((err) => {
    safeLog('warn', '[os] audit write failed', { type, error: err.message });
  });
}

function paramsOf(wf) {
  const minCond = (wf.conditions || []).find((c) => c.key === 'min_balance');
  return { overdueDays: Number(wf.trigger?.overdueDays ?? DEFAULTS.overdueDays), minBalance: Number(minCond?.value ?? DEFAULTS.minBalance) };
}

// ── Persistence ─────────────────────────────────────────────────────────

async function getWorkflow(db, userId, id) {
  assertUuid(id, 'workflow');
  const r = await db.query('SELECT * FROM starlane_workflows WHERE id = $1 AND user_id = $2', [id, userId]);
  return r.rows[0] || null;
}

async function listWorkflows(pool, userId, { statuses } = {}) {
  const r = await pool.query(
    `SELECT w.*,
       (SELECT COUNT(*)::int FROM starlane_workflow_items i WHERE i.workflow_id = w.id AND i.status = 'AWAITING_APPROVAL') AS awaiting,
       (SELECT COUNT(*)::int FROM starlane_workflow_items i WHERE i.workflow_id = w.id AND i.outcome_status = 'MET') AS met,
       (SELECT COUNT(*)::int FROM starlane_workflow_items i WHERE i.workflow_id = w.id AND i.outcome_status = 'NOT_MET') AS not_met,
       (SELECT MAX(started_at) FROM starlane_workflow_runs r WHERE r.workflow_id = w.id) AS last_run_at
     FROM starlane_workflows w WHERE w.user_id = $1 ${statuses ? 'AND w.status = ANY($2)' : ''} ORDER BY w.updated_at DESC`,
    statuses ? [userId, statuses] : [userId]
  );
  return r.rows;
}

/**
 * Creates (or refreshes) a PROPOSED workflow. A tenant has at most one live
 * workflow per template; a live one is refreshed, never duplicated. A
 * workflow the owner rejected is not proposed again by Scan.
 */
async function proposeWorkflow(pool, userId, { templateKey, params, source, sourceRef = null, discovery = null, simulation = null, createdBy }) {
  const build = TEMPLATES[templateKey];
  if (!build) throw httpError(400, 'unknown workflow template');
  const m = build(params);
  const existing = await pool.query(`SELECT * FROM starlane_workflows WHERE user_id = $1 AND template_key = $2 AND status = ANY($3)`, [userId, templateKey, LIVE_STATUSES]);
  const live = existing.rows[0];
  if (live) {
    if (live.status !== 'PROPOSED') return { workflow: live, outcome: 'ALREADY_DEPLOYED' };
    const changed = JSON.stringify(live.trigger) !== JSON.stringify(m.trigger) || JSON.stringify(live.conditions) !== JSON.stringify(m.conditions);
    const r = await pool.query(
      `UPDATE starlane_workflows SET trigger = $3, conditions = $4, objective = $5, discovery = COALESCE($6, discovery), simulation = COALESCE($7, simulation),
         source = $8, source_ref = COALESCE($9, source_ref), version = version + $10, updated_at = NOW()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [live.id, userId, JSON.stringify(m.trigger), JSON.stringify(m.conditions), m.objective, discovery ? JSON.stringify(discovery) : null,
        simulation ? JSON.stringify(simulation) : null, source, sourceRef ? JSON.stringify(sourceRef) : null, changed ? 1 : 0]
    );
    return { workflow: r.rows[0], outcome: 'REFRESHED' };
  }
  if (source === 'SCAN') {
    const rejected = await pool.query(`SELECT id, updated_at FROM starlane_workflows WHERE user_id = $1 AND template_key = $2 AND status = 'REJECTED' ORDER BY updated_at DESC LIMIT 1`, [userId, templateKey]);
    if (rejected.rows[0]) return { workflow: null, outcome: 'PREVIOUSLY_REJECTED', rejectedAt: rejected.rows[0].updated_at };
  }
  const r = await pool.query(
    `INSERT INTO starlane_workflows (user_id, template_key, name, objective, trigger, conditions, steps, approvals, policies, agent_permissions, budget,
       success_metric, expected_outcome, fallback, stop_conditions, status, automation_level, source, source_ref, discovery, simulation, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'PROPOSED',2,$16,$17,$18,$19,$20) RETURNING *`,
    [userId, m.templateKey, m.name, m.objective, JSON.stringify(m.trigger), JSON.stringify(m.conditions), JSON.stringify(m.steps), JSON.stringify(m.approvals),
      JSON.stringify(m.policies), JSON.stringify(m.agentPermissions), JSON.stringify(m.budget), JSON.stringify(m.successMetric), JSON.stringify(m.expectedOutcome),
      JSON.stringify(m.fallback), JSON.stringify(m.stopConditions), source, sourceRef ? JSON.stringify(sourceRef) : null,
      discovery ? JSON.stringify(discovery) : null, simulation ? JSON.stringify(simulation) : null, createdBy]
  );
  await audit(pool, userId, 'WORKFLOW_PROPOSED', source === 'TEXT' ? humanActor(createdBy) : engineActor(null), { workflowId: r.rows[0].id, templateKey, source, params });
  return { workflow: r.rows[0], outcome: 'CREATED' };
}

const TRANSITIONS = {
  deploy_shadow: { from: ['PROPOSED', 'PAUSED', 'WITH_APPROVAL'], to: 'SHADOW', level: 3, event: 'WORKFLOW_DEPLOYED_SHADOW' },
  deploy_with_approval: { from: ['PROPOSED', 'PAUSED', 'SHADOW'], to: 'WITH_APPROVAL', level: 4, event: 'WORKFLOW_DEPLOYED_WITH_APPROVAL' },
  pause: { from: ['SHADOW', 'WITH_APPROVAL'], to: 'PAUSED', event: 'WORKFLOW_PAUSED' },
  reject: { from: ['PROPOSED'], to: 'REJECTED', level: 0, event: 'WORKFLOW_REJECTED' },
  retire: { from: ['SHADOW', 'WITH_APPROVAL', 'PAUSED'], to: 'RETIRED', level: 0, event: 'WORKFLOW_RETIRED' },
};

async function transitionWorkflow(pool, userId, id, action, { actorId, reason = null }) {
  const t = TRANSITIONS[action];
  if (!t) throw httpError(400, `action must be one of ${Object.keys(TRANSITIONS).join(', ')}`);
  const wf = await getWorkflow(pool, userId, id);
  if (!wf) throw httpError(404, 'workflow not found');
  if (!t.from.includes(wf.status)) throw httpError(409, `A ${wf.status.toLowerCase().replace('_', ' ')} workflow cannot ${action.replace(/_/g, ' ')}.`);
  const deploying = action.startsWith('deploy');
  const r = await pool.query(
    `UPDATE starlane_workflows SET status = $3, automation_level = COALESCE($4, automation_level),
       deployed_by = CASE WHEN $5 THEN $6::uuid ELSE deployed_by END, deployed_at = CASE WHEN $5 THEN NOW() ELSE deployed_at END,
       decided_reason = COALESCE($7, decided_reason), updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status = $8 RETURNING *`,
    [id, userId, t.to, t.level ?? null, deploying, actorId, reason ? String(reason).slice(0, 500) : null, wf.status]
  );
  if (!r.rows[0]) throw httpError(409, 'The workflow changed while this was being saved. Reload and try again.');
  // Pending approvals cannot survive the workflow being paused, rejected or retired.
  if (['PAUSED', 'REJECTED', 'RETIRED', 'SHADOW'].includes(t.to)) {
    await pool.query(
      `UPDATE starlane_workflow_items SET status = 'CANCELLED', status_reason = $3, outcome_status = 'NOT_APPLICABLE', updated_at = NOW()
       WHERE workflow_id = $1 AND user_id = $2 AND status = 'AWAITING_APPROVAL'`,
      [id, userId, `Workflow ${t.to === 'SHADOW' ? 'moved to shadow mode' : t.to.toLowerCase()} before approval`]
    );
  }
  await audit(pool, userId, t.event, humanActor(actorId), { workflowId: id, from: wf.status, to: t.to, reason });
  return r.rows[0];
}

/**
 * Changing what the agent may do bumps the workflow version, so approvals
 * prepared under the old version are refused ("policy changed").
 */
async function setAgentPermissions(pool, userId, id, perms, { actorId }) {
  if (!Array.isArray(perms) || perms.some((p) => !PERMISSIONS.includes(p))) throw httpError(400, `permissions must be a list drawn from ${PERMISSIONS.join(', ')}`);
  if (perms.includes('EXECUTE')) throw httpError(409, 'EXECUTE cannot be granted: this workflow has no connector that can send on its own, so sending stays manual.');
  const wf = await getWorkflow(pool, userId, id);
  if (!wf) throw httpError(404, 'workflow not found');
  const next = { ...(wf.agent_permissions || {}), [AGENT_KEY]: [...new Set(perms)] };
  const r = await pool.query(`UPDATE starlane_workflows SET agent_permissions = $3, version = version + 1, updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING *`, [id, userId, JSON.stringify(next)]);
  await audit(pool, userId, 'WORKFLOW_PERMISSIONS_CHANGED', humanActor(actorId), { workflowId: id, agent: AGENT_KEY, permissions: perms, version: r.rows[0].version });
  return r.rows[0];
}

// ── Simulation (historical replay) ─────────────────────────────────────

async function simulateWorkflow(pool, userId, id, { asOfIso = new Date().toISOString(), lookbackDays = 180 } = {}) {
  const wf = await getWorkflow(pool, userId, id);
  if (!wf) throw httpError(404, 'workflow not found');
  const settings = await getSettings(pool, userId);
  const raw = await loadRawReceivables(pool, userId);
  const result = replayWorkflow(raw, paramsOf(wf), asOfIso, { lookbackDays, baseCurrency: settings.definitions.base_currency });
  const simulation = { ...result, ranAt: new Date().toISOString(), asOf: asOfIso, params: paramsOf(wf) };
  await pool.query('UPDATE starlane_workflows SET simulation = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2', [id, userId, JSON.stringify(simulation)]);
  return simulation;
}

// ── Engine ──────────────────────────────────────────────────────────────

async function withRetry(fn, attempts = 2) {
  let lastErr;
  for (let k = 1; k <= attempts; k++) {
    try { return { ok: true, value: await fn(k), attempts: k }; } catch (err) { lastErr = err; }
  }
  return { ok: false, error: lastErr, attempts };
}

async function finishRun(pool, userId, runId, status, counts, stoppedReason = null) {
  const r = await pool.query(
    `UPDATE starlane_workflow_runs SET status = $3, counts = $4, stopped_reason = $5, finished_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING *`,
    [runId, userId, status, JSON.stringify(counts), stoppedReason ? JSON.stringify(stoppedReason) : null]
  );
  return r.rows[0];
}

/**
 * Runs one deployed workflow for one tenant.
 * @param {object} opts { actorId, source: MANUAL|SCHEDULE|OBJECTIVE, asOfIso, failTargets (test hook: customer keys whose writes fail) }
 */
async function runWorkflow(pool, userId, id, { actorId = null, source = 'MANUAL', asOfIso = new Date().toISOString(), failTargets = null } = {}) {
  const wf = await getWorkflow(pool, userId, id);
  if (!wf) throw httpError(404, 'workflow not found');
  if (!['SHADOW', 'WITH_APPROVAL'].includes(wf.status)) throw httpError(409, `This workflow is ${wf.status.toLowerCase().replace('_', ' ')}. Deploy it in shadow or with approval before it can run.`);

  const runRes = await pool.query(
    `INSERT INTO starlane_workflow_runs (user_id, workflow_id, workflow_version, mode, trigger_source, status, as_of, started_by)
     VALUES ($1,$2,$3,$4,$5,'RUNNING',$6,$7) RETURNING *`,
    [userId, id, wf.version, wf.status, source, asOfIso, actorId ? String(actorId) : ENGINE_KEY]
  );
  const run = runRes.rows[0];
  const counts = { targets: 0, created: 0, shadowed: 0, awaitingApproval: 0, duplicates: 0, superseded: 0, replanned: 0, deferredByBudget: 0, failed: 0, excluded: {} };

  const stops = await checkStops(pool, userId, { agentKey: AGENT_KEY, actionClass: 'CONTACT_CUSTOMER', workflowId: id });
  if (!stops.allowed) {
    const done = await finishRun(pool, userId, run.id, 'STOPPED', counts, { key: 'kill_switch', blockedBy: stops.blockedBy });
    await audit(pool, userId, 'WORKFLOW_RUN_STOPPED', engineActor(actorId), { workflowId: id, runId: run.id, blockedBy: stops.blockedBy });
    return { run: done, items: [] };
  }
  const perms = (wf.agent_permissions || {})[AGENT_KEY] || [];
  if (!perms.includes('PREPARE')) {
    const done = await finishRun(pool, userId, run.id, 'STOPPED', counts, { key: 'permission_revoked', detail: `${AGENT_KEY} does not have PREPARE permission on this workflow.` });
    return { run: done, items: [] };
  }
  const settings = await getSettings(pool, userId);
  const defs = settings.definitions;
  const freshness = await receivablesFreshness(pool, userId, defs);
  if (freshness.status === 'STALE' || freshness.status === 'UNKNOWN') {
    const done = await finishRun(pool, userId, run.id, 'STOPPED', counts, { key: 'stale_data', detail: `${freshness.detail}. Starlane does not act on balances older than ${defs.receivables_stale_hours} hours.` });
    return { run: done, items: [] };
  }

  const raw = await loadRawReceivables(pool, userId);
  const state = deriveReceivablesState(raw, asOfIso, { mode: 'live', baseCurrency: defs.base_currency });
  const behavior = buildBehaviorModel(state);
  const params = paramsOf(wf);

  // Re-plan: items still waiting for approval whose reality has changed.
  const pending = await pool.query(`SELECT * FROM starlane_workflow_items WHERE workflow_id = $1 AND user_id = $2 AND status = 'AWAITING_APPROVAL'`, [id, userId]);
  const invById = new Map(state.invoices.map((i) => [i.id, i]));
  for (const item of pending.rows) {
    const reason = realityChange(item, invById);
    if (reason) {
      await pool.query(`UPDATE starlane_workflow_items SET status = 'CANCELLED', status_reason = $3, outcome_status = 'NOT_APPLICABLE', updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'AWAITING_APPROVAL'`, [item.id, userId, reason]);
      counts.replanned++;
    }
  }

  const { targets, excluded } = selectTargets(state, params, behavior);
  counts.targets = targets.length;
  counts.excluded = excluded;
  const budget = Number(wf.budget?.maxActionsPerRun || DEFAULTS.maxActionsPerRun);
  const now = targets.slice(0, budget);
  counts.deferredByBudget = Math.max(0, targets.length - budget);
  const businessRes = await pool.query('SELECT business_name FROM users WHERE id = $1', [userId]);
  const businessName = businessRes.rows[0]?.business_name || null;
  const asOfDay = startOfUtcDay(Date.parse(asOfIso));
  const created = [];
  const failures = [];

  for (const target of now) {
    // Already handled under any version (acted on, or the owner said no):
    // never ask twice. An item that expired or was cancelled can be prepared
    // again; the attempt number keeps the key unique yet idempotent.
    const prior = await pool.query(
      `SELECT status FROM starlane_workflow_items WHERE user_id = $1 AND idempotency_key LIKE $2`,
      [userId, `${episodeKey(id, target)}:v%`]
    );
    if (prior.rows.some((p) => ['SHADOWED', 'PREPARED_MANUAL', 'REJECTED'].includes(p.status))) { counts.duplicates++; continue; }
    const retired = prior.rows.filter((p) => ['CANCELLED', 'EXPIRED', 'FAILED'].includes(p.status)).length;
    const key = `${idempotencyKey(id, wf.version, target)}:a${retired + 1}`;
    const draft = draftReminder(target, { businessName, currency: defs.base_currency });
    const policy = [
      { key: 'no_disputed', verdict: 'PASS' },
      { key: 'strategic_requires_approval', verdict: target.strategic ? 'APPROVAL_REQUIRED' : 'PASS' },
      { key: 'pilot_mode', verdict: settings.pilotMode },
      { key: 'external_send', verdict: 'MANUAL_COMPLETION_REQUIRED' },
    ];
    const agent = { agent: AGENT_KEY, version: AGENT_VERSION, model: MODEL, delegator: wf.deployed_by, workflowId: id, workflowVersion: wf.version, tool: 'receivables.reminder_draft', permissions: perms };
    const expected = { metric: 'payment_received', withinDays: DEFAULTS.verifyWithinDays, baselineProbability: target.baselineProbability, verification: 'A payment on any of these invoices is recorded in the ledger within the window' };
    const shadow = wf.status === 'SHADOW';
    const status = shadow ? 'SHADOWED' : 'AWAITING_APPROVAL';
    const action = shadow ? { mode: 'SHADOW', wouldHave: { channel: draft.channel, to: target.customerName, message: draft.text }, note: 'Shadow mode: nothing was sent.' } : null;

    const res = await withRetry(async () => {
      if (failTargets && failTargets.includes(target.customerKey)) throw new Error('simulated write failure');
      return pool.query(
        `INSERT INTO starlane_workflow_items (user_id, workflow_id, workflow_version, run_id, idempotency_key, target_type, target_key, target_label, invoice_ids,
           amount, currency, priority, context, draft, status, action, agent, policy, expected_outcome, acted_at, verify_after, expires_at, attempts)
         VALUES ($1,$2,$3,$4,$5,'customer',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING *`,
        [userId, id, wf.version, run.id, key, target.customerKey, target.customerName, target.invoices.map((i) => i.id), target.amount, defs.base_currency,
          target.priority, JSON.stringify({ history: target.history, invoices: target.invoices, maxAgeDays: target.maxAgeDays, strategic: target.strategic }),
          JSON.stringify(draft), status, action ? JSON.stringify(action) : null, JSON.stringify(agent), JSON.stringify(policy), JSON.stringify(expected),
          shadow ? asOfIso : null, shadow ? toIsoDate(addDays(asOfDay, DEFAULTS.verifyWithinDays)) : null,
          shadow ? null : new Date(asOfDay + DEFAULTS.approvalExpiryDays * DAY_MS).toISOString(), 1]
      );
    });
    if (!res.ok) {
      counts.failed++;
      failures.push({ customer: target.customerName, error: res.error.message, attempts: res.attempts, fallback: 'Handed to a person: prepare this reminder by hand' });
      continue;
    }
    const row = res.value.rows[0];
    if (!row) { counts.duplicates++; continue; }
    // A newer set of overdue invoices for the same customer supersedes an older pending item.
    const sup = await pool.query(
      `UPDATE starlane_workflow_items SET status = 'CANCELLED', status_reason = 'Superseded by a newer reminder for the same customer', outcome_status = 'NOT_APPLICABLE', updated_at = NOW()
       WHERE workflow_id = $1 AND user_id = $2 AND target_key = $3 AND status = 'AWAITING_APPROVAL' AND id <> $4`,
      [id, userId, target.customerKey, row.id]
    );
    counts.superseded += sup.rowCount;
    counts.created++;
    if (shadow) counts.shadowed++; else counts.awaitingApproval++;
    created.push(row);
  }

  if (failures.length) counts.failures = failures;
  const status = failures.length ? (created.length ? 'PARTIAL' : 'FAILED') : 'COMPLETED';
  const done = await finishRun(pool, userId, run.id, status, counts);
  await audit(pool, userId, 'WORKFLOW_RUN', engineActor(actorId), { workflowId: id, runId: run.id, status, counts: { ...counts, failures: undefined } },
    [{ key: 'kill_switch', verdict: 'PASS' }, { key: 'permission', verdict: 'PASS' }, { key: 'freshness', verdict: freshness.status }]);
  return { run: done, items: created };
}

function realityChange(item, invById) {
  const invs = (item.invoice_ids || []).map((x) => invById.get(String(x)));
  if (invs.some((i) => !i)) return 'An invoice in this reminder no longer exists in the ledger';
  if (invs.some((i) => i.disputeOpen)) return 'A dispute was opened on one of these invoices';
  const open = invs.reduce((a, i) => a + i.outstanding, 0);
  if (open <= 0) return 'All invoices were paid before approval';
  if (Math.abs(open - Number(item.amount)) / Number(item.amount) > 0.25) return 'The amount owed changed by more than 25% since the reminder was drafted';
  return null;
}

// ── Approvals (Prepared) ────────────────────────────────────────────────

async function listItems(pool, userId, { status, workflowId, limit = 100 } = {}) {
  const params = [userId];
  let q = 'SELECT i.*, w.name AS workflow_name FROM starlane_workflow_items i JOIN starlane_workflows w ON w.id = i.workflow_id AND w.user_id = i.user_id WHERE i.user_id = $1';
  if (status) { params.push(status); q += ` AND i.status = $${params.length}`; }
  if (workflowId) { assertUuid(workflowId, 'workflow'); params.push(workflowId); q += ` AND i.workflow_id = $${params.length}`; }
  params.push(Math.min(Number(limit) || 100, 500));
  q += ` ORDER BY i.priority DESC NULLS LAST, i.created_at DESC LIMIT $${params.length}`;
  return (await pool.query(q, params)).rows;
}

async function decideItem(pool, userId, itemId, decision, { actorId, nowIso = new Date().toISOString() }) {
  if (!['approve', 'reject'].includes(decision)) throw httpError(400, 'decision must be approve or reject');
  assertUuid(itemId, 'item');
  const itemRes = await pool.query('SELECT * FROM starlane_workflow_items WHERE id = $1 AND user_id = $2', [itemId, userId]);
  const item = itemRes.rows[0];
  if (!item) throw httpError(404, 'item not found');
  if (item.status !== 'AWAITING_APPROVAL') throw httpError(409, `This reminder is already ${item.status.toLowerCase().replace(/_/g, ' ')}.`, { itemStatus: item.status });

  const cancel = async (status, reason, httpStatus = 409) => {
    await pool.query(`UPDATE starlane_workflow_items SET status = $3, status_reason = $4, outcome_status = 'NOT_APPLICABLE', updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'AWAITING_APPROVAL'`, [itemId, userId, status, reason]);
    await audit(pool, userId, `WORKFLOW_ITEM_${status}`, humanActor(actorId), { itemId, workflowId: item.workflow_id, reason });
    throw httpError(httpStatus, reason, { itemStatus: status });
  };

  if (decision === 'reject') {
    const r = await pool.query(`UPDATE starlane_workflow_items SET status = 'REJECTED', status_reason = 'Rejected by the owner', approval = $3, outcome_status = 'NOT_APPLICABLE', updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'AWAITING_APPROVAL' RETURNING *`,
      [itemId, userId, JSON.stringify({ decision: 'REJECTED', by: actorId, at: nowIso })]);
    if (!r.rows[0]) throw httpError(409, 'This reminder was decided by someone else a moment ago.');
    await audit(pool, userId, 'WORKFLOW_ITEM_REJECTED', humanActor(actorId), { itemId, workflowId: item.workflow_id });
    return r.rows[0];
  }

  if (item.expires_at && Date.parse(item.expires_at) < Date.parse(nowIso)) await cancel('EXPIRED', 'This approval request expired. The next run prepares a fresh one if the invoices are still overdue.');
  const wf = await getWorkflow(pool, userId, item.workflow_id);
  if (!wf || wf.status !== 'WITH_APPROVAL') await cancel('CANCELLED', 'The workflow was paused or changed after this reminder was prepared.');
  if (wf.version !== item.workflow_version) await cancel('CANCELLED', 'The workflow policy changed after this reminder was prepared. It will be prepared again under the new policy.');
  const stops = await checkStops(pool, userId, { agentKey: AGENT_KEY, actionClass: 'CONTACT_CUSTOMER', workflowId: item.workflow_id });
  if (!stops.allowed) throw httpError(423, 'A stop is on, so nothing can be approved right now.', { blockedBy: stops.blockedBy });
  const settings = await getSettings(pool, userId);
  const raw = await loadRawReceivables(pool, userId);
  const state = deriveReceivablesState(raw, nowIso, { mode: 'live', baseCurrency: settings.definitions.base_currency });
  const changed = realityChange(item, new Map(state.invoices.map((i) => [i.id, i])));
  if (changed) await cancel('CANCELLED', changed);

  const shadow = settings.pilotMode === 'SHADOW';
  const action = shadow
    ? { mode: 'SHADOW', approvedBy: actorId, wouldHave: { channel: item.draft.channel, to: item.target_label, message: item.draft.text }, note: 'Approved in shadow mode: nothing was sent.' }
    : { mode: 'LIVE', approvedBy: actorId, manualCompletionRequired: true, message: item.draft.text, note: 'Starlane does not send from workflows yet. Copy this reminder and send it.' };
  const today = startOfUtcDay(Date.parse(nowIso));
  const r = await pool.query(
    `UPDATE starlane_workflow_items SET status = $3, approval = $4, action = $5, acted_at = $6, verify_after = $7, updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status = 'AWAITING_APPROVAL' RETURNING *`,
    [itemId, userId, shadow ? 'SHADOWED' : 'PREPARED_MANUAL', JSON.stringify({ decision: 'APPROVED', by: actorId, at: nowIso }), JSON.stringify(action), nowIso,
      toIsoDate(addDays(today, DEFAULTS.verifyWithinDays))]
  );
  if (!r.rows[0]) throw httpError(409, 'This reminder was decided by someone else a moment ago.');
  await audit(pool, userId, 'WORKFLOW_ITEM_APPROVED', humanActor(actorId), { itemId, workflowId: item.workflow_id, mode: action.mode },
    [{ key: 'approval', verdict: 'HUMAN_APPROVED' }, { key: 'pilot_mode', verdict: settings.pilotMode }, { key: 'external_send', verdict: 'MANUAL_COMPLETION_REQUIRED' }]);
  return r.rows[0];
}

// ── Outcome verification (Memory) ───────────────────────────────────────

/**
 * Checks each acted-on item against the ledger: did a payment on its
 * invoices land within the window? Reads raw rows (payment_date and
 * payment_amount), so part-payments count.
 */
async function verifyOutcomes(pool, userId, { asOfIso = new Date().toISOString(), workflowId = null } = {}) {
  const params = [userId];
  let q = `SELECT * FROM starlane_workflow_items WHERE user_id = $1 AND outcome_status = 'PENDING' AND acted_at IS NOT NULL`;
  if (workflowId) { assertUuid(workflowId, 'workflow'); params.push(workflowId); q += ` AND workflow_id = $2`; }
  const items = (await pool.query(q, params)).rows;
  if (!items.length) return { checked: 0, met: 0, notMet: 0, pending: 0, unknown: 0 };
  const inv = await pool.query('SELECT id, invoice_amount, payment_amount, payment_status, payment_date FROM invoices WHERE user_id = $1 AND id::text = ANY($2)', [userId, [...new Set(items.flatMap((i) => i.invoice_ids))]]);
  const byId = new Map(inv.rows.map((r) => [String(r.id), r]));
  const asOf = Date.parse(asOfIso);
  const summary = { checked: items.length, met: 0, notMet: 0, pending: 0, unknown: 0 };
  const touched = new Set();
  for (const item of items) {
    const acted = startOfUtcDay(Date.parse(item.acted_at));
    const until = acted + Number(item.expected_outcome.withinDays || DEFAULTS.verifyWithinDays) * DAY_MS;
    const rows = item.invoice_ids.map((x) => byId.get(String(x)));
    let status;
    let outcome;
    if (rows.some((r) => !r)) {
      status = 'UNKNOWN';
      outcome = { reason: 'An invoice was removed from the ledger, so the outcome cannot be checked.' };
    } else {
      let collected = 0;
      const paidInvoices = [];
      for (const r of rows) {
        const d = r.payment_date ? Date.parse(String(r.payment_date instanceof Date ? r.payment_date.toISOString() : r.payment_date).slice(0, 10)) : NaN;
        const amt = Number(r.payment_amount) > 0 ? Number(r.payment_amount) : r.payment_status === 'Paid' ? Number(r.invoice_amount) : 0;
        if (Number.isFinite(d) && d >= acted && d <= until && amt > 0 && d <= asOf) { collected += amt; paidInvoices.push(String(r.id)); }
      }
      if (collected > 0) {
        status = 'MET';
        outcome = { collected: Math.round(collected * 100) / 100, paidInvoices };
      } else if (asOf >= until) {
        status = 'NOT_MET';
        outcome = { collected: 0, reason: `No payment recorded within ${item.expected_outcome.withinDays} days` };
      } else {
        summary.pending++;
        continue;
      }
    }
    outcome.attribution = item.action?.mode === 'SHADOW'
      ? 'Nothing was sent (shadow), so this measures what happens without a reminder.'
      : 'Reminder prepared for manual sending; Starlane cannot see whether it was sent.';
    outcome.expectedProbability = item.expected_outcome.baselineProbability;
    await pool.query(`UPDATE starlane_workflow_items SET outcome_status = $3, outcome = $4, verified_at = $5, updated_at = NOW() WHERE id = $1 AND user_id = $2 AND outcome_status = 'PENDING'`,
      [item.id, userId, status, JSON.stringify(outcome), asOfIso]);
    summary[status === 'MET' ? 'met' : status === 'NOT_MET' ? 'notMet' : 'unknown']++;
    touched.add(item.workflow_id);
  }
  for (const wid of touched) await learnFromWorkflow(pool, userId, wid, asOfIso);
  return summary;
}

// Wilson score interval for a proportion.
function wilson(k, n, z = 1.2816) {
  if (!n) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.round(((c - m) / d) * 1000) / 1000, Math.round(((c + m) / d) * 1000) / 1000];
}

/**
 * Experiment view of a workflow: expected (baseline) vs observed, split by
 * whether anything was acted on, with an 80% interval and a recommendation
 * only once there are enough resolved items.
 */
async function outcomeSummary(pool, userId, workflowId) {
  const r = await pool.query(
    `SELECT action->>'mode' AS mode, outcome_status, (expected_outcome->>'baselineProbability')::numeric AS p, (outcome->>'collected')::numeric AS collected
     FROM starlane_workflow_items WHERE user_id = $1 AND workflow_id = $2 AND outcome_status IN ('MET','NOT_MET')`,
    [userId, workflowId]
  );
  const groups = {};
  for (const row of r.rows) {
    const g = groups[row.mode] || (groups[row.mode] = { n: 0, met: 0, expected: 0, collected: 0 });
    g.n++;
    if (row.outcome_status === 'MET') g.met++;
    g.expected += Number(row.p || 0);
    g.collected += Number(row.collected || 0);
  }
  const out = {};
  for (const [mode, g] of Object.entries(groups)) {
    const observed = g.met / g.n;
    const expected = g.expected / g.n;
    const ci = wilson(g.met, g.n);
    let recommendation = 'KEEP_MEASURING';
    let why = `${g.n} resolved so far; at least 20 are needed before recommending a change.`;
    if (g.n >= 20 && ci) {
      if (mode === 'SHADOW') { recommendation = 'MOVE_TO_APPROVAL'; why = 'The baseline is measured. Move to approval to test whether reminders beat it.'; }
      else if (ci[0] > expected) { recommendation = 'EXPAND'; why = 'Even the low end of the observed rate beats the baseline.'; }
      else if (ci[1] < expected) { recommendation = 'STOP'; why = 'Even the high end of the observed rate is below the baseline.'; }
      else { recommendation = 'MODIFY'; why = 'No clear difference from the baseline yet; try a different trigger day or tone.'; }
    }
    out[mode] = {
      resolved: g.n,
      met: g.met,
      observedRate: Math.round(observed * 1000) / 1000,
      expectedRate: Math.round(expected * 1000) / 1000,
      difference: Math.round((observed - expected) * 1000) / 1000,
      interval80: ci,
      collected: Math.round(g.collected),
      recommendation,
      why,
    };
  }
  return out;
}

async function learnFromWorkflow(pool, userId, workflowId, asOfIso) {
  const wf = await getWorkflow(pool, userId, workflowId);
  if (!wf) return;
  const summary = await outcomeSummary(pool, userId, workflowId);
  for (const [mode, s] of Object.entries(summary)) {
    const p = paramsOf(wf);
    const statement = mode === 'SHADOW'
      ? `Without a reminder, ${s.met} of ${s.resolved} customers ${p.overdueDays}+ days overdue paid within 7 days (${Math.round(s.observedRate * 100)}%; the model expected ${Math.round(s.expectedRate * 100)}%).`
      : `With an approved reminder, ${s.met} of ${s.resolved} customers ${p.overdueDays}+ days overdue paid within 7 days (${Math.round(s.observedRate * 100)}%, against ${Math.round(s.expectedRate * 100)}% expected without one).`;
    await recordLearnedPattern(pool, userId, {
      patternKey: `workflow:${workflowId}:${mode.toLowerCase()}`,
      statement,
      scope: { workflowId, templateKey: wf.template_key, mode, overdueDays: p.overdueDays },
      sampleCount: s.resolved,
      confidence: s.resolved >= 20 ? 0.8 : s.resolved >= 5 ? 0.5 : 0.2,
      evidence: [{ label: 'Resolved items', value: s.resolved }, { label: '80% interval', value: s.interval80 }, { label: 'Expected rate', value: s.expectedRate }],
      asOfIso,
    });
  }
}

module.exports = {
  getWorkflow, listWorkflows, proposeWorkflow, transitionWorkflow, setAgentPermissions, simulateWorkflow,
  runWorkflow, listItems, decideItem, verifyOutcomes, outcomeSummary, paramsOf, wilson, withRetry, LIVE_STATUSES, assertUuid,
};
