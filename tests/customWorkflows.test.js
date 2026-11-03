// FILE: tests/customWorkflows.test.js
// Custom workflows: validation (pure), schedules (pure), the runner with
// stubbed agents against a real Postgres, and the HTTP API end to end with
// real agents, tenant isolation and the kill switch. Also covers the region
// settings API.
//
// Run: DATABASE_URL=... JWT_SECRET=... node --test tests/customWorkflows.test.js
// Database tests skip (never pass silently) without a database.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dbReady, createTenant, deleteTenant, seedGolden, startServer, client, todayIso } = require('./helpers/decisionHarness');
const cw = require('../lib/domain/workflows/customWorkflows');

// ── Validation (no database) ─────────────────────────────────────────────

test('every starter template validates', () => {
  for (const t of cw.TEMPLATES) {
    const v = cw.validateDefinition(t.definition);
    assert.ok(v.ok, `${t.key}: ${v.errors.join('; ')}`);
  }
});

test('a workflow cannot use a trigger, agent or action that is not built', () => {
  const comingSoonTrigger = cw.validateDefinition({ trigger: { type: 'payment_received' }, steps: [{ id: 'a', type: 'agent', agent: 'starlane.scan' }] });
  assert.equal(comingSoonTrigger.ok, false);
  assert.match(comingSoonTrigger.errors[0], /not available yet/);

  const comingSoonAgent = cw.validateDefinition({ trigger: { type: 'manual' }, steps: [{ id: 'a', type: 'agent', agent: 'starlane.research' }] });
  assert.equal(comingSoonAgent.ok, false);

  const comingSoonAction = cw.validateDefinition({ trigger: { type: 'manual' }, steps: [
    { id: 'a', type: 'agent', agent: 'starlane.scan' },
    { id: 'b', type: 'action', action: 'send_whatsapp', params: { title: 'x' } },
  ] });
  assert.equal(comingSoonAction.ok, false);
  assert.match(comingSoonAction.errors[0], /not available yet/);

  for (const a of cw.ACTIONS.filter((x) => x.availability !== 'available')) assert.ok(a.reason, `${a.key} says why it is not available`);
  // Every live action that reaches outside Starlane names the server flag that gates it.
  for (const a of cw.ACTIONS.filter((x) => x.availability === 'available' && x.external)) assert.ok(a.flag, `${a.key} is behind a flag`);
  assert.deepEqual(cw.ACTIONS.filter((x) => x.availability === 'available' && !x.external).map((x) => x.key), ['notify_owner', 'create_task']);
});

test('conditions must test an earlier agent step and a number it really produces', () => {
  const before = cw.validateDefinition({ trigger: { type: 'manual' }, steps: [
    { id: 'c', type: 'condition', signal: 'cash.gap', op: 'gt', value: 0 },
    { id: 'cash', type: 'agent', agent: 'starlane.working_capital' },
  ] });
  assert.equal(before.ok, false);
  const unknownField = cw.validateDefinition({ trigger: { type: 'manual' }, steps: [
    { id: 'cash', type: 'agent', agent: 'starlane.working_capital' },
    { id: 'c', type: 'condition', signal: 'cash.profit', op: 'gt', value: 0 },
  ] });
  assert.equal(unknownField.ok, false);
  const noValue = cw.validateDefinition({ trigger: { type: 'manual' }, steps: [
    { id: 'cash', type: 'agent', agent: 'starlane.working_capital' },
    { id: 'c', type: 'condition', signal: 'cash.gap', op: 'gt', value: '' },
  ] });
  assert.equal(noValue.ok, false);
  const ok = cw.validateDefinition({ trigger: { type: 'schedule', every: 'weekly', weekday: 'fri', hour: 17 }, steps: [
    { id: 'cash', type: 'agent', agent: 'starlane.working_capital', params: { horizonDays: '14' } },
    { id: 'c', type: 'condition', signal: 'cash.firstShortWeek', op: 'exists' },
    { id: 'n', type: 'action', action: 'notify_owner', params: { title: '  Short week ahead  ', includeSummaryOf: 'cash' } },
  ] });
  assert.ok(ok.ok, ok.errors.join('; '));
  assert.equal(ok.definition.steps[0].params.horizonDays, 14);
  assert.equal(ok.definition.steps[2].params.title, 'Short week ahead');
  assert.equal(ok.definition.steps[1].value, undefined, 'exists takes no value');
});

