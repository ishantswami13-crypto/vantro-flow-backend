// FILE: tests/decisions.delayReconcile.test.js
// A supplier-delay decision that has been chosen, approved or run must not go
// stale when the facts change. Over real HTTP against a real local Postgres,
// with the Meridian Trading fixture (tests/fixtures/meridianTrading.js, every
// expected number worked out by hand there):
//
//   delay -> approve -> run (LIVE: 2 customer-update drafts) -> partial
//   receipt -> the run decision is SUPERSEDED (kept as history, exposure then
//   ₹2,62,575), its unsent drafts are expired with a reason, and a NEW open
//   decision says ₹75,000 and needs fresh approval -> full receipt -> RESOLVED,
//   no draft left that could be sent.
//
// Plus: shadow mode, a correction, idempotent re-discovery (no duplicates),
// data changing between approval and run, data changing between a draft
// being prepared and approved/sent, a receipt racing a run, tenant isolation,
// and other decision kinds untouched.
//
// Run: DATABASE_URL=postgres://...@127.0.0.1/... JWT_SECRET=... node --test tests/decisions.delayReconcile.test.js
// Skips (never passes silently) when no database is configured.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { dbReady, createTenant, deleteTenant, seedGolden, startServer, client, tokenFor, todayIso } = require('./helpers/decisionHarness');
const { testDatabaseProblem } = require('../lib/db/testDatabaseGuard');
const { plus } = require('./fixtures/realPilot');
const M = require('./fixtures/meridianTrading');

let env;
let server;
const tenants = [];
const today = todayIso();
const d = (n) => plus(today, n);

