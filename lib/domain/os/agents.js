// FILE: lib/domain/os/agents.js
// The workers that actually run in the seven-surface loop, with their real
// identity, permissions, run counts, last activity, kill-switch state and
// measured performance. Each entry is backed by code that runs today and by
// rows it writes; nothing here is a template or a placeholder.
//
// All five are deterministic code (no model). That is deliberate (§48): the
// money maths, policy and verification do not need a language model. The
// agent abstraction is separate from any model (§45): `model` is a field,
// and swapping it would not change identity, permissions or history.
//
// Agents from the directive that have no behaviour yet are listed under
// `notBuilt` with the reason, never as live workers.

const { loadActiveStops, evaluateStops } = require('../decisions/controls');
const { AGENT: DECISION_AGENT } = require('../decisions/store');
const { SCAN_AGENT } = require('./scan');
const { AGENT_KEY: COLLECTIONS_AGENT, AGENT_VERSION: COLLECTIONS_VERSION, MODEL, DEFAULTS } = require('./workflowTemplates');

const { AGENT_KEY: WORKING_CAPITAL_AGENT } = require('./workingCapital');

const VERIFIER_KEY = 'starlane.outcome_verifier';

const DEFINITIONS = [
  {
    key: SCAN_AGENT,
    name: 'Scan',
    purpose: 'Rebuilds the invoice-to-payment process from the ledger, finds the bottleneck, scores automation candidates and proposes workflows.',
    performs: ['Read invoices, customers and payments', 'Reconstruct process timing', 'Propose a workflow for your review'],
    permissions: ['READ', 'ANALYZE', 'PROPOSE'],
    cannot: ['Deploy a workflow', 'Contact anyone', 'Change a record'],
  },
  {
    key: DECISION_DEFINITION_KEY(),
    name: 'Decision engine',
    purpose: 'Finds receivable decisions worth your time, builds the options including doing nothing, simulates each and recommends one.',
    performs: ['Detect material changes', 'Build options and simulate them', 'Run approved options through the action fabric'],
    permissions: ['READ', 'ANALYZE', 'PREPARE', 'EXECUTE_APPROVED_INTERNAL'],
    cannot: ['Approve its own recommendation', 'Send a message in shadow mode', 'Mark an invoice paid or change an amount'],
  },
  {
    key: COLLECTIONS_AGENT,
    name: 'Collections agent',
    purpose: 'Runs the overdue follow-up workflow: picks customers past the trigger, drafts a reminder from ledger facts only, and waits for your approval.',
    performs: ['Draft reminders from ledger facts', 'Skip disputed and small balances', 'Hand failures to a person after one retry'],
    permissions: ['READ', 'ANALYZE', 'PREPARE'],
    cannot: ['Send a message', 'Change a draft after approval', 'Grant itself permission to execute'],
  },
  {
    key: VERIFIER_KEY,
    name: 'Outcome verifier',
    purpose: 'Checks, from the ledger and after a waiting period, whether what was expected actually happened. It never grades itself: the recommender does not verify its own outcome.',
    performs: ['Compare expected with observed payments', 'Mark outcomes verified, failed or unknown', 'Write learned patterns with their sample count'],
    permissions: ['READ', 'RECORD_OUTCOME'],
    cannot: ['Take any action', 'Change a recommendation'],
  },
  {
    key: WORKING_CAPITAL_AGENT,
    name: 'Working capital agent',
    purpose: 'Lays out the next 30 days of money due in from customers against money owed to suppliers, week by week, and names the first week that runs short.',
    performs: ['Read open invoices and unpaid purchases', 'Bucket money in and out by due date', 'Name overdue customers to chase and suppliers due soonest'],
    permissions: ['READ', 'ANALYZE'],
    cannot: ['Pay or reschedule a supplier', 'Contact anyone', 'Assume a bank balance it cannot see'],
  },
];

// Agents a person can run on demand from the Agents page. The others run
// inside their own flows (decisions discovery, workflow runs, verification).
const RUNNABLE = new Set([SCAN_AGENT, WORKING_CAPITAL_AGENT]);

// Keys whose runs are written to agent_runs (so run history is real for them).
// The collections agent and verifier record per item in
// starlane_workflow_items instead.
const RUN_LEDGER = new Set([SCAN_AGENT, DECISION_AGENT.key, WORKING_CAPITAL_AGENT]);

function DECISION_DEFINITION_KEY() {
  return DECISION_AGENT.key;
}

// Agents named in the directive with no behaviour in this codebase yet.
const NOT_BUILT = [
  { name: 'Supplier risk agent', reason: 'Needs supplier, purchase and lead-time data that no connector provides yet.' },
  { name: 'Research agent', reason: 'No external research source is connected, and Starlane does not invent market data.' },
  { name: 'Customer agent', reason: 'Beyond receivables follow-ups (Collections agent), no customer workflow exists yet.' },
  { name: 'Critic agent', reason: 'Not a separate worker. Each decision instead carries do-nothing, stress, sensitivity and unknowns computed in code; an independent model review is not built.' },
];

