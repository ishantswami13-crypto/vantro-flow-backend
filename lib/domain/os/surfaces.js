// FILE: lib/domain/os/surfaces.js
// The seven surfaces as one system. Each has one question, the backend
// capabilities that answer it (with their real status), and live counts.
// The capability list is an honest inventory: BUILT means backend behaviour
// and storage exist; PARTIAL means some of it; NOT_BUILT means nothing yet.

const SURFACES = [
  {
    key: 'BRIDGE', route: '/bridge', question: 'What is connected?', promise: 'Connect my company.',
    capabilities: [
      { name: 'Connector contract and health', status: 'BUILT', api: 'GET /api/os/bridge' },
      { name: 'Receivables file import (CSV/Excel) with mapping', status: 'BUILT', api: 'POST /api/decisions/import/*' },
      { name: 'Tally read sync (local agent)', status: 'PARTIAL', note: 'Read only; no write-back' },
      { name: 'Duplicate customer candidates (entity resolution)', status: 'BUILT', note: 'Never auto-merged' },
      { name: 'Teach Starlane (typed knowledge)', status: 'BUILT', api: 'POST /api/os/knowledge' },
      { name: 'Document extraction (PDF, contracts, SOPs)', status: 'NOT_BUILT' },
      { name: 'Busy, QuickBooks, Zoho Books, Xero, Odoo, SAP connectors', status: 'NOT_BUILT', note: 'Export to CSV/Excel and upload instead' },
      { name: 'Bank and CRM connectors', status: 'NOT_BUILT' },
    ],
  },
  {
    key: 'SCAN', route: '/scan', question: 'What did Starlane discover?', promise: 'Understand my company.',
    capabilities: [
      { name: 'Invoice-to-payment process reconstruction', status: 'BUILT', api: 'POST /api/os/scan' },
      { name: 'Bottleneck and documented-vs-actual', status: 'BUILT' },
      { name: 'Automation discovery with scored candidates', status: 'BUILT' },
      { name: 'Opportunities (dormant customers, cash from reliable payers)', status: 'BUILT' },
      { name: 'Constraint identification', status: 'PARTIAL', note: 'Receivables only; other constraints need more data' },
      { name: 'Walk-forward backtest with no future leakage', status: 'BUILT', api: 'POST /api/decisions/backtest' },
      { name: 'Purchase, order and inventory process discovery', status: 'NOT_BUILT' },
    ],
  },
  {
    key: 'WATCH', route: '/watch', question: 'What is changing?', promise: 'Tell me what matters.',
    capabilities: [
      { name: 'Objectives with health and forecast', status: 'BUILT', api: '/api/os/objectives' },
      { name: 'Collections autopilot (objective + workflow)', status: 'BUILT' },
      { name: 'Condition watches', status: 'BUILT', api: '/api/watches' },
      { name: 'Decision discovery with decision windows', status: 'BUILT', api: 'POST /api/decisions/discover' },
      { name: 'Morning brief', status: 'BUILT', api: 'GET /api/os/watch/brief' },
      { name: 'Cash, inventory, supplier, fulfilment autopilots', status: 'NOT_BUILT', note: 'Need bank, stock and order data' },
    ],
  },
  {
    key: 'SIMULATE', route: '/simulate', question: 'What could happen?', promise: 'Tell me what could happen.',
    capabilities: [
      { name: 'Decision routes incl. do nothing, P10/P50/P90, stress, sensitivity', status: 'BUILT', api: 'POST /api/decisions/:id/simulate' },
      { name: 'Workflow replay on history (automation test)', status: 'BUILT', api: 'POST /api/os/workflows/:id/simulate' },
      { name: 'Experiment view (expected vs observed, interval)', status: 'BUILT', note: 'Computed from verified workflow outcomes' },
      { name: 'Negotiation preparation', status: 'NOT_BUILT', note: 'Needs supplier price history' },
      { name: 'Resource contention across missions', status: 'NOT_BUILT' },
    ],
  },
  {
    key: 'PREPARED', route: '/prepared', question: 'What needs me?', promise: 'Tell me what needs me.',
    capabilities: [
      { name: 'Decision inbox', status: 'BUILT', api: 'GET /api/decisions' },
      { name: 'Automation proposals (deploy shadow / with approval / reject)', status: 'BUILT', api: '/api/os/workflows' },
      { name: 'Workflow approvals, enforced server-side', status: 'BUILT', api: '/api/os/workflows/items/:id/*' },
      { name: 'Prepared actions from recommendations', status: 'BUILT', api: '/api/intelligence/prepared' },
      { name: 'Information requests', status: 'BUILT', api: 'POST /api/decisions/:id/request-information' },
    ],
  },
  {
    key: 'MISSIONS', route: '/missions', question: 'What is being handled?', promise: 'Handle it.',
    capabilities: [
      { name: 'Missions list: every handled decision and deployed workflow with state and verified outcome', status: 'BUILT', api: 'GET /api/os/missions' },
      { name: 'Handle it: choose, approve and run a decision as a mission (shadow by default)', status: 'BUILT', api: 'POST /api/decisions/:id/handle' },
      { name: 'Workflow engine: trigger, conditions, steps, approvals, outcome', status: 'BUILT' },
      { name: 'Workflow from a sentence', status: 'BUILT', note: 'Overdue follow-ups only; deterministic parser' },
      { name: 'Idempotent items, re-planning, retry then hand to a person', status: 'BUILT' },
      { name: 'Agent identity, permissions and budgets per item', status: 'BUILT' },
      { name: 'Kill switches: tenant, agent, workflow, autopilot, action type, connector', status: 'BUILT' },
      { name: 'Decision execution (shadow/live) with contracts', status: 'BUILT', api: 'POST /api/decisions/:id/execute' },
      { name: 'Sending from workflows', status: 'NOT_BUILT', note: 'Manual completion required' },
      { name: 'Replenishment, supplier-risk and order-exception workflows', status: 'NOT_BUILT' },
    ],
  },
  {
    key: 'MEMORY', route: '/memory', question: 'What have we learned?', promise: 'Remember and improve.',
    capabilities: [
      { name: 'Outcome memory (expected vs actual) for workflows', status: 'BUILT', api: 'GET /api/os/memory' },
      { name: 'Decision contracts, verification and track record', status: 'BUILT', api: 'GET /api/decisions/track-record' },
      { name: 'Learned patterns with sample count and last verified', status: 'BUILT' },
      { name: 'Typed company knowledge', status: 'BUILT' },
      { name: 'Audit trail (append-only)', status: 'BUILT' },
      { name: 'Playbooks and similar-decision retrieval', status: 'NOT_BUILT' },
    ],
  },
];

