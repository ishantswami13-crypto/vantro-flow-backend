// FILE: tests/dataFeeds.test.js
// Data feeds (lib/connectors/feeds): products, orders and purchase orders
// flowing in from other software through the operational import.
//
//   - pure: JSON records (including an order with its lines) become rows;
//     CSV quoting; share links become download links; unsafe headers are
//     refused; each app's records map to the import's own column names with
//     nothing invented (no promised date where the app has none, no stock
//     where the app does not track it);
//   - end to end over HTTP against a real Postgres, with a local server
//     standing in for every vendor and file host:
//       push: key → rows imported; the same rows again change nothing; a
//         changed quantity updates the same line (no duplicate); columns the
//         owner has not confirmed write nothing and flag the feed; a wrong
//         key is refused; a paused feed refuses; tenant B cannot see, run or
//         push into tenant A's feed;
//       file URL: JSON and Excel served from an address, read on Run now;
//         a token header is never sent to another host after a redirect;
//       Shopify: connect with a token, products then open orders; outstanding
//         = Shopify's fulfillable quantity; a re-run is "unchanged";
//       Zoho Inventory: open purchase orders with received quantities;
//       scheduler: a due feed is claimed once, even by two runners at once.
//     Every request to a vendor is a GET.
//
// Run: DATABASE_URL=postgres://...@127.0.0.1/... node --test tests/dataFeeds.test.js
// Database tests skip (never pass silently) without a database.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const XLSX = require('xlsx');

process.env.OUTBOUND_CREDENTIALS_KEY = process.env.OUTBOUND_CREDENTIALS_KEY || crypto.randomBytes(32).toString('hex');
process.env.JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

const tabular = require('../lib/connectors/feeds/tabular');
const sources = require('../lib/connectors/feeds/sources');
const feeds = require('../lib/connectors/feeds/feeds');
const shopify = require('../lib/connectors/apps/shopify');
const woo = require('../lib/connectors/apps/woocommerce');
const zinv = require('../lib/connectors/apps/zohoInventory');
const qbo = require('../lib/connectors/apps/quickbooks');
const appHttp = require('../lib/connectors/apps/http');
const creds = require('../lib/domain/outbound/credentials');
const { safeRequest } = require('../lib/connectors/safeHttp');
const { testDatabaseProblem } = require('../lib/db/testDatabaseGuard');

// ── Pure ────────────────────────────────────────────────────────────────

test('an order with its lines becomes one row per line, keeping the order fields', () => {
  const rows = tabular.rowsFromJson({ rows: [{ order_no: 'SO-1', customer: { name: 'Acme' }, id: 9, lines: [{ id: 1, sku: 'A', qty: 2 }, { id: 2, sku: 'B', qty: 3 }] }] });
  assert.deepEqual(rows, [
    { order_no: 'SO-1', 'customer.name': 'Acme', 'parent.id': 9, id: 1, sku: 'A', qty: 2 },
    { order_no: 'SO-1', 'customer.name': 'Acme', 'parent.id': 9, id: 2, sku: 'B', qty: 3 },
  ]);
  assert.throws(() => tabular.rowsFromJson([1, 2]), /JSON object/);
});

test('CSV output quotes commas, quotes and line breaks', () => {
  const csv = tabular.rowsToCsv([{ a: 'x,y', b: 'say "hi"' }, { a: 'line\nbreak', c: 3 }]).toString();
  assert.equal(csv, 'a,b,c\r\n"x,y","say ""hi""",\r\n"line\nbreak",,3\r\n');
});

test('share links become download links; only https, no credentials in the address', () => {
  assert.equal(sources.normalizeFileUrl('https://www.dropbox.com/s/abc/orders.csv?dl=0'), 'https://www.dropbox.com/s/abc/orders.csv?dl=1');
  assert.equal(sources.normalizeFileUrl('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing'), 'https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOp');
  assert.throws(() => sources.normalizeFileUrl('http://erp.example.com/x.csv'), /https/);
  assert.throws(() => sources.normalizeFileUrl('https://user:pw@erp.example.com/x.csv'), /header/);
  assert.throws(() => sources.normalizeFileUrl('https://docs.google.com/spreadsheets/d/abc/edit'), /Google Sheet/);
  assert.deepEqual(sources.checkHeader({ name: 'Authorization', value: 'Bearer x' }), { name: 'Authorization', value: 'Bearer x' });
  assert.throws(() => sources.checkHeader({ name: 'Host', value: 'evil' }), /header name/);
  assert.throws(() => sources.checkHeader({ name: 'X-Key', value: 'a\r\nInjected: 1' }), /one line/);
});

