// FILE: lib/domain/os/missions.js
// Missions: one list of everything Starlane is handling, whether it started
// as a Decision (an approved option run through the Action Fabric) or as a
// deployed Workflow (an automation that runs on a trigger).
//
// Nothing is stored here. A mission's state is derived from rows that
// already exist (decisions, decision_contracts, decision_action_runs,
// starlane_workflows, _runs, _items), so the Missions surface can never
// disagree with the decision or workflow it came from.
//
// States (directive §39): PLANNING, WAITING_FOR_INFORMATION,
// WAITING_FOR_APPROVAL, RUNNING, BLOCKED, VERIFYING, COMPLETED, FAILED,
// STOPPED. Outcome (§68): VERIFIED_SUCCESS, VERIFIED_FAILURE,
// OUTCOME_UNKNOWN, or PENDING while it is too early to tell.
// "Task completed" never means "outcome achieved": a mission whose steps
// all ran is VERIFYING until its contract or items are checked against the
// ledger.

const DECISION_MISSION_STATUSES = ['NEEDS_INFORMATION', 'SELECTED', 'APPROVED', 'EXECUTING', 'SHADOWED', 'EXECUTED', 'VERIFIED', 'REJECTED', 'RESOLVED'];

// Attribution (§69) is carried as stored: a shadow run took no action, and a
// live one is an observed association, never claimed as proof of cause.
const { AGENT: DECISION_AGENT } = require('../decisions/store');

const ATTRIBUTION = { SHADOW_NO_ACTION_TAKEN: 'NO_ACTION_TAKEN', OBSERVED_ASSOCIATION: 'OBSERVED' };

function outcomeFromContract(c) {
  if (!c) return { status: 'PENDING', detail: null };
  const base = outcomeStatus(c);
  return { ...base, attribution: c.attribution ? (ATTRIBUTION[c.attribution] || 'UNKNOWN') : null, attributionNote: c.verification?.attributionNote || null };
}

function outcomeStatus(c) {
  if (c.status === 'MET') return { status: 'VERIFIED_SUCCESS', detail: summariseVerification(c) };
  if (c.status === 'NOT_MET') return { status: 'VERIFIED_FAILURE', detail: summariseVerification(c) };
  if (c.status === 'UNKNOWN') return { status: 'OUTCOME_UNKNOWN', detail: summariseVerification(c) || 'The ledger did not show enough to say whether it worked.' };
  return { status: 'PENDING', detail: null };
}

function summariseVerification(c) {
  const v = c.verification;
  if (!v) return null;
  return v.reason || null;
}

function decisionMission(d, contract, runs, lastEvent) {
  const failedRuns = runs.filter((r) => ['FAILED', 'UNKNOWN', 'BLOCKED'].includes(r.status));
  const liveContract = contract && !['SUPERSEDED'].includes(contract.status) ? contract : null;
  const outcome = outcomeFromContract(liveContract);
  let state;
  let reason;
  switch (d.status) {
    case 'NEEDS_INFORMATION':
      state = 'WAITING_FOR_INFORMATION';
      reason = 'Starlane asked for information before this can go ahead.';
      break;
    case 'SELECTED':
      state = 'WAITING_FOR_APPROVAL';
      reason = 'An option is chosen. It runs only after you approve it.';
      break;
    case 'APPROVED':
      if (failedRuns.length) {
        state = 'BLOCKED';
        reason = failedRuns[failedRuns.length - 1].error || `A step ended ${failedRuns[failedRuns.length - 1].status.toLowerCase()}.`;
      } else {
        state = 'PLANNING';
        reason = 'Approved. Starlane has not started it yet.';
      }
      break;
    case 'EXECUTING':
      state = 'RUNNING';
      reason = 'Steps are running now.';
      break;
    case 'SHADOWED':
    case 'EXECUTED':
      if (outcome.status === 'PENDING') {
        state = 'VERIFYING';
        reason = d.status === 'SHADOWED'
          ? 'Ran in shadow mode: nothing changed outside Starlane. Watching the ledger to see what happens anyway.'
          : 'Steps ran. Watching the ledger to see whether the outcome follows.';
      } else {
        state = 'COMPLETED';
        reason = outcome.detail || 'Outcome checked against the ledger.';
      }
      break;
    case 'VERIFIED':
    case 'RESOLVED':
      state = 'COMPLETED';
      reason = outcome.detail || 'Closed.';
      break;
    case 'REJECTED':
      state = 'STOPPED';
      reason = d.resolution_reason || 'Stopped by a person.';
      break;
    default:
      state = 'PLANNING';
      reason = null;
  }
  const option = (d.options || []).find((o) => o.key === d.selected_option) || null;
  return {
    id: `decision:${d.id}`,
    source: 'DECISION',
    sourceId: d.id,
    title: d.title,
    objective: option ? option.label : null,
    state,
    stateReason: reason,
    mode: liveContract?.mode || runs[runs.length - 1]?.mode || null,
    outcome,
    steps: runs.map((r) => ({ index: r.step_index, intent: r.intent_type, adapter: r.adapter, status: r.status, mode: r.mode, error: r.error || null, wouldHave: r.would_have || null })),
    assigned: { agent: DECISION_AGENT.key, model: DECISION_AGENT.model, owner: 'you' },
    reviewAt: liveContract?.review_at || [],
    href: `/decisions/${d.id}`,
    startedAt: liveContract?.activated_at || d.updated_at,
    updatedAt: lastEvent || d.updated_at,
  };
}