async function surfaceCounts(pool, userId) {
  const one = (sql) => pool.query(sql, [userId]).then((r) => r.rows[0]?.n ?? 0).catch(() => null);
  const [connections, invoices, proposals, awaiting, openDecisions, deployed, objectivesAtRisk, verified, knowledge] = await Promise.all([
    one(`SELECT COUNT(*)::int AS n FROM data_connections WHERE user_id = $1 AND status = 'CONNECTED'`),
    one('SELECT COUNT(*)::int AS n FROM invoices WHERE user_id = $1'),
    one(`SELECT COUNT(*)::int AS n FROM starlane_workflows WHERE user_id = $1 AND status = 'PROPOSED'`),
    one(`SELECT COUNT(*)::int AS n FROM starlane_workflow_items WHERE user_id = $1 AND status = 'AWAITING_APPROVAL'`),
    one(`SELECT COUNT(*)::int AS n FROM decisions WHERE user_id = $1 AND status IN ('OPEN','NEEDS_INFORMATION')`),
    one(`SELECT COUNT(*)::int AS n FROM starlane_workflows WHERE user_id = $1 AND status IN ('SHADOW','WITH_APPROVAL')`),
    one(`SELECT COUNT(*)::int AS n FROM starlane_objectives WHERE user_id = $1 AND status = 'ACTIVE' AND last_health IN ('AT_RISK','OFF_TRACK')`),
    one(`SELECT COUNT(*)::int AS n FROM starlane_workflow_items WHERE user_id = $1 AND outcome_status IN ('MET','NOT_MET')`),
    one(`SELECT COUNT(*)::int AS n FROM starlane_knowledge WHERE user_id = $1 AND status = 'ACTIVE'`),
  ]);
  return {
    BRIDGE: { connections, invoices },
    SCAN: { proposals },
    WATCH: { objectivesAtRisk },
    SIMULATE: {},
    PREPARED: { decisions: openDecisions, approvals: awaiting, proposals },
    MISSIONS: { workflowsRunning: deployed },
    MEMORY: { verifiedOutcomes: verified, knowledge },
  };
}

async function surfaces(pool, userId) {
  const counts = await surfaceCounts(pool, userId);
  return {
    loop: ['BRIDGE', 'SCAN', 'WATCH', 'SIMULATE', 'PREPARED', 'MISSIONS', 'MEMORY'],
    surfaces: SURFACES.map((s) => ({ ...s, counts: counts[s.key] })),
  };
}

module.exports = { surfaces, SURFACES };
