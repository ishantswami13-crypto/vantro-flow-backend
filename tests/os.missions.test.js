// FILE: tests/os.missions.test.js
// Missions, "Handle it", Today, Agents and the funnel, over real HTTP
// against a real Postgres, plus the pure mapping from decision and contract
// state to mission state and outcome.
//
// Run: DATABASE_URL=... JWT_SECRET=... node --test tests/os.missions.test.js
// The HTTP tests skip (never pass silently) when no database or migration
// 061 is missing; the mapping tests always run.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dbReady, createTenant, deleteTenant, seedGolden, startServer, client, todayIso } = require('./helpers/decisionHarness');
const { decisionMission } = require('../lib/domain/os/missions');

const DAY = 86400000;

// ── Mapping (no database) ────────────────────────────────────────────────

const base = { id: 'd1', title: 'Recover overdue', options: [{ key: 'escalate', label: 'Escalate' }], selected_option: 'escalate' };

test('mission state follows the decision lifecycle', () => {
  assert.equal(decisionMission({ ...base, status: 'NEEDS_INFORMATION' }, null, []).state, 'WAITING_FOR_INFORMATION');
  assert.equal(decisionMission({ ...base, status: 'SELECTED' }, null, []).state, 'WAITING_FOR_APPROVAL');
  assert.equal(decisionMission({ ...base, status: 'APPROVED' }, null, []).state, 'PLANNING');
  assert.equal(decisionMission({ ...base, status: 'APPROVED' }, null, [{ step_index: 0, status: 'FAILED', error: 'provider down' }]).state, 'BLOCKED');
  assert.equal(decisionMission({ ...base, status: 'EXECUTING' }, null, []).state, 'RUNNING');
  assert.equal(decisionMission({ ...base, status: 'SHADOWED' }, { status: 'OPEN' }, []).state, 'VERIFYING');
  assert.equal(decisionMission({ ...base, status: 'REJECTED' }, null, []).state, 'STOPPED');
});

test('a mission is only completed once the ledger has been checked, and says how', () => {
  const met = decisionMission({ ...base, status: 'EXECUTED' }, { status: 'MET', attribution: 'OBSERVED_ASSOCIATION', verification: { reason: 'Paid ₹4.2L within 14 days' } }, []);
  assert.equal(met.state, 'COMPLETED');
  assert.equal(met.outcome.status, 'VERIFIED_SUCCESS');
  assert.equal(met.outcome.attribution, 'OBSERVED', 'a live outcome is an association, not proof of cause');
  const notMet = decisionMission({ ...base, status: 'EXECUTED' }, { status: 'NOT_MET', verification: { reason: 'Nothing paid' } }, []);
  assert.equal(notMet.outcome.status, 'VERIFIED_FAILURE');
  const unknown = decisionMission({ ...base, status: 'SHADOWED' }, { status: 'UNKNOWN', attribution: 'SHADOW_NO_ACTION_TAKEN' }, []);
  assert.equal(unknown.outcome.status, 'OUTCOME_UNKNOWN');
  assert.equal(unknown.outcome.attribution, 'NO_ACTION_TAKEN');
  const ran = decisionMission({ ...base, status: 'EXECUTED' }, { status: 'OPEN' }, [{ step_index: 0, status: 'SUCCEEDED' }]);
  assert.notEqual(ran.state, 'COMPLETED', 'steps that ran are not an outcome');
  assert.equal(ran.outcome.status, 'PENDING');
});

// ── HTTP (real database) ─────────────────────────────────────────────────

let env;
let server;
const tenants = [];

test.before(async () => {
  env = await dbReady();
  if (env.ok) {
    const r = await env.pool.query(`SELECT to_regclass('public.starlane_workflows') AS t`);
    if (!r.rows[0].t) env = { ok: false, reason: 'migration 061_operating_system.sql not applied' };
  }
  if (!env.ok) return;
  server = await startServer({ FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED: 'false', STARLANE_GLOBAL_STOP: '' });
});