test('schedules fire once per local day in the business timezone', () => {
  const trig = { type: 'schedule', every: 'daily', hour: 9 };
  // 13:05 UTC = 09:05 in New York (EDT, UTC-4) on 2026-10-05.
  const t = Date.UTC(2026, 9, 5, 13, 5);
  assert.equal(cw.scheduleSlot(trig, 'America/New_York', t), 'schedule:2026-10-05');
  assert.equal(cw.scheduleSlot(trig, 'America/New_York', t + 45 * 60000), 'schedule:2026-10-05', 'every tick in the hour claims the same slot');
  assert.equal(cw.scheduleSlot(trig, 'America/New_York', t + 60 * 60000), null);
  assert.equal(cw.scheduleSlot(trig, 'Asia/Kolkata', t), null, 'a different timezone is a different hour');
  const weekly = { type: 'schedule', every: 'weekly', weekday: 'mon', hour: 9 };
  assert.equal(cw.scheduleSlot(weekly, 'America/New_York', t), 'schedule:2026-10-05', '2026-10-05 is a Monday');
  assert.equal(cw.scheduleSlot(weekly, 'America/New_York', t + 86400000), null);
  const next = cw.nextRunAt(weekly, 'America/New_York', t + 86400000);
  assert.equal(next, new Date(Date.UTC(2026, 9, 12, 13, 0)).toISOString());
});

test('working capital outputs: a gap is how far money out exceeds money in, never negative', () => {
  assert.equal(cw.extractOutputs('starlane.working_capital', { net: -5000, moneyIn: 1, moneyOut: 2, inflow: { overdue: 3 }, firstShortWeek: 2 }).gap, 5000);
  assert.equal(cw.extractOutputs('starlane.working_capital', { net: 800 }).gap, 0);
  assert.equal(cw.extractOutputs('starlane.working_capital', { status: 'NEEDS_DATA' }).gap, null, 'no data is no value, not zero');
  assert.equal(cw.evaluateCondition({ signal: 'a.gap', op: 'gt', value: 0 }, { a: { gap: null } }).passed, false);
});

// ── Database ────────────────────────────────────────────────────────────

let env;
let server;
const tenants = [];

test.before(async () => {
  env = await dbReady();
  if (env.ok) {
    const r = await env.pool.query(`SELECT to_regclass('public.starlane_custom_workflows') AS w, to_regclass('public.agent_runs') AS a, to_regclass('public.notification_events') AS n`);
    if (!r.rows[0].w || !r.rows[0].a || !r.rows[0].n) env = { ok: false, reason: 'migrations 043/052/068 not applied' };
  }
  if (!env.ok) return;
  server = await startServer({ FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED: 'false', STARLANE_GLOBAL_STOP: '', FEATURE_CUSTOM_WORKFLOW_SCHEDULER_ENABLED: 'false' });
});

