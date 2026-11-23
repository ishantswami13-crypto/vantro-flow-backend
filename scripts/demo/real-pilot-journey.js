#!/usr/bin/env node
/* global document, localStorage */ // used inside page.evaluate (browser context)
// FILE: scripts/demo/real-pilot-journey.js
// `npm run demo:real-pilot:journey`: the real-customer pilot flow, driven
// through the real frontend and backend in a headless browser, with the
// database checked after every step against values worked out by hand
// (tests/fixtures/realPilot.js, EXPECTED).
//
// Needs, all local:
//   1. a migrated local Postgres (DATABASE_URL, refused unless it is a test
//      database by testDatabaseGuard)
//   2. this backend running on API_URL (default http://localhost:3001) with
//      the same DATABASE_URL and JWT_SECRET
//   3. the frontend running on APP_URL (default http://localhost:3000) with
//      NEXT_PUBLIC_API_URL pointing at the backend
//
// Journey (a fresh synthetic tenant, Nirmal Pumps):
//   Decisions -> Import orders & POs -> upload the Zoho PO export (CSV) ->
//   confirm columns, name the source, choose who records stock -> answer the
//   two product questions -> import -> upload the open sales orders (XLSX)
//   -> import -> Open orders shows what is missing -> Inbound shipments ->
//   report the motor delay -> decision names exactly the two late orders ->
//   record a partial receipt (the first response is dropped on the way back;
//   pressing again records nothing twice) -> decision recalculated -> choose
//   + approve + shadow run -> record the rest -> line closed, stock exact,
//   the finished decision left as decided. Nothing is sent to anyone.
// Exits non-zero on the first failed check count. Screenshots: JOURNEY_OUT.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { assertTestDatabase } = require('../../lib/db/testDatabaseGuard');
const { plus, seedProductMaster, purchaseCsv, ordersXlsx, PURCHASE_MAPPING, ORDER_MAPPING, EXPECTED } = require('../../tests/fixtures/realPilot');

const EMAIL = 'owner@real-pilot-journey.invalid';
const APP = process.env.APP_URL || 'http://localhost:3000';
const OUT = process.env.JOURNEY_OUT || path.join(process.cwd(), 'real-pilot-journey');

