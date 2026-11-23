// FILE: tests/dataFeedSources.test.js
// More data feed sources (lib/connectors/feeds): Tally orders and stock,
// Xero, an SFTP folder, and a report emailed to the owner's Gmail.
//
//   - pure: Tally's XML (stock items; sales and purchase orders with the
//     delivery notes, receipt notes and invoices that fulfil them) becomes
//     rows with what is still outstanding, never counting a delivery note
//     and its invoice twice; renamed voucher types are recognised; Xero's
//     records map without inventing a received quantity; SFTP and email
//     settings are checked; file patterns pick the newest file;
//   - end to end over HTTP against a real Postgres:
//       Tally: a paired bridge device asks which feeds to send, sends Tally's
//         XML, and orders, purchase orders and stock arrive through the
//         checked import; the same export again changes nothing; a delivery
//         recorded in Tally lowers what is outstanding on the same line;
//       Xero: OAuth connect (organisation chosen from /connections),
//         invoices synced, products and purchase orders through feeds, and
//         every request to Xero is a GET with the organisation's tenant id;
//       SFTP: a local SFTP server; password sign-in; the newest matching
//         file is imported; the host key is pinned and a changed key is
//         refused; a private address is refused outside tests;
//       email: the newest matching attachment in Gmail is imported; nothing
//         is sent (every Gmail call is a read).
//
// Run: DATABASE_URL=postgres://...@127.0.0.1/... node --test tests/dataFeedSources.test.js
// Database tests skip (never pass silently) without a database.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const XLSX = require('xlsx');

process.env.OUTBOUND_CREDENTIALS_KEY = process.env.OUTBOUND_CREDENTIALS_KEY || crypto.randomBytes(32).toString('hex');
process.env.JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

const tallyOps = require('../lib/connectors/feeds/tallyOps');
const sftp = require('../lib/connectors/feeds/sftp');
const emailDrop = require('../lib/connectors/feeds/emailDrop');
const feeds = require('../lib/connectors/feeds/feeds');
const tabular = require('../lib/connectors/feeds/tabular');
const xero = require('../lib/connectors/apps/xero');
const appHttp = require('../lib/connectors/apps/http');
const creds = require('../lib/domain/outbound/credentials');
const ops = require('../lib/domain/operations/operationalImport');
const { testDatabaseProblem } = require('../lib/db/testDatabaseGuard');

const SAMPLE_ORDERS = fs.readFileSync(path.join(__dirname, '..', 'tally-connector', 'sample-order-vouchers.xml'), 'utf8');
const SAMPLE_STOCK = fs.readFileSync(path.join(__dirname, '..', 'tally-connector', 'sample-stock-items.xml'), 'utf8');

function importable(kind, rows, stockFollows = 'EXTERNAL') {
  const headers = Object.keys(rows[0]);
  const data = rows.map((r) => headers.map((h) => r[h]));
  const n = ops.normalizeRows(kind, headers, data, ops.validateMapping(kind, headers, tabular.canonicalInput(kind, headers, { sourceSystem: 'X', stockFollows }), data));
  assert.equal(n.rejected.length, 0, `${kind}: ${JSON.stringify(n.rejected)}`);
}

// ── Pure ────────────────────────────────────────────────────────────────

test('Tally: open order lines with outstanding quantity; a delivery note and its invoice are not counted twice', () => {
  const so = tallyOps.orderRows(SAMPLE_ORDERS, 'orders', { company: 'Nirmal Industries' });
  const steel = so.rows.find((r) => r['Line Ref'] === 'Steel Rod 10mm');
  assert.equal(steel.Quantity, '100');
  assert.equal(steel['Outstanding Qty'], '60', '40 on the delivery note and the same 40 on the invoice: 40 delivered, not 80');
  assert.equal(steel['Promised Date'], '2026-06-15', 'from the order due date');
  assert.equal(steel.Status, 'partially shipped');
  assert.equal(steel['Record ID'], 'tally:nirmal industries:so:SO/12:Steel Rod 10mm');
  const paint = so.rows.find((r) => r['Order Number'] === 'SO/12' && r['Line Ref'] === 'Paint 1L');
  assert.equal(paint['Outstanding Qty'], '0');
  assert.equal(paint.Status, 'fulfilled');
  const cancelled = so.rows.find((r) => r['Order Number'] === 'SO/13');
  assert.equal(cancelled.Status, 'cancelled', 'a cancelled order closes its lines');
  assert.equal(cancelled['Customer Name'], 'Gupta & Sons');
  importable('orders', so.rows);

  const po = tallyOps.orderRows(SAMPLE_ORDERS, 'purchase_lines');
  assert.equal(po.rows.length, 1);
  assert.equal(po.rows[0]['Received Qty'], '200');
  assert.equal(po.rows[0]['Outstanding Qty'], '300');
  assert.equal(po.rows[0]['Expected Date'], '2026-06-20');
  assert.equal(po.rows[0].Status, 'partially received');
  importable('purchase_lines', po.rows);

  const stock = tallyOps.stockRows(SAMPLE_STOCK);
  assert.deepEqual(stock.rows.map((r) => [r['Product Name'], r['On Hand'], r.Unit, r.Category]), [
    ['Steel Rod 10mm', '250', 'Kg', 'Raw Material'], ['Bracket & Bolt Set', '0', 'Nos', ''], ['Paint 1L', '1200', 'Ltr', 'Finishing'],
  ]);
  assert.equal(stock.negative, 1, 'negative stock in Tally is none on hand, and counted');
  assert.deepEqual(Object.keys(stock.rows[0]), Object.values(tabular.CANONICAL.products), 'the import’s own column names');
});