test('Shopify: open lines with fulfillable quantity, cancelled orders skipped, no promised date invented', () => {
  const rows = shopify.orderRows([
    { id: 1, name: '#1001', currency: 'INR', created_at: '2026-11-01T10:00:00+05:30', customer: { id: 5, first_name: 'Ravi', last_name: 'Kumar' },
      line_items: [{ id: 11, sku: 'PMP-A1', title: 'Pump A1', variant_title: null, quantity: 3, fulfillable_quantity: 1, price: '9000.00' }] },
    { id: 2, name: '#1002', cancelled_at: '2026-11-02T00:00:00Z', line_items: [{ id: 21, quantity: 1 }] },
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    'Customer Name': 'Ravi Kumar', 'Customer ID': '5', 'Order Number': '#1001', 'Line Ref': '11', 'Record ID': 'shopify:1:11', SKU: 'PMP-A1', 'Product Name': 'Pump A1',
    Quantity: '3', 'Outstanding Qty': '1', 'Unit Price': '9000.00', Currency: 'INR', 'Order Date': '2026-11-01', 'Promised Date': '', Status: 'partial',
  });
  const p = shopify.productRows([{ title: 'Valve', product_type: 'resale', status: 'active', variants: [
    { sku: 'V-25', title: '25mm', inventory_management: 'shopify', inventory_quantity: 40, price: '400' },
    { sku: 'V-32', title: '32mm', inventory_management: null, inventory_quantity: 7, price: '450' },
  ] }]);
  assert.equal(p[0]['Product Name'], 'Valve - 25mm');
  assert.equal(p[0]['On Hand'], '40');
  assert.equal(p[1]['On Hand'], '', 'stock Shopify does not track is not a stated stock');
});

test('WooCommerce, Zoho Inventory and QuickBooks rows use only status words the import understands', () => {
  const w = woo.orderRows([{ id: 7, number: '7', status: 'on-hold', currency: 'INR', date_created: '2026-11-03T09:00:00', billing: { company: 'Shree Traders' }, line_items: [{ id: 70, sku: 'A', name: 'A', quantity: 2, price: 10 }] }]);
  assert.equal(w[0].Status, 'on hold');
  assert.equal(w[0]['Customer Name'], 'Shree Traders');
  const z = zinv.orderRows([{ salesorder_id: 'so1', salesorder_number: 'SO-1', customer_name: 'C', date: '2026-11-01', shipment_date: '2026-11-20', status: 'confirmed', currency_code: 'INR',
    line_items: [{ line_item_id: 'l1', sku: 'A', name: 'A', quantity: 10, quantity_shipped: 4, rate: 5 }] }]);
  assert.equal(z[0]['Outstanding Qty'], '6');
  assert.equal(z[0]['Promised Date'], '2026-11-20');
  assert.equal(z[0].Status, 'partially shipped');
  const zp = zinv.purchaseRows([{ purchaseorder_id: 'p1', purchaseorder_number: 'PO-1', vendor_name: 'V', date: '2026-11-01', delivery_date: '2026-11-15', currency_code: 'INR',
    line_items: [{ line_item_id: 'pl1', sku: 'A', name: 'A', quantity: 10, quantity_received: 10, rate: 5 }] }]);
  assert.equal(zp[0].Status, 'received');
  const q = qbo.purchaseRows([{ Id: '9', DocNumber: 'PO-9', POStatus: 'Open', TxnDate: '2026-11-01', VendorRef: { value: '3', name: 'Volt' }, CurrencyRef: { value: 'INR' },
    Line: [{ Id: '1', DetailType: 'ItemBasedExpenseLineDetail', ItemBasedExpenseLineDetail: { ItemRef: { value: '44', name: 'Motor' }, Qty: 5, UnitPrice: 100 } }, { Id: '2', DetailType: 'AccountBasedExpenseLineDetail' }] }],
  [{ Id: '44', Sku: 'MTR-1HP' }]);
  assert.equal(q.length, 1);
  assert.equal(q[0].SKU, 'MTR-1HP');
  assert.equal(q[0]['Expected Date'], '', 'QuickBooks has no expected date; none is borrowed');
  const ops = require('../lib/domain/operations/operationalImport');
  for (const [kind, row] of [['orders', w[0]], ['orders', z[0]], ['purchase_lines', zp[0]], ['purchase_lines', q[0]]]) {
    const headers = Object.keys(row);
    const n = ops.normalizeRows(kind, headers, [headers.map((h) => row[h])], ops.validateMapping(kind, headers, tabular.canonicalInput(kind, headers, { sourceSystem: 'X', stockFollows: 'STARLANE' }), [headers.map((h) => row[h])]));
    assert.equal(n.rejected.length, 0, `${kind}: ${JSON.stringify(n.rejected)}`);
  }
});