async function agentStats(pool, userId) {
  const q = (sql, params = [userId]) => pool.query(sql, params).then((r) => r.rows[0] || {}).catch(() => ({}));
  const [ledger, decisions, collections, verifierItems, verifierContracts, feedback, stops] = await Promise.all([
    pool.query(
      `SELECT agent_key, COUNT(*)::int AS runs, MAX(started_at) AS last
         FROM agent_runs WHERE user_id = $1 AND agent_key = ANY($2::text[]) GROUP BY agent_key`,
      [userId, [SCAN_AGENT, WORKING_CAPITAL_AGENT]]
    ).then((r) => Object.fromEntries(r.rows.map((x) => [x.agent_key, x]))).catch(() => ({})),
    q(`SELECT COUNT(*)::int AS runs, MAX(created_at) AS last,
              COUNT(*) FILTER (WHERE event_type = 'DISCOVERED')::int AS discovered
         FROM decision_events WHERE user_id = $1 AND agent_key = $2`, [userId, DECISION_AGENT.key]),
    q(`SELECT COUNT(*)::int AS items, MAX(created_at) AS last,
              COUNT(*) FILTER (WHERE outcome_status = 'MET')::int AS met,
              COUNT(*) FILTER (WHERE outcome_status = 'NOT_MET')::int AS not_met,
              COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected
         FROM starlane_workflow_items WHERE user_id = $1`),
    q(`SELECT COUNT(*)::int AS n, MAX(verified_at) AS last FROM starlane_workflow_items WHERE user_id = $1 AND outcome_status IN ('MET','NOT_MET','UNKNOWN')`),
    q(`SELECT COUNT(*)::int AS n, MAX(verified_at) AS last FROM decision_contracts WHERE user_id = $1 AND status IN ('MET','NOT_MET','UNKNOWN')`),
    q(`SELECT COUNT(*) FILTER (WHERE payload->>'kind' IN ('USEFUL','MATTERS'))::int AS useful,
              COUNT(*) FILTER (WHERE payload->>'kind' IN ('WRONG','NOT_IMPORTANT'))::int AS unhelpful,
              COUNT(*)::int AS total
         FROM decision_events WHERE user_id = $1 AND event_type = 'HUMAN_FEEDBACK'`),
    // One read of the kill switches for every agent, not one per agent.
    loadActiveStops(pool, userId),
  ]);
  const latestWc = ledger[WORKING_CAPITAL_AGENT]
    ? await q(`SELECT output_json->>'headline' AS headline FROM agent_runs WHERE user_id = $1 AND agent_key = $2 AND status = 'completed' ORDER BY started_at DESC LIMIT 1`, [userId, WORKING_CAPITAL_AGENT])
    : {};
  return {
    scan: ledger[SCAN_AGENT] || {},
    workingCapital: { ...(ledger[WORKING_CAPITAL_AGENT] || {}), headline: latestWc.headline || null },
    decisions, collections, verifierItems, verifierContracts, feedback, stops,
  };
}

async function listAgents(pool, userId) {
  const s = await agentStats(pool, userId);
  const out = [];
  for (const d of DEFINITIONS) {
    const stop = evaluateStops(s.stops, { agentKey: d.key });
    let runs = 0;
    let last = null;
    let performance = null;
    if (d.key === SCAN_AGENT) {
      runs = s.scan.runs || 0; last = s.scan.last || null;
    } else if (d.key === DECISION_AGENT.key) {
      runs = s.decisions.runs || 0; last = s.decisions.last || null;
      if (s.feedback.total) performance = `${s.feedback.useful} of ${s.feedback.total} feedback marks said useful; ${s.feedback.unhelpful} said wrong or not important.`;
      else if (s.decisions.discovered) performance = `${s.decisions.discovered} decisions discovered. No feedback yet, so usefulness is not measured.`;
    } else if (d.key === COLLECTIONS_AGENT) {
      runs = s.collections.items || 0; last = s.collections.last || null;
      const resolved = (s.collections.met || 0) + (s.collections.not_met || 0);
      performance = resolved ? `${s.collections.met} of ${resolved} checked follow-ups ended in a payment within 7 days.` : runs ? 'No follow-up has reached its check date yet.' : null;
    } else if (d.key === VERIFIER_KEY) {
      runs = (s.verifierItems.n || 0) + (s.verifierContracts.n || 0);
      const dates = [s.verifierItems.last, s.verifierContracts.last].filter(Boolean).map((x) => new Date(x));
      last = dates.length ? new Date(Math.max(...dates)) : null;
    } else if (d.key === WORKING_CAPITAL_AGENT) {
      runs = s.workingCapital.runs || 0; last = s.workingCapital.last || null;
      performance = s.workingCapital.headline || null;
    }
    out.push({
      key: d.key,
      name: d.name,
      purpose: d.purpose,
      model: d.key === COLLECTIONS_AGENT ? MODEL : 'deterministic (no LLM)',
      version: d.key === COLLECTIONS_AGENT ? COLLECTIONS_VERSION : d.key === DECISION_AGENT.key ? DECISION_AGENT.version : null,
      performs: d.performs,
      permissions: d.permissions,
      cannot: d.cannot,
      status: !stop.allowed ? 'STOPPED' : runs ? 'ACTIVE' : 'IDLE',
      stoppedReason: stop.allowed ? null : stop.blockedBy.map((b) => b.reason).join('; '),
      runs,
      lastRunAt: last,
      performance,
      // No model is called, so there is no token spend to budget. The
      // collections agent's action budget is enforced per run in
      // workflows.runWorkflow (extra targets are deferred, not dropped).
      runnable: RUNNABLE.has(d.key),
      runHistory: RUN_LEDGER.has(d.key),
      budget: d.key === COLLECTIONS_AGENT ? `At most ${DEFAULTS.maxActionsPerRun} reminders per run (enforced); no model spend` : 'No model spend (deterministic)',
    });
  }
  return { agents: out, notBuilt: NOT_BUILT };
}