test.after(async () => {
  if (server) await server.stop();
  if (env?.ok) {
    for (const t of tenants) await deleteTenant(env.pool, t.id).catch(() => {});
    await env.pool.end();
  }
});

async function tenant(label) {
  const t = await createTenant(env.pool, label);
  tenants.push(t);
  return t;
}

async function openDecision(c) {
  await c.post('/api/decisions/discover', {});
  const list = await c.get('/api/decisions');
  const open = (list.body.decisions || []).find((d) => d.status === 'OPEN');
  assert.ok(open, 'the golden ledger produces an open decision');
  return (await c.get(`/api/decisions/${open.id}`)).body.decision;
}

test('Handle it: waits for approval, respects the kill switch, runs once in shadow, and becomes a mission', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const a = await tenant('missions-a');
  const b = await tenant('missions-b');
  await seedGolden(env.pool, a.id, todayIso());
  const ca = client(server.base, a);
  const cb = client(server.base, b);
  const d = await openDecision(ca);

  // Another tenant cannot handle it.
  assert.equal((await cb.post(`/api/decisions/${d.id}/handle`, { approve: true })).status, 404);

  // Without approval: the option is chosen and the mission waits.
  const wait = await ca.post(`/api/decisions/${d.id}/handle`, {});
  assert.equal(wait.status, 202, JSON.stringify(wait.body));
  assert.equal(wait.body.mission.state, 'WAITING_FOR_APPROVAL');
  assert.deepEqual(wait.body.steps.map((s) => s.step), ['SELECTED']);

  // Kill switch on: approval is recorded but nothing executes.
  await ca.post('/api/decisions/controls', { scope: 'TENANT', stopped: true, reason: 'test' });
  const blocked = await ca.post(`/api/decisions/${d.id}/handle`, { approve: true });
  assert.equal(blocked.status, 423, JSON.stringify(blocked.body));
  await ca.post('/api/decisions/controls', { scope: 'TENANT', stopped: false });

  // Approved and executed in shadow mode.
  const done = await ca.post(`/api/decisions/${d.id}/handle`, {});
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const exec = done.body.steps.find((s) => s.step === 'EXECUTED');
  assert.equal(exec.mode, 'SHADOW');
  assert.equal(exec.status, 'SHADOWED');
  assert.equal(done.body.mission.state, 'VERIFYING');
  assert.equal(done.body.mission.outcome.status, 'PENDING', 'a shadow run is not an outcome');

  // A second press does nothing.
  const again = await ca.post(`/api/decisions/${d.id}/handle`, { approve: true });
  assert.equal(again.status, 409);
  const actions = await env.pool.query('SELECT COUNT(*)::int n FROM ai_actions WHERE user_id = $1 AND decision_id = $2', [a.id, d.id]);
  assert.equal(actions.rows[0].n, 0, 'shadow mode prepares no messages');

  // Missions lists it; the other tenant sees nothing.
  const ms = await ca.get('/api/os/missions');
  const m = ms.body.missions.find((x) => x.id === `decision:${d.id}`);
  assert.ok(m);
  assert.equal(m.assigned.agent, 'starlane.decision_engine');
  assert.equal((await cb.get('/api/os/missions')).body.missions.length, 0);

  // Checked against the ledger later: the mission reports the contract's verdict.
  const { verifyContract } = require('../lib/domain/decisions/verification');
  const v = await verifyContract(env.pool, a.id, d.id, { nowMs: Date.now() + 90 * DAY });
  const after = (await ca.get('/api/os/missions')).body.missions.find((x) => x.id === `decision:${d.id}`);
  const expected = { MET: 'VERIFIED_SUCCESS', NOT_MET: 'VERIFIED_FAILURE', UNKNOWN: 'OUTCOME_UNKNOWN' }[v.status || v.contract?.status];
  assert.ok(expected, JSON.stringify(v).slice(0, 300));
  assert.equal(after.outcome.status, expected);
  assert.equal(after.outcome.attribution, 'NO_ACTION_TAKEN');
});