test.after(async () => {
  if (server) await server.stop();
  if (env?.ok) {
    for (const t of tenants) {
      for (const tbl of ['notification_events', 'purchases', 'starlane_controls', 'starlane_definition_versions', 'starlane_tenant_settings']) {
        await env.pool.query(`DELETE FROM ${tbl} WHERE user_id = $1`, [t.id]).catch(() => {});
      }
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

test('the runner chains agents, stops at an unmet condition, and a slot runs once', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const a = await tenant('cw-runner');
  const wf = await cw.createWorkflow(env.pool, a.id, { name: 'Cash', definition: cw.TEMPLATES[0].definition });
  const calls = [];
  const notes = [];
  const runAgent = async (key) => { calls.push(key); return { status: 'COMPUTED', net: -1200, moneyIn: 100, moneyOut: 1300, inflow: { overdue: 0 }, firstShortWeek: 1, headline: 'Short by 1,200' }; };
  const notifyFn = async (userId, n) => { notes.push({ userId, ...n }); return { id: 'n1' }; };

  const r1 = await cw.executeWorkflow(env.pool, a.id, wf, { trigger: 'manual', slot: 'test:1', runAgent, notifyFn });
  assert.equal(r1.status, 'COMPLETED');
  assert.deepEqual(r1.steps.map((s) => s.status), ['DONE', 'PASSED', 'DONE']);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].body, 'Short by 1,200', 'the notification carries the agent result');
  assert.equal(notes[0].userId, a.id);

  const again = await cw.executeWorkflow(env.pool, a.id, wf, { trigger: 'manual', slot: 'test:1', runAgent, notifyFn });
  assert.equal(again.status, 'DUPLICATE');
  assert.equal(calls.length, 1, 'a duplicate slot runs nothing');

  const fine = async () => ({ status: 'COMPUTED', net: 500, moneyIn: 600, moneyOut: 100, inflow: { overdue: 0 }, firstShortWeek: null, headline: 'Fine' });
  const r2 = await cw.executeWorkflow(env.pool, a.id, wf, { trigger: 'manual', slot: 'test:2', runAgent: fine, notifyFn });
  assert.equal(r2.status, 'ENDED_BY_CONDITION');
  assert.deepEqual(r2.steps.map((s) => s.status), ['DONE', 'NOT_MET', 'SKIPPED']);
  assert.equal(notes.length, 1, 'nothing is sent when the condition is not met');

  const b = await tenant('cw-runner-other');
  await assert.rejects(cw.executeWorkflow(env.pool, b.id, wf, { trigger: 'manual', slot: 'x', runAgent, notifyFn }), /not found/, 'another tenant cannot run it');
});

test('scheduled workflows run only when due, only when active, once per slot', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const a = await tenant('cw-sched');
  await env.pool.query(`INSERT INTO starlane_tenant_settings (user_id, definitions, definitions_version) VALUES ($1, $2, 1)
    ON CONFLICT (user_id) DO UPDATE SET definitions = EXCLUDED.definitions`, [a.id, JSON.stringify({ timezone: 'America/New_York', base_currency: 'USD' })]);
  const def = { trigger: { type: 'schedule', every: 'daily', hour: 9 }, steps: [{ id: 'cash', type: 'agent', agent: 'starlane.working_capital' }] };
  const active = await cw.createWorkflow(env.pool, a.id, { name: 'Active', definition: def });
  await cw.setStatus(env.pool, a.id, active.id, 'ACTIVE');
  await cw.createWorkflow(env.pool, a.id, { name: 'Draft', definition: def });
  const ran = [];
  const runAgent = async (key, userId) => { ran.push(userId); return { status: 'COMPUTED', net: 1, inflow: {}, headline: 'ok' }; };
  const due = Date.UTC(2026, 9, 5, 13, 5); // 09:05 New York
  const out1 = await cw.runScheduledCustomWorkflows(env.pool, { now: due, runAgent, notifyFn: async () => ({}) });
  const out2 = await cw.runScheduledCustomWorkflows(env.pool, { now: due + 15 * 60000, runAgent, notifyFn: async () => ({}) });
  const out3 = await cw.runScheduledCustomWorkflows(env.pool, { now: due + 3 * 3600000, runAgent, notifyFn: async () => ({}) });
  assert.equal(ran.filter((u) => u === a.id).length, 1, 'one run for the day, and none for the draft');
  assert.ok(out1.ran >= 1);
  assert.ok(out2.duplicate >= 1);
  assert.ok(out3.notDue >= 1);
});

