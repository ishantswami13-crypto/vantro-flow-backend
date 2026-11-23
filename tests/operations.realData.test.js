// FILE: tests/operations.realData.test.js
// Real-data pilot for supplier-delay intelligence, over real HTTP against a
// real local Postgres:
//
//   product master in Starlane -> import open purchase lines (CSV) and open
//   customer orders (XLSX) through preview -> confirm -> commit -> report a
//   supplier delay -> the decision names exactly the orders it puts at risk,
//   using imported OUTSTANDING quantities -> record a partial receipt ->
//   recalculated -> record the rest -> decision resolves. Inventory stays
//   mathematically consistent through retries, races, the app's reconcile
//   and Tally-booked lines. Every expected value is worked out by hand in
//   tests/fixtures/realPilot.js.
//
// Run: DATABASE_URL=postgres://...@127.0.0.1/... JWT_SECRET=... node --test tests/operations.realData.test.js
// Skips (never passes silently) when no database is configured.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { dbReady, createTenant, deleteTenant, startServer, client, todayIso } = require('./helpers/decisionHarness');
const { testDatabaseProblem } = require('../lib/db/testDatabaseGuard');
const { plus, seedProductMaster, productsCsv, componentsCsv, purchaseCsv, ordersXlsx, PRODUCT_MAPPING, COMPONENT_MAPPING, PURCHASE_MAPPING, ORDER_MAPPING, EXPECTED } = require('./fixtures/realPilot');
const { commitOperationalImport } = require('../lib/domain/operations/operationalImport');

let env;
let server;
const tenants = [];
const today = todayIso();

test.before(async () => {
  const problem = testDatabaseProblem();
  if (problem) { env = { ok: false, reason: problem }; return; }
  env = await dbReady();
  if (!env.ok) return;
  const t = await env.pool.query(`SELECT to_regclass('public.purchase_line_receipts') AS t`);
  if (!t.rows[0].t) { env = { ok: false, reason: 'migration 078_operational_imports_receipts.sql not applied' }; return; }
  server = await startServer({ FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED: 'false', STARLANE_GLOBAL_STOP: '' });
});

test.after(async () => {
  if (server) await server.stop();
  if (env?.ok) {
    for (const t of tenants) {
      for (const tbl of ['purchase_line_receipts', 'stock_movements', 'raw_observations', 'file_import_batches', 'order_line_items', 'orders', 'purchase_line_items', 'purchases', 'product_suppliers', 'product_components', 'products', 'suppliers', 'customers']) {
        await env.pool.query(`DELETE FROM ${tbl} WHERE user_id = $1`, [t.id]).catch(() => {});
      }
      await deleteTenant(env.pool, t.id).catch(() => {});
    }
    await env.pool.end();
  }
});