function workflowMission(w, lastRun, items) {
  const awaiting = items.AWAITING_APPROVAL || 0;
  const pendingVerify = items.pendingVerify || 0;
  let state;
  let reason;
  if (w.status === 'PAUSED') {
    state = 'STOPPED';
    reason = w.decided_reason || 'Paused by a person.';
  } else if (lastRun && lastRun.status === 'FAILED') {
    state = 'FAILED';
    reason = 'The last run failed. The items it could not prepare were handed to a person.';
  } else if (lastRun && lastRun.status === 'STOPPED') {
    state = 'BLOCKED';
    const key = lastRun.stopped_reason?.key;
    reason = key === 'stale_data' ? 'Stopped: the data is too old to act on. Upload a fresh file.'
      : key === 'kill_switch' ? 'Stopped by a kill switch.'
        : key === 'permission_revoked' ? 'Stopped: the agent no longer has permission to prepare work.'
          : lastRun.stopped_reason?.detail || 'Stopped by a safety check.';
  } else if (awaiting) {
    state = 'WAITING_FOR_APPROVAL';
    reason = `${awaiting} prepared item${awaiting === 1 ? '' : 's'} wait${awaiting === 1 ? 's' : ''} for your approval.`;
  } else if (pendingVerify) {
    state = 'VERIFYING';
    reason = `${pendingVerify} handled item${pendingVerify === 1 ? '' : 's'} will be checked against the ledger after the wait period.`;
  } else if (!lastRun) {
    state = 'PLANNING';
    reason = 'Deployed. It has not run yet.';
  } else {
    state = 'RUNNING';
    reason = 'Deployed and watching for its trigger.';
  }
  const met = items.MET || 0;
  const notMet = items.NOT_MET || 0;
  const unknown = items.UNKNOWN || 0;
  const resolved = met + notMet;
  const outcome = resolved === 0
    ? { status: unknown ? 'OUTCOME_UNKNOWN' : 'PENDING', detail: null }
    // A tie is not a verdict either way.
    : { status: met > notMet ? 'VERIFIED_SUCCESS' : met < notMet ? 'VERIFIED_FAILURE' : 'OUTCOME_UNKNOWN', detail: `${met} of ${resolved} checked item${resolved === 1 ? '' : 's'} ended in the expected outcome.`, met, notMet };
  return {
    id: `workflow:${w.id}`,
    source: 'WORKFLOW',
    sourceId: w.id,
    title: w.name,
    objective: w.objective,
    state,
    stateReason: reason,
    mode: w.status === 'SHADOW' ? 'SHADOW' : w.status === 'WITH_APPROVAL' ? 'WITH_APPROVAL' : null,
    outcome,
    steps: (w.steps || []).map((s, i) => ({ index: i, intent: s.key, label: s.label, performer: s.performer, capability: s.capability })),
    counts: { awaitingApproval: awaiting, shadowed: items.SHADOWED || 0, preparedManual: items.PREPARED_MANUAL || 0, rejected: items.REJECTED || 0, failed: items.FAILED || 0, met, notMet },
    assigned: { agent: 'starlane.collections_agent', model: 'deterministic (no LLM)', owner: 'you' },
    lastRun: lastRun ? { status: lastRun.status, startedAt: lastRun.started_at, counts: lastRun.counts, stoppedReason: lastRun.stopped_reason } : null,
    href: '/missions',
    startedAt: w.deployed_at || w.created_at,
    updatedAt: lastRun?.started_at || w.updated_at,
  };
}

// Collection missions (table `missions`, migration 053) are started from
// Watch and Scan on the web and from the apps. They belong in the same list,
// linked to their own page. A database without 053 simply has none.
const COLLECTION_STATE = { draft: 'PLANNING', active: 'RUNNING', paused: 'STOPPED', completed: 'COMPLETED', failed: 'FAILED', cancelled: 'STOPPED' };
function collectionMission(m) {
  const state = COLLECTION_STATE[m.status] || 'PLANNING';
  const outcome = m.outcome && typeof m.outcome === 'object' ? m.outcome : null;
  const verdict = m.status === 'completed' ? 'VERIFIED_SUCCESS' : m.status === 'failed' ? 'VERIFIED_FAILURE' : 'PENDING';
  const reason = m.status === 'draft' ? 'Saved as a draft. Start it to begin tracking.'
    : m.status === 'active' ? `Tracking collections against the target${m.ends_at ? ` until ${new Date(m.ends_at).toISOString().slice(0, 10)}` : ''}.`
      : m.status === 'paused' ? 'Paused by a person.'
        : m.status === 'cancelled' ? 'Cancelled by a person.'
          : m.status === 'completed' ? 'Reached its target.' : 'Ended short of its target.';
  return {
    id: `collection:${m.id}`,
    source: 'COLLECTION',
    sourceId: m.id,
    title: m.title,
    objective: m.objective,
    state,
    stateReason: reason,
    mode: null,
    outcome: { status: verdict, detail: outcome?.summary || null },
    steps: [],
    counts: {},
    assigned: { agent: 'starlane.collections_mission', model: 'deterministic (no LLM)', owner: 'you' },
    lastRun: null,
    href: `/missions/${m.id}`,
    startedAt: m.activated_at || m.created_at,
    updatedAt: m.updated_at,
  };
}