test('Tally: voucher kinds come from the base type, so renamed types still count; Tally errors are reported', () => {
  assert.equal(tallyOps.voucherClass('Sales Order'), 'sales_order');
  assert.equal(tallyOps.voucherClass('Purc Order'), 'purchase_order');
  assert.equal(tallyOps.voucherClass('GST Sales'), 'sales_invoice');
  assert.equal(tallyOps.voucherClass('Sales Return'), null);
  assert.equal(tallyOps.voucherClass('Receipt Note'), 'receipt_note');
  assert.equal(tallyOps.voucherClass('Receipt'), null, 'a money receipt is not a goods receipt');
  assert.equal(tallyOps.tallyDate('5-Jun-26'), '2026-06-05');
  assert.throws(() => tallyOps.orderRows('<ENVELOPE><LINEERROR>Could not find Company</LINEERROR></ENVELOPE>', 'orders'), /Tally refused the export: Could not find Company/);
  assert.throws(() => tallyOps.tallyFeedRows('components', { xml: '' }), /not bills of materials/);
  assert.deepEqual(tallyOps.orderRows('', 'orders').rows, []);
});

test('Xero: products only where inventory is tracked, approved POs only, no received quantity invented', () => {
  const p = xero.productRows([{ Code: 'PMP-A1', Name: 'Pump A1', IsTrackedAsInventory: true, QuantityOnHand: 7, SalesDetails: { UnitPrice: 9000 } }, { Code: 'SVC', Name: 'Service', IsTrackedAsInventory: false }]);
  assert.equal(p.length, 1);
  assert.equal(p[0]['On Hand'], '7');
  const po = xero.purchaseRows([
    { PurchaseOrderID: 'a1', PurchaseOrderNumber: 'PO-0001', Status: 'AUTHORISED', DateString: '2026-11-01T00:00:00', DeliveryDate: '/Date(1765497600000+0000)/', CurrencyCode: 'INR', Contact: { ContactID: 'c1', Name: 'Volt Motors' },
      LineItems: [{ LineItemID: 'l1', ItemCode: 'PMP-A1', Quantity: 10, UnitAmount: 4000 }] },
    { PurchaseOrderID: 'a2', Status: 'BILLED', LineItems: [{ LineItemID: 'l2', ItemCode: 'X', Quantity: 1 }] },
  ]);
  assert.equal(po.length, 1);
  assert.equal(po[0]['Expected Date'], '2025-12-12');
  assert.equal(po[0]['PO Date'], '2026-11-01');
  assert.equal(po[0]['Received Qty'], undefined);
  importable('purchase_lines', po, 'STARLANE');
  const inv = xero.mapInvoice({ InvoiceID: 'i1', InvoiceNumber: 'INV-1', Contact: { ContactID: 'c9', Name: 'Shree' }, Total: 1180, AmountDue: 0, CurrencyCode: 'inr', DateString: '2026-10-01T00:00:00', DueDateString: '2026-10-31T00:00:00', FullyPaidOnDate: '/Date(1762300800000+0000)/', Status: 'PAID' });
  assert.deepEqual([inv.amount, inv.balance, inv.currency, inv.issuedOn, inv.dueOn, inv.paidOn, inv.status], [1180, 0, 'INR', '2026-10-01', '2026-10-31', '2025-11-05', 'paid']);
});

