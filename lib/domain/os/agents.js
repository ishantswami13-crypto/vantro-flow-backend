// FILE: lib/domain/os/agents.js
// The workers that actually run in the seven-surface loop, with their real
// identity, permissions, run counts, last activity, kill-switch state and
// measured performance. Each entry is backed by code that runs today and by
// rows it writes; nothing here is a template or a placeholder.
//
// All four are deterministic code (no model). That is deliberate (§48): the
// money maths, policy and verification do not need a language model. The
// agent abstraction is separate from any model (§45): `model` is a field,
// and swapping it would not change identity, permissions or history.
//
// Agents from the directive that have no behaviour yet are listed under
// `notBuilt` with the reason, never as live workers.

const { checkStops } = require('../decisions/controls');
const { AGENT: DECISION_AGENT } = require('../decisions/store');
const { SCAN_AGENT } = require('./scan');
const { AGENT_KEY: COLLECTIONS_AGENT, AGENT_VERSION: COLLECTIONS_VERSION, MODEL, DEFAULTS } = require('./workflowTemplates');

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
];

function DECISION_DEFINITION_KEY() {
  return DECISION_AGENT.key;
}

// Agents named in the directive with no behaviour in this codebase yet.
const NOT_BUILT = [
  { name: 'Supplier risk agent', reason: 'Needs supplier, purchase and lead-time data that no connector provides yet.' },
  { name: 'Working capital agent', reason: 'Needs payables and a bank feed; only receivables are connected.' },
  { name: 'Research agent', reason: 'No external research source is connected, and Starlane does not invent market data.' },
  { name: 'Customer agent', reason: 'Beyond receivables follow-ups (Collections agent), no customer workflow exists yet.' },
  { name: 'Critic agent', reason: 'Not a separate worker. Each decision instead carries do-nothing, stress, sensitivity and unknowns computed in code; an independent model review is not built.' },
];

async function agentStats(pool, userId) {
  const q = (sql, params = [userId]) => pool.query(sql, params).then((r) => r.rows[0] || {}).catch(() => ({}));
  const [scan, decisions, collections, verifierItems, verifierContracts] = await Promise.all([
    q(`SELECT COUNT(*)::int AS runs, MAX(started_at) AS last FROM agent_runs WHERE user_id = $1 AND agent_key = $2`, [userId, SCAN_AGENT]),
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
  ]);
  const feedback = await q(
    `SELECT COUNT(*) FILTER (WHERE payload->>'kind' IN ('USEFUL','MATTERS'))::int AS useful,
            COUNT(*) FILTER (WHERE payload->>'kind' IN ('WRONG','NOT_IMPORTANT'))::int AS unhelpful,
            COUNT(*)::int AS total
       FROM decision_events WHERE user_id = $1 AND event_type = 'HUMAN_FEEDBACK'`
  );
  return { scan, decisions, collections, verifierItems, verifierContracts, feedback };
}

async function listAgents(pool, userId) {
  const s = await agentStats(pool, userId);
  const out = [];
  for (const d of DEFINITIONS) {
    const stop = await checkStops(pool, userId, { agentKey: d.key });
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
      budget: d.key === COLLECTIONS_AGENT ? `At most ${DEFAULTS.maxActionsPerRun} reminders per run (enforced); no model spend` : 'No model spend (deterministic)',
    });
  }
  return { agents: out, notBuilt: NOT_BUILT };
}

module.exports = { listAgents, VERIFIER_KEY, NOT_BUILT };
