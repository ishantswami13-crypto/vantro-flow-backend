#!/usr/bin/env node
/* global document, localStorage */ // used inside page.evaluate / addInitScript (browser context)
// FILE: scripts/demo/real-pilot-journey.js
// `npm run demo:real-pilot:journey`: the customer pilot flow, driven through
// the real frontend and backend in a headless browser, starting from an
// EMPTY account. Every product, stock level, component, purchase line and
// order comes from a file uploaded through the import page; nothing is
// inserted into the database by hand. The database is checked after every
// step against values worked out by hand (tests/fixtures/realPilot.js).
//
// Needs, all local (see docs/pilot/README.md):
//   1. a migrated local Postgres (DATABASE_URL; refused unless it is a test
//      database, by testDatabaseGuard)
//   2. this backend on API_URL (default http://localhost:3001), same
//      DATABASE_URL and JWT_SECRET, FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED=false
//   3. the frontend on APP_URL (default http://localhost:3000) built with
//      NEXT_PUBLIC_API_URL pointing at the backend
//
// Journey (synthetic Nirmal Pumps):
//   import products + stock -> components -> open POs -> open sales orders ->
//   Open orders shows what is missing -> Inbound shipments -> report the motor
//   delay -> decision names exactly the two late orders, with evidence ->
//   record a partial receipt (first response lost; pressing again records
//   nothing twice) -> decision recalculated -> owner switches the account to
//   live -> choose "prepare customer updates" -> approve -> run -> one draft
//   waits in Approvals, nothing sent -> decision history -> the rest arrives.
// Exits non-zero if any check fails. Screenshots and the uploaded files are
// written to JOURNEY_OUT (default ./real-pilot-journey).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { assertTestDatabase } = require('../../lib/db/testDatabaseGuard');
const { plus, productsCsv, componentsCsv, purchaseCsv, ordersXlsx, PRODUCT_MAPPING, COMPONENT_MAPPING, PURCHASE_MAPPING, ORDER_MAPPING, EXPECTED } = require('../../tests/fixtures/realPilot');

const EMAIL = 'owner@real-pilot-journey.invalid';
const APP = process.env.APP_URL || 'http://localhost:3000';
const OUT = process.env.JOURNEY_OUT || path.join(process.cwd(), 'real-pilot-journey');