test('Today, Agents and the funnel are counted from real rows and scoped to the tenant', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const empty = await tenant('today-empty');
  const ce = client(server.base, empty);
  const td0 = await ce.get('/api/os/today');
  assert.equal(td0.status, 200);
  assert.equal(td0.body.lines[0].key, 'connect', 'an empty tenant is told to connect data, not that all is well');
  assert.equal(td0.body.pilotMode, 'SHADOW');

  const a = await tenant('today-a');
  await seedGolden(env.pool, a.id, todayIso());
  const ca = client(server.base, a);
  const d = await openDecision(ca);
  await ca.get(`/api/decisions/${d.id}/evidence`);
  await ca.post(`/api/decisions/${d.id}/simulate`, { paymentSpeed: 0.5 });
  await ca.post(`/api/decisions/${d.id}/feedback`, { kind: 'WRONG', note: 'test' });

  const td = await ca.get('/api/os/today');
  const needs = td.body.lines.find((l) => l.key === 'needs_you');
  assert.match(needs.text, /decision/);
  assert.ok(td.body.counts.decisionsNeedYou >= 1);
  assert.equal(td.body.lines[td.body.lines.length - 1].key, 'stable');

  const f = await ca.get('/api/os/funnel');
  const at = Object.fromEntries(f.body.steps.map((s) => [s.key, s.at]));
  assert.ok(at.decisionOpened, 'opening a decision is recorded once');
  assert.ok(at.evidenceInspected);
  assert.ok(at.simulationRun);
  assert.equal(at.approved, null, 'nothing was approved');
  assert.equal(f.body.metrics.falsePositiveRate, 1, 'the only feedback said wrong');
  const opened = await env.pool.query(`SELECT COUNT(*)::int n FROM decision_events WHERE user_id = $1 AND decision_id = $2 AND event_type = 'DECISION_OPENED'`, [a.id, d.id]);
  await ca.get(`/api/decisions/${d.id}`);
  const openedAgain = await env.pool.query(`SELECT COUNT(*)::int n FROM decision_events WHERE user_id = $1 AND decision_id = $2 AND event_type = 'DECISION_OPENED'`, [a.id, d.id]);
  assert.equal(opened.rows[0].n, 1);
  assert.equal(openedAgain.rows[0].n, 1, 'reopening does not inflate the funnel');

  const ag = await ca.get('/api/os/agents');
  assert.equal(ag.body.agents.length, 4);
  assert.ok(ag.body.notBuilt.length >= 1, 'agents that do not exist are disclosed as not built');
  for (const x of ag.body.agents) assert.ok(!x.permissions.includes('EXECUTE'), `${x.name} cannot hold EXECUTE`);
  const engine = ag.body.agents.find((x) => x.key === 'starlane.decision_engine');
  assert.equal(engine.status, 'ACTIVE');
  assert.match(engine.performance, /0 of 1 feedback marks said useful/);
  await ca.post('/api/decisions/controls', { scope: 'AGENT', scopeKey: 'starlane.decision_engine', stopped: true, reason: 'test' });
  const stopped = (await ca.get('/api/os/agents')).body.agents.find((x) => x.key === 'starlane.decision_engine');
  assert.equal(stopped.status, 'STOPPED');
  assert.match(stopped.stoppedReason, /test/);
  await ca.post('/api/decisions/controls', { scope: 'AGENT', scopeKey: 'starlane.decision_engine', stopped: false });

  // The empty tenant sees none of it.
  const eAg = (await ce.get('/api/os/agents')).body.agents;
  assert.equal(eAg.reduce((s, x) => s + x.runs, 0), 0);
  assert.equal((await ce.get('/api/os/funnel')).body.reached, 0);
});
