// FILE: tests/os.agents.test.js
// Agents: the working capital agent's maths (pure), and over real HTTP
// against a real Postgres: run on demand, run history, run detail, kill
// switch, non-runnable agents, and tenant isolation of runs.
//
// Run: DATABASE_URL=... JWT_SECRET=... node --test tests/os.agents.test.js
// HTTP tests skip (never pass silently) without a database.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dbReady, createTenant, deleteTenant, seedGolden, startServer, client, todayIso } = require('./helpers/decisionHarness');
const { computeWorkingCapital } = require('../lib/domain/os/workingCapital');
const { cleanInstruction, horizonFromInstruction, readInstruction } = require('../lib/domain/os/agentWork');

const DAY = 86400000;
const asOfDay = Date.UTC(2026, 10, 3);
const iso = (d) => new Date(asOfDay + d * DAY).toISOString().slice(0, 10);

// ── Working capital maths (no database) ──────────────────────────────────

test('money in is only receivables due inside the horizon; late and disputed ones are kept apart', () => {
  const wc = computeWorkingCapital({
    asOfDay,
    horizonDays: 28,
    baseCurrency: 'INR',
    receivables: [
      { id: 'a', customerName: 'A', outstanding: 10000, dueDay: asOfDay + 2 * DAY, currency: 'INR' },
      { id: 'b', customerName: 'B', outstanding: 5000, dueDay: asOfDay + 20 * DAY, currency: 'INR' },
      { id: 'c', customerName: 'C', outstanding: 7000, dueDay: asOfDay - 10 * DAY, ageDays: 10, currency: 'INR' },
      { id: 'd', customerName: 'D', outstanding: 9000, dueDay: asOfDay + 3 * DAY, currency: 'INR', disputeOpen: true },
      { id: 'e', customerName: 'E', outstanding: 4000, dueDay: asOfDay + 60 * DAY, currency: 'INR' },
      { id: 'f', customerName: 'F', outstanding: 3000, dueDay: asOfDay + 1 * DAY, currency: 'USD' },
      { id: 'g', customerName: 'G', outstanding: 0, dueDay: asOfDay + 1 * DAY, currency: 'INR' },
    ],
    purchases: [],
  });
  assert.equal(wc.moneyIn, 15000);
  assert.equal(wc.inflow.overdue, 7000);
  assert.equal(wc.inflow.laterThanHorizon, 4000);
  assert.equal(wc.excluded.disputedReceivables, 1);
  assert.equal(wc.excluded.otherCurrencyReceivables, 1);
  assert.equal(wc.weeks.length, 4);
  assert.equal(wc.weeks[0].moneyIn, 10000);
  assert.equal(wc.weeks[2].moneyIn, 5000);
  assert.equal(wc.chaseFirst[0].customer, 'C');
  assert.ok(wc.unknowns.some((u) => /no purchases are recorded/i.test(u)), 'missing payables are unknown, not zero');
  assert.ok(wc.unknowns.some((u) => /bank/i.test(u)), 'it never claims a bank balance');
});

test('money out counts unpaid purchases, overdue ones land in week one, and the first short week is named', () => {
  const wc = computeWorkingCapital({
    asOfDay,
    horizonDays: 28,
    baseCurrency: 'INR',
    receivables: [{ id: 'a', customerName: 'A', outstanding: 10000, dueDay: asOfDay + 15 * DAY, currency: 'INR' }],
    purchases: [
      { id: 1, supplier_name: 'Steel Co', amount: 8000, paid_amount: 2000, status: 'partial', due_date: iso(-3) },
      { id: 2, supplier_name: 'Paper Co', amount: 9000, paid_amount: 0, status: 'unpaid', due_date: iso(9) },
      { id: 3, supplier_name: 'Paid Co', amount: 9000, paid_amount: 9000, status: 'paid', due_date: iso(2) },
      { id: 4, supplier_name: 'Later Co', amount: 1000, paid_amount: 0, status: 'unpaid', due_date: iso(40) },
      { id: 5, supplier_name: 'Open Co', amount: 500, paid_amount: 0, status: 'unpaid', due_date: null },
    ],
  });
  assert.equal(wc.outflow.overdue, 6000);
  assert.equal(wc.outflow.dueInHorizon, 9000);
  assert.equal(wc.moneyOut, 15000);
  assert.equal(wc.net, -5000);
  assert.equal(wc.weeks[0].moneyOut, 6000);
  assert.equal(wc.weeks[1].moneyOut, 9000);
  assert.equal(wc.firstShortWeek, 1);
  assert.equal(wc.payablesSoonest[0].supplier, 'Steel Co');
  assert.equal(wc.payablesSoonest[0].when, 'OVERDUE');
  assert.ok(!wc.payablesSoonest.some((p) => p.supplier === 'Paid Co'));
  assert.match(wc.headline, /gap from week 1/);
});

test('nothing open means NEEDS_DATA, not a zero forecast', () => {
  const wc = computeWorkingCapital({ asOfDay, receivables: [], purchases: [] });
  assert.equal(wc.status, 'NEEDS_DATA');
});