test('SFTP and email settings are checked before anything is stored', () => {
  assert.deepEqual(sftp.checkSftpConfig({ host: 'SFTP.Example.com', username: 'erp', folder: 'exports/', pattern: 'orders-*.csv' }), { host: 'sftp.example.com', port: 22, username: 'erp', folder: '/exports', pattern: 'orders-*.csv' });
  assert.throws(() => sftp.checkSftpConfig({ host: 'sftp://x.com', username: 'u' }), /server name/);
  assert.throws(() => sftp.checkSftpConfig({ host: 'x.com', username: 'u', folder: '/a/../etc' }), /folder/);
  assert.throws(() => sftp.checkSftpConfig({ host: 'x.com', username: 'u', pattern: '../x.csv' }), /pattern/);
  assert.throws(() => sftp.checkSftpSecret({}), /password/);
  assert.throws(() => sftp.checkSftpSecret({ privateKey: 'not a key' }), /BEGIN/);
  const pick = sftp.pickNewest([
    { filename: 'orders-1.csv', attrs: { mtime: 10, mode: 0o100644, size: 1 } },
    { filename: 'orders-2.CSV', attrs: { mtime: 20, mode: 0o100644, size: 1 } },
    { filename: 'orders-dir', attrs: { mtime: 30, mode: 0o040755 } },
    { filename: 'stock.csv', attrs: { mtime: 40, mode: 0o100644 } },
  ], 'orders-*.csv');
  assert.equal(pick.filename, 'orders-2.CSV');

  assert.deepEqual(emailDrop.checkEmailConfig({ from: 'Reports@ERP.example.com', subject: 'Daily stock' }), { from: 'reports@erp.example.com', subject: 'Daily stock' });
  assert.throws(() => emailDrop.checkEmailConfig({ from: 'x" OR in:anywhere' }), /address/);
  assert.throws(() => emailDrop.checkEmailConfig({ from: 'erp.example.com', subject: 'a" OR "b' }), /no quotes/);
  assert.equal(emailDrop.gmailQuery({ from: 'erp.example.com', subject: 'Daily stock' }), 'from:erp.example.com has:attachment newer_than:30d subject:"Daily stock"');
  assert.equal(emailDrop.acceptAttachment({ filename: 'stock-*.xlsx' })('stock-23.xlsx'), true);
  assert.equal(emailDrop.acceptAttachment({})('invoice.pdf'), false);

  assert.equal(feeds.checkInterval(60, 'tally'), null, 'Tally feeds follow the bridge, not a schedule here');
  assert.throws(() => feeds.checkSource('tally', {}, 'components'), /not bills of materials/);
  const s = feeds.checkSource('sftp', { host: 'sftp.example.com', username: 'erp', password: 'pw', pattern: '*.csv' }, 'orders');
  assert.equal(s.config.authKind, 'password');
  assert.equal(JSON.stringify(s.config).includes('pw'), false, 'the password is never in the stored config');
});

// ── End to end ──────────────────────────────────────────────────────────

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

function xeroServer() {
  const seen = [];
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { seen.push({ method: req.method, path: req.path, query: req.query, headers: req.headers }); next(); });
  app.post('/xero-identity/connect/token', (req, res) => {
    if (req.get('authorization') !== `Basic ${Buffer.from('xero-client:xero-secret').toString('base64')}`) return res.status(401).json({ error: 'invalid_client' });
    if (req.body.grant_type === 'authorization_code' && req.body.code === 'xero-code') return res.json({ access_token: 'xat-1', refresh_token: 'xrt-1', expires_in: 1800 });
    if (req.body.grant_type === 'refresh_token') return res.json({ access_token: 'xat-2', refresh_token: 'xrt-2', expires_in: 1800 });
    res.status(400).json({ error: 'invalid_grant' });
  });
  const TENANT = '2c5f1d2e-8a8d-4d64-9a51-6a3b8f1f9e11';
  app.get('/xero-api/connections', (req, res) => res.json([{ id: 'x', tenantId: TENANT, tenantType: 'ORGANISATION', tenantName: 'Nirmal Pumps Pvt Ltd' }]));
  app.use('/xero-api/api.xro/2.0', (req, res, next) => (req.get('xero-tenant-id') === TENANT && /^Bearer xat-/.test(req.get('authorization') || '') ? next() : res.status(403).json({ Detail: 'AuthorizationUnsuccessful' })));
  app.get('/xero-api/api.xro/2.0/Organisation', (req, res) => res.json({ Organisations: [{ Name: 'Nirmal Pumps Pvt Ltd', BaseCurrency: 'INR' }] }));
  app.get('/xero-api/api.xro/2.0/Contacts', (req, res) => res.json({ Contacts: req.query.page === '1' ? [{ ContactID: 'c1', Name: 'Shree Traders', EmailAddress: 'accounts@shree.example', Phones: [{ PhoneType: 'MOBILE', PhoneCountryCode: '91', PhoneNumber: '9876543210' }] }] : [] }));
  app.get('/xero-api/api.xro/2.0/Invoices', (req, res) => res.json({ Invoices: req.query.page === '1' ? [
    { InvoiceID: 'i1', InvoiceNumber: 'INV-0042', Type: 'ACCREC', Status: 'AUTHORISED', Contact: { ContactID: 'c1', Name: 'Shree Traders' }, Total: 118000, AmountDue: 50000, CurrencyCode: 'INR', DateString: '2026-10-01T00:00:00', DueDateString: '2026-10-31T00:00:00' },
    { InvoiceID: 'i2', InvoiceNumber: 'INV-0043', Type: 'ACCREC', Status: 'AUTHORISED', Contact: { ContactID: 'c1', Name: 'Shree Traders' }, Total: 0, AmountDue: 0, CurrencyCode: 'INR', DateString: '2026-10-02T00:00:00' },
  ] : [] }));
  app.get('/xero-api/api.xro/2.0/Items', (req, res) => res.json({ Items: [
    { Code: 'PMP-A1', Name: 'Pump A1', IsTrackedAsInventory: true, QuantityOnHand: 7, SalesDetails: { UnitPrice: 9000 } },
    { Code: 'INSTALL', Name: 'Installation', IsTrackedAsInventory: false },
  ] }));
  app.get('/xero-api/api.xro/2.0/PurchaseOrders', (req, res) => res.json({ PurchaseOrders: req.query.page === '1' ? [
    { PurchaseOrderID: 'po1', PurchaseOrderNumber: 'PO-0007', Status: 'AUTHORISED', DateString: '2026-11-01T00:00:00', DeliveryDateString: '2026-12-01T00:00:00', CurrencyCode: 'INR', Contact: { ContactID: 's1', Name: 'Volt Motors' },
      LineItems: [{ LineItemID: 'pl1', ItemCode: 'PMP-A1', Quantity: 10, UnitAmount: 4000 }] },
  ] : [] }));
  app.use((req, res) => res.status(404).json({ error: 'not mocked' }));
  return { server: http.createServer(app), seen };
}