// ── Run history ──────────────────────────────────────────────────────
// Reads agent_runs, always scoped to the signed-in tenant.

function summarizeRun(agentKey, out) {
  if (!out || typeof out !== 'object') return null;
  if (out.headline) return out.headline;
  if (agentKey === DECISION_AGENT.key && out.discovered != null) return `${out.discovered} discovered, ${out.revised || 0} revised, ${out.resolved || 0} resolved.`;
  if (Array.isArray(out.summary) && out.summary.length) return out.summary.join(' ');
  return null;
}

function runView(row, { full = false } = {}) {
  const started = row.started_at ? new Date(row.started_at) : null;
  const finished = row.finished_at ? new Date(row.finished_at) : null;
  const view = {
    id: row.id,
    agentKey: row.agent_key,
    status: row.status,
    startedAt: started,
    finishedAt: finished,
    durationMs: started && finished ? finished - started : null,
    summary: summarizeRun(row.agent_key, row.output_json),
    error: row.error_text ? String(row.error_text).slice(0, 500) : null,
  };
  if (full) { view.input = row.input_json || null; view.output = row.output_json || null; }
  return view;
}

function knownAgent(key) {
  return DEFINITIONS.find((d) => d.key === key) || null;
}

function notFound(msg) {
  return Object.assign(new Error(msg), { status: 404 });
}

async function listRuns(pool, userId, agentKey, { limit = 20, before = null } = {}) {
  if (!knownAgent(agentKey)) throw notFound(`No agent "${agentKey}" runs in this workspace`);
  if (!RUN_LEDGER.has(agentKey)) return { agentKey, tracked: false, runs: [], note: 'This agent records each item it handles on Missions instead of a run log.' };
  const n = Math.max(1, Math.min(100, Number(limit) || 20));
  const params = [userId, agentKey, n + 1];
  let cursor = '';
  if (before) {
    const t = new Date(before);
    if (Number.isNaN(t.getTime())) throw Object.assign(new Error('before must be a timestamp'), { status: 400 });
    params.push(t.toISOString());
    cursor = 'AND started_at < $4';
  }
  // Only the columns the list needs; output_json can be large (scan results),
  // so the list pulls just the fields the summary reads.
  const r = await pool.query(
    `SELECT id, agent_key, status, started_at, finished_at, error_text,
            jsonb_build_object(
              'headline', output_json->'headline',
              'discovered', output_json->'discovered', 'revised', output_json->'revised', 'resolved', output_json->'resolved',
              'summary', output_json->'summary'
            ) AS output_json
       FROM agent_runs WHERE user_id = $1 AND agent_key = $2 ${cursor}
      ORDER BY started_at DESC LIMIT $3`,
    params
  );
  const rows = r.rows.slice(0, n);
  return {
    agentKey,
    tracked: true,
    runs: rows.map((x) => runView(x)),
    nextBefore: r.rows.length > n ? rows[rows.length - 1].started_at : null,
  };
}

async function getRun(pool, userId, agentKey, runId) {
  if (!knownAgent(agentKey)) throw notFound(`No agent "${agentKey}" runs in this workspace`);
  if (!/^[0-9a-f-]{36}$/i.test(String(runId || ''))) throw notFound('Run not found');
  const r = await pool.query(
    `SELECT id, agent_key, status, started_at, finished_at, input_json, output_json, error_text
       FROM agent_runs WHERE user_id = $1 AND agent_key = $2 AND id = $3`,
    [userId, agentKey, runId]
  );
  if (!r.rows[0]) throw notFound('Run not found');
  return runView(r.rows[0], { full: true });
}

module.exports = { listAgents, listRuns, getRun, VERIFIER_KEY, NOT_BUILT, RUNNABLE, RUN_LEDGER, WORKING_CAPITAL_AGENT };