// ── Work instructions (no database) ─────────────────────────────────────

test('an instruction is cleaned and a fixed agent only takes what it can read from it', () => {
  assert.equal(cleanInstruction('   '), null);
  assert.equal(cleanInstruction(undefined), null);
  assert.equal(cleanInstruction('  next 60 days\u0000 please '), 'next 60 days please');
  assert.throws(() => cleanInstruction('x'.repeat(1001)), /under 1000/);
  assert.throws(() => cleanInstruction({ a: 1 }), /must be text/);

  assert.equal(horizonFromInstruction('Lay out the next 60 days'), 60);
  assert.equal(horizonFromInstruction('next 8 weeks'), 56);
  assert.equal(horizonFromInstruction('two months ahead'), 60);
  assert.equal(horizonFromInstruction('who should I chase?'), null);

  const wc = 'starlane.working_capital';
  const a = readInstruction(wc, 'next 6 weeks', { workingCapitalKey: wc });
  assert.equal(a.settings.horizonDays, 42);
  assert.match(a.understood, /42-day horizon/);
  const clamped = readInstruction(wc, 'next 365 days', { workingCapitalKey: wc });
  assert.equal(clamped.settings.horizonDays, 90, 'clamped to what the agent supports, and it says so');
  assert.match(clamped.understood, /used 90/);
  const other = readInstruction('starlane.scan', 'look at the last quarter', { workingCapitalKey: wc });
  assert.deepEqual(other.settings, {});
  assert.match(other.understood, /fixed code/);
  assert.deepEqual(readInstruction(wc, null, { workingCapitalKey: wc }), { settings: {}, understood: null });
});

// ── HTTP (real database) ─────────────────────────────────────────────────

let env;
let server;
const tenants = [];

test.before(async () => {
  env = await dbReady();
  if (env.ok) {
    const r = await env.pool.query(`SELECT to_regclass('public.agent_runs') AS a, to_regclass('public.starlane_workflows') AS w`);
    if (!r.rows[0].a || !r.rows[0].w) env = { ok: false, reason: 'migrations 043/061 not applied' };
  }
  if (!env.ok) return;
  server = await startServer({ FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED: 'false', STARLANE_GLOBAL_STOP: '' });
});

test.after(async () => {
  if (server) await server.stop();
  if (env?.ok) {
    for (const t of tenants) {
      await env.pool.query('DELETE FROM purchases WHERE user_id = $1', [t.id]).catch(() => {});
      await deleteTenant(env.pool, t.id).catch(() => {});
    }
    await env.pool.end();
  }
});

async function tenant(label) {
  const t = await createTenant(env.pool, label);
  tenants.push(t);
  return t;
}