/** A minimal read-only SFTP server (ssh2) serving an in-memory folder. */
function sftpServer(files, hostKey) {
  const { Server, utils } = require('ssh2');
  const { STATUS_CODE } = utils.sftp;
  const logins = [];
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('error', (err) => logins.push({ clientError: err.message }));
    client.on('authentication', (ctx) => {
      logins.push({ method: ctx.method, username: ctx.username });
      if (ctx.method === 'password' && ctx.username === 'erp' && ctx.password === 'erp-pass') return ctx.accept();
      ctx.reject(['password']);
    }).on('ready', () => {
      client.on('session', (accept) => {
        accept().on('sftp', (acceptSftp) => {
          const s = acceptSftp();
          const handles = new Map();
          let next = 0;
          const attrsOf = (f) => ({ mode: 0o100644, uid: 0, gid: 0, size: f.data.length, atime: f.mtime, mtime: f.mtime });
          s.on('OPENDIR', (id, dir) => {
            if (dir !== '/exports') return s.status(id, STATUS_CODE.NO_SUCH_FILE);
            const h = Buffer.from(String(next++)); handles.set(h.toString(), { dir: true, sent: false }); s.handle(id, h);
          });
          s.on('READDIR', (id, h) => {
            const st = handles.get(h.toString());
            if (!st || st.sent) return s.status(id, STATUS_CODE.EOF);
            st.sent = true;
            s.name(id, [...Object.entries(files), ['sub', null]].map(([name, f]) => (f
              ? { filename: name, longname: `-rw-r--r-- 1 erp erp ${f.data.length} Nov 1 00:00 ${name}`, attrs: attrsOf(f) }
              : { filename: name, longname: `drwxr-xr-x 2 erp erp 0 Nov 1 00:00 ${name}`, attrs: { mode: 0o040755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 9e9 } })));
          });
          s.on('OPEN', (id, file, flags) => {
            const f = files[file.replace(/^\/exports\//, '')];
            if (!f || flags !== utils.sftp.OPEN_MODE.READ) { logins.push({ refusedOpen: file, flags }); return s.status(id, STATUS_CODE.PERMISSION_DENIED); }
            const h = Buffer.from(String(next++)); handles.set(h.toString(), { file: f }); s.handle(id, h);
          });
          s.on('FSTAT', (id, h) => { const st = handles.get(h.toString()); return st?.file ? s.attrs(id, attrsOf(st.file)) : s.status(id, STATUS_CODE.FAILURE); });
          s.on('READ', (id, h, offset, length) => {
            const st = handles.get(h.toString());
            if (!st?.file) return s.status(id, STATUS_CODE.FAILURE);
            if (offset >= st.file.data.length) return s.status(id, STATUS_CODE.EOF);
            s.data(id, st.file.data.subarray(offset, offset + length));
          });
          s.on('CLOSE', (id, h) => { handles.delete(h.toString()); s.status(id, STATUS_CODE.OK); });
          for (const op of ['WRITE', 'REMOVE', 'RENAME', 'MKDIR', 'RMDIR', 'SETSTAT']) s.on(op, (id) => { logins.push({ refused: op }); s.status(id, STATUS_CODE.PERMISSION_DENIED); });
        });
      });
    });
  });
  return { server, logins };
}