test('stored feed choices are checked: a source name is required, push and app sources are not scheduled wrongly', () => {
  assert.throws(() => feeds.checkMapping('orders', { mapping: { order_ref: 'No' } }), /Name the system/);
  assert.throws(() => feeds.checkMapping('purchase_lines', { sourceSystem: 'ERP', auto: true }), /who records stock/);
  assert.deepEqual(feeds.checkMapping('orders', { sourceSystem: 'Shop', auto: true }), { sourceSystem: 'Shop', currency: null, reviewChoices: {}, auto: true });
  assert.equal(feeds.checkInterval(60, 'push'), null);
  assert.throws(() => feeds.checkInterval(5, 'file_url'), /Run every/);
  assert.throws(() => feeds.checkSource('app', { connectorId: 'shopify' }, 'purchase_lines'), /can feed/);
});

// ── End to end ──────────────────────────────────────────────────────────

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

function vendorServer() {
  const seen = [];
  const state = { shopifyFulfillable: 2 };
  const app = express();
  app.use((req, res, next) => { seen.push({ method: req.method, path: req.path, headers: req.headers }); next(); });
  // Shopify
  app.get('/shopify/admin/api/2025-01/shop.json', (req, res) => {
    if (req.get('x-shopify-access-token') !== 'shpat_0123456789abcdef0123') return res.status(401).json({ errors: 'Invalid API key or access token' });
    res.json({ shop: { name: 'Nirmal Pumps', currency: 'INR', iana_timezone: 'Asia/Kolkata' } });
  });
  app.get('/shopify/admin/api/2025-01/products.json', (req, res) => {
    if (req.query.page_info === 'p2') return res.json({ products: [{ id: 2, title: 'Seal kit', status: 'active', product_type: 'resale', variants: [{ sku: 'SEAL-K', title: 'Default Title', inventory_management: 'shopify', inventory_quantity: 12, price: '150.00' }] }] });
    res.set('Link', `<https://x.myshopify.com/admin/api/2025-01/products.json?limit=250&page_info=p2>; rel="next"`);
    res.json({ products: [{ id: 1, title: 'Pump A1', status: 'active', product_type: 'finished', variants: [{ sku: 'PMP-A1', title: 'Default Title', inventory_management: 'shopify', inventory_quantity: 5, price: '9000.00' }] }] });
  });
  app.get('/shopify/admin/api/2025-01/orders.json', (req, res) => res.json({ orders: [{
    id: 501, name: '#1001', currency: 'INR', created_at: '2026-11-01T10:00:00+05:30', customer: { id: 7, first_name: 'Ravi', last_name: 'Kumar' },
    line_items: [
      { id: 9001, sku: 'PMP-A1', title: 'Pump A1', quantity: 3, fulfillable_quantity: state.shopifyFulfillable, price: '9000.00' },
      { id: 9002, sku: 'SEAL-K', title: 'Seal kit', quantity: 2, fulfillable_quantity: 2, price: '150.00' },
    ],
  }] }));
  // Zoho Inventory
  app.get('/zoho-api/inventory/v1/purchaseorders', (req, res) => res.json({ code: 0, purchaseorders: [
    { purchaseorder_id: 'p1', status: 'open' }, { purchaseorder_id: 'p2', status: 'cancelled' },
  ], page_context: { has_more_page: false } }));
  app.get('/zoho-api/inventory/v1/purchaseorders/p1', (req, res) => res.json({ code: 0, purchaseorder: {
    purchaseorder_id: 'p1', purchaseorder_number: 'PO-77', vendor_name: 'Volt Motors', vendor_id: 'v1', date: '2026-11-01', delivery_date: '2026-12-01', currency_code: 'INR',
    line_items: [{ line_item_id: 'pl1', sku: 'PMP-A1', name: 'Pump A1', quantity: 50, quantity_received: 10, rate: 4000 }],
  } }));
  // File host
  app.get('/files/orders.json', (req, res) => res.json({ orders: [{ order_no: 'WEB-1', customer: 'Shree Traders', promised: '2026-12-10', items: [{ sku: 'PMP-A1', qty: 4 }, { sku: 'SEAL-K', qty: 1 }] }] }));
  app.get('/files/products.xlsx', (req, res) => {
    const ws = XLSX.utils.aoa_to_sheet([['Item Code', 'Item Name', 'Closing Stock'], ['VLV-25', 'Valve 25mm', 40]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Stock');
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  });
  app.get('/files/moved.csv', (req, res) => res.redirect(302, `${state.otherHost}/files/elsewhere.csv`));
  app.get('/files/elsewhere.csv', (req, res) => res.type('text/csv').send('SKU,Product Name,On Hand\r\nVLV-25,Valve 25mm,41\r\n'));
  app.use((req, res) => res.status(404).json({ error: 'not mocked' }));
  return { server: http.createServer(app), seen, state };
}

test('end to end: push, file address, Shopify, Zoho Inventory and the scheduler feed the same checked import', async (t) => {
  if (testDatabaseProblem()) { t.skip(`SKIP database: ${testDatabaseProblem()}`); return; }
  const { dbReady, createTenant, deleteTenant } = require('./helpers/decisionHarness');
  const ready = await dbReady();
  if (!ready.ok) { t.skip(`SKIP database: ${ready.reason}`); return; }
  const pool = ready.pool;
  if (!(await pool.query(`SELECT to_regclass('public.data_feeds') AS t`)).rows[0].t) { t.skip('SKIP database: migration 079 not applied'); return; }

  const LIVE = { FEATURE_CONNECTOR_SHOPIFY_ENABLED: 'true', FEATURE_CONNECTOR_ZOHO_INVENTORY_ENABLED: 'true', ZOHO_CLIENT_ID: 'zc', ZOHO_CLIENT_SECRET: 'zs', PUBLIC_API_URL: 'https://api.starlane.test' };
  const saved = {};
  for (const [k, v] of Object.entries(LIVE)) { saved[k] = process.env[k]; process.env[k] = v; }
  const vendors = vendorServer();
  const mock = await listen(vendors.server);
  const other = vendorServer();
  const otherBase = await listen(other.server);
  vendors.state.otherHost = otherBase.replace('127.0.0.1', 'localhost');
  appHttp.__setTestOverrides({ urls: { shopifyApi: `${mock}/shopify`, zohoApi: `${mock}/zoho-api`, zohoAccounts: `${mock}/zoho-accounts` } });
  sources.__setTestRequest(safeRequest, { allowHttp: true, allowPrivate: true });

  const { feedsRouter } = require('../lib/routes/feeds');
  const { connectorsRouter } = require('../lib/routes/connectors');
  const app = express();
  app.use((req, res, next) => (req.path.startsWith('/api/feeds/in') ? next() : express.json()(req, res, next)));
  const authMiddleware = (req, res, next) => { const u = req.get('x-test-user'); if (!u) return res.status(401).json({ error: 'auth' }); req.user = { userId: u }; next(); };
  app.use('/api/feeds', feedsRouter({ pool, authMiddleware }));
  app.use('/api/connectors', connectorsRouter({ pool, authMiddleware }));
  const api = http.createServer(app);
  const base = await listen(api);
  const call = async (user, method, path, body, headers = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { ...(user ? { 'x-test-user': user.id } : {}), 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: r.status, body: json };
  };

  const a = await createTenant(pool, 'feeds-a');
  const b = await createTenant(pool, 'feeds-b');
  t.after(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    appHttp.__setTestOverrides(null);
    sources.__setTestRequest(null);
    await new Promise((r) => api.close(r));
    await new Promise((r) => vendors.server.close(r));
    await new Promise((r) => other.server.close(r));
    for (const u of [a, b]) {
      for (const tbl of ['data_feed_runs', 'data_feeds', 'app_connector_accounts', 'decision_events', 'purchase_line_receipts', 'stock_movements', 'raw_observations', 'file_import_batches', 'order_line_items', 'orders', 'purchase_line_items', 'purchases', 'product_suppliers', 'product_components', 'products', 'suppliers', 'customers']) {
        await pool.query(`DELETE FROM ${tbl} WHERE user_id = $1`, [u.id]).catch(() => {});
      }
      await deleteTenant(pool, u.id).catch(() => {});
    }
  });
  const count = async (sql, params) => Number((await pool.query(sql, params)).rows[0].n);

  // ── Push: products, then orders, from "any software" ─────────────────
  const pf = await call(a, 'POST', '/api/feeds', { name: 'ERP products', kind: 'products', sourceType: 'push', mapping: { sourceSystem: 'ERP', auto: true } });
  assert.equal(pf.status, 201, JSON.stringify(pf.body));
  assert.match(pf.body.pushKey, /^slf_/);
  assert.equal(pf.body.firstRun, null);
  const productKey = pf.body.pushKey;
  const stored = (await pool.query('SELECT push_token_hash FROM data_feeds WHERE id = $1', [pf.body.feed.id])).rows[0].push_token_hash;
  assert.notEqual(stored, productKey, 'only the hash of the key is stored');

  const products = [{ sku: 'PMP-A1', product_name: 'Pump A1', on_hand: 5, unit_price: 9000 }, { sku: 'SEAL-K', product_name: 'Seal kit', on_hand: 12 }];
  let r = await call(null, 'POST', '/api/feeds/in', { rows: products }, { Authorization: `Bearer ${productKey}` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'imported');
  assert.equal(r.body.counts.new, 2);
  assert.equal(await count('SELECT count(*) n FROM products WHERE user_id = $1', [a.id]), 2);
  const evt = (await pool.query(`SELECT actor_type, actor_id, on_behalf_of FROM decision_events WHERE user_id = $1 AND event_type = 'OPERATIONS_IMPORTED' ORDER BY created_at DESC LIMIT 1`, [a.id])).rows[0];
  assert.deepEqual(evt, { actor_type: 'system', actor_id: `starlane.data_feed:${pf.body.feed.id}`, on_behalf_of: a.id }, 'the audit trail names the feed, on behalf of the owner');

  r = await call(null, 'POST', `/api/feeds/in/${productKey}`, { rows: products });
  assert.equal(r.body.status, 'unchanged', 'the same rows again change nothing');

  const of = await call(a, 'POST', '/api/feeds', { name: 'Web orders', kind: 'orders', sourceType: 'push', mapping: { sourceSystem: 'Web shop', auto: true } });
  const orderKey = of.body.pushKey;
  const order = (qty) => [{ order_ref: 'WEB-9', customer_name: 'Ravi Kumar', order_date: '2026-11-02', promised_date: '2026-12-01', lines: [{ line_ref: '1', sku: 'PMP-A1', quantity: qty }] }];
  r = await call(null, 'POST', '/api/feeds/in', order(3), { Authorization: `Bearer ${orderKey}` });
  assert.equal(r.body.status, 'imported', JSON.stringify(r.body));
  r = await call(null, 'POST', '/api/feeds/in', order(4), { Authorization: `Bearer ${orderKey}` });
  assert.equal(r.body.status, 'imported');
  assert.equal(r.body.counts.updated, 1);
  const lines = (await pool.query(`SELECT quantity::text q FROM order_line_items WHERE user_id = $1 AND sku_as_imported = 'PMP-A1'`, [a.id])).rows;
  assert.deepEqual(lines.map((x) => Number(x.q)), [4], 'a changed quantity updates the same line; nothing is duplicated');

  // Columns nobody confirmed: nothing written, the feed asks the owner.
  const before = await count('SELECT count(*) n FROM order_line_items WHERE user_id = $1', [a.id]);
  r = await call(null, 'POST', '/api/feeds/in', 'Ref,Who,Thing,How many\r\nX-1,Someone,PMP-A1,2\r\n', { Authorization: `Bearer ${orderKey}`, 'Content-Type': 'text/csv' });
  assert.equal(r.status, 422);
  assert.equal(r.body.status, 'needs_attention');
  assert.equal(await count('SELECT count(*) n FROM order_line_items WHERE user_id = $1', [a.id]), before);
  let list = await call(a, 'GET', '/api/feeds');
  assert.equal(list.body.feeds.find((f) => f.id === of.body.feed.id).status, 'NEEDS_ATTENTION');
  // Confirming a mapping clears it.
  const fix = await call(a, 'PATCH', `/api/feeds/${of.body.feed.id}`, { mapping: { sourceSystem: 'Web shop', mapping: { order_ref: 'Ref', customer_name: 'Who', sku: 'Thing', quantity: 'How many' } } });
  assert.equal(fix.body.feed.status, 'ACTIVE');
  r = await call(null, 'POST', '/api/feeds/in', 'Ref,Who,Thing,How many\r\nX-1,Someone,PMP-A1,2\r\n', { Authorization: `Bearer ${orderKey}`, 'Content-Type': 'text/csv' });
  assert.equal(r.body.status, 'imported', JSON.stringify(r.body));

  // Wrong key, paused feed, another tenant.
  r = await call(null, 'POST', '/api/feeds/in', { rows: products }, { Authorization: 'Bearer slf_wrongwrongwrongwrongwrongwrongwrongwrongwro' });
  assert.equal(r.status, 401);
  await call(a, 'PATCH', `/api/feeds/${pf.body.feed.id}`, { status: 'PAUSED' });
  r = await call(null, 'POST', '/api/feeds/in', { rows: products }, { Authorization: `Bearer ${productKey}` });
  assert.equal(r.status, 423);
  assert.equal((await call(b, 'GET', '/api/feeds')).body.feeds.length, 0);
  assert.equal((await call(b, 'GET', `/api/feeds/${pf.body.feed.id}/runs`)).status, 404);
  assert.equal((await call(b, 'DELETE', `/api/feeds/${pf.body.feed.id}`)).status, 404);
  assert.equal((await call(b, 'PATCH', `/api/feeds/${pf.body.feed.id}`, { status: 'ACTIVE' })).status, 404);
  assert.equal(await count('SELECT count(*) n FROM products WHERE user_id = $1', [b.id]), 0);
  const rot = await call(a, 'POST', `/api/feeds/${pf.body.feed.id}/rotate-key`);
  await call(a, 'PATCH', `/api/feeds/${pf.body.feed.id}`, { status: 'ACTIVE' });
  assert.equal((await call(null, 'POST', '/api/feeds/in', { rows: products }, { Authorization: `Bearer ${productKey}` })).status, 401, 'the old key stops working after rotation');
  assert.equal((await call(null, 'POST', '/api/feeds/in', { rows: products }, { Authorization: `Bearer ${rot.body.pushKey}` })).status, 200);

  // ── File address: JSON orders and an Excel stock file ─────────────────
  let pv = await call(a, 'POST', '/api/feeds/preview', { kind: 'orders', sourceType: 'file_url', source: { url: `${mock}/files/orders.json` } });
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.deepEqual(pv.body.preview.file.columns, ['order_no', 'customer', 'promised', 'sku', 'qty']);
  const confirmed = { ...pv.body.suggestedInput, sourceSystem: 'Website', mapping: { order_ref: 'order_no', customer_name: 'customer', promised_date: 'promised', sku: 'sku', quantity: 'qty' }, dateOrders: { promised: 'DMY' } };
  const ff = await call(a, 'POST', '/api/feeds', { name: 'Website orders', kind: 'orders', sourceType: 'file_url', source: { url: `${mock}/files/orders.json`, header: { name: 'X-Api-Key', value: 'secret-123' } }, mapping: confirmed, intervalMinutes: 60 });
  assert.equal(ff.status, 201, JSON.stringify(ff.body));
  assert.equal(ff.body.firstRun.status, 'imported', JSON.stringify(ff.body.firstRun));
  assert.equal(ff.body.feed.source.hasHeader, true);
  assert.equal(JSON.stringify(ff.body).includes('secret-123'), false, 'the header value is never returned');
  assert.equal(vendors.seen.filter((s) => s.path === '/files/orders.json').pop().headers['x-api-key'], 'secret-123');
  assert.equal((await call(a, 'POST', `/api/feeds/${ff.body.feed.id}/run`)).body.run.status, 'unchanged');

  const xf = await call(a, 'POST', '/api/feeds', { kind: 'products', sourceType: 'file_url', source: { url: `${mock}/files/products.xlsx` }, mapping: { sourceSystem: 'Tally export', mapping: { sku: 'Item Code', product_name: 'Item Name', on_hand: 'Closing Stock' } } });
  assert.equal(xf.body.firstRun.status, 'imported', JSON.stringify(xf.body.firstRun));
  assert.equal(await count(`SELECT count(*) n FROM products WHERE user_id = $1 AND sku = 'VLV-25'`, [a.id]), 1);

  // A token header is not carried to another host after a redirect.
  const mf = await call(a, 'POST', '/api/feeds', { kind: 'products', sourceType: 'file_url', source: { url: `${mock}/files/moved.csv`, header: { name: 'Authorization', value: 'Bearer do-not-leak' } }, mapping: { sourceSystem: 'Mirror', mapping: { sku: 'SKU', product_name: 'Product Name', on_hand: 'On Hand' } } });
  assert.equal(mf.body.firstRun.status, 'imported', JSON.stringify(mf.body.firstRun));
  const hop = other.seen.find((s) => s.path === '/files/elsewhere.csv');
  assert.ok(hop, 'the redirect was followed');
  assert.equal(hop.headers.authorization, undefined);

  // ── Shopify ───────────────────────────────────────────────────────────
  r = await call(a, 'POST', '/api/connectors/shopify/credentials', { shop: 'nirmal-pumps', accessToken: 'shpat_wrongwrongwrongwrong' });
  assert.equal(r.status, 400);
  r = await call(a, 'POST', '/api/connectors/shopify/credentials', { shop: 'https://nirmal-pumps.myshopify.com/admin', accessToken: 'shpat_0123456789abcdef0123' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  list = await call(a, 'GET', '/api/feeds');
  assert.deepEqual(list.body.apps.find((x) => x.connectorId === 'shopify'), { connectorId: 'shopify', name: 'Shopify', kinds: ['orders', 'products'], live: true, connected: true, status: 'CONNECTED', label: 'Nirmal Pumps (Shopify)' });
  assert.equal((await call(a, 'POST', '/api/connectors/shopify/sync')).body.code, 'USE_FEEDS');

  const sp = await call(a, 'POST', '/api/feeds', { kind: 'products', sourceType: 'app', source: { connectorId: 'shopify' }, intervalMinutes: 30 });
  assert.equal(sp.status, 201, JSON.stringify(sp.body));
  assert.equal(sp.body.firstRun.status, 'imported', JSON.stringify(sp.body.firstRun));
  assert.equal(sp.body.firstRun.details.counts.accepted, 2, 'both pages of Shopify products are read');
  const so = await call(a, 'POST', '/api/feeds', { kind: 'orders', sourceType: 'app', source: { connectorId: 'shopify' } });
  assert.equal(so.body.firstRun.status, 'imported', JSON.stringify(so.body.firstRun));
  const shopLines = (await pool.query(`SELECT external_ref, quantity::text q, outstanding_quantity::text o, product_id IS NOT NULL linked, needed_by FROM order_line_items WHERE user_id = $1 AND source_system = 'Shopify' ORDER BY external_ref`, [a.id])).rows;
  assert.equal(shopLines.length, 2);
  assert.deepEqual(shopLines.map((l) => [Number(l.q), Number(l.o), l.linked, l.needed_by]), [[3, 2, true, null], [2, 2, true, null]], 'outstanding = fulfillable; no promised date invented');
  assert.equal((await call(a, 'POST', `/api/feeds/${so.body.feed.id}/run`)).body.run.status, 'unchanged');
  vendors.state.shopifyFulfillable = 0;
  const rerun = await call(a, 'POST', `/api/feeds/${so.body.feed.id}/run`);
  assert.equal(rerun.body.run.status, 'imported');
  assert.equal(Number((await pool.query(`SELECT outstanding_quantity::text o FROM order_line_items WHERE user_id = $1 AND source_system = 'Shopify' AND sku_as_imported = 'PMP-A1'`, [a.id])).rows[0].o), 0);
  assert.ok(vendors.seen.filter((s) => s.path.startsWith('/shopify')).every((s) => s.method === 'GET'), 'Shopify only ever receives GET requests');
  // Tenant B cannot use A's Shopify connection.
  assert.equal((await call(b, 'POST', '/api/feeds', { kind: 'orders', sourceType: 'app', source: { connectorId: 'shopify' } })).body.firstRun.status, 'failed');

  // ── Zoho Inventory (account stored as the OAuth callback would) ───────
  await pool.query(
    `INSERT INTO app_connector_accounts (user_id, connector_id, account_label, external_account_id, config, credentials_enc) VALUES ($1,'zoho_inventory','Nirmal (Zoho Inventory)','org1',$2,$3)`,
    [a.id, JSON.stringify({ apiDomain: 'https://www.zohoapis.in', organizationId: 'org1', currency: 'INR' }), creds.encrypt({ accessToken: 'z-token', refreshToken: 'z-refresh', expiresAt: Date.now() + 3600e3 })]);
  const zp = await call(a, 'POST', '/api/feeds', { kind: 'purchase_lines', sourceType: 'app', source: { connectorId: 'zoho_inventory' }, mapping: { stockFollows: 'STARLANE' } });
  assert.equal(zp.body.firstRun.status, 'imported', JSON.stringify(zp.body.firstRun));
  const pl = (await pool.query(`SELECT quantity::text q, received_quantity::text rq, expected_at FROM purchase_line_items WHERE user_id = $1 AND source_system = 'Zoho Inventory'`, [a.id])).rows;
  assert.equal(pl.length, 1, 'the cancelled purchase order is not read');
  assert.deepEqual([Number(pl[0].q), Number(pl[0].rq), new Date(pl[0].expected_at).toISOString().slice(0, 10)], [50, 10, '2026-12-01']);
  assert.ok(vendors.seen.filter((s) => s.path.startsWith('/zoho-api')).every((s) => s.method === 'GET' && s.headers.authorization === 'Zoho-oauthtoken z-token'));

  // ── Scheduler: a due feed is claimed once ─────────────────────────────
  await pool.query(`UPDATE data_feeds SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [sp.body.feed.id]);
  const [one, two] = await Promise.all([feeds.runDueFeeds(pool, { limit: 50 }), feeds.runDueFeeds(pool, { limit: 50 })]);
  const mine = (o) => o.feeds;
  assert.equal(mine(one) + mine(two) >= 1, true);
  const runs = await count(`SELECT count(*) n FROM data_feed_runs WHERE feed_id = $1 AND trigger = 'schedule'`, [sp.body.feed.id]);
  assert.equal(runs, 1, 'two runners at once still run the feed once');
  const next = (await pool.query('SELECT next_run_at > now() AS later FROM data_feeds WHERE id = $1', [sp.body.feed.id])).rows[0];
  assert.equal(next.later, true);

  // Run history and delete.
  const hist = await call(a, 'GET', `/api/feeds/${so.body.feed.id}/runs`);
  assert.deepEqual(hist.body.runs.map((x) => x.status), ['imported', 'unchanged', 'imported']);
  assert.equal((await call(a, 'DELETE', `/api/feeds/${so.body.feed.id}`)).status, 200);
  assert.equal(await count(`SELECT count(*) n FROM order_line_items WHERE user_id = $1 AND source_system = 'Shopify'`, [a.id]), 2, 'deleting a feed keeps what it imported');
});