function withUpload(api, user) {
  const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
  async function upload(path, buffer, filename, fields) {
    const form = new FormData();
    form.append('file', new Blob([buffer]), filename);
    for (const [k, v] of Object.entries(fields)) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    const r = await fetch(`${server.base}/api/decisions${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return { status: r.status, body };
  }
  return { ...api, upload };
}

async function tenant(label) {
  const user = await createTenant(env.pool, `ops-${label}`);
  tenants.push(user);
  const P = await seedProductMaster(env.pool, user.id);
  return { user, P, api: withUpload(client(server.base, user), user) };
}

const key = () => `test-${crypto.randomUUID()}`;
const stockOf = async (userId, productId) => Number((await env.pool.query('SELECT current_stock FROM products WHERE id = $1 AND user_id = $2', [productId, userId])).rows[0].current_stock);
const ledgerOf = async (userId, productId) => Number((await env.pool.query(`SELECT COALESCE(SUM(CASE WHEN movement_type='in' THEN quantity ELSE -quantity END),0) AS s FROM stock_movements WHERE user_id = $1 AND product_id = $2`, [userId, productId])).rows[0].s);

async function importPurchases(t, extra = {}) {
  const buf = purchaseCsv(today, extra.overrides || {});
  const preview = await t.api.upload('/operations/import/preview', buf, 'zoho-open-pos.csv', { kind: 'purchase_lines' });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const options = { mapping: PURCHASE_MAPPING, dateOrders: {}, sourceSystem: 'Zoho Inventory', currency: null, stockFollows: extra.stockFollows || 'STARLANE', reviewChoices: extra.reviewChoices || {} };
  const commit = await t.api.upload('/operations/import/commit', buf, 'zoho-open-pos.csv', { kind: 'purchase_lines', options });
  assert.equal(commit.status, 200, JSON.stringify(commit.body));
  return { preview: preview.body, commit: commit.body, buf, options };
}

async function importOrders(t, overrides = {}) {
  const buf = ordersXlsx(today, overrides);
  const options = { mapping: ORDER_MAPPING, dateOrders: {}, sourceSystem: 'Tally sales orders', currency: null, reviewChoices: {} };
  const commit = await t.api.upload('/operations/import/commit', buf, 'open-orders.xlsx', { kind: 'orders', options });
  assert.equal(commit.status, 200, JSON.stringify(commit.body));
  return { commit: commit.body, buf, options };
}

async function motorLine(userId) {
  return (await env.pool.query(`SELECT * FROM purchase_line_items WHERE user_id = $1 AND external_ref = 'PO-901/1'`, [userId])).rows[0];
}

test('purchase-line import: preview shows mapping, review items, rejections and conflicts; commit writes only what was confirmed', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const a = await tenant('po');
  // A bill typed in by hand earlier with the same number as an open PO.
  await env.pool.query(`INSERT INTO purchases (user_id, supplier_name, amount, status, bill_number) VALUES ($1,'Volt Motors Pvt Ltd',21000,'unpaid','PO-777')`, [a.user.id]);

  const buf = purchaseCsv(today);
  const pv = await a.api.upload('/operations/import/preview', buf, 'zoho-open-pos.csv', { kind: 'purchase_lines' });
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  const prop = pv.body.proposal.fields;
  assert.equal(prop.po_ref.header, 'PO No');
  assert.equal(prop.supplier_name.header, 'Vendor');
  assert.equal(prop.received_quantity.header, 'Received Qty');
  assert.equal(prop.quantity.verdict, 'SUGGESTED', 'a column with an unreadable value is not auto-confirmed');
  assert.ok(pv.body.mappingErrors.some((e) => /system this file came from/.test(e)), 'source system must be named by a human');
  assert.ok(pv.body.mappingErrors.some((e) => /who records stock/.test(e)) === false, 'the suggestion pre-fills stockFollows for review');
  assert.equal(pv.body.suggestedInput.stockFollows, 'STARLANE', 'no Tally stock on this tenant');
  assert.equal(pv.body.summary, null, 'no row analysis until the mapping is valid');

  const options = { mapping: PURCHASE_MAPPING, dateOrders: {}, sourceSystem: 'Zoho Inventory', stockFollows: 'STARLANE', reviewChoices: {} };
  const pv2 = await a.api.upload('/operations/import/preview', buf, 'zoho-open-pos.csv', { kind: 'purchase_lines', options });
  assert.equal(pv2.status, 200, JSON.stringify(pv2.body));
  const s = pv2.body.summary;
  assert.equal(s.counts.new, 3, JSON.stringify(s.counts));
  assert.equal(s.counts.reviewRequired, 2);
  assert.equal(s.counts.rejected, 3);
  assert.equal(s.counts.conflicts, 1);
  const reviewByLabel = Object.fromEntries(s.review.map((r) => [r.label, r]));
  assert.equal(reviewByLabel['GSK-1 · Gasket'].candidates.length, 2, 'two products share the SKU: ambiguous, not guessed');
  assert.ok(reviewByLabel['UNK-9 · Unknown part'].unknown, 'unknown product is held, never created');
  const reasons = s.rejectedByReason.map((r) => r.example).join(' | ');
  assert.match(reasons, /received quantity 12 is more than the ordered 10/);
  assert.match(reasons, /"abc" is not a quantity/);
  assert.match(reasons, /expected delivery date "2026-02-31" could not be read/);
  assert.match(s.conflicts[0].details[0], /PO-777 .*already exists/);
  const nothing = await env.pool.query('SELECT COUNT(*)::int AS n FROM purchase_line_items WHERE user_id = $1', [a.user.id]);
  assert.equal(nothing.rows[0].n, 0, 'preview writes nothing');

  // Commit with the review answered: gasket -> Gasket Red, unknown part -> import unlinked.
  const gasketKey = reviewByLabel['GSK-1 · Gasket'].key;
  const unknownKey = reviewByLabel['UNK-9 · Unknown part'].key;
  const choices = { [gasketKey]: a.P.gasketRed, [unknownKey]: 'UNLINKED' };
  const cm = await a.api.upload('/operations/import/commit', buf, 'zoho-open-pos.csv', { kind: 'purchase_lines', options: { ...options, reviewChoices: choices } });
  assert.equal(cm.status, 200, JSON.stringify(cm.body));
  assert.equal(cm.body.summary.counts.new, 5);
  assert.equal(cm.body.summary.counts.unlinked, 1);
  assert.equal(cm.body.summary.entities.suppliersCreated, 2);

  const lines = (await env.pool.query(
    `SELECT pli.external_ref, pli.product_id, pli.quantity::text, pli.received_quantity::text, pli.received_before_tracking::text, pli.expected_at, pli.unit_price::text, pli.currency, pli.stock_follows,
            pu.amount::text AS amount, pu.status AS pstatus, pu.bill_number
       FROM purchase_line_items pli JOIN purchases pu ON pu.id = pli.purchase_id WHERE pli.user_id = $1 ORDER BY pli.external_ref`,
    [a.user.id]
  )).rows;
  assert.deepEqual(lines.map((l) => l.external_ref), ['PO-901/1', 'PO-901/2', 'PO-905/1', 'PO-906/1', 'PO-907/1']);
  const m = lines[0];
  assert.equal(m.product_id, a.P.motor);
  assert.equal(m.quantity, '50');
  assert.equal(m.received_quantity, '10');
  assert.equal(m.received_before_tracking, '10', 'units already received in Zoho are already in stock');
  assert.equal(m.unit_price, '4200.00' === m.unit_price ? '4200.00' : '4200', 'exact decimal from "4,200.00"');
  assert.equal(new Date(m.expected_at).toISOString(), `${plus(today, 5)}T00:00:00.000Z`, 'expected date stored as that calendar day, UTC');
  assert.equal(m.amount, '0.00', 'an open PO is not a bill: payables unchanged');
  assert.equal(m.pstatus, 'ordered');
  assert.equal(lines[3].product_id, a.P.gasketRed, 'owner-confirmed product');
  assert.equal(lines[4].product_id, null, 'unknown product imported unlinked, as chosen');
  const manual = await env.pool.query(`SELECT COUNT(*)::int AS n FROM purchase_line_items pli JOIN purchases pu ON pu.id = pli.purchase_id WHERE pu.user_id = $1 AND pu.bill_number = 'PO-777' AND pu.import_key IS NULL`, [a.user.id]);
  assert.equal(manual.rows[0].n, 0, 'never attached to a bill entered elsewhere');
  const links = await env.pool.query(`SELECT COUNT(*)::int AS n FROM product_suppliers WHERE user_id = $1 AND source = 'ops_import'`, [a.user.id]);
  assert.equal(links.rows[0].n, 4);
  const obs = await env.pool.query(`SELECT COUNT(*)::int AS n FROM raw_observations WHERE user_id = $1 AND source_quality = 'REAL' AND entity_type = 'purchase_line_item'`, [a.user.id]);
  assert.equal(obs.rows[0].n, 5, 'every committed row has provenance');
  const audit = await env.pool.query(`SELECT payload FROM decision_events WHERE user_id = $1 AND event_type = 'OPERATIONS_IMPORTED'`, [a.user.id]);
  assert.equal(audit.rows.length, 1);

  // Importing does not book anything into stock (motors 4, gaskets 0).
  assert.equal(await stockOf(a.user.id, a.P.motor), 4);
  // Opening the app runs the reconcile: still nothing booked, typed stock kept.
  await a.api.get('/api/auth/me');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await stockOf(a.user.id, a.P.motor), 4, 'received-before-tracking units are not booked again');
  assert.equal(await ledgerOf(a.user.id, a.P.motor), 4);

  // Repeat: identical file + choices -> recognised, nothing written.
  const again = await a.api.upload('/operations/import/commit', buf, 'zoho-open-pos.csv', { kind: 'purchase_lines', options: { ...options, reviewChoices: choices } });
  assert.equal(again.status, 200);
  assert.equal(again.body.import.alreadyImported, true);
  // Same rows, different bytes (re-saved file, LF endings): matched row by row, all unchanged.
  const lf = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'));
  const resaved = await a.api.upload('/operations/import/commit', lf, 'zoho-open-pos (1).csv', { kind: 'purchase_lines', options: { ...options, reviewChoices: choices } });
  assert.equal(resaved.status, 200, JSON.stringify(resaved.body));
  assert.equal(resaved.body.summary.counts.new, 0);
  assert.equal(resaved.body.summary.counts.unchanged, 5);
  const count = await env.pool.query('SELECT COUNT(*)::int AS n FROM purchase_line_items WHERE user_id = $1', [a.user.id]);
  assert.equal(count.rows[0].n, 5, 'no duplicate purchase lines');
  const pcount = await env.pool.query(`SELECT COUNT(*)::int AS n FROM purchases WHERE user_id = $1 AND import_key IS NOT NULL`, [a.user.id]);
  assert.equal(pcount.rows[0].n, 4, 'one purchase per PO (901, 905, 906, 907)');

  // Newer export: Ferro moved the impeller date (+20 -> +25) and PO-907 is gone.
  const newer = purchaseCsv(today, { impellerDate: plus(today, 25), dropLine: 'PO-907' });
  const up = await a.api.upload('/operations/import/commit', newer, 'zoho-open-pos-newer.csv', { kind: 'purchase_lines', options: { ...options, reviewChoices: choices } });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.summary.counts.updated, 1);
  assert.equal(up.body.summary.notInThisFile, 1, 'a line missing from the newer export is counted');
  const imp = (await env.pool.query(`SELECT expected_at, original_expected_at, delay_reason FROM purchase_line_items WHERE user_id = $1 AND external_ref = 'PO-905/1'`, [a.user.id])).rows[0];
  assert.equal(new Date(imp.expected_at).toISOString().slice(0, 10), plus(today, 25));
  assert.equal(new Date(imp.original_expected_at).toISOString().slice(0, 10), plus(today, 20), 'the date relied on is kept for delay comparison');
  assert.match(imp.delay_reason, /moved in Zoho Inventory export/);
  const kept = await env.pool.query(`SELECT COUNT(*)::int AS n FROM purchase_line_items WHERE user_id = $1 AND external_ref = 'PO-907/1'`, [a.user.id]);
  assert.equal(kept.rows[0].n, 1, 'absent from the newer file is not deleted');
});

test('end to end: imported orders + purchase lines -> delay -> exact at-risk orders -> receipts recalculate -> resolves; inventory stays consistent', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const a = await tenant('e2e');
  await importPurchases(a, { reviewChoices: {} });
  const ord = await importOrders(a);
  const s = ord.commit.summary;
  assert.equal(s.counts.new, 7, JSON.stringify(s.counts));
  assert.equal(s.counts.closedSkipped, 1, 'a delivered order is not imported as open demand');
  assert.ok(s.limitations.some((l) => l.key === 'outstandingNotReported'));
  assert.ok(s.limitations.some((l) => l.key === 'noPromisedDate'));
  const so2 = (await env.pool.query(`SELECT quantity::text, outstanding_quantity::text, needed_by::text, unit_price::text, currency FROM order_line_items WHERE user_id = $1 AND external_ref = 'SO-2/1'`, [a.user.id])).rows[0];
  assert.deepEqual(so2, { quantity: '20', outstanding_quantity: '15', needed_by: plus(today, 8), unit_price: '9000', currency: 'INR' });
  const so3 = (await env.pool.query(`SELECT outstanding_quantity FROM order_line_items WHERE user_id = $1 AND external_ref = 'SO-3/1'`, [a.user.id])).rows[0];
  assert.equal(so3.outstanding_quantity, null, 'not reported stays unknown');
  const so8 = (await env.pool.query(`SELECT currency FROM order_line_items WHERE user_id = $1 AND external_ref = 'SO-8/1'`, [a.user.id])).rows[0];
  assert.equal(so8.currency, 'USD');

  const open = await a.api.get('/api/decisions/operations/open-orders');
  assert.equal(open.status, 200);
  assert.equal(open.body.lines.length, 7);
  assert.equal(open.body.checkable, 6, 'SO-7 has no promised date');

  // Before any delay: no supplier-delay decision exists.
  const shipments = await a.api.get('/api/decisions/inbound-shipments');
  const motor = shipments.body.shipments.find((x) => x.external_ref === 'PO-901/1');
  assert.ok(motor, JSON.stringify(shipments.body.shipments.map((x) => x.external_ref)));
  assert.equal(Number(motor.quantity) - Number(motor.received_quantity), 40);

  // Volt Motors moves the motors from +5 to +12.
  const rep = await a.api.post('/api/decisions/report-supplier-delay', { purchaseLineItemId: motor.id, newExpectedAt: plus(today, 12), reason: 'Copper shortage' });
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  assert.ok(rep.body.decision, JSON.stringify(rep.body));
  const d1 = (await a.api.get(`/api/decisions/${rep.body.decision.id}`)).body.decision;
  const sd = d1.analysis.supplierDelay;
  assert.deepEqual(sd.atRisk.map((l) => l.customerName).sort(), EXPECTED.afterDelay.atRisk);
  assert.deepEqual(sd.alreadyAtRisk.map((l) => l.customerName), EXPECTED.afterDelay.alreadyAtRisk);
  assert.equal(sd.unaffectedCount, EXPECTED.afterDelay.unaffected);
  assert.equal(sd.unknownCount, EXPECTED.afterDelay.unknown);
  assert.equal(d1.materiality.revenueExposure, EXPECTED.afterDelay.valueAtRisk, 'uses the imported pending quantity, not the ordered quantity');
  assert.equal(sd.unitsNeededFromShipment, EXPECTED.afterDelay.unitsNeededFromShipment);
  assert.equal(d1.materiality.delayDays, EXPECTED.afterDelay.delayDays);
  for (const l of sd.atRisk) assert.equal(l.slipDays, EXPECTED.afterDelay.slip[l.customerName]);
  assert.ok(d1.evidence.some((e) => e.kind === 'ASSUMPTION' && /did not say how much is still to deliver/.test(e.detail)), 'missing outstanding quantity is shown as an assumption');
  assert.ok(d1.evidence.some((e) => /Order #SO-1/.test(e.label)), 'orders are named by the customer\'s own order number');
  const notify = d1.options.find((o) => o.key === 'notify_customers');
  assert.ok(notify.intent.drafts.every((dr) => /order #SO-[12]/.test(dr.message)));

  // Repeated calculation is identical.
  const rerun = await a.api.post('/api/decisions/discover', {});
  assert.equal(rerun.status, 200);
  const d1b = (await a.api.get(`/api/decisions/${rep.body.decision.id}`)).body.decision;
  assert.deepEqual(d1b.analysis.supplierDelay.atRisk, sd.atRisk);

  // Approval gate: nothing executes without a selected, approved option; no drafts, no sends.
  const early = await a.api.post(`/api/decisions/${d1.id}/execute`, {});
  assert.equal(early.status, 409);
  const drafts0 = await env.pool.query(`SELECT COUNT(*)::int AS n FROM ai_actions WHERE user_id = $1`, [a.user.id]);
  assert.equal(drafts0.rows[0].n, 0);

  // Partial receipt: 20 of the 40 motors arrive today.
  const k1 = key();
  const r1 = await a.api.post(`/api/decisions/purchase-lines/${motor.id}/receipts`, { quantity: '20', receivedOn: today, reference: 'GRN-55', idempotencyKey: k1 });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal(r1.body.stock.posted, true);
  assert.equal(r1.body.line.outstandingQuantity, '20');
  assert.equal(r1.body.line.receivedQuantity, '30');
  assert.equal(await stockOf(a.user.id, a.P.motor), 24, '4 typed in + 20 received');
  assert.equal(await ledgerOf(a.user.id, a.P.motor), 24, 'ledger agrees (opening 4 recorded + 20)');
  const d2 = (await a.api.get(`/api/decisions/${d1.id}`)).body.decision;
  assert.deepEqual(d2.analysis.supplierDelay.atRisk.map((l) => l.customerName), EXPECTED.afterPartialReceipt.atRisk, 'receiving goods updates the assessment');
  assert.equal(d2.materiality.revenueExposure, EXPECTED.afterPartialReceipt.valueAtRisk);

  // Retry with the same key: same receipt, no new stock.
  const r1b = await a.api.post(`/api/decisions/purchase-lines/${motor.id}/receipts`, { quantity: '20', receivedOn: today, reference: 'GRN-55', idempotencyKey: k1 });
  assert.equal(r1b.status, 200);
  assert.equal(r1b.body.duplicate, true);
  assert.equal(r1b.body.receipt.id, r1.body.receipt.id);
  const reuse = await a.api.post(`/api/decisions/purchase-lines/${motor.id}/receipts`, { quantity: '5', receivedOn: today, idempotencyKey: k1 });
  assert.equal(reuse.status, 409, 'same key, different content is refused');
  assert.equal(await stockOf(a.user.id, a.P.motor), 24);

  // Excess receipt is refused.
  const over = await a.api.post(`/api/decisions/purchase-lines/${motor.id}/receipts`, { quantity: '21', receivedOn: today, idempotencyKey: key() });
  assert.equal(over.status, 409);
  assert.equal(over.body.outstandingQuantity, '20');

  // Two different receipts of 15 racing for 20 outstanding: exactly one wins.
  const race = await Promise.all([1, 2].map(() => a.api.post(`/api/decisions/purchase-lines/${motor.id}/receipts`, { quantity: '15', receivedOn: today, idempotencyKey: key() })));
  assert.deepEqual(race.map((r) => r.status).sort(), [201, 409], JSON.stringify(race.map((r) => r.body)));
  assert.equal(await stockOf(a.user.id, a.P.motor), 39);

  // Correction: 15 was wrong, it was 10. Needs a reason; cannot go below zero.
  const noReason = await a.api.post(`/api/decisions/purchase-lines/${motor.id}/receipts`, { kind: 'CORRECTION', quantity: '-5', receivedOn: today, idempotencyKey: key() });
  assert.equal(noReason.status, 400);
  const corr = await a.api.post(`/api/decisions/purchase-lines/${motor.id}/receipts`, { kind: 'CORRECTION', quantity: '-5', receivedOn: today, notes: 'Counted 10, not 15, on GRN-56', idempotencyKey: key() });
  assert.equal(corr.status, 201, JSON.stringify(corr.body));
  assert.equal(await stockOf(a.user.id, a.P.motor), 34);
  assert.equal(corr.body.line.outstandingQuantity, '10');

  // Final receipt closes the line; the delay decision resolves.
  const fin = await a.api.post(`/api/decisions/purchase-lines/${motor.id}/receipts`, { quantity: '10', receivedOn: today, idempotencyKey: key() });
  assert.equal(fin.status, 201, JSON.stringify(fin.body));
  assert.equal(fin.body.line.outstandingQuantity, '0');
  assert.equal(await stockOf(a.user.id, a.P.motor), 44, '4 + 40 received; the 10 received before tracking are not counted twice');
  const d3 = (await a.api.get(`/api/decisions/${d1.id}`)).body.decision;
  assert.equal(d3.status, 'RESOLVED');

  // History is complete and ordered.
  const hist = await a.api.get(`/api/decisions/purchase-lines/${motor.id}/receipts`);
  assert.equal(hist.status, 200);
  assert.deepEqual(hist.body.receipts.map((r) => [r.kind, r.quantity]), [['RECEIPT', '20'], ['RECEIPT', '15'], ['CORRECTION', '-5'], ['RECEIPT', '10']]);
  assert.equal(hist.body.line.receivedBeforeTracking, '10');

  // App restart + reconcile: no movement is added, stock is unchanged.
  const pliMoves = async () => (await env.pool.query(`SELECT COUNT(*)::int AS n FROM stock_movements WHERE user_id = $1 AND reference NOT LIKE 'OPENING-%'`, [a.user.id])).rows[0].n;
  const movesBefore = await pliMoves();
  await server.stop();
  server = await startServer({ FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED: 'false', STARLANE_GLOBAL_STOP: '' });
  const api2 = client(server.base, a.user);
  await api2.get('/api/auth/me');
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(await stockOf(a.user.id, a.P.motor), 44);
  assert.equal(await pliMoves(), movesBefore, 'reconcile books no receipt twice (it may only record opening balances for untouched products)');
  for (const pid of Object.values(a.P)) assert.equal(await ledgerOf(a.user.id, pid), await stockOf(a.user.id, pid), 'every product: stock equals its ledger');
  // Other products untouched by any of this.
  assert.equal(await stockOf(a.user.id, a.P.valve), 40);
  assert.equal(await stockOf(a.user.id, a.P.impeller), 30);
  const sent = await env.pool.query(`SELECT COUNT(*)::int AS n FROM execution_records WHERE user_id = $1`, [a.user.id]);
  assert.equal(sent.rows[0].n, 0, 'nothing was sent to anyone');
});

test('Tally-booked lines: a receipt reduces outstanding but never moves stock; the reconcile books nothing for them', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const a = await tenant('tally');
  // This tenant's stock comes from Tally vouchers.
  await env.pool.query(`INSERT INTO stock_movements (user_id, product_id, movement_type, quantity, reference) VALUES ($1,$2,'in',4,'TLY-PURCHASE-1-20260101:Motor 1HP')`, [a.user.id, a.P.motor]);
  const pv = await a.api.upload('/operations/import/preview', purchaseCsv(today), 'pos.csv', { kind: 'purchase_lines' });
  assert.equal(pv.body.suggestedInput.stockFollows, 'EXTERNAL', 'Tally stock on record: suggest Tally books the stock');
  await importPurchases(a, { stockFollows: 'EXTERNAL' });
  const line = await motorLine(a.user.id);
  assert.equal(line.stock_follows, 'EXTERNAL');
  const r = await a.api.post(`/api/decisions/purchase-lines/${line.id}/receipts`, { quantity: '40', receivedOn: today, idempotencyKey: key() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.stock.posted, false);
  assert.match(r.body.stock.reason, /accounting system/);
  assert.equal(r.body.line.outstandingQuantity, '0');
  assert.equal(await stockOf(a.user.id, a.P.motor), 4);
  await a.api.get('/api/auth/me');
  await new Promise((res) => setTimeout(res, 1500));
  assert.equal(await stockOf(a.user.id, a.P.motor), 4, 'stock is left to the Tally voucher');
  assert.equal((await env.pool.query(`SELECT COUNT(*)::int AS n FROM stock_movements WHERE user_id = $1 AND reference LIKE 'PLI-%'`, [a.user.id])).rows[0].n, 0);
});

test('tenant isolation: another tenant cannot see, receive against or import into this tenant; bad tokens are refused', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const a = await tenant('iso-a');
  const b = await tenant('iso-b');
  await importPurchases(a);
  const lineA = await motorLine(a.user.id);

  const peek = await b.api.get(`/api/decisions/purchase-lines/${lineA.id}/receipts`);
  assert.equal(peek.status, 404);
  const steal = await b.api.post(`/api/decisions/purchase-lines/${lineA.id}/receipts`, { quantity: '1', receivedOn: today, idempotencyKey: key() });
  assert.equal(steal.status, 404);
  assert.equal((await motorLine(a.user.id)).received_quantity, '10');
  const shipB = await b.api.get('/api/decisions/inbound-shipments');
  assert.equal(shipB.body.shipments.length, 0);
  // B's import matches B's own products (same SKUs), never A's.
  await importPurchases(b);
  const lineB = await motorLine(b.user.id);
  assert.equal(lineB.product_id, b.P.motor);
  assert.notEqual(lineB.product_id, a.P.motor);
  // A review choice pointing at another tenant's product is ignored (stays in review).
  const buf = purchaseCsv(today);
  const pv = await b.api.upload('/operations/import/preview', buf, 'x.csv', { kind: 'purchase_lines', options: { mapping: PURCHASE_MAPPING, dateOrders: {}, sourceSystem: 'Zoho Inventory', stockFollows: 'STARLANE', reviewChoices: {} } });
  const gk = pv.body.summary.review.find((r) => r.label === 'GSK-1 · Gasket').key;
  const pv2 = await b.api.upload('/operations/import/preview', buf, 'x.csv', { kind: 'purchase_lines', options: { mapping: PURCHASE_MAPPING, dateOrders: {}, sourceSystem: 'Zoho Inventory', stockFollows: 'STARLANE', reviewChoices: { [gk]: a.P.gasketRed } } });
  assert.ok(pv2.body.summary.review.some((r) => r.key === gk), "another tenant's product id is not accepted");
  // Body-supplied tenant ids are ignored.
  const forged = await b.api.post(`/api/decisions/purchase-lines/${lineA.id}/receipts`, { userId: a.user.id, user_id: a.user.id, quantity: '1', receivedOn: today, idempotencyKey: key() });
  assert.equal(forged.status, 404);
  // No token / forged token / unknown user.
  const none = await fetch(`${server.base}/api/decisions/operations/open-orders`);
  assert.equal(none.status, 401);
  const badSig = jwt.sign({ userId: a.user.id }, 'not-the-secret', { algorithm: 'HS256' });
  const r2 = await fetch(`${server.base}/api/decisions/operations/open-orders`, { headers: { Authorization: `Bearer ${badSig}` } });
  assert.equal(r2.status, 401);
  const ghost = jwt.sign({ userId: crypto.randomUUID(), email: 'ghost@x.invalid' }, process.env.JWT_SECRET, { algorithm: 'HS256' });
  const r3 = await fetch(`${server.base}/api/decisions/operations/open-orders`, { headers: { Authorization: `Bearer ${ghost}` } });
  if (r3.status === 200) assert.equal((await r3.json()).lines.length, 0, 'an unknown tenant sees nothing');
  else assert.ok([401, 403, 404].includes(r3.status));
  const notUuid = jwt.sign({ userId: 'not-a-uuid' }, process.env.JWT_SECRET, { algorithm: 'HS256' });
  const r4 = await fetch(`${server.base}/api/decisions/operations/open-orders`, { headers: { Authorization: `Bearer ${notUuid}` } });
  assert.ok(r4.status >= 400 && r4.status < 500, `invalid tenant id refused, got ${r4.status}`);
});

test('order import edge cases: currency, invalid values, changed source records', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const a = await tenant('orders-edge');
  const d = (n) => plus(today, n);
  const csv = [
    'Order No,Customer,SKU,Qty,Pending Qty,Price,Currency,Promised Date',
    `SO-10,Arora Agro,VLV-25,5,5,$12,,${d(3)}`,
    `SO-11,Arora Agro,VLV-25,5,5,12,RUP,${d(3)}`,
    `SO-12,Arora Agro,VLV-25,5,7,400,INR,${d(3)}`,
    `SO-13,Arora Agro,VLV-25,-5,,400,INR,${d(3)}`,
    `SO-14,Arora Agro,VLV-25,5,5,₹400,USD,${d(3)}`,
    `SO-15,Arora Agro,VLV-25,5,5,400,INR,${d(3)}`,
    `SO-15,Arora Agro,VLV-25,5,5,400,INR,${d(3)}`,
    `SO-16,Arora Agro,VLV-25,5,5,400,INR,${d(3)}`,
    `SO-16,Arora Agro,VLV-25,6,6,400,INR,${d(3)}`,
  ].join('\n');
  const options = { mapping: { order_ref: 'Order No', customer_name: 'Customer', sku: 'SKU', quantity: 'Qty', outstanding_quantity: 'Pending Qty', unit_price: 'Price', currency: 'Currency', promised_date: 'Promised Date' }, dateOrders: {}, sourceSystem: 'Orders sheet', reviewChoices: {} };
  const pv = await a.api.upload('/operations/import/preview', Buffer.from(csv), 'orders.csv', { kind: 'orders', options });
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  const s = pv.body.summary;
  const reasons = s.rejectedByReason.map((r) => r.example).join(' | ');
  assert.match(reasons, /symbol several currencies share/);
  assert.match(reasons, /"RUP" is not a recognised ISO code/);
  assert.match(reasons, /outstanding quantity 7 is more than the ordered 5/);
  assert.match(reasons, /"-5" is negative/);
  assert.match(reasons, /currency column says USD but the price is written in INR/);
  assert.match(reasons, /appears again with different values/);
  assert.equal(s.counts.new, 2, 'SO-15 once (exact duplicate counted once), SO-16 first row');
  assert.equal(s.counts.duplicateRows, 1);

  const cm = await a.api.upload('/operations/import/commit', Buffer.from(csv), 'orders.csv', { kind: 'orders', options });
  assert.equal(cm.status, 200, JSON.stringify(cm.body));
  // Changed source record: SO-15 partly delivered, promise moved.
  const changed = `Order No,Customer,SKU,Qty,Pending Qty,Price,Currency,Promised Date\nSO-15,Arora Agro,VLV-25,5,2,400,INR,${d(5)}\n`;
  const up = await a.api.upload('/operations/import/commit', Buffer.from(changed), 'orders-2.csv', { kind: 'orders', options });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.summary.counts.updated, 1);
  assert.equal(up.body.summary.notInThisFile, 1, 'SO-16 not in the newer file, left as is');
  const row = (await env.pool.query(`SELECT outstanding_quantity::text, needed_by::text FROM order_line_items WHERE user_id = $1 AND external_ref = 'SO-15'`, [a.user.id])).rows[0];
  assert.deepEqual(row, { outstanding_quantity: '2', needed_by: d(5) });
  assert.equal((await env.pool.query(`SELECT COUNT(*)::int AS n FROM order_line_items WHERE user_id = $1`, [a.user.id])).rows[0].n, 2);
  // Delivered in a later export: the line and its order close.
  const done = `Order No,Customer,SKU,Qty,Pending Qty,Price,Currency,Promised Date,Status\nSO-15,Arora Agro,VLV-25,5,0,400,INR,${d(5)},Delivered\n`;
  const opts2 = { ...options, mapping: { ...options.mapping, status: 'Status' } };
  const cl = await a.api.upload('/operations/import/commit', Buffer.from(done), 'orders-3.csv', { kind: 'orders', options: opts2 });
  assert.equal(cl.status, 200, JSON.stringify(cl.body));
  const o = (await env.pool.query(`SELECT o.status, oli.line_status FROM order_line_items oli JOIN orders o ON o.id = oli.order_id WHERE oli.user_id = $1 AND oli.external_ref = 'SO-15'`, [a.user.id])).rows[0];
  assert.deepEqual(o, { status: 'delivered', line_status: 'delivered' });
});

test('from an empty account: products, stock and components come only from files; stock is physical; the delay result is the same as hand-worked', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const user = await createTenant(env.pool, 'ops-empty');
  tenants.push(user);
  const a = { user, api: withUpload(client(server.base, user), user) };
  const count = async (tbl) => (await env.pool.query(`SELECT COUNT(*)::int AS n FROM ${tbl} WHERE user_id = $1`, [user.id])).rows[0].n;
  assert.equal(await count('products'), 0);

  // Products: preview proposes the mapping, writes nothing, shows the three bad rows.
  const pbuf = productsCsv();
  const pv = await a.api.upload('/operations/import/preview', pbuf, 'item-master.csv', { kind: 'products' });
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(pv.body.proposal.fields.on_hand.header, 'Stock On Hand');
  assert.equal(pv.body.proposal.fields.sku.header, 'SKU');
  assert.ok(pv.body.mappingErrors.some((e) => /system this file came from/.test(e)));
  const popts = { mapping: PRODUCT_MAPPING, dateOrders: {}, sourceSystem: 'Tally item master', reviewChoices: {} };
  const pv2 = await a.api.upload('/operations/import/preview', pbuf, 'item-master.csv', { kind: 'products', options: popts });
  const ps = pv2.body.summary;
  assert.equal(ps.counts.new, 6, JSON.stringify(ps.counts));
  assert.equal(ps.counts.rejected, 3);
  const reasons = ps.rejectedByReason.map((r) => r.example).join(' | ');
  assert.match(reasons, /SKU GSK-1 appears again with different values/);
  assert.match(reasons, /"Coupling 2in" is a new product with no stock on hand stated/);
  assert.match(reasons, /stock on hand "-5" is negative/);
  assert.equal(await count('products'), 0, 'preview writes nothing');

  const pc = await a.api.upload('/operations/import/commit', pbuf, 'item-master.csv', { kind: 'products', options: popts });
  assert.equal(pc.status, 200, JSON.stringify(pc.body));
  assert.equal(pc.body.summary.entities.productsCreated, 6);
  assert.equal(pc.body.summary.entities.openingStockRecorded, 3, 'motor 4, impeller 30, valve 40');
  const prods = Object.fromEntries((await env.pool.query(`SELECT sku, id, current_stock::text AS s, unit_price::text AS price FROM products WHERE user_id = $1`, [user.id])).rows.map((r) => [r.sku, r]));
  assert.deepEqual(Object.keys(prods).sort(), ['GSK-1', 'IMP-SS', 'MTR-1HP', 'PMP-A1', 'SEAL-K', 'VLV-25']);
  assert.equal(Number(prods['MTR-1HP'].s), 4);
  assert.equal(prods['MTR-1HP'].price, null, 'no selling price stays unknown, not 0');
  assert.equal(Number(prods['PMP-A1'].price), 9000);
  const ledger = (await env.pool.query(`SELECT reference, quantity::float AS q FROM stock_movements WHERE user_id = $1 ORDER BY quantity`, [user.id])).rows;
  assert.deepEqual(ledger.map((m) => [m.reference.split('-')[0], m.q]), [['OPENING', 4], ['OPENING', 30], ['OPENING', 40]]);

  // Same file again: one import. Changed choices: a new batch, nothing duplicated.
  const again = await a.api.upload('/operations/import/commit', pbuf, 'item-master.csv', { kind: 'products', options: popts });
  assert.equal(again.body.import.alreadyImported, true);
  const renamed = await a.api.upload('/operations/import/commit', pbuf, 'item-master.csv', { kind: 'products', options: { ...popts, sourceSystem: 'Tally items' } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.summary.counts.unchanged, 6);
  assert.equal(await count('products'), 6);

  // Components.
  const cbuf = componentsCsv();
  const copts = { mapping: COMPONENT_MAPPING, dateOrders: {}, sourceSystem: 'Tally BOM', reviewChoices: {} };
  const cc = await a.api.upload('/operations/import/commit', cbuf, 'bom.csv', { kind: 'components', options: copts });
  assert.equal(cc.status, 200, JSON.stringify(cc.body));
  assert.equal(cc.body.summary.counts.new, 2);
  assert.match(cc.body.summary.rejectedByReason[0].example, /component: no product with SKU NUT-8 or named "Nut M8"; import products first/);
  assert.equal(await count('product_components'), 2);

  // Then the purchase and order exports; the rest of the loop must match the hand-worked plan.
  const pbuf2 = purchaseCsv(today);
  const prev = await a.api.upload('/operations/import/preview', pbuf2, 'zoho-open-pos.csv', { kind: 'purchase_lines', options: { mapping: PURCHASE_MAPPING, dateOrders: {}, sourceSystem: 'Zoho Inventory', stockFollows: 'STARLANE', reviewChoices: {} } });
  const review = prev.body.summary.review;
  assert.deepEqual(review.map((r) => r.label), ['UNK-9 · Unknown part'], 'GSK-1 now names exactly one product, so only the unknown part is asked');
  await importPurchases(a, { reviewChoices: { [review[0].key]: 'SKIP' } });
  await importOrders(a);
  const pli = (await env.pool.query(`SELECT external_ref, received_quantity::text AS r FROM purchase_line_items WHERE user_id = $1 ORDER BY external_ref`, [user.id])).rows;
  assert.deepEqual(pli.map((x) => x.external_ref), ['PO-777/1', 'PO-901/1', 'PO-901/2', 'PO-905/1', 'PO-906/1']);
  assert.equal(Number(prods['MTR-1HP'] && (await env.pool.query('SELECT current_stock FROM products WHERE id = $1', [prods['MTR-1HP'].id])).rows[0].current_stock), 4, 'open purchase quantities never become stock');

  const motor = await motorLine(user.id);
  const rep = await a.api.post('/api/decisions/report-supplier-delay', { purchaseLineItemId: motor.id, newExpectedAt: plus(today, 12), reason: 'Copper shortage' });
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  const d = (await a.api.get(`/api/decisions/${rep.body.decision.id}`)).body.decision;
  assert.deepEqual(d.analysis.supplierDelay.atRisk.map((l) => l.customerName).sort(), EXPECTED.afterDelay.atRisk);
  // PO-777 (5 motors at +9) is also imported on this account, since no typed-in
  // bill conflicts with it; the at-risk orders and value are unchanged by it.
  assert.equal(d.materiality.revenueExposure, EXPECTED.afterDelay.valueAtRisk);

  // A later product file never overwrites stock Starlane now tracks through movements.
  const r1 = await a.api.post(`/api/decisions/purchase-lines/${motor.id}/receipts`, { quantity: '20', receivedOn: today, idempotencyKey: key() });
  assert.equal(r1.status, 201);
  const recount = Buffer.from('SKU,Item Name,Stock On Hand\r\nMTR-1HP,Motor 1HP,50\r\nVLV-25,Valve 25mm,35\r\n');
  const rc = await a.api.upload('/operations/import/commit', recount, 'recount.csv', { kind: 'products', options: { mapping: { sku: 'SKU', product_name: 'Item Name', on_hand: 'Stock On Hand' }, dateOrders: {}, sourceSystem: 'Tally item master', reviewChoices: {} } });
  assert.equal(rc.status, 200, JSON.stringify(rc.body));
  assert.equal(rc.body.summary.counts.conflicts, 2);
  assert.match(rc.body.summary.conflicts[0].details[0], /already tracks stock of Motor 1HP .*24 now.*was not applied/);
  assert.equal(Number((await env.pool.query('SELECT current_stock FROM products WHERE id = $1', [prods['MTR-1HP'].id])).rows[0].current_stock), 24);
  const audit = (await env.pool.query(`SELECT payload->>'kind' AS kind FROM decision_events WHERE user_id = $1 AND event_type = 'OPERATIONS_IMPORTED' ORDER BY created_at`, [user.id])).rows.map((r) => r.kind);
  assert.deepEqual(audit, ['products', 'products', 'components', 'purchase_lines', 'orders', 'products']);
});

test('import limits: oversize and malformed files are refused before anything is read into the database', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const a = await tenant('limits');
  const big = Buffer.alloc(16 * 1024 * 1024, 'a');
  const r = await a.api.upload('/operations/import/preview', big, 'huge.csv', { kind: 'products' });
  assert.equal(r.status, 413, JSON.stringify(r.body).slice(0, 200));
  const wrong = await a.api.upload('/operations/import/preview', Buffer.from('%PDF-1.4'), 'scan.pdf', { kind: 'products' });
  assert.equal(wrong.status, 400);
  const badKind = await a.api.upload('/operations/import/preview', productsCsv(), 'x.csv', { kind: 'invoices' });
  assert.equal(badKind.status, 400);
  assert.match(badKind.body.error, /kind must be/);
});

test('a failed import rolls back every row of the file', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const a = await tenant('rollback');
  // A pool whose connection fails on the third purchase-line insert.
  let n = 0;
  const failing = {
    query: (...args) => env.pool.query(...args),
    connect: async () => {
      const c = await env.pool.connect();
      return {
        query: (sql, params) => {
          if (/INSERT INTO purchase_line_items/.test(String(sql)) && ++n === 3) return Promise.reject(new Error('simulated failure mid-import'));
          return c.query(sql, params);
        },
        release: () => c.release(),
      };
    },
  };
  const options = { mapping: PURCHASE_MAPPING, dateOrders: {}, sourceSystem: 'Zoho Inventory', stockFollows: 'STARLANE', reviewChoices: {} };
  await assert.rejects(() => commitOperationalImport(failing, a.user.id, 'purchase_lines', purchaseCsv(today), 'pos.csv', options), /simulated failure/);
  for (const tbl of ['purchase_line_items', 'purchases', 'suppliers', 'product_suppliers', 'raw_observations']) {
    const r = await env.pool.query(`SELECT COUNT(*)::int AS n FROM ${tbl} WHERE user_id = $1`, [a.user.id]);
    assert.equal(r.rows[0].n, 0, `${tbl} rolled back`);
  }
  const b = await env.pool.query(`SELECT status, error_message FROM file_import_batches WHERE user_id = $1`, [a.user.id]);
  assert.equal(b.rows[0].status, 'FAILED');
  assert.match(b.rows[0].error_message, /simulated failure/);
  // The same file then imports cleanly.
  const ok = await commitOperationalImport(env.pool, a.user.id, 'purchase_lines', purchaseCsv(today), 'pos.csv', options);
  assert.equal(ok.summary.counts.new, 4, 'PO-901 x2, PO-905 and PO-777 (no conflicting bill on this tenant); 2 held for review');
});