// The labels the import page shows for each field (app/decisions/operations-import).
const UI_LABEL = {
  customer_name: 'Customer name', order_ref: 'Order number', line_ref: 'Line number', product_name: 'Product name', sku: 'SKU / item code',
  quantity: 'Ordered quantity', outstanding_quantity: 'Quantity still to deliver', unit_price: 'Unit price', currency: 'Currency',
  order_date: 'Order date', promised_date: 'Promised delivery date', status: 'Status', supplier_name: 'Supplier name',
  supplier_tax_id: 'Supplier GSTIN', po_ref: 'Purchase order number', received_quantity: 'Quantity already received',
  expected_date: 'Expected delivery date', purchase_date: 'PO date', unit_cost: 'Unit cost',
};

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required (a local database).');
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required (the one the local backend uses).');
  assertTestDatabase(process.env.DATABASE_URL);
  const { chromium } = require('playwright');
  const { getPool } = require('../../lib/db/pg');
  const pool = getPool();
  fs.mkdirSync(OUT, { recursive: true });

  // Fresh tenant, every run.
  const old = (await pool.query('SELECT id FROM users WHERE email = $1', [EMAIL])).rows[0];
  if (old) {
    for (const t of ['promises', 'tasks', 'ai_actions', 'followups', 'business_memory', 'predictions', 'agent_runs']) await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [old.id]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = $1', [old.id]);
  }
  const userId = (await pool.query(`INSERT INTO users (email, business_name, owner_name) VALUES ($1, 'Nirmal Pumps (synthetic)', 'Pilot Owner') RETURNING id`, [EMAIL])).rows[0].id;
  const P = await seedProductMaster(pool, userId);
  // A bill typed in by hand earlier with the same number as an open PO: the import must not attach to it.
  await pool.query(`INSERT INTO purchases (user_id, supplier_name, amount, status, bill_number) VALUES ($1,'Volt Motors Pvt Ltd',21000,'unpaid','PO-777')`, [userId]);
  const token = jwt.sign({ userId, email: EMAIL }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

  const today = new Date().toISOString().slice(0, 10);
  const poFile = path.join(OUT, 'zoho-open-pos.csv');
  const soFile = path.join(OUT, 'open-sales-orders.xlsx');
  fs.writeFileSync(poFile, purchaseCsv(today));
  fs.writeFileSync(soFile, ordersXlsx(today));

  const q1 = async (sql, params = [userId]) => (await pool.query(sql, params)).rows[0];
  const sent = async () => q1(`SELECT (SELECT COUNT(*) FROM execution_records WHERE user_id = $1)::int AS sends,
                                      (SELECT COUNT(*) FROM outbound_send_jobs WHERE user_id = $1)::int AS jobs,
                                      (SELECT COUNT(*) FROM ai_actions WHERE user_id = $1)::int AS drafts`);
  const nothingSent = (s) => s.sends === 0 && s.jobs === 0 && s.drafts === 0;
  const stock = async (pid) => Number((await q1('SELECT current_stock FROM products WHERE id = $1 AND user_id = $2', [pid, userId])).current_stock);
  const delayDecision = async () => (await pool.query(`SELECT id, status, materiality, analysis FROM decisions WHERE user_id = $1 AND kind = 'SUPPLIER_DELAY' ORDER BY created_at DESC LIMIT 1`, [userId])).rows[0] || null;

  const browser = await chromium.launch();
  const host = new URL(APP).hostname;
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([{ name: 'vantro_token', value: token, domain: host, path: '/' }]);
  await ctx.addInitScript((v) => { try { localStorage.setItem('vantro_token', v); } catch { /* ignore */ } }, token);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  const body = () => page.evaluate(() => document.body.innerText);

  async function mapColumns(mapping) {
    for (const [field, header] of Object.entries(mapping)) {
      await page.getByLabel(UI_LABEL[field], { exact: true }).selectOption(header);
    }
  }
  async function waitForCounts() {
    await page.waitForTimeout(700);
    await page.getByText('Checking your changes…').waitFor({ state: 'detached', timeout: 60000 }).catch(() => {});
    await page.waitForLoadState('networkidle');
  }

  try {
    // ── 1. Purchase orders ──
    await page.goto(`${APP}/decisions`, { waitUntil: 'load', timeout: 240000 });
    await page.getByRole('link', { name: 'Import orders & POs' }).click();
    await page.getByRole('radio', { name: /Open purchase orders/ }).click();
    await page.getByLabel('File to import').setInputFiles(poFile);
    await page.getByText('What each column means').waitFor({ timeout: 120000 });
    await page.getByText('Before this can be imported').waitFor({ timeout: 60000 });
    let t = await body();
    check(/Suggested: please check/i.test(t), 'a column with an unreadable value is only suggested, not confirmed', /Suggested/i.test(t) ? '' : t.slice(0, 1500));
    check(/system this file came from/i.test(t), 'the source system must be named before anything can be imported');
    check((await q1('SELECT COUNT(*)::int AS n FROM purchase_line_items WHERE user_id = $1')).n === 0, 'preview writes nothing');
    await mapColumns(PURCHASE_MAPPING);
    await page.getByPlaceholder(/Tally Prime, Zoho Inventory/).fill('Zoho Inventory');
    await page.locator('input[name=stockFollows]').first().check();
    await waitForCounts();
    await page.getByText('Products Starlane could not match with certainty').waitFor({ timeout: 60000 });
    await shot('1-po-mapping-and-review');
    t = await body();
    check(/received quantity 12 is more than the ordered 10/.test(t) && /"abc" is not a quantity/.test(t) && /2026-02-31/.test(t), 'the three bad rows are shown as rejected, with reasons');
    check(/PO-777 .*already exists/.test(t), 'the PO number that already exists as a typed-in bill is a conflict');
    check(/2 rows need a product answer/.test(t) && await page.getByRole('button', { name: /^Import \d+ line/ }).count() === 0, 'import is not offered while products are unanswered');
    await page.getByLabel('Product for GSK-1 · Gasket').selectOption({ label: 'Link to Gasket Red (GSK-1)' });
    await page.getByLabel('Product for UNK-9 · Unknown part').selectOption('SKIP');
    await waitForCounts();
    await page.getByRole('checkbox').check();
    await shot('2-po-confirm');
    await page.getByRole('button', { name: 'Import 4 lines' }).click();
    await page.getByText(/new and 0 updated purchase lines saved/).waitFor({ timeout: 120000 });
    await shot('3-po-imported');
    const pos = (await pool.query(`SELECT external_ref, product_id, received_quantity::text AS rec, received_before_tracking::text AS rbt, stock_follows FROM purchase_line_items WHERE user_id = $1 ORDER BY external_ref`, [userId])).rows;
    check(JSON.stringify(pos.map((l) => l.external_ref)) === JSON.stringify(['PO-901/1', 'PO-901/2', 'PO-905/1', 'PO-906/1']), 'exactly the four confirmed purchase lines are saved', pos.map((l) => l.external_ref).join(','));
    check(pos.find((l) => l.external_ref === 'PO-906/1')?.product_id === P.gasketRed, 'the gasket line is linked to the product the owner chose');
    check(pos[0].rec === '10' && pos[0].rbt === '10' && pos.every((l) => l.stock_follows === 'STARLANE'), '10 motors already received in Zoho are recorded as received before tracking');

    // ── 2. Customer orders ──
    await page.getByRole('button', { name: 'Import another file' }).click();
    await page.getByRole('radio', { name: /Open customer orders/ }).click();
    await page.getByLabel('File to import').setInputFiles(soFile);
    await page.getByText('What each column means').waitFor({ timeout: 120000 });
    await mapColumns(ORDER_MAPPING);
    await page.getByPlaceholder(/Tally Prime, Zoho Inventory/).fill('Tally sales orders');
    await waitForCounts();
    t = await body();
    check(/no outstanding quantity/.test(t) && /no promised date/.test(t), 'missing outstanding quantity and promised date are stated as limitations');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Import 7 lines' }).click();
    await page.getByText(/7 new and 0 updated order lines saved/).waitFor({ timeout: 120000 });
    await shot('4-orders-imported');
    check(/No supplier delay is putting an order at risk/.test(await body()), 'before any delay, no order is at risk');
    check((await q1(`SELECT COUNT(*)::int AS n FROM order_line_items WHERE user_id = $1`)).n === 7, 'seven open order lines saved; the delivered one is skipped');

    await page.getByRole('link', { name: /Review open orders/ }).click();
    await page.getByText('Ganga Traders').waitFor({ timeout: 60000 });
    await shot('5-open-orders');
    const gangaRow = page.locator('tr', { hasText: 'Ganga Traders' });
    const coastalRow = page.locator('tr', { hasText: 'Coastal Farms' });
    check(/No promised date/.test(await gangaRow.innerText()), 'the order with no promised date says so');
    check(/Assumed: full quantity/.test(await coastalRow.innerText()), 'the order with no pending quantity is marked as an assumption');

    // ── 3. Report the delay ──
    await page.goto(`${APP}/decisions/shipments`, { waitUntil: 'load', timeout: 240000 });
    const motorRow = page.locator('li', { hasText: 'PO-901' }).filter({ hasText: 'Motor 1HP' });
    await motorRow.waitFor({ timeout: 120000 });
    check(/10 of 50 received/.test(await motorRow.innerText()) && /^40 ×/.test((await motorRow.innerText()).trim()), 'the motor line shows 40 still due, 10 of 50 received');
    await motorRow.getByRole('button', { name: 'Report a delay' }).click();
    await motorRow.locator('input[type=date]').fill(plus(today, 12));
    await motorRow.getByPlaceholder('e.g. Factory power cuts').fill('Copper shortage');
    await motorRow.getByRole('button', { name: 'Check affected orders' }).click();
    await page.getByText('Some customer orders are now at risk').waitFor({ timeout: 120000 });
    let d = await delayDecision();
    const sd = d.analysis.supplierDelay;
    check(JSON.stringify(sd.atRisk.map((l) => l.customerName).sort()) === JSON.stringify(EXPECTED.afterDelay.atRisk), 'exactly Arora Agro and Bharat Irrigation are put at risk', sd.atRisk.map((l) => l.customerName).join(','));
    check(Number(d.materiality.revenueExposure) === EXPECTED.afterDelay.valueAtRisk, 'value at risk is 2,25,000 (pending, not ordered, quantity)', String(d.materiality.revenueExposure));
    check(sd.atRisk.every((l) => l.slipDays === EXPECTED.afterDelay.slip[l.customerName]), 'slips are 6 and 4 days');
    await page.getByRole('link', { name: /See which orders/ }).click();
    await page.getByRole('button', { name: 'Choose' }).first().waitFor({ timeout: 120000 });
    await shot('6-decision-after-delay');
    t = await body();
    check(/Arora Agro by 6 days/.test(t) && /Bharat Irrigation by 4 days/.test(t), 'the decision names both late orders and by how much');
    check(!/Evergreen Estates by|Coastal Farms by|Delta Nurseries by/.test(t), 'does not blame the delay for other orders');
    check(/Assumption/.test(t), 'the assumed outstanding quantity is labelled as an assumption');
    check(nothingSent(await sent()), 'nothing drafted or sent');

    // ── 4. Partial receipt, with the first response lost on the way back ──
    await page.goto(`${APP}/decisions/shipments`, { waitUntil: 'load', timeout: 240000 });
    await motorRow.waitFor({ timeout: 120000 });
    await motorRow.getByRole('button', { name: 'Record receipt' }).click();
    const qty = motorRow.getByPlaceholder(/up to 40/);
    await qty.fill('41');
    check(/Only 40 are still due/.test(await motorRow.innerText()) && await motorRow.getByRole('button', { name: 'Record receipt', exact: true }).last().isDisabled(), 'an over-receipt is refused before it is sent');
    await qty.fill('20');
    await motorRow.getByPlaceholder('e.g. GRN-2231').fill('GRN-55');
    let dropped = 0;
    await page.route('**/purchase-lines/*/receipts', async (route) => {
      if (route.request().method() === 'POST' && dropped === 0) { dropped += 1; await route.fetch(); return route.abort('connectionreset'); }
      return route.continue();
    });
    const submit = motorRow.locator('form[aria-label="Record goods received"]').getByRole('button', { name: 'Record receipt' });
    await submit.click();
    await page.getByText('The receipt was not recorded').waitFor({ timeout: 60000 });
    await shot('7-receipt-response-lost');
    check(/Pressing the button again is safe/.test(await body()), 'a lost response says retrying is safe');
    check((await q1(`SELECT COUNT(*)::int AS n FROM purchase_line_receipts WHERE user_id = $1`)).n === 1, 'the first attempt did reach the server');
    await submit.click();
    await page.getByText('Already recorded').waitFor({ timeout: 120000 });
    await shot('8-receipt-retry-deduplicated');
    check((await q1(`SELECT COUNT(*)::int AS n FROM purchase_line_receipts WHERE user_id = $1`)).n === 1 && await stock(P.motor) === 24, 'pressing again records nothing twice: one receipt, motors 4 + 20 = 24');
    await page.unroute('**/purchase-lines/*/receipts');
    d = await delayDecision();
    check(JSON.stringify(d.analysis.supplierDelay.atRisk.map((l) => l.customerName)) === JSON.stringify(EXPECTED.afterPartialReceipt.atRisk) && Number(d.materiality.revenueExposure) === EXPECTED.afterPartialReceipt.valueAtRisk,
      'after the receipt only Bharat Irrigation is at risk, 1,35,000', `${d.analysis.supplierDelay.atRisk.map((l) => l.customerName)} ${d.materiality.revenueExposure}`);
    await page.reload({ waitUntil: 'load' });
    await motorRow.waitFor({ timeout: 120000 });
    await motorRow.getByRole('button', { name: /Receipt history \(1\)/ }).click();
    await motorRow.getByText('Receipt history', { exact: true }).waitFor({ timeout: 60000 });
    t = await motorRow.innerText();
    check(/\+20/.test(t) && /GRN-55/.test(t) && /Stock updated/.test(t) && /10 were already received in your own system/.test(t), 'receipt history shows the receipt, its stock effect and the pre-tracking units');
    await shot('9-receipt-history');

    // ── 5. Recommendation: choose, approve, shadow run ──
    await page.goto(`${APP}/decisions/${d.id}`, { waitUntil: 'load', timeout: 240000 });
    await page.getByRole('button', { name: 'Choose' }).first().waitFor({ timeout: 120000 });
    t = await body();
    check(/Bharat Irrigation by 4 days/.test(t) && !/Arora Agro by/.test(t), 'the decision page shows the recalculated assessment');
    // The recommended option: prepare customer updates (drafts only, each needing its own approval).
    await page.getByRole('button', { name: 'Choose' }).nth(1).click();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Run in shadow mode' }).waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: 'Run in shadow mode' }).click();
    await page.waitForTimeout(4000);
    await shot('10-approved-shadow-run');
    check(nothingSent(await sent()), 'approve + shadow run sends nothing and drafts nothing');

    // ── 6. The rest arrives ──
    await page.goto(`${APP}/decisions/shipments`, { waitUntil: 'load', timeout: 240000 });
    await motorRow.waitFor({ timeout: 120000 });
    await motorRow.getByRole('button', { name: 'Record receipt' }).click();
    await motorRow.getByPlaceholder(/up to 20/).fill('20');
    await motorRow.locator('form[aria-label="Record goods received"]').getByRole('button', { name: 'Record receipt' }).click();
    await page.getByText(/Received in full/).waitFor({ timeout: 120000 });
    await shot('11-received-in-full');
    check(await page.locator('li', { hasText: 'PO-901' }).filter({ hasText: 'Motor 1HP' }).count() === 0, 'the fully received line leaves Inbound shipments');
    check(await stock(P.motor) === 44, 'motors: 4 typed in + 40 received; the 10 received before tracking are not counted twice', String(await stock(P.motor)));
    const ev = (await pool.query(`SELECT event_type, payload, created_at FROM decision_events WHERE user_id = $1 AND decision_id = $2 ORDER BY created_at`, [userId, d.id])).rows;
    // A shadow-run decision is finished: what was decided is never rewritten
    // by later data, and the closed line opens no new decision.
    const after = await q1(`SELECT (SELECT status FROM decisions WHERE id = $2) AS status,
                                   (SELECT COUNT(*) FROM decisions WHERE user_id = $1 AND kind = 'SUPPLIER_DELAY')::int AS n`, [userId, d.id]);
    check(after.status === 'SHADOWED' && after.n === 1 && !ev.some((e) => e.event_type === 'REVISED' && e.created_at > ev.find((x) => x.event_type === 'APPROVED').created_at),
      'the shadow-run decision is left as decided, and the closed line opens no new decision', JSON.stringify(after));
    const bad = (await pool.query(
      `SELECT p.name, p.current_stock::float AS stock, COALESCE(SUM(CASE WHEN m.movement_type='in' THEN m.quantity ELSE -m.quantity END),0)::float AS ledger
         FROM products p LEFT JOIN stock_movements m ON m.product_id = p.id AND m.user_id = p.user_id
        WHERE p.user_id = $1 GROUP BY p.id HAVING COUNT(m.id) > 0 AND p.current_stock::float <> COALESCE(SUM(CASE WHEN m.movement_type='in' THEN m.quantity ELSE -m.quantity END),0)::float`, [userId])).rows;
    check(bad.length === 0, 'stock equals the movement ledger for every product with movements', JSON.stringify(bad));
    const types = ev.map((e) => e.event_type);
    for (const ty of ['DISCOVERED', 'REVISED', 'OPTION_SELECTED', 'APPROVED']) check(types.includes(ty), `decision audit trail has ${ty}`);
    const ops = (await pool.query(`SELECT event_type FROM decision_events WHERE user_id = $1 AND event_type IN ('OPERATIONS_IMPORTED','GOODS_RECEIPT_RECORDED','SUPPLIER_DELAY_REPORTED')`, [userId])).rows.map((e) => e.event_type);
    check(ops.filter((x) => x === 'OPERATIONS_IMPORTED').length === 2 && ops.filter((x) => x === 'GOODS_RECEIPT_RECORDED').length === 2 && ops.includes('SUPPLIER_DELAY_REPORTED'), 'imports, the delay and both receipts are in the audit trail', ops.join(','));
    check(nothingSent(await sent()), 'at the end: nothing drafted, nothing sent');
    check(errors.length === 0, 'no page errors', errors.join(' | '));
  } catch (err) {
    await shot('FAILED').catch(() => {});
    throw err;
  } finally {
    await browser.close();
    await pool.end();
  }
  console.log(`\n${failures ? `${failures} check(s) FAILED` : 'All checks passed'}. Screenshots: ${OUT}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error('JOURNEY FAILED:', err.message); process.exit(1); });