test('HTTP: build, activate, run with real agents, see the run, and stay inside the tenant', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const a = await tenant('cw-http-a');
  const b = await tenant('cw-http-b');
  await seedGolden(env.pool, a.id, todayIso());
  await env.pool.query(`INSERT INTO purchases (user_id, supplier_name, amount, paid_amount, status, due_date) VALUES ($1,'Steel Co',5000000,0,'unpaid',CURRENT_DATE + 3)`, [a.id]);
  const ca = client(server.base, a);
  const cb = client(server.base, b);

  const cat = await ca.get('/api/custom-workflows/catalog');
  assert.equal(cat.status, 200);
  assert.ok(cat.body.agents.some((x) => x.key === 'starlane.working_capital' && x.availability === 'available'));
  assert.equal(cat.body.triggers.find((x) => x.type === 'schedule').schedulerEnabled, false, 'the API says when schedules are switched off');

  const bad = await ca.post('/api/custom-workflows', { name: 'Bad', definition: { trigger: { type: 'manual' }, steps: [{ id: 'a', type: 'agent', agent: 'starlane.scan' }, { id: 'b', type: 'action', action: 'post_slack', params: { title: 'x' } }] } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.length);

  const created = await ca.post('/api/custom-workflows', { name: 'Cash check', definition: cw.TEMPLATES[0].definition });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.workflow.id;
  assert.equal(created.body.workflow.status, 'DRAFT');

  assert.equal((await cb.get(`/api/custom-workflows/${id}`)).status, 404, 'another tenant cannot read it');
  assert.equal((await cb.post(`/api/custom-workflows/${id}/run`)).status, 404, 'or run it');
  assert.equal((await cb.get('/api/custom-workflows')).body.workflows.length, 0);

  const act = await ca.post(`/api/custom-workflows/${id}/activate`);
  assert.equal(act.body.workflow.status, 'ACTIVE');
  assert.equal(act.body.workflow.nextRunAt, null, 'no next run is promised while the scheduler is off');

  const run = await ca.post(`/api/custom-workflows/${id}/run`);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.run.status, 'COMPLETED', JSON.stringify(run.body.run));
  assert.equal(run.body.run.steps[0].status, 'DONE');
  assert.ok(run.body.run.steps[0].agentRunId, 'the agent run is in the agent history too');
  assert.ok(run.body.run.steps[0].outputs.gap > 0, 'a 5,000,000 bill due this week opens a gap');
  assert.equal(run.body.run.steps[2].status, 'DONE');
  const inbox = await env.pool.query(`SELECT title, route FROM notification_events WHERE user_id = $1`, [a.id]);
  assert.equal(inbox.rows.length, 1);
  assert.match(inbox.rows[0].route, new RegExp(id));

  assert.equal((await ca.post(`/api/custom-workflows/${id}/run`)).status, 429, 'a second run in the same minute is refused');

  const detail = await ca.get(`/api/custom-workflows/${id}`);
  assert.equal(detail.body.runs.length, 1);
  assert.equal(detail.body.runs[0].status, 'COMPLETED');

  const edited = await ca.put(`/api/custom-workflows/${id}`, { name: 'Cash check (renamed)' });
  assert.equal(edited.body.workflow.version, 2);

  await env.pool.query(`INSERT INTO starlane_controls (user_id, scope, scope_key, stopped, reason, set_by) VALUES ($1,'WORKFLOW',$2,TRUE,'test stop',$1)`, [a.id, id]);
  await env.pool.query(`DELETE FROM starlane_custom_workflow_runs WHERE workflow_id = $1`, [id]);
  const stopped = await ca.post(`/api/custom-workflows/${id}/run`);
  assert.equal(stopped.body.run.status, 'BLOCKED', 'a workflow kill switch blocks the run');
  assert.equal(stopped.body.run.steps[0]?.status ?? 'none', 'none', 'no agent ran');

  const del = await cb.post(`/api/custom-workflows/${id}/pause`);
  assert.equal(del.status, 404);
});

test('HTTP: region settings follow the country and accept a deliberate change', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const a = await tenant('region');
  const ca = client(server.base, a);
  const set = await ca.put('/api/settings/region', { country: 'GB' });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.region.currency, 'GBP');
  assert.equal(set.body.region.timezone, 'Europe/London');
  assert.equal(set.body.region.taxLabel, 'VAT');
  const own = await ca.put('/api/settings/region', { currency: 'USD' });
  assert.equal(own.body.region.currency, 'USD');
  assert.equal(own.body.region.country, 'GB');
  assert.equal((await ca.put('/api/settings/region', { currency: 'DOLLARS' })).status, 400);
  const u = await env.pool.query('SELECT country FROM users WHERE id = $1', [a.id]);
  assert.equal(u.rows[0].country, 'United Kingdom');

  // Onboarding fills only what the owner has not chosen.
  const { applyCountryDefaults } = require('../lib/routes/region');
  const after = await applyCountryDefaults(env.pool, a.id, 'Germany');
  assert.equal(after.currency, 'USD', 'a currency the owner chose is kept');
});