async function listMissions(pool, userId) {
  const collections = await pool.query(`SELECT * FROM missions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 100`, [userId])
    .catch((e) => { if (e.code === '42P01') return { rows: [] }; throw e; });
  const [decs, wfs] = await Promise.all([
    pool.query(`SELECT * FROM decisions WHERE user_id = $1 AND status = ANY($2) AND (selected_option IS NOT NULL OR status = 'NEEDS_INFORMATION') ORDER BY updated_at DESC LIMIT 100`, [userId, DECISION_MISSION_STATUSES]),
    pool.query(`SELECT * FROM starlane_workflows WHERE user_id = $1 AND status IN ('SHADOW','WITH_APPROVAL','PAUSED') ORDER BY updated_at DESC`, [userId]),
  ]);
  const decisionIds = decs.rows.map((d) => d.id);
  const wfIds = wfs.rows.map((w) => w.id);
  const [contracts, runs, events, lastRuns, itemCounts] = await Promise.all([
    decisionIds.length ? pool.query(`SELECT * FROM decision_contracts WHERE user_id = $1 AND decision_id = ANY($2::uuid[]) ORDER BY created_at DESC`, [userId, decisionIds]) : { rows: [] },
    decisionIds.length ? pool.query(`SELECT * FROM decision_action_runs WHERE user_id = $1 AND decision_id = ANY($2::uuid[]) ORDER BY created_at`, [userId, decisionIds]) : { rows: [] },
    decisionIds.length ? pool.query(`SELECT decision_id, MAX(created_at) AS at FROM decision_events WHERE user_id = $1 AND decision_id = ANY($2::uuid[]) GROUP BY decision_id`, [userId, decisionIds]) : { rows: [] },
    wfIds.length ? pool.query(`SELECT DISTINCT ON (workflow_id) * FROM starlane_workflow_runs WHERE user_id = $1 AND workflow_id = ANY($2::uuid[]) ORDER BY workflow_id, started_at DESC`, [userId, wfIds]) : { rows: [] },
    wfIds.length ? pool.query(
      `SELECT workflow_id, status, outcome_status, COUNT(*)::int AS n FROM starlane_workflow_items WHERE user_id = $1 AND workflow_id = ANY($2::uuid[]) GROUP BY workflow_id, status, outcome_status`,
      [userId, wfIds]
    ) : { rows: [] },
  ]);
  const contractOf = new Map();
  for (const c of contracts.rows) if (!contractOf.has(c.decision_id) && c.status !== 'SUPERSEDED') contractOf.set(c.decision_id, c);
  const runsOf = new Map();
  for (const r of runs.rows) runsOf.set(r.decision_id, [...(runsOf.get(r.decision_id) || []), r]);
  const lastEventOf = new Map(events.rows.map((e) => [e.decision_id, e.at]));
  const lastRunOf = new Map(lastRuns.rows.map((r) => [r.workflow_id, r]));
  const itemsOf = new Map();
  for (const r of itemCounts.rows) {
    const acc = itemsOf.get(r.workflow_id) || {};
    acc[r.status] = (acc[r.status] || 0) + r.n;
    if (['MET', 'NOT_MET', 'UNKNOWN'].includes(r.outcome_status)) acc[r.outcome_status] = (acc[r.outcome_status] || 0) + r.n;
    if (['SHADOWED', 'PREPARED_MANUAL'].includes(r.status) && r.outcome_status === 'PENDING') acc.pendingVerify = (acc.pendingVerify || 0) + r.n;
    itemsOf.set(r.workflow_id, acc);
  }

  const missions = [
    ...decs.rows.map((d) => decisionMission(d, contractOf.get(d.id), runsOf.get(d.id) || [], lastEventOf.get(d.id))),
    ...wfs.rows.map((w) => workflowMission(w, lastRunOf.get(w.id), itemsOf.get(w.id) || {})),
    ...collections.rows.map(collectionMission),
  ].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  const byState = {};
  for (const m of missions) byState[m.state] = (byState[m.state] || 0) + 1;
  return { missions, byState };
}

async function getMission(pool, userId, missionId) {
  const { missions } = await listMissions(pool, userId);
  return missions.find((m) => m.id === missionId) || null;
}

module.exports = { listMissions, getMission, decisionMission, workflowMission, collectionMission };