test.before(async () => {
  const problem = testDatabaseProblem();
  if (problem) { env = { ok: false, reason: problem }; return; }
  env = await dbReady();
  if (!env.ok) return;
  const t = await env.pool.query(`SELECT to_regclass('public.purchase_line_receipts') AS t`);
  if (!t.rows[0].t) { env = { ok: false, reason: 'migration 078_operational_imports_receipts.sql not applied' }; return; }
  // ai_message_drafts on so the send route reaches the send-time check; no
  // messaging provider is configured and external sending is off, so nothing
  // can leave this process.
  server = await startServer({ FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED: 'false', FEATURE_AI_MESSAGE_DRAFTS: 'true', STARLANE_GLOBAL_STOP: '', TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', TWILIO_WHATSAPP_NUMBER: '' });
});

test.after(async () => {
  if (server) await server.stop();
  if (env?.ok) {
    for (const t of tenants) {
      for (const tbl of ['purchase_line_receipts', 'stock_movements', 'raw_observations', 'file_import_batches', 'order_line_items', 'orders', 'purchase_line_items', 'purchases', 'product_suppliers', 'product_components', 'products', 'suppliers', 'customers', 'invoices', 'disputes']) {
        await env.pool.query(`DELETE FROM ${tbl} WHERE user_id = $1`, [t.id]).catch(() => {});
      }
      await deleteTenant(env.pool, t.id).catch(() => {});
    }
    await env.pool.end();
  }
});

function api(user) {
  const base = client(server.base, user);
  const token = tokenFor(user);
  async function raw(method, url, body) {
    const r = await fetch(`${server.base}${url}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: r.status, body: json };
  }
  async function upload(kind, buffer, filename, options) {
    const form = new FormData();
    form.append('kind', kind);
    if (options) form.append('options', JSON.stringify(options));
    form.append('file', new Blob([buffer]), filename);
    const r = await fetch(`${server.base}/api/decisions/operations/import/commit`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }
  return { ...base, patch: (u, b) => raw('PATCH', u, b), upload };
}

const key = () => `test-${crypto.randomUUID()}`;
const q = async (sql, params) => (await env.pool.query(sql, params)).rows;

// A fresh tenant with the four Meridian files imported through the real
// import endpoint.
async function meridian(label, { live = false } = {}) {
  const user = await createTenant(env.pool, `reconcile-${label}`);
  tenants.push(user);
  const a = api(user);
  for (const [kind, buf, name, opts] of [
    ['products', M.productsCsv(), 'items.csv', M.PRODUCT_OPTIONS],
    ['components', M.componentsCsv(), 'bom.csv', M.COMPONENT_OPTIONS],
    ['purchase_lines', M.purchaseCsv(today), 'open-pos.csv', M.PURCHASE_OPTIONS],
    ['orders', M.ordersCsv(today), 'open-sos.csv', M.ORDER_OPTIONS],
  ]) {
    const r = await a.upload(kind, buf, name, opts);
    assert.equal(r.status, 200, `${kind}: ${JSON.stringify(r.body).slice(0, 400)}`);
  }
  if (live) {
    const c = await a.post('/api/decisions/controls', { pilotMode: 'LIVE' });
    assert.equal(c.status, 200, JSON.stringify(c.body));
  }
  const panels = (await q(`SELECT pli.id FROM purchase_line_items pli JOIN products p ON p.id = pli.product_id WHERE pli.user_id = $1 AND p.sku = 'LED-40W' AND pli.quantity = 300`, [user.id]))[0];
  assert.ok(panels, 'PO-A1 imported');
  return { user, a, panelLine: panels.id };
}

const atRiskOf = (dec) => Object.fromEntries(dec.analysis.supplierDelay.atRisk.map((l) => [l.customerName, l.slipDays]));
const delayDecisions = (userId) => q(`SELECT id, status, materiality, analysis, resolution_reason FROM decisions WHERE user_id = $1 AND kind = 'SUPPLIER_DELAY' ORDER BY created_at`, [userId]);
const activeDelay = async (userId) => (await delayDecisions(userId)).filter((x) => !['SUPERSEDED', 'RESOLVED', 'REJECTED', 'EXPIRED'].includes(x.status));
const notices = (userId, decisionId) => q(`SELECT id, status, block_reason, parameters, decision_id FROM ai_actions WHERE user_id = $1 AND action_type = 'COMMITMENT_DELAY_NOTICE' ${decisionId ? 'AND decision_id = $2' : ''} ORDER BY created_at`, decisionId ? [userId, decisionId] : [userId]);
const sendable = async (userId) => (await notices(userId)).filter((n) => ['pending', 'approved'].includes(n.status));

async function reportDelay(t, days = 9) {
  const rep = await t.a.post('/api/decisions/report-supplier-delay', { purchaseLineItemId: t.panelLine, newExpectedAt: d(days), reason: 'Port congestion (synthetic)' });
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  assert.ok(rep.body.decision, JSON.stringify(rep.body));
  return rep.body.decision.id;
}

async function approveAndRun(t, decisionId) {
  const s = await t.a.post(`/api/decisions/${decisionId}/select`, { optionKey: 'notify_customers' });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const ap = await t.a.post(`/api/decisions/${decisionId}/approve`, { note: 'synthetic approval' });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  return t.a.post(`/api/decisions/${decisionId}/execute`, {});
}

const receive = (t, quantity, extra = {}) => t.a.post(`/api/decisions/purchase-lines/${t.panelLine}/receipts`, { quantity: String(quantity), receivedOn: today, idempotencyKey: key(), ...extra });

test('LIVE: a run delay decision is superseded by receipts, its drafts are withdrawn, and the full receipt resolves it', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const m = await meridian('live', { live: true });
  const d1 = await reportDelay(m);
  const g1 = (await m.a.get(`/api/decisions/${d1}`)).body.decision;
  assert.deepEqual(atRiskOf(g1), M.EXPECTED.afterDelay.atRisk);
  assert.equal(Number(g1.materiality.revenueExposure), M.EXPECTED.afterDelay.valueAtRisk);

  const run = await approveAndRun(m, d1);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.status, 'EXECUTED');
  assert.equal((await notices(m.user.id, d1)).filter((n) => n.status === 'pending').length, M.EXPECTED.afterDelay.drafts);

  // 150 of the 300 panels arrive.
  const r1 = await receive(m, 150, { reference: 'GRN-7001' });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));

  // The run decision is history now, not the current recommendation.
  const old = (await m.a.get(`/api/decisions/${d1}`)).body;
  assert.equal(old.decision.status, 'SUPERSEDED', 'the decision that was run is no longer shown as current');
  assert.match(old.decision.resolutionReason || '', /changed/i);
  assert.equal(Number(old.decision.materiality.revenueExposure), M.EXPECTED.afterDelay.valueAtRisk, 'the exposure at the time is kept');
  assert.ok(old.lineage && old.lineage.supersededBy, 'links to the newer decision');
  const oldDrafts = await notices(m.user.id, d1);
  assert.equal(oldDrafts.length, 2, 'original drafts are kept');
  assert.ok(oldDrafts.every((n) => n.status === 'expired'), JSON.stringify(oldDrafts));
  assert.ok(oldDrafts.every((n) => /changed|no longer/i.test(n.block_reason || '')), 'each withdrawn draft says why');
  assert.ok(old.events.some((e) => e.type === 'SUPERSEDED'), 'the audit trail records the supersession');

  // The newer decision: ₹75,000, Sai Contractors only, needs fresh approval.
  const active = await activeDelay(m.user.id);
  assert.equal(active.length, 1);
  const d2 = active[0].id;
  assert.equal(old.lineage.supersededBy, d2);
  const g2 = (await m.a.get(`/api/decisions/${d2}`)).body;
  assert.equal(g2.decision.status, 'OPEN', 'no auto-approval: the new decision starts open');
  assert.deepEqual(atRiskOf(g2.decision), M.EXPECTED.afterPartialReceipt.atRisk);
  assert.equal(Number(g2.decision.materiality.revenueExposure), M.EXPECTED.afterPartialReceipt.valueAtRisk);
  assert.equal(g2.lineage.supersedes, d1);
  const rec = g2.decision.analysis.reconciliation;
  assert.equal(rec.supersedes, d1);
  assert.equal(Number(rec.previousExposure), M.EXPECTED.afterDelay.valueAtRisk, 'historical exposure is distinct from current exposure');
  assert.ok(rec.changes.some((c) => c.customerName === 'Pioneer Builders' && c.after === null), 'says Pioneer Builders is no longer at risk');
  assert.equal(rec.notices.withdrawn, 2);
  assert.equal(rec.notices.cannotWithdraw, 0);
  assert.ok(old.notices.every((n) => n.state === 'WITHDRAWN' && n.blockReason), 'the old decision lists its drafts as withdrawn, with the reason');
  assert.ok(g2.decision.analysis.supplierDelay.sourcesChangedAt, 'shows when source records last changed');
  assert.equal((await notices(m.user.id, d2)).length, 0, 'no draft exists for the new decision until it is approved');
  const early = await m.a.post(`/api/decisions/${d2}/execute`, {});
  assert.equal(early.status, 409);

  // Identical data again: nothing new.
  const again = await m.a.post('/api/decisions/discover', {});
  assert.equal(again.status, 200);
  assert.equal(again.body.discovered, 0);
  assert.equal((await delayDecisions(m.user.id)).length, 2, 'no duplicate decisions from identical data');

  // Approve and run the new one: exactly one draft, for Sai Contractors.
  const run2 = await approveAndRun(m, d2);
  assert.equal(run2.status, 200, JSON.stringify(run2.body));
  const n2 = await notices(m.user.id, d2);
  assert.equal(n2.length, M.EXPECTED.afterPartialReceipt.drafts);
  assert.equal(n2[0].status, 'pending');

  // The rest arrives: nothing is late, nothing can be sent.
  const r2 = await receive(m, 150, { reference: 'GRN-7002' });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  const fin = (await m.a.get(`/api/decisions/${d2}`)).body.decision;
  assert.equal(fin.status, 'RESOLVED');
  assert.match(fin.resolutionReason || '', /received in full/i);
  assert.equal((await activeDelay(m.user.id)).length, 0);
  assert.equal((await sendable(m.user.id)).length, 0, 'no draft from a stale decision can be approved or sent');
  assert.equal((await q(`SELECT status FROM decisions WHERE id = $1`, [d1]))[0].status, 'SUPERSEDED', 'history is preserved');
  const sent = (await q(`SELECT (SELECT count(*) FROM execution_records WHERE user_id = $1)::int e, (SELECT count(*) FROM outbound_send_jobs WHERE user_id = $1)::int j`, [m.user.id]))[0];
  assert.deepEqual(sent, { e: 0, j: 0 }, 'nothing was sent or queued');
});

test('SHADOW: a shadow-run decision is superseded, then resolved; a correction reopens the risk on a newer decision', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const m = await meridian('shadow');
  const d1 = await reportDelay(m);
  const run = await approveAndRun(m, d1);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.status, 'SHADOWED');
  assert.equal((await notices(m.user.id)).length, 0, 'shadow creates no drafts');

  const r1 = await receive(m, 150);
  assert.equal(r1.status, 201);
  assert.equal((await q(`SELECT status FROM decisions WHERE id = $1`, [d1]))[0].status, 'SUPERSEDED');
  const [d2] = await activeDelay(m.user.id);
  assert.deepEqual(atRiskOf(d2), M.EXPECTED.afterPartialReceipt.atRisk);
  assert.equal(d2.status, 'OPEN');

  // A correction: only 100 were really received. Pioneer Builders is late
  // again (150 needed by +6, 110 left on hand after earlier orders).
  const corr = await receive(m, -50, { kind: 'CORRECTION', notes: 'Counted 100, not 150 (synthetic)' });
  assert.equal(corr.status, 201, JSON.stringify(corr.body));
  const [d3] = await activeDelay(m.user.id);
  assert.equal(d3.id, d2.id, 'an open decision is revised in place, not duplicated');
  assert.equal(atRiskOf(d3)['Pioneer Builders'], 3);

  // Approve, shadow-run, then a second slip of the remaining panels to +11.
  const run3 = await approveAndRun(m, d3.id);
  assert.equal(run3.status, 200, JSON.stringify(run3.body));
  const corr2 = await receive(m, 50, { kind: 'CORRECTION', notes: 'Found the other 50 (synthetic)' });
  assert.equal(corr2.status, 201, JSON.stringify(corr2.body));
  const moved = await m.a.post('/api/decisions/report-supplier-delay', { purchaseLineItemId: m.panelLine, newExpectedAt: d(11), reason: 'Second slip (synthetic)' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const [d4] = await activeDelay(m.user.id);
  assert.notEqual(d4.id, d3.id);
  assert.deepEqual(atRiskOf(d4), M.EXPECTED.afterSecondDelay.atRisk);
  assert.equal(d4.analysis.reconciliation.supersedes, d3.id);

  const r2 = await receive(m, 150);
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.equal((await activeDelay(m.user.id)).length, 0);
  const all = await delayDecisions(m.user.id);
  assert.deepEqual(all.map((x) => x.status), ['SUPERSEDED', 'SUPERSEDED', 'RESOLVED'], 'the full chain is kept as history');
});

test('data that changes between approval and run is caught at run time, even when the same orders stay at risk', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const m = await meridian('approve-race', { live: true });
  const d1 = await reportDelay(m);
  await m.a.post(`/api/decisions/${d1}/select`, { optionKey: 'notify_customers' });
  await m.a.post(`/api/decisions/${d1}/approve`, {});
  // A feed moves the date again without running discovery: same two orders
  // late, but by 5 and 4 days now, so the drafted dates would be wrong.
  await env.pool.query(`UPDATE purchase_line_items SET expected_at = ($3::date)::timestamp AT TIME ZONE 'UTC' WHERE id = $1 AND user_id = $2`, [m.panelLine, m.user.id, d(11)]);
  const run = await m.a.post(`/api/decisions/${d1}/execute`, {});
  assert.equal(run.status, 409, JSON.stringify(run.body));
  assert.equal((await notices(m.user.id)).length, 0, 'no drafts with outdated dates were prepared');
  assert.equal((await q(`SELECT status FROM decisions WHERE id = $1`, [d1]))[0].status, 'SUPERSEDED');
  const [d2] = await activeDelay(m.user.id);
  assert.deepEqual(atRiskOf(d2), { 'Pioneer Builders': 5, 'Sai Contractors': 4 });
  assert.equal(d2.status, 'OPEN');
  assert.equal(run.body.supersededBy, d2.id);
});

test('a prepared draft whose facts changed cannot be approved or sent; a current one can still be approved', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const m = await meridian('send-check', { live: true });
  const d1 = await reportDelay(m);
  const run = await approveAndRun(m, d1);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const [n1, n2] = await notices(m.user.id, d1);

  const ok = await m.a.patch(`/api/ai-actions/${n1.id}`, { status: 'approved' });
  assert.equal(ok.status, 200, `a current draft can be approved: ${JSON.stringify(ok.body)}`);

  // The date moves again with no discovery run (a feed write, a direct edit).
  await env.pool.query(`UPDATE purchase_line_items SET expected_at = ($3::date)::timestamp AT TIME ZONE 'UTC' WHERE id = $1 AND user_id = $2`, [m.panelLine, m.user.id, d(11)]);

  // Sending the approved one: the last safe point catches it.
  const send = await m.a.post(`/api/ai-actions/${n1.id}/send-whatsapp`, {});
  assert.equal(send.status, 409, `an approved but outdated draft is not sent: ${JSON.stringify(send.body)}`);
  assert.equal(send.body.code, 'NOTICE_STALE');
  const approve = await m.a.patch(`/api/ai-actions/${n2.id}`, { status: 'approved' });
  assert.equal(approve.status, 409, JSON.stringify(approve.body));
  assert.equal(approve.body.code, 'NOTICE_STALE');
  const viaClient = await m.a.post(`/api/client/actions/${n2.id}/decision`, { decision: 'approve' });
  assert.equal(viaClient.status, 409, JSON.stringify(viaClient.body));

  const after = await notices(m.user.id, d1);
  assert.ok(after.every((n) => n.status === 'expired'), JSON.stringify(after));
  assert.equal((await q(`SELECT status FROM decisions WHERE id = $1`, [d1]))[0].status, 'SUPERSEDED', 'the stale decision is reconciled');
  const [d2] = await activeDelay(m.user.id);
  assert.deepEqual(atRiskOf(d2), { 'Pioneer Builders': 5, 'Sai Contractors': 4 });
  assert.equal(approve.body.newerDecisionId, d2.id);
  const sent = (await q(`SELECT count(*)::int n FROM execution_records WHERE user_id = $1`, [m.user.id]))[0].n;
  assert.equal(sent, 0);
});

test('a receipt racing a run never leaves a sendable draft on an outdated decision', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  for (let i = 0; i < 3; i++) {
    const m = await meridian(`race-${i}`, { live: true });
    const d1 = await reportDelay(m);
    await m.a.post(`/api/decisions/${d1}/select`, { optionKey: 'notify_customers' });
    await m.a.post(`/api/decisions/${d1}/approve`, {});
    const [run, rec] = await Promise.all([m.a.post(`/api/decisions/${d1}/execute`, {}), receive(m, 150)]);
    assert.equal(rec.status, 201, JSON.stringify(rec.body));
    assert.ok([200, 409].includes(run.status), JSON.stringify(run.body));
    // Settle: whatever the interleaving, a discovery afterwards agrees.
    await m.a.post('/api/decisions/discover', {});
    const active = await activeDelay(m.user.id);
    assert.equal(active.length, 1);
    assert.deepEqual(atRiskOf(active[0]), M.EXPECTED.afterPartialReceipt.atRisk, `round ${i}`);
    const live = await sendable(m.user.id);
    const stale = live.filter((n) => !active.some((a) => a.id === n.decision_id));
    assert.equal(stale.length, 0, `round ${i}: drafts left on an outdated decision: ${JSON.stringify(live)}`);
    const onOld = (await notices(m.user.id, d1)).filter((n) => ['pending', 'approved'].includes(n.status));
    assert.equal(onOld.length, 0, `round ${i}: run=${run.status}`);
  }
});

test('tenant isolation: another account cannot see lineage or approve drafts, and its discovery touches nothing here', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const m = await meridian('iso-a', { live: true });
  const d1 = await reportDelay(m);
  await approveAndRun(m, d1);
  await receive(m, 150);
  const [n1] = await notices(m.user.id, d1);
  const other = await createTenant(env.pool, 'reconcile-iso-b');
  tenants.push(other);
  const b = api(other);
  assert.equal((await b.get(`/api/decisions/${d1}`)).status, 404);
  assert.equal((await b.patch(`/api/ai-actions/${n1.id}`, { status: 'approved' })).status, 404);
  assert.equal((await b.post(`/api/client/actions/${n1.id}/decision`, { decision: 'approve' })).status, 404);
  const before = await delayDecisions(m.user.id);
  const disc = await b.post('/api/decisions/discover', {});
  assert.equal(disc.status, 200);
  assert.deepEqual(await delayDecisions(m.user.id), before);
});

test('other decision kinds keep their contracted behaviour', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const user = await createTenant(env.pool, 'reconcile-recv');
  tenants.push(user);
  await seedGolden(env.pool, user.id, today);
  const a = api(user);
  const disc = await a.post('/api/decisions/discover', {});
  assert.equal(disc.status, 200, JSON.stringify(disc.body));
  const recv = (await q(`SELECT id FROM decisions WHERE user_id = $1 AND kind = 'RECEIVABLE_RISK' AND status = 'OPEN' ORDER BY attention_score DESC LIMIT 1`, [user.id]))[0];
  assert.ok(recv, 'the golden fixture yields a receivables decision');
  const s = await a.post(`/api/decisions/${recv.id}/select`, { optionKey: 'do_nothing' });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  // Change the receivables and re-discover: the chosen decision is re-observed, not superseded.
  await env.pool.query(`UPDATE invoices SET invoice_amount = invoice_amount * 2 WHERE user_id = $1`, [user.id]);
  await a.post('/api/decisions/discover', {});
  const st = (await q(`SELECT status FROM decisions WHERE id = $1`, [recv.id]))[0].status;
  assert.equal(st, 'SELECTED');
  assert.equal((await q(`SELECT count(*)::int n FROM decisions WHERE user_id = $1 AND status = 'SUPERSEDED'`, [user.id]))[0].n, 0);
});

// Pure checks, no database. This file is also run with the process in
// Asia/Kolkata, Pacific/Kiritimati and America/Los_Angeles by
// tests/decisions.timezone.test.js, so these hold in every one of them.
test('year boundary: slip, ready date and fingerprint are calendar days across 31 Dec -> 1 Jan', () => {
  const { assessSupplierDelay } = require('../lib/domain/decisions/commitments');
  const { delayFingerprint, delayChanges } = require('../lib/domain/decisions/detectors/supplierDelay');
  const { pgDateDay } = require('../lib/domain/decisions/dates');
  const line = { purchaseLineId: 'pl-1', productId: 'p-1', quantity: 20, receivedQuantity: 0 };
  const plan = (expectedAt) => assessSupplierDelay({
    asOfDay: '2026-12-29',
    delayedLine: { ...line, originalExpectedAt: '2026-12-31', expectedAt },
    // Promised dates as node-pg hands them over: a Date at LOCAL midnight.
    orderLines: [{ orderId: 'o-1', orderLineId: 'ol-1', productId: 'p-1', quantity: 10, unitPrice: 100, neededBy: pgDateDay(new Date(2027, 0, 1)), customerName: 'New Year Co' }],
    stock: [{ productId: 'p-1', onHand: 0 }],
    inbound: [{ ...line, expectedAt }],
    bom: [],
  });
  const a = plan('2027-01-02');
  assert.equal(a.atRisk.length, 1);
  assert.equal(a.atRisk[0].neededBy, '2027-01-01');
  assert.equal(a.atRisk[0].readyAt, '2027-01-02');
  assert.equal(a.atRisk[0].slipDays, 1);
  assert.equal(a.delayDays, 2);
  // The same assessment with the shipment date as a UTC-midnight timestamp
  // (how expected_at is stored) has the same fingerprint.
  const asStored = { expectedAt: new Date(Date.UTC(2027, 0, 2)), atRisk: a.atRisk };
  assert.equal(delayFingerprint(asStored), delayFingerprint({ expectedAt: '2027-01-02', atRisk: a.atRisk }));
  // One more day of slip is a different fingerprint and a named change.
  const b = plan('2027-01-03');
  assert.notEqual(delayFingerprint({ expectedAt: b.expectedAt, atRisk: b.atRisk }), delayFingerprint({ expectedAt: a.expectedAt, atRisk: a.atRisk }));
  const ch = delayChanges({ atRisk: a.atRisk }, { atRisk: b.atRisk });
  assert.deepEqual(ch.map((c) => [c.customerName, c.before.readyAt, c.after.readyAt]), [['New Year Co', '2027-01-02', '2027-01-03']]);
  // Back on the original date: nothing at risk.
  assert.equal(plan('2026-12-31').atRisk.length, 0);
});
