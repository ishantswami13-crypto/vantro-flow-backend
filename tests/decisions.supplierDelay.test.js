// FILE: tests/decisions.supplierDelay.test.js
// Supplier-delay workflow end to end, over real HTTP against a real Postgres,
// on synthetic data (tests/fixtures/supplierDelay.js):
//
//   inbound shipments -> report a delay -> decision with the customer orders
//   the delay put at risk (and NOT the ones it did not) -> evidence ->
//   select "prepare customer updates" -> approval required -> execute in
//   SHADOW (records only) and in LIVE (pending drafts, nothing sent) ->
//   idempotency -> cross-tenant isolation -> supplier recovers, decision
//   resolves.
//
// Run: DATABASE_URL=... JWT_SECRET=... node --test tests/decisions.supplierDelay.test.js
// Skips (never passes silently) when no database is configured.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dbReady, createTenant, deleteTenant, startServer, client, todayIso } = require('./helpers/decisionHarness');
const { seedSupplierDelay, deleteSupplierDelayData } = require('./fixtures/supplierDelay');

let env;
let server;
const tenants = [];

test.before(async () => {
  env = await dbReady();
  if (!env.ok) return;
  const col = await env.pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'purchase_line_items' AND column_name = 'original_expected_at'`);
  if (!col.rows.length) { env = { ok: false, reason: 'migration 072_shipment_delays.sql not applied' }; return; }
  server = await startServer({ FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED: 'false', STARLANE_GLOBAL_STOP: '' });
});

test.after(async () => {
  if (server) await server.stop();
  if (env?.ok) {
    for (const t of tenants) {
      await deleteSupplierDelayData(env.pool, t.id).catch(() => {});
      await deleteTenant(env.pool, t.id).catch(() => {});
    }
    await env.pool.end();
  }
});

async function tenantWithScenario(label) {
  const user = await createTenant(env.pool, `delay-${label}`);
  tenants.push(user);
  const fx = await seedSupplierDelay(env.pool, user.id, todayIso());
  return { user, fx, api: client(server.base, user) };
}

async function reportFrameDelay(api, fx) {
  const r = await api.post('/api/decisions/report-supplier-delay', { purchaseLineItemId: fx.frameLineId, newExpectedAt: fx.delayedDate, reason: 'Factory power cuts; supplier moved dispatch by two weeks' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

test('a supplier delay finds exactly the customer commitments it put at risk, with evidence', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const { user, fx, api } = await tenantWithScenario('find');

  // Opening the app runs the legacy auto-reconcile, which recomputes stock
  // from stock_movements. The scenario must survive it unchanged.
  const me = await api.get('/api/auth/me');
  assert.equal(me.status, 200, JSON.stringify(me.body));
  await new Promise((r) => setTimeout(r, 1500));
  const stock = await env.pool.query(`SELECT name, current_stock::float AS s FROM products WHERE user_id = $1 ORDER BY name`, [user.id]);
  assert.deepEqual(stock.rows.map((r) => [r.name, r.s]), [['Aluminium Frame 18in', 10], ['City Bike C1', 2], ['D-Lock', 100], ['Wheel 700c', 200]], 'stock unchanged and no invented products after reconcile');

  const inbound = await api.get('/api/decisions/inbound-shipments');
  assert.equal(inbound.status, 200);
  assert.equal(inbound.body.shipments.length, 2);

  // Negative control: a short wheel delay is absorbed by 200 wheels on hand.
  const wheel = await api.post('/api/decisions/report-supplier-delay', { purchaseLineItemId: fx.wheelLineId, newExpectedAt: fx.delayedDate });
  assert.equal(wheel.status, 200, JSON.stringify(wheel.body));
  assert.equal(wheel.body.decision, null, 'no decision when no promised order is affected');
  assert.match(wheel.body.finding.reason, /puts no promised order at risk/);

  const out = await reportFrameDelay(api, fx);
  assert.ok(out.decision, `expected a decision, got ${JSON.stringify(out)}`);
  assert.equal(out.shipment.original_expected_at.slice(0, 10), fx.frameOriginalDate, 'the date the business relied on is kept');
  assert.equal(out.discovery.degraded.length, 0, JSON.stringify(out.discovery.degraded));

  const detail = await api.get(`/api/decisions/${out.decision.id}`);
  assert.equal(detail.status, 200);
  const d = detail.body.decision;
  assert.equal(d.kind, 'SUPPLIER_DELAY');
  assert.equal(d.status, 'OPEN');
  assert.match(d.title, /Shenzhen Frame Co is 15 days late/);

  const orders = d.affectedEntities.filter((e) => e.type === 'order').map((e) => e.id).sort();
  const expectedOrders = fx.expected.atRisk.map((c) => fx.orders[c].orderId).sort();
  assert.deepEqual(orders, expectedOrders, 'exactly Brightwater and Harbour');
  for (const name of [...fx.expected.onTime, ...fx.expected.alreadyAtRisk]) {
    assert.ok(!orders.includes(fx.orders[name].orderId), `${name} must not be blamed on this delay`);
  }
  assert.equal(d.materiality.revenueExposure, fx.expected.valueAtRisk, 'value at risk is the exact sum of the two at-risk order lines');
  assert.equal(d.materiality.ordersAtRisk, 2);
  assert.equal(d.materiality.delayDays, 15);

  const sd = d.analysis.supplierDelay;
  assert.equal(sd.unitsNeededFromShipment, fx.expected.unitsNeededFromShipment);
  assert.deepEqual(sd.alreadyAtRisk.map((l) => l.customerName), fx.expected.alreadyAtRisk);
  const brightwater = sd.atRisk.find((l) => l.customerName === 'Brightwater Stores');
  assert.equal(brightwater.neededBy, fx.orders['Brightwater Stores'].neededBy);
  assert.equal(brightwater.plannedReadyAt, fx.frameOriginalDate);
  assert.equal(brightwater.readyAt, fx.delayedDate);
  assert.equal(brightwater.slipDays, 10);

  // Evidence: every claim labelled; the delayed line and each order are sourced.
  assert.ok(d.evidence.some((e) => e.kind === 'OBSERVED_FACT' && e.source?.table === 'purchase_line_items' && e.source.id === fx.frameLineId));
  assert.equal(d.evidence.filter((e) => e.kind === 'CALCULATED_FACT' && e.source?.table === 'order_line_items' && e.source.id).length, 2);
  assert.ok(d.evidence.some((e) => e.kind === 'ASSUMPTION'), 'assumptions are shown as assumptions');
  assert.ok(d.evidence.some((e) => /Already at risk/.test(e.label) && /Echo Fleet/.test(e.detail)));

  // Options: do nothing is always there; the recommended option needs owner approval.
  const dn = d.options.find((o) => o.isDoNothing);
  const notify = d.options.find((o) => o.key === 'notify_customers');
  assert.ok(dn && notify);
  assert.equal(d.recommendation.key, 'notify_customers');
  assert.equal(notify.approval.required, true);
  assert.equal(notify.intent.type, 'PREPARE_CUSTOMER_UPDATE');
  assert.equal(notify.intent.drafts.length, 2);
  for (const draft of notify.intent.drafts) {
    assert.ok(draft.message.includes(draft.customerName));
    assert.ok(!/Shenzhen/.test(draft.message), 'the supplier is not named to the customer');
    assert.ok(!/legal|court|police/i.test(draft.message));
  }
  assert.equal(d.analysis.deterministic, true);
  assert.equal(d.modelVersions.supplierDelay, 'commitment-plan@1');

  // Re-reporting revises the same decision instead of duplicating it.
  const again = await reportFrameDelay(api, fx);
  assert.equal(again.decision.id, out.decision.id);
  const list = await api.get('/api/decisions');
  assert.equal(list.body.decisions.filter((x) => x.kind === 'SUPPLIER_DELAY').length, 1);
});

test('approval gate: nothing runs unapproved; shadow records only; live prepares drafts and sends nothing', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);

  // SHADOW (the default for every new tenant)
  const a = await tenantWithScenario('shadow');
  const outA = await reportFrameDelay(a.api, a.fx);
  const idA = outA.decision.id;
  const sel = await a.api.post(`/api/decisions/${idA}/select`, { optionKey: 'notify_customers' });
  assert.equal(sel.status, 200, JSON.stringify(sel.body));
  const early = await a.api.post(`/api/decisions/${idA}/execute`, {});
  assert.equal(early.status, 409, 'cannot execute before approval');
  assert.match(early.body.error, /approval/i);
  const appr = await a.api.post(`/api/decisions/${idA}/approve`, {});
  assert.equal(appr.status, 200, JSON.stringify(appr.body));
  const ex = await a.api.post(`/api/decisions/${idA}/execute`, {});
  assert.equal(ex.status, 200, JSON.stringify(ex.body));
  assert.equal(ex.body.mode, 'SHADOW');
  assert.equal(ex.body.status, 'SHADOWED');
  assert.equal(ex.body.runs[0].status, 'SHADOWED');
  assert.equal(ex.body.runs[0].would_have.drafts.length, 2);
  const noneA = await env.pool.query(`SELECT COUNT(*)::int AS n FROM ai_actions WHERE user_id = $1 AND action_type = 'COMMITMENT_DELAY_NOTICE'`, [a.user.id]);
  assert.equal(noneA.rows[0].n, 0, 'shadow mode writes no drafts');
  const liveAuth = await a.api.post(`/api/decisions/${idA}/execute`, { authorizeLive: true });
  assert.notEqual(liveAuth.status, 200, 'customer messages cannot be one-off authorised in shadow mode');

  // LIVE: owner switched the tenant to live.
  const b = await tenantWithScenario('live');
  const live = await b.api.post('/api/decisions/controls', { pilotMode: 'LIVE' });
  assert.equal(live.status, 200);
  const outB = await reportFrameDelay(b.api, b.fx);
  const idB = outB.decision.id;
  assert.equal((await b.api.post(`/api/decisions/${idB}/select`, { optionKey: 'notify_customers' })).status, 200);
  assert.equal((await b.api.post(`/api/decisions/${idB}/approve`, {})).status, 200);
  const exB = await b.api.post(`/api/decisions/${idB}/execute`, {});
  assert.equal(exB.status, 200, JSON.stringify(exB.body));
  assert.equal(exB.body.mode, 'LIVE');
  assert.equal(exB.body.status, 'EXECUTED');
  assert.equal(exB.body.runs[0].status, 'PREPARED');

  const drafts = await env.pool.query(
    `SELECT status, requires_approval, recommended_message, customer_id, related_entity_id, decision_id FROM ai_actions WHERE user_id = $1 AND action_type = 'COMMITMENT_DELAY_NOTICE' ORDER BY title`,
    [b.user.id]
  );
  assert.equal(drafts.rows.length, 2);
  for (const r of drafts.rows) {
    assert.equal(r.status, 'pending', 'each draft waits for its own approval');
    assert.equal(r.requires_approval, true);
    assert.equal(r.decision_id, idB);
    assert.ok(r.customer_id, 'linked to the customer record');
  }
  assert.deepEqual(drafts.rows.map((r) => r.related_entity_id).sort(), b.fx.expected.atRisk.map((c) => b.fx.orders[c].orderId).sort());
  const sent = await env.pool.query(`SELECT COUNT(*)::int AS n FROM execution_records WHERE user_id = $1`, [b.user.id]);
  assert.equal(sent.rows[0].n, 0, 'nothing was sent');

  // Idempotent: a second execute does not prepare more drafts.
  const again = await b.api.post(`/api/decisions/${idB}/execute`, {});
  assert.equal(again.status, 409);
  const count = await env.pool.query(`SELECT COUNT(*)::int AS n FROM ai_actions WHERE user_id = $1 AND action_type = 'COMMITMENT_DELAY_NOTICE'`, [b.user.id]);
  assert.equal(count.rows[0].n, 2);

  // Audit trail has the human approval and the execution.
  const audit = await b.api.get(`/api/decisions/${idB}/audit`);
  assert.equal(audit.status, 200);
  const types = JSON.stringify(audit.body);
  for (const ev of ['DISCOVERED', 'OPTION_SELECTED', 'APPROVED', 'EXECUTION_COMPLETED']) assert.ok(types.includes(ev), `audit has ${ev}`);
});

test('tenant isolation and recovery: other tenants cannot see or move the shipment; a recovered supplier resolves the decision', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const a = await tenantWithScenario('owner');
  const b = await tenantWithScenario('other');
  const out = await reportFrameDelay(a.api, a.fx);

  const peek = await b.api.get(`/api/decisions/${out.decision.id}`);
  assert.equal(peek.status, 404);
  const move = await b.api.post('/api/decisions/report-supplier-delay', { purchaseLineItemId: a.fx.frameLineId, newExpectedAt: a.fx.delayedDate });
  assert.equal(move.status, 404);
  const bad = await a.api.post('/api/decisions/report-supplier-delay', { purchaseLineItemId: a.fx.frameLineId, newExpectedAt: 'next week' });
  assert.equal(bad.status, 400);

  // Supplier recovers: back to the original date. Nothing is at risk any more.
  const rec = await a.api.post('/api/decisions/report-supplier-delay', { purchaseLineItemId: a.fx.frameLineId, newExpectedAt: a.fx.frameOriginalDate, reason: 'Supplier confirmed original dispatch' });
  assert.equal(rec.status, 200);
  assert.equal(rec.body.decision, null);
  const after = await a.api.get(`/api/decisions/${out.decision.id}`);
  assert.equal(after.body.decision.status, 'RESOLVED');
});