test('end to end: Tally bridge, Xero, an SFTP folder and an emailed report feed the same checked import', async (t) => {
  if (testDatabaseProblem()) { t.skip(`SKIP database: ${testDatabaseProblem()}`); return; }
  const { dbReady, createTenant, deleteTenant } = require('./helpers/decisionHarness');
  const ready = await dbReady();
  if (!ready.ok) { t.skip(`SKIP database: ${ready.reason}`); return; }
  const pool = ready.pool;
  const col = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'data_feeds' AND column_name = 'source_state'`);
  if (!col.rows[0]) { t.skip('SKIP database: migration 080 not applied'); return; }

  const LIVE = {
    FEATURE_CONNECTOR_XERO_ENABLED: 'true', XERO_CLIENT_ID: 'xero-client', XERO_CLIENT_SECRET: 'xero-secret',
    PUBLIC_API_URL: 'https://api.starlane.test', FRONTEND_URL: 'https://app.starlane.test', GOOGLE_CLIENT_ID: 'g-client', GOOGLE_CLIENT_SECRET: 'g-secret',
  };
  const saved = {};
  for (const [k, v] of Object.entries(LIVE)) { saved[k] = process.env[k]; process.env[k] = v; }
  const xv = xeroServer();
  const xbase = await listen(xv.server);
  appHttp.__setTestOverrides({ urls: { xeroApi: `${xbase}/xero-api`, xeroIdentity: `${xbase}/xero-identity`, xeroLogin: `${xbase}/xero-login` } });

  const { feedsRouter } = require('../lib/routes/feeds');
  const { connectorsRouter } = require('../lib/routes/connectors');
  const { tallyConnectorRouter } = require('../lib/routes/tallyConnector');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const authMiddleware = (req, res, next) => { const u = req.get('x-test-user'); if (!u) return res.status(401).json({ error: 'auth' }); req.user = { userId: u }; next(); };
  app.use('/api/feeds', feedsRouter({ pool, authMiddleware }));
  app.use('/api/connectors', connectorsRouter({ pool, authMiddleware }));
  app.use('/api', tallyConnectorRouter({ pool, supabase: null, authMiddleware }));
  const api = http.createServer(app);
  const base = await listen(api);
  const call = async (user, method, p, body, headers = {}) => {
    const r = await fetch(`${base}${p}`, { method, redirect: 'manual', headers: { ...(user ? { 'x-test-user': user.id } : {}), 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: r.status, body: json, location: r.headers.get('location') };
  };

  const a = await createTenant(pool, 'feedsrc-a');
  const b = await createTenant(pool, 'feedsrc-b');
  const closers = [];
  t.after(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    appHttp.__setTestOverrides(null);
    sftp.__setTestSftp(null);
    emailDrop.__setTestGmailFetch(null);
    for (const c of closers) await c().catch(() => {});
    await new Promise((r) => api.close(r));
    await new Promise((r) => xv.server.close(r));
    for (const u of [a, b]) {
      for (const tbl of ['data_feed_runs', 'data_feeds', 'app_connector_sync_runs', 'app_connector_accounts', 'outbound_provider_accounts', 'connector_sync_runs', 'connector_devices', 'connector_enrollments', 'decision_events', 'purchase_line_receipts', 'stock_movements', 'raw_observations', 'file_import_batches', 'order_line_items', 'orders', 'purchase_line_items', 'purchases', 'product_suppliers', 'product_components', 'products', 'suppliers', 'invoices', 'customers']) {
        await pool.query(`DELETE FROM ${tbl} WHERE user_id = $1`, [u.id]).catch(() => {});
      }
      await deleteTenant(pool, u.id).catch(() => {});
    }
  });
  const count = async (sql, params) => Number((await pool.query(sql, params)).rows[0].n);

  // ── Tally: through a paired bridge device ─────────────────────────────
  const { createEnrollment, claimEnrollment } = require('../lib/domain/ingestion/deviceEnrollment');
  const enr = await createEnrollment(a.id);
  const dev = await claimEnrollment(enr.enrollmentCode, 'Shop PC');
  const device = { Authorization: `VantroDevice ${dev.deviceId}.${dev.deviceSecret}` };

  let r = await call(null, 'GET', '/api/connectors/device/feeds', undefined, device);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.kinds, [], 'no Tally feeds yet: the bridge exports nothing extra');

  for (const kind of ['orders', 'purchase_lines', 'products']) {
    const f = await call(a, 'POST', '/api/feeds', { kind, sourceType: 'tally', source: { company: '' }, intervalMinutes: 60 });
    assert.equal(f.status, 201, JSON.stringify(f.body));
    assert.equal(f.body.feed.intervalMinutes, null, 'Tally feeds run when the bridge sends');
    assert.equal(f.body.firstRun, null);
  }
  const tallyFeeds = (await call(a, 'GET', '/api/feeds')).body.feeds.filter((f) => f.sourceType === 'tally');
  assert.equal(tallyFeeds.find((f) => f.kind === 'purchase_lines').mapping.stockFollows, 'EXTERNAL', 'Tally books stock itself; a PO feed never moves stock twice');
  r = await call(null, 'GET', '/api/connectors/device/feeds', undefined, device);
  assert.deepEqual(r.body.kinds, ['orders', 'purchase_lines', 'products']);
  assert.match(r.body.ordersFromDate, /^\d{8}$/);

  r = await call(null, 'POST', '/api/import/tally/feeds', { kind: 'products', xml: SAMPLE_STOCK, company: '' }, device);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.results[0].status, 'imported', JSON.stringify(r.body));
  assert.equal(await count(`SELECT count(*) n FROM products WHERE user_id = $1`, [a.id]), 3);
  r = await call(null, 'POST', '/api/import/tally/feeds', { kind: 'orders', xml: SAMPLE_ORDERS }, device);
  assert.equal(r.body.results[0].status, 'imported', JSON.stringify(r.body));
  r = await call(null, 'POST', '/api/import/tally/feeds', { kind: 'purchase_lines', xml: SAMPLE_ORDERS }, device);
  assert.equal(r.body.results[0].status, 'imported', JSON.stringify(r.body));
  const steel = async () => (await pool.query(`SELECT l.quantity::text q, l.outstanding_quantity::text o FROM order_line_items l JOIN orders o ON o.id = l.order_id
    WHERE l.user_id = $1 AND o.external_ref = 'SO/12' AND l.product_name_as_imported = 'Steel Rod 10mm'`, [a.id])).rows;
  assert.deepEqual((await steel()).map((x) => [Number(x.q), Number(x.o)]), [[100, 60]]);
  assert.equal(await count(`SELECT count(*) n FROM purchase_line_items WHERE user_id = $1`, [a.id]), 1);
  assert.equal(await count(`SELECT count(*) n FROM stock_movements WHERE user_id = $1 AND reference LIKE 'PO%'`, [a.id]), 0, 'a Tally PO receipt does not book stock again');

  r = await call(null, 'POST', '/api/import/tally/feeds', { kind: 'orders', xml: SAMPLE_ORDERS }, device);
  assert.equal(r.body.results[0].status, 'unchanged', 'the same export again changes nothing');
  // A second delivery in Tally lowers what is outstanding on the same line.
  const more = SAMPLE_ORDERS.replace('<VOUCHER REMOTEID="so-13"', `<VOUCHER REMOTEID="dn-6" VCHTYPE="Delivery Note"><DATE>20260612</DATE><VOUCHERTYPENAME>Delivery Note</VOUCHERTYPENAME><VOUCHERNUMBER>DN/6</VOUCHERNUMBER><PARTYLEDGERNAME>Sharma Traders</PARTYLEDGERNAME>
    <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Steel Rod 10mm</STOCKITEMNAME><ACTUALQTY> 25 Kg</ACTUALQTY><BATCHALLOCATIONS.LIST><ORDERNO>SO/12</ORDERNO><ACTUALQTY> 25 Kg</ACTUALQTY></BATCHALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST></VOUCHER>
  <VOUCHER REMOTEID="so-13"`);
  r = await call(null, 'POST', '/api/import/tally/feeds', { kind: 'orders', xml: more }, device);
  assert.equal(r.body.results[0].status, 'imported', JSON.stringify(r.body));
  assert.deepEqual((await steel()).map((x) => [Number(x.q), Number(x.o)]), [[100, 35]], 'updated in place, not duplicated');
  r = await call(null, 'POST', '/api/import/tally/feeds', { kind: 'orders', xml: '<ENVELOPE><LINEERROR>Could not find Company</LINEERROR></ENVELOPE>' }, device);
  assert.equal(r.body.results[0].status, 'failed');
  assert.match(r.body.results[0].error, /Could not find Company/);
  r = await call(a, 'POST', `/api/feeds/${tallyFeeds[0].id}/run`);
  assert.equal(r.status, 409, 'Run now explains that Tally data comes from the bridge');
  assert.match(r.body.error, /bridge/);
  // Another tenant's session cannot send into this tenant's feeds.
  r = await call(b, 'POST', '/api/import/tally/feeds', { kind: 'orders', xml: SAMPLE_ORDERS });
  assert.deepEqual([r.status, r.body.feeds], [200, 0]);
  assert.equal(await count(`SELECT count(*) n FROM order_line_items WHERE user_id = $1`, [b.id]), 0);
  assert.equal((await call(null, 'POST', '/api/import/tally/feeds', { kind: 'orders', xml: SAMPLE_ORDERS }, { Authorization: `VantroDevice ${dev.deviceId}.${'x'.repeat(43)}` })).status, 401);

  // ── Xero: OAuth, invoices, then products and purchase orders ─────────
  const cu = await call(a, 'GET', '/api/connectors/xero/connect-url');
  assert.equal(cu.status, 200, JSON.stringify(cu.body));
  const consent = new URL(cu.body.url);
  assert.equal(consent.pathname, '/xero-login/identity/connect/authorize');
  assert.equal(consent.searchParams.get('scope'), 'offline_access accounting.transactions.read accounting.contacts.read accounting.settings.read', 'read-only scopes');
  const xcb = await call(null, 'GET', `/api/connectors/xero/callback?code=xero-code&state=${encodeURIComponent(consent.searchParams.get('state'))}`);
  assert.equal(xcb.location, 'https://app.starlane.test/sources?app=xero&result=connected');
  await new Promise((res) => setTimeout(res, 300));
  let s = await call(a, 'POST', '/api/connectors/xero/sync');
  if (s.status === 409 && s.body.code === 'SYNC_RUNNING') { await new Promise((res) => setTimeout(res, 500)); s = await call(a, 'POST', '/api/connectors/xero/sync'); }
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const inv = (await pool.query(`SELECT invoice_number, currency, payment_status FROM invoices WHERE user_id = $1 AND source_type = 'xero'`, [a.id])).rows;
  assert.deepEqual(inv.map((x) => [x.invoice_number, x.currency]), [['INV-0042', 'INR']], 'the zero invoice is not a receivable');
  const xp = await call(a, 'POST', '/api/feeds', { kind: 'products', sourceType: 'app', source: { connectorId: 'xero' } });
  assert.equal(xp.body.firstRun.status, 'imported', JSON.stringify(xp.body.firstRun));
  assert.equal(await count(`SELECT count(*) n FROM products WHERE user_id = $1 AND sku = 'PMP-A1'`, [a.id]), 1);
  const xpo = await call(a, 'POST', '/api/feeds', { kind: 'purchase_lines', sourceType: 'app', source: { connectorId: 'xero' }, mapping: { stockFollows: 'STARLANE' } });
  assert.equal(xpo.body.firstRun.status, 'imported', JSON.stringify(xpo.body.firstRun));
  assert.equal(await count(`SELECT count(*) n FROM purchase_line_items WHERE user_id = $1`, [a.id]), 2);
  const xeroCalls = xv.seen.filter((x) => x.path.startsWith('/xero-api/api.xro'));
  assert.ok(xeroCalls.length >= 5);
  assert.ok(xeroCalls.every((x) => x.method === 'GET' && x.headers['xero-tenant-id'] === '2c5f1d2e-8a8d-4d64-9a51-6a3b8f1f9e11'), 'only reads, always for the chosen organisation');

  // ── SFTP ──────────────────────────────────────────────────────────────
  const { utils } = require('ssh2');
  const key1 = utils.generateKeyPairSync('ed25519').private;
  const key2 = utils.generateKeyPairSync('ed25519').private;
  const files = {
    'stock-2026-11-01.csv': { data: Buffer.from('Item Code,Item Name,Closing Stock\r\nVLV-25,Valve 25mm,40\r\n'), mtime: 1761955200 },
    'stock-2026-11-02.csv': { data: Buffer.from('Item Code,Item Name,Closing Stock\r\nVLV-25,Valve 25mm,38\r\nVLV-32,Valve 32mm,12\r\n'), mtime: 1762041600 },
    'notes.txt': { data: Buffer.from('ignore me'), mtime: 1762900000 },
  };
  let srv = sftpServer(files, key1);
  await new Promise((res) => srv.server.listen(0, '127.0.0.1', res));
  const port = srv.server.address().port;
  closers.push(() => new Promise((res) => srv.server.close(() => res())));
  const sftpSource = { host: '127.0.0.1', port, username: 'erp', password: 'erp-pass', folder: '/exports', pattern: 'stock-*.csv' };
  r = await call(a, 'POST', '/api/feeds/preview', { kind: 'products', sourceType: 'sftp', source: sftpSource });
  assert.equal(r.status, 400, 'a private address is refused');
  assert.match(r.body.error, /private or internal/);
  sftp.__setTestSftp({ allowPrivate: true });
  r = await call(a, 'POST', '/api/feeds/preview', { kind: 'products', sourceType: 'sftp', source: { ...sftpSource, password: 'wrong' } });
  assert.equal(r.status, 401);
  r = await call(a, 'POST', '/api/feeds/preview', { kind: 'products', sourceType: 'sftp', source: sftpSource });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.origin, /^stock-2026-11-02\.csv/, 'the newest matching file');
  assert.match(r.body.hostKey, /^SHA256:/);
  const sf = await call(a, 'POST', '/api/feeds', { name: 'Warehouse stock', kind: 'products', sourceType: 'sftp', source: sftpSource, intervalMinutes: 360,
    mapping: { sourceSystem: 'Warehouse WMS', mapping: { sku: 'Item Code', product_name: 'Item Name', on_hand: 'Closing Stock' } } });
  assert.equal(sf.status, 201, JSON.stringify(sf.body));
  assert.equal(sf.body.firstRun.status, 'imported', JSON.stringify(sf.body.firstRun));
  assert.equal(JSON.stringify(sf.body).includes('erp-pass'), false, 'the password is never returned');
  assert.equal(await count(`SELECT count(*) n FROM products WHERE user_id = $1 AND sku IN ('VLV-25','VLV-32')`, [a.id]), 2);
  let feedRow = (await pool.query('SELECT source_state, secret_enc FROM data_feeds WHERE id = $1', [sf.body.feed.id])).rows[0];
  assert.equal(feedRow.source_state.hostKey, r.body.hostKey, 'the host key seen is pinned');
  assert.equal(feedRow.source_state.lastFile, 'stock-2026-11-02.csv');
  assert.equal(String(feedRow.secret_enc).includes('erp-pass'), false);
  assert.equal((await call(a, 'POST', `/api/feeds/${sf.body.feed.id}/run`)).body.run.status, 'unchanged');
  assert.ok(srv.logins.every((l) => !l.refused && !l.refusedOpen), `read only: ${JSON.stringify(srv.logins)}`);
  assert.ok(srv.logins.some((l) => l.method === 'password' && l.username === 'erp'));
  // The server comes back with a different host key: refused until the owner acts.
  await new Promise((res) => srv.server.close(() => res()));
  srv = sftpServer(files, key2);
  await new Promise((res) => srv.server.listen(port, '127.0.0.1', res));
  r = await call(a, 'POST', `/api/feeds/${sf.body.feed.id}/run`);
  assert.equal(r.body.run.status, 'failed');
  assert.match(r.body.run.error, /identity changed/);
  assert.equal((await call(a, 'GET', '/api/feeds')).body.feeds.find((f) => f.id === sf.body.feed.id).status, 'NEEDS_ATTENTION');

  // ── Email: the newest report in Gmail ─────────────────────────────────
  await pool.query(`INSERT INTO outbound_provider_accounts (user_id, provider, from_address, credentials_enc, created_by) VALUES ($1,'gmail','owner@nirmal.example',$2,$1)`,
    [a.id, creds.encrypt({ refreshToken: 'g-refresh' })]);
  const gmailCalls = [];
  const xlsx = (() => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['PO No', 'Vendor', 'Item', 'Qty', 'Due'], ['DP-501', 'Distributor One', 'PMP-A1', 100, '15/12/2026']]), 'Open POs');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  })();
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  emailDrop.__setTestGmailFetch(async (url, init = {}) => {
    const u = new URL(url);
    gmailCalls.push({ method: init.method || 'GET', path: u.pathname, q: u.searchParams.get('q') });
    if (u.host === 'oauth2.googleapis.com') return json({ access_token: 'g-access', expires_in: 3600 });
    if (u.pathname === '/gmail/v1/users/me/messages') return json({ messages: [{ id: 'm2', threadId: 't2' }, { id: 'm1', threadId: 't1' }] });
    if (u.pathname === '/gmail/v1/users/me/messages/m2') return json({ id: 'm2', internalDate: '1763600000000', payload: { headers: [{ name: 'Subject', value: 'Open POs - daily' }, { name: 'From', value: 'Portal <reports@portal.example>' }], parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('see attached').toString('base64url') } }, { filename: 'logo.png', mimeType: 'image/png', body: { attachmentId: 'img', size: 10 } }, { filename: 'open-pos.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: { attachmentId: 'att-x', size: xlsx.length } }] } });
    if (u.pathname === '/gmail/v1/users/me/messages/m2/attachments/att-x') return json({ data: xlsx.toString('base64url'), size: xlsx.length });
    return json({ error: { message: 'not mocked' } }, 404);
  });
  const emailSource = { from: 'reports@portal.example', subject: 'Open POs' };
  r = await call(a, 'POST', '/api/feeds/preview', { kind: 'purchase_lines', sourceType: 'email', source: emailSource });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.origin, /^open-pos\.xlsx from the email "Open POs - daily"/);
  const ef = await call(a, 'POST', '/api/feeds', { name: 'Distributor POs', kind: 'purchase_lines', sourceType: 'email', source: emailSource, intervalMinutes: 1440,
    mapping: { sourceSystem: 'Distributor portal', stockFollows: 'STARLANE', mapping: { po_ref: 'PO No', supplier_name: 'Vendor', sku: 'Item', quantity: 'Qty', expected_date: 'Due' }, dateOrders: { Due: 'DMY' } } });
  assert.equal(ef.status, 201, JSON.stringify(ef.body));
  assert.equal(ef.body.firstRun.status, 'imported', JSON.stringify(ef.body.firstRun));
  assert.equal(await count(`SELECT count(*) n FROM purchase_line_items WHERE user_id = $1`, [a.id]), 3);
  assert.equal((await call(a, 'POST', `/api/feeds/${ef.body.feed.id}/run`)).body.run.status, 'unchanged');
  assert.ok(gmailCalls.filter((c) => c.path.startsWith('/gmail')).every((c) => c.method === 'GET'), 'Gmail is only read');
  assert.ok(gmailCalls.some((c) => c.q === 'from:reports@portal.example has:attachment newer_than:30d subject:"Open POs"'));
  feedRow = (await pool.query('SELECT source_state FROM data_feeds WHERE id = $1', [ef.body.feed.id])).rows[0];
  assert.equal(feedRow.source_state.lastMessageId, 'm2');
  // No Gmail connected: the owner is told what to do.
  r = await call(b, 'POST', '/api/feeds/preview', { kind: 'orders', sourceType: 'email', source: emailSource });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Connect Gmail/);
});