// The labels the import page shows (app/decisions/operations-import), per kind.
const UI_LABEL = {
  customer_name: 'Customer name', order_ref: 'Order number', line_ref: 'Line number', product_name: 'Product name', sku: 'SKU / item code',
  quantity: 'Ordered quantity', outstanding_quantity: 'Quantity still to deliver', unit_price: 'Unit price', currency: 'Currency',
  order_date: 'Order date', promised_date: 'Promised delivery date', status: 'Status', supplier_name: 'Supplier name',
  supplier_tax_id: 'Supplier GSTIN', po_ref: 'Purchase order number', received_quantity: 'Quantity already received',
  expected_date: 'Expected delivery date', purchase_date: 'PO date', unit_cost: 'Unit cost',
  on_hand: 'Stock on hand', unit: 'Unit', category: 'Category', finished_sku: 'Finished product SKU', finished_name: 'Finished product name',
  component_sku: 'Component SKU', component_name: 'Component name', quantity_per_unit: 'Quantity per finished unit',
};
const uiLabel = (kind, field) => (kind === 'products' && field === 'unit_price' ? 'Selling price' : UI_LABEL[field]);

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

  // A fresh, empty account every run (the equivalent of signing up).
  const old = (await pool.query('SELECT id FROM users WHERE email = $1', [EMAIL])).rows[0];
  if (old) {
    for (const t of ['promises', 'tasks', 'ai_actions', 'followups', 'business_memory', 'predictions', 'agent_runs']) await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [old.id]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = $1', [old.id]);
  }
  const userId = (await pool.query(`INSERT INTO users (email, business_name, owner_name) VALUES ($1, 'Nirmal Pumps (synthetic)', 'Pilot Owner') RETURNING id`, [EMAIL])).rows[0].id;
  const token = jwt.sign({ userId, email: EMAIL }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
  const q1 = async (sql, params = [userId]) => (await pool.query(sql, params)).rows[0];
  const n = async (table) => (await q1(`SELECT COUNT(*)::int AS n FROM ${table} WHERE user_id = $1`)).n;
  for (const t of ['products', 'product_components', 'purchase_line_items', 'order_line_items', 'stock_movements', 'decisions']) {
    if (await n(t) !== 0) throw new Error(`the new account is not empty (${t})`);
  }
  check(true, 'starts from an empty account: no products, stock, orders, purchases or decisions');

  // The four files, dated relative to today, exactly as a customer would upload them.
  const today = new Date().toISOString().slice(0, 10);
  const files = {
    products: path.join(OUT, 'nirmal-item-master.csv'),
    components: path.join(OUT, 'nirmal-bill-of-materials.csv'),
    purchase_lines: path.join(OUT, 'nirmal-open-purchase-orders.csv'),
    orders: path.join(OUT, 'nirmal-open-sales-orders.xlsx'),
  };
  fs.writeFileSync(files.products, productsCsv());
  fs.writeFileSync(files.components, componentsCsv());
  fs.writeFileSync(files.purchase_lines, purchaseCsv(today));
  fs.writeFileSync(files.orders, ordersXlsx(today));

  const sent = async () => q1(`SELECT (SELECT COUNT(*) FROM execution_records WHERE user_id = $1)::int AS sends,
                                      (SELECT COUNT(*) FROM outbound_send_jobs WHERE user_id = $1)::int AS jobs,
                                      (SELECT COUNT(*) FROM ai_actions WHERE user_id = $1)::int AS drafts,
                                      (SELECT COUNT(*) FROM ai_actions WHERE user_id = $1 AND status NOT IN ('pending','pending_approval','draft'))::int AS drafts_moved`);
  const stock = async (sku) => Number((await q1('SELECT current_stock FROM products WHERE user_id = $1 AND sku = $2', [userId, sku])).current_stock);
  const delayDecision = async () => (await pool.query(`SELECT id, status, materiality, analysis FROM decisions WHERE user_id = $1 AND kind = 'SUPPLIER_DELAY' ORDER BY created_at DESC LIMIT 1`, [userId])).rows[0] || null;

  const browser = await chromium.launch();
  const host = new URL(APP).hostname;
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await ctx.addCookies([{ name: 'vantro_token', value: token, domain: host, path: '/' }]);
  await ctx.addInitScript((v) => { try { localStorage.setItem('vantro_token', v); } catch { /* ignore */ } }, token);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  let shotNo = 0;
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${String(++shotNo).padStart(2, '0')}-${name}.png`), fullPage: true });
  const body = () => page.evaluate(() => document.body.innerText);

  async function settle() {
    await page.waitForTimeout(700);
    await page.getByText('Checking your changes…').waitFor({ state: 'detached', timeout: 60000 }).catch(() => {});
    await page.waitForLoadState('networkidle');
  }
  // Upload one file of one kind and confirm the columns; returns the page text.
  async function uploadAndMap(kind, mapping, sourceSystem) {
    await page.getByLabel('File to import').setInputFiles(files[kind]);
    await page.getByText('What each column means').waitFor({ timeout: 120000 });
    for (const [field, header] of Object.entries(mapping)) await page.getByLabel(uiLabel(kind, field), { exact: true }).selectOption(header);
    await page.getByPlaceholder(/Tally Prime, Zoho Inventory/).fill(sourceSystem);
    await settle();
    return body();
  }
  async function confirmImport(lines, savedText) {
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: `Import ${lines} line${lines === 1 ? '' : 's'}` }).click();
    await page.getByText(savedText).waitFor({ timeout: 120000 });
  }

  try {
    // ── 1. Products and stock on hand ──
    await page.goto(`${APP}/decisions`, { waitUntil: 'load', timeout: 240000 });
    await page.getByRole('link', { name: 'Import orders & POs' }).click();
    await page.getByRole('radio', { name: /Products and stock on hand/ }).click();
    const tpl = await page.getByRole('link', { name: /Download a sample products and stock on hand CSV/ }).getAttribute('href');
    const tplRes = await page.request.get(`${APP}${tpl}`);
    check(tplRes.ok() && /^SKU,Item Name,Unit,Category,Stock On Hand,Selling Price/.test(await tplRes.text()), 'a sample products CSV can be downloaded', tpl);
    let t = await uploadAndMap('products', PRODUCT_MAPPING, 'Tally item master');
    await shot('products-preview');
    check(/SKU GSK-1 appears again with different values/.test(t) && /"Coupling 2in" is a new product with no stock on hand stated/.test(t) && /stock on hand "-5" is negative/.test(t), 'row-level errors: a second product on one SKU, a new product with no stock, a negative stock');
    check(/Goods still on order are not stock/.test(t), 'the page says stock on hand is physical stock only');
    check(await n('products') === 0, 'preview writes nothing');
    await confirmImport(6, /6 new and 0 updated products saved/);
    await shot('products-imported');
    check(await n('products') === 6 && await stock('MTR-1HP') === 4 && await stock('IMP-SS') === 30 && await stock('VLV-25') === 40, '6 products saved with their stock on hand (motor 4, impeller 30, valve 40)');
    check((await q1(`SELECT COUNT(*)::int AS n FROM stock_movements WHERE user_id = $1 AND reference LIKE 'OPENING-%'`)).n === 3, 'each stocked product has its opening movement in the ledger');

    // ── 2. Components ──
    await page.getByRole('button', { name: /Next: components/ }).click();
    t = await uploadAndMap('components', COMPONENT_MAPPING, 'Tally BOM');
    check(/no product with SKU NUT-8 or named "Nut M8"; import products first/.test(t), 'a component that is not in the product master is refused, not created');
    await confirmImport(2, /2 new and 0 updated component links saved/);
    check(await n('product_components') === 2, 'Pump A1 = 1 motor + 1 impeller');

    // ── 3. Open purchase orders ──
    await page.getByRole('button', { name: /Next: open purchase orders/ }).click();
    t = await uploadAndMap('purchase_lines', PURCHASE_MAPPING, 'Zoho Inventory');
    await page.locator('input[name=stockFollows]').first().check();
    await settle();
    await page.getByText('Products Starlane could not match with certainty').waitFor({ timeout: 60000 });
    t = await body();
    check(/received quantity 12 is more than the ordered 10/.test(t) && /"abc" is not a quantity/.test(t) && /2026-02-31/.test(t), 'the three bad PO rows are rejected with reasons');
    check(/1 row need a product answer|1 rows need a product answer|1 row needs a product answer/.test(t) && await page.getByRole('button', { name: /^Import \d+ line/ }).count() === 0, 'import is held until the unknown part is answered');
    await page.getByLabel('Product for UNK-9 · Unknown part').selectOption('SKIP');
    await settle();
    await shot('purchase-orders-preview');
    await confirmImport(5, /5 new and 0 updated purchase lines saved/);
    const pos = (await pool.query(`SELECT external_ref, received_quantity::text AS rec, received_before_tracking::text AS rbt FROM purchase_line_items WHERE user_id = $1 ORDER BY external_ref`, [userId])).rows;
    check(JSON.stringify(pos.map((l) => l.external_ref)) === JSON.stringify(['PO-777/1', 'PO-901/1', 'PO-901/2', 'PO-905/1', 'PO-906/1']), 'five open purchase lines saved', pos.map((l) => l.external_ref).join(','));
    check(await stock('MTR-1HP') === 4, 'open purchase quantities are not stock: motors still 4');
    check(pos.find((l) => l.external_ref === 'PO-901/1').rbt === '10', 'the 10 motors Zoho already received are marked as received before tracking');

    // ── 4. Open customer orders ──
    await page.getByRole('button', { name: /Next: open customer orders/ }).click();
    t = await uploadAndMap('orders', ORDER_MAPPING, 'Tally sales orders');
    check(/no outstanding quantity/.test(t) && /no promised date/.test(t), 'missing pending quantity and promised date are stated, not filled in');
    await confirmImport(7, /7 new and 0 updated order lines saved/);
    await shot('orders-imported');
    check(await n('order_line_items') === 7 && await n('customers') === 7, 'seven open order lines and their customers saved; the delivered order is skipped');
    check(/No supplier delay is putting an order at risk/.test(await body()), 'before any delay, no order is at risk');
    await page.getByText('Recent imports').waitFor({ timeout: 30000 });
    t = await body();
    check((t.match(/Imported/g) || []).length >= 4 && /Tally item master/.test(t) && /Zoho Inventory/.test(t), 'import history lists all four files with their source');
    const batches = await q1(`SELECT COUNT(*)::int AS n FROM file_import_batches WHERE user_id = $1 AND status = 'COMPLETED' AND source_system LIKE 'ops_import:%'`);
    check(batches.n === 4, 'four import batches recorded in the audit trail');

    await page.getByRole('link', { name: 'Review open orders' }).click();
    await page.getByText('Ganga Traders').waitFor({ timeout: 60000 });
    await shot('open-orders');
    check(/No promised date/.test(await page.locator('tr', { hasText: 'Ganga Traders' }).innerText()), 'the order with no promised date says so');
    check(/Assumed: full quantity/.test(await page.locator('tr', { hasText: 'Coastal Farms' }).innerText()), 'the order with no pending quantity is marked as an assumption');

    // ── 5. Report the delay ──
    await page.goto(`${APP}/decisions/shipments`, { waitUntil: 'load', timeout: 240000 });
    const motorRow = page.locator('li', { hasText: 'PO-901' }).filter({ hasText: 'Motor 1HP' });
    await motorRow.waitFor({ timeout: 120000 });
    await shot('inbound-shipments');
    check(/10 of 50 received/.test(await motorRow.innerText()), 'the motor line shows 40 still due, 10 of 50 received');
    await motorRow.getByRole('button', { name: 'Report a delay' }).click();
    await motorRow.locator('input[type=date]').fill(plus(today, 12));
    await motorRow.getByPlaceholder('e.g. Factory power cuts').fill('Copper shortage');
    await motorRow.getByRole('button', { name: 'Check affected orders' }).click();
    await page.getByText('Some customer orders are now at risk').waitFor({ timeout: 120000 });
    let d = await delayDecision();
    const sd = d.analysis.supplierDelay;
    check(JSON.stringify(sd.atRisk.map((l) => l.customerName).sort()) === JSON.stringify(EXPECTED.afterDelay.atRisk), 'exactly Arora Agro and Bharat Irrigation become late because of this delay', sd.atRisk.map((l) => l.customerName).join(','));
    check(JSON.stringify(sd.alreadyAtRisk.map((l) => l.customerName)) === JSON.stringify(EXPECTED.afterDelay.alreadyAtRisk), 'Evergreen Estates is shown as already late, not blamed on this delay');
    check(Number(d.materiality.revenueExposure) === EXPECTED.afterDelay.valueAtRisk, 'value at risk ₹2,25,000 (pending quantity × price)', String(d.materiality.revenueExposure));
    check(sd.atRisk.every((l) => l.slipDays === EXPECTED.afterDelay.slip[l.customerName]), 'slips are 6 and 4 days');
    await page.getByRole('link', { name: /See which orders/ }).click();
    await page.getByRole('button', { name: 'Choose' }).first().waitFor({ timeout: 120000 });
    await page.waitForTimeout(1500); // let the page's entrance transition finish before the screenshot
    await shot('decision-after-delay');
    t = await body();
    check(/Arora Agro by 6 days/.test(t) && /Bharat Irrigation by 4 days/.test(t), 'the decision names both late orders and by how much');
    check(!/Evergreen Estates by|Coastal Farms by|Delta Nurseries by/.test(t), 'does not blame the delay for other orders');
    check(/Calculation/.test(t) && /Assumption/.test(t), 'evidence is labelled: calculation vs assumption');
    check(/No simulation and no language model|no language model/i.test(t), 'the page says the counts are a fixed calculation, not AI or simulation');
    check((await sent()).drafts === 0 && (await sent()).sends === 0, 'nothing drafted or sent yet');

    // ── 6. Partial receipt; the first response is lost on the way back ──
    await page.goto(`${APP}/decisions/shipments`, { waitUntil: 'load', timeout: 240000 });
    await motorRow.waitFor({ timeout: 120000 });
    await motorRow.getByRole('button', { name: 'Record receipt' }).click();
    const qty = motorRow.getByPlaceholder(/up to 40/);
    const submit = motorRow.locator('form[aria-label="Record goods received"]').getByRole('button', { name: 'Record receipt' });
    await qty.fill('41');
    check(/Only 40 are still due/.test(await motorRow.innerText()) && await submit.isDisabled(), 'an over-receipt is refused before it is sent');
    await qty.fill('20');
    await motorRow.getByPlaceholder('e.g. GRN-2231').fill('GRN-55');
    let dropped = 0;
    await page.route('**/purchase-lines/*/receipts', async (route) => {
      if (route.request().method() === 'POST' && dropped === 0) { dropped += 1; await route.fetch(); return route.abort('connectionreset'); }
      return route.continue();
    });
    await submit.click();
    await page.getByText('The receipt was not recorded').waitFor({ timeout: 60000 });
    check(/Pressing the button again is safe/.test(await body()), 'a lost response says retrying is safe');
    await submit.click();
    await page.getByText('Already recorded').waitFor({ timeout: 120000 });
    await page.unroute('**/purchase-lines/*/receipts');
    await shot('receipt-retry-not-doubled');
    check(await n('purchase_line_receipts') === 1 && await stock('MTR-1HP') === 24, 'pressing again records nothing twice: one receipt, motors 4 + 20 = 24');
    d = await delayDecision();
    check(JSON.stringify(d.analysis.supplierDelay.atRisk.map((l) => l.customerName)) === JSON.stringify(EXPECTED.afterPartialReceipt.atRisk) && Number(d.materiality.revenueExposure) === EXPECTED.afterPartialReceipt.valueAtRisk,
      'recalculated after the receipt: only Bharat Irrigation, ₹1,35,000', `${d.analysis.supplierDelay.atRisk.map((l) => l.customerName)} ${d.materiality.revenueExposure}`);

    // ── 7. Owner switches the account to live, then chooses and approves ──
    await page.goto(`${APP}/control/decisions`, { waitUntil: 'load', timeout: 240000 });
    await page.getByRole('button', { name: 'Switch to live' }).click();
    await page.getByRole('button', { name: 'Yes, go live' }).click();
    await page.getByRole('button', { name: 'Back to shadow' }).waitFor({ timeout: 30000 });
    await page.goto(`${APP}/decisions/${d.id}`, { waitUntil: 'load', timeout: 240000 });
    await page.getByRole('button', { name: 'Choose' }).first().waitFor({ timeout: 120000 });
    t = await body();
    check(/Bharat Irrigation by 4 days/.test(t) && !/Arora Agro by/.test(t), 'the decision page shows the recalculated assessment');
    await page.getByRole('button', { name: 'Choose' }).nth(1).click();
    await page.getByRole('button', { name: 'Approve', exact: true }).waitFor({ timeout: 30000 });
    check((await sent()).drafts === 0, 'choosing an option drafts nothing');
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Run', exact: true }).waitFor({ timeout: 30000 });
    check((await sent()).drafts === 0, 'approving drafts nothing until it is run');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await page.waitForTimeout(5000);
    await shot('approved-and-run');
    let s = await sent();
    check(s.drafts === 1 && s.drafts_moved === 0 && s.sends === 0 && s.jobs === 0, 'running writes one pending customer-update draft and sends nothing', JSON.stringify(s));

    await page.goto(`${APP}/approvals`, { waitUntil: 'load', timeout: 240000 });
    await page.getByText(/Delay update: Bharat Irrigation/).first().waitFor({ timeout: 120000 });
    await page.getByText(/Delay update: Bharat Irrigation/).first().click();
    await page.waitForTimeout(1500);
    await shot('draft-waiting-in-approvals');
    check(await page.getByText(/Delay update: Arora Agro/).count() === 0, 'no draft for the customer whose order is no longer at risk');

    await page.goto(`${APP}/decisions/${d.id}`, { waitUntil: 'load', timeout: 240000 });
    await page.getByText(/^History \(\d+ events\)/).click();
    t = await body();
    await shot('decision-history');
    check(['revised', 'option selected', 'approved', 'execution started'].every((w) => t.includes(w)), 'decision history shows revision, choice, approval and run');

    // ── 8. The rest arrives ──
    await page.goto(`${APP}/decisions/shipments`, { waitUntil: 'load', timeout: 240000 });
    await motorRow.waitFor({ timeout: 120000 });
    await motorRow.getByRole('button', { name: 'Record receipt' }).click();
    await motorRow.getByPlaceholder(/up to 20/).fill('20');
    await motorRow.locator('form[aria-label="Record goods received"]').getByRole('button', { name: 'Record receipt' }).click();
    await page.getByText(/Received in full/).waitFor({ timeout: 120000 });
    await shot('received-in-full');
    check(await page.locator('li', { hasText: 'PO-901' }).filter({ hasText: 'Motor 1HP' }).count() === 0, 'the fully received line leaves Inbound shipments');
    check(await stock('MTR-1HP') === 44, 'motors: 4 on hand + 40 received; the 10 received before tracking are not counted twice', String(await stock('MTR-1HP')));
    const bad = (await pool.query(
      `SELECT p.name, p.current_stock::float AS stock, COALESCE(SUM(CASE WHEN m.movement_type='in' THEN m.quantity ELSE -m.quantity END),0)::float AS ledger
         FROM products p LEFT JOIN stock_movements m ON m.product_id = p.id AND m.user_id = p.user_id
        WHERE p.user_id = $1 GROUP BY p.id HAVING p.current_stock::float <> COALESCE(SUM(CASE WHEN m.movement_type='in' THEN m.quantity ELSE -m.quantity END),0)::float`, [userId])).rows;
    check(bad.length === 0, 'stock equals the movement ledger for every product', JSON.stringify(bad));
    const ops = (await pool.query(`SELECT event_type FROM decision_events WHERE user_id = $1 AND event_type IN ('OPERATIONS_IMPORTED','GOODS_RECEIPT_RECORDED','SUPPLIER_DELAY_REPORTED')`, [userId])).rows.map((e) => e.event_type);
    check(ops.filter((x) => x === 'OPERATIONS_IMPORTED').length === 4 && ops.filter((x) => x === 'GOODS_RECEIPT_RECORDED').length === 2 && ops.includes('SUPPLIER_DELAY_REPORTED'), 'audit trail has the 4 imports, the delay and both receipts', ops.join(','));
    const agentEvents = (await pool.query(`SELECT COALESCE(model, '') AS model FROM decision_events WHERE user_id = $1 AND actor_type = 'agent'`, [userId])).rows;
    check(agentEvents.length > 0 && agentEvents.every((e) => /no LLM/.test(e.model)), 'every engine event is recorded as deterministic (no LLM)');
    s = await sent();
    // Everything arrived, so no order is late: the run decision resolves and
    // its unsent draft is withdrawn (kept, with a reason), never left sendable.
    const left = (await pool.query(`SELECT status, block_reason FROM ai_actions WHERE user_id = $1`, [userId])).rows;
    check(s.sends === 0 && s.jobs === 0 && left.length === 1 && left[0].status === 'expired' && /received in full/.test(left[0].block_reason || ''), 'at the end: the draft is withdrawn because the goods arrived; nothing was sent', JSON.stringify({ ...s, left }));
    const dstat = (await pool.query(`SELECT status FROM decisions WHERE user_id = $1 AND kind = 'SUPPLIER_DELAY'`, [userId])).rows.map((r) => r.status);
    check(dstat.length === 1 && dstat[0] === 'RESOLVED', 'the run decision is resolved, not left current', dstat.join(','));
    check(errors.length === 0, 'no page errors', errors.join(' | '));
  } catch (err) {
    await shot('FAILED').catch(() => {});
    throw err;
  } finally {
    await browser.close();
    await pool.end();
  }
  console.log(`\n${failures ? `${failures} check(s) FAILED` : 'All checks passed'}. Screenshots and the uploaded files: ${OUT}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error('JOURNEY FAILED:', err.message); process.exit(1); });