test('the working capital agent runs on demand, records a run, and shows it in history', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const a = await tenant('wc-a');
  const b = await tenant('wc-b');
  await seedGolden(env.pool, a.id, todayIso());
  await env.pool.query(
    `INSERT INTO purchases (user_id, supplier_name, amount, paid_amount, status, due_date) VALUES ($1,'Steel Co',50000,0,'unpaid',CURRENT_DATE + 5), ($1,'Paid Co',9000,9000,'paid',CURRENT_DATE + 2)`,
    [a.id]
  );
  const ca = client(server.base, a);
  const cb = client(server.base, b);
  const key = 'starlane.working_capital';

  const list = await ca.get('/api/os/agents');
  assert.equal(list.status, 200);
  const wcAgent = list.body.agents.find((x) => x.key === key);
  assert.ok(wcAgent, 'the working capital agent is registered');
  assert.equal(wcAgent.runnable, true);
  assert.equal(wcAgent.status, 'IDLE');
  assert.ok(!list.body.notBuilt.some((n) => /working capital/i.test(n.name)), 'no longer listed as not built');

  const run = await ca.post(`/api/os/agents/${key}/run`, {});
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.status, 'COMPUTED');
  assert.equal(run.body.outflow.dueInHorizon, 50000, 'only the unpaid purchase counts');
  assert.ok(run.body.runId, 'the run is recorded');

  const after = (await ca.get('/api/os/agents')).body.agents.find((x) => x.key === key);
  assert.equal(after.runs, 1);
  assert.equal(after.status, 'ACTIVE');
  assert.equal(after.performance, run.body.headline);

  const runs = await ca.get(`/api/os/agents/${key}/runs`);
  assert.equal(runs.status, 200);
  assert.equal(runs.body.tracked, true);
  assert.equal(runs.body.runs.length, 1);
  assert.equal(runs.body.runs[0].id, run.body.runId);
  assert.equal(runs.body.runs[0].summary, run.body.headline);
  assert.equal(runs.body.runs[0].output, undefined, 'the list does not ship full outputs');

  const detail = await ca.get(`/api/os/agents/${key}/runs/${run.body.runId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.run.output.moneyOut, run.body.moneyOut);

  // Another tenant sees none of it.
  assert.equal((await cb.get(`/api/os/agents/${key}/runs/${run.body.runId}`)).status, 404);
  assert.equal((await cb.get(`/api/os/agents/${key}/runs`)).body.runs.length, 0);
  assert.equal((await cb.get('/api/os/agents')).body.agents.find((x) => x.key === key).runs, 0);

  // A run id under the wrong agent is not found.
  assert.equal((await ca.get(`/api/os/agents/starlane.scan/runs/${run.body.runId}`)).status, 404);
});

test('scan runs from the agents route too and returns its run id', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const a = await tenant('scan-run');
  await seedGolden(env.pool, a.id, todayIso());
  const ca = client(server.base, a);
  const scanKey = (await ca.get('/api/os/agents')).body.agents.find((x) => x.name === 'Scan').key;
  const run = await ca.post(`/api/os/agents/${encodeURIComponent(scanKey)}/run`, {});
  assert.equal(run.status, 200, JSON.stringify(run.body).slice(0, 400));
  assert.ok(run.body.runId);
  const runs = await ca.get(`/api/os/agents/${encodeURIComponent(scanKey)}/runs`);
  assert.equal(runs.body.runs[0].id, run.body.runId);
  assert.ok(runs.body.runs[0].summary, 'scan runs carry their summary');
});

test('kill switches stop on-demand runs; agents that run in their own flow cannot be started', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const a = await tenant('wc-stop');
  const ca = client(server.base, a);
  const key = 'starlane.working_capital';
  await ca.post('/api/decisions/controls', { scope: 'AGENT', scopeKey: key, stopped: true, reason: 'test stop' });
  const stopped = await ca.post(`/api/os/agents/${key}/run`, {});
  assert.equal(stopped.status, 423);
  assert.equal((await ca.get('/api/os/agents')).body.agents.find((x) => x.key === key).status, 'STOPPED');
  const runs = await env.pool.query('SELECT COUNT(*)::int AS n FROM agent_runs WHERE user_id = $1', [a.id]);
  assert.equal(runs.rows[0].n, 0, 'a stopped agent writes no run');
  await ca.post('/api/decisions/controls', { scope: 'AGENT', scopeKey: key, stopped: false });
  assert.equal((await ca.post(`/api/os/agents/${key}/run`, {})).status, 200);

  assert.equal((await ca.post('/api/os/agents/starlane.collections_agent/run', {})).status, 409);
  assert.equal((await ca.get('/api/os/agents/no.such.agent/runs')).status, 404);
  const verifier = await ca.get('/api/os/agents/starlane.outcome_verifier/runs');
  assert.equal(verifier.status, 200);
  assert.equal(verifier.body.tracked, false, 'agents without a run log say so');
});

test('a person gives an agent work: the instruction is stored on the run and read where it can be', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const a = await tenant('wc-work');
  const b = await tenant('wc-work-b');
  await seedGolden(env.pool, a.id, todayIso());
  const ca = client(server.base, a);
  const key = 'starlane.working_capital';

  const run = await ca.post(`/api/os/agents/${key}/run`, { instruction: 'Lay out the next 8 weeks and tell me which week runs short' });
  assert.equal(run.status, 200, JSON.stringify(run.body).slice(0, 400));
  assert.equal(run.body.horizonDays, 56, 'the horizon came from the instruction');
  assert.match(run.body.understood, /56-day horizon/);
  const detail = await ca.get(`/api/os/agents/${key}/runs/${run.body.runId}`);
  assert.equal(detail.body.run.input.instruction, 'Lay out the next 8 weeks and tell me which week runs short');
  assert.equal(detail.body.run.input.horizonDays, 56);

  assert.equal((await ca.post(`/api/os/agents/${key}/run`, { instruction: 'x'.repeat(1001) })).status, 400);
  assert.equal((await ca.post(`/api/os/agents/${key}/run`, { instruction: 42 })).status, 400);

  // Another tenant cannot read the instruction.
  assert.equal((await client(server.base, b).get(`/api/os/agents/${key}/runs/${run.body.runId}`)).status, 404);
});

test('the decision engine can be started on demand; it prepares decisions and sends nothing', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const a = await tenant('de-run');
  await seedGolden(env.pool, a.id, todayIso());
  const ca = client(server.base, a);
  const key = 'starlane.decision_engine';
  assert.equal((await ca.get('/api/os/agents')).body.agents.find((x) => x.key === key).runnable, true);
  const run = await ca.post(`/api/os/agents/${key}/run`, { instruction: 'Find what needs me this week' });
  assert.equal(run.status, 200, JSON.stringify(run.body).slice(0, 400));
  assert.ok(run.body.runId, 'the run is recorded and its id returned');
  const detail = await ca.get(`/api/os/agents/${key}/runs/${run.body.runId}`);
  assert.equal(detail.body.run.input.instruction, 'Find what needs me this week');
  const sent = await env.pool.query(`SELECT COUNT(*)::int AS n FROM outbound_messages WHERE user_id = $1`, [a.id]).catch(() => ({ rows: [{ n: 0 }] }));
  assert.equal(sent.rows[0].n, 0, 'starting the agent sends no message');
});
