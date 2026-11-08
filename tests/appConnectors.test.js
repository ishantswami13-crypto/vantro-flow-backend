// FILE: tests/appConnectors.test.js
// Live app connectors (lib/connectors/apps): Zoho Books, QuickBooks Online,
// Razorpay, WhatsApp Business.
//   - pure: each vendor's records map to Starlane's invoice fields exactly;
//     Razorpay subunits; forged Zoho hosts are refused; WhatsApp signatures
//     and message parsing; no connector can write or send;
//   - honesty: every connector stays "Coming soon" with no connect action
//     until its flag is on AND its developer credentials are set;
//   - end to end against a local server standing in for each vendor and a
//     real Postgres: OAuth connect (signed state, code exchange, refresh with
//     Intuit's rotating token), API-key connect, sync into invoices and
//     customers, a re-sync that changes nothing, a payment that updates the
//     same invoice, a refused token that becomes "Reconnect", tenant
//     isolation, and WhatsApp deliveries stored once per message. Every
//     request to a vendor's data endpoints is a GET.
//
// Run: DATABASE_URL=... node --test tests/appConnectors.test.js
// Database tests skip (never pass silently) without a database.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const express = require('express');

process.env.OUTBOUND_CREDENTIALS_KEY = process.env.OUTBOUND_CREDENTIALS_KEY || crypto.randomBytes(32).toString('hex');
process.env.JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

const zoho = require('../lib/connectors/apps/zohoBooks');
const qbo = require('../lib/connectors/apps/quickbooks');
const rzp = require('../lib/connectors/apps/razorpay');
const wa = require('../lib/connectors/apps/whatsappBusiness');
const apps = require('../lib/connectors/apps');
const { toRow } = require('../lib/connectors/apps/sync');
const registry = require('../lib/connectors/registry');
const { deriveAppHealth } = require('../lib/connectors/state');
const { createRuntime } = require('../lib/connectors/sdk');
const appHttp = require('../lib/connectors/apps/http');

const LIVE_ENV = {
  FEATURE_CONNECTOR_ZOHO_BOOKS_ENABLED: 'true', ZOHO_CLIENT_ID: 'zoho-client', ZOHO_CLIENT_SECRET: 'zoho-secret',
  FEATURE_CONNECTOR_QUICKBOOKS_ENABLED: 'true', QUICKBOOKS_CLIENT_ID: 'qbo-client', QUICKBOOKS_CLIENT_SECRET: 'qbo-secret',
  FEATURE_CONNECTOR_RAZORPAY_ENABLED: 'true',
  FEATURE_CONNECTOR_WHATSAPP_BUSINESS_ENABLED: 'true', META_APP_SECRET: 'meta-app-secret', WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'verify-me',
  PUBLIC_API_URL: 'https://api.starlane.test', FRONTEND_URL: 'https://app.starlane.test',
};

// ── Pure ────────────────────────────────────────────────────────────────

test('Zoho Books invoices and contacts map to Starlane fields as Zoho states them', () => {
  const i = zoho.mapInvoice({ invoice_id: '9001', customer_id: '77', customer_name: 'Acme Traders', invoice_number: 'INV-0042', total: 11800, balance: 1800, currency_code: 'inr', date: '2026-09-01', due_date: '2026-10-01', last_payment_date: '2026-09-20', status: 'partially_paid' });
  assert.deepEqual(i, { sourceId: '9001', customerRef: '77', customerName: 'Acme Traders', number: 'INV-0042', amount: 11800, balance: 1800, currency: 'INR', issuedOn: '2026-09-01', dueOn: '2026-10-01', paidOn: '2026-09-20', status: 'partially_paid' });
  const c = zoho.mapCustomer({ contact_id: '77', contact_name: 'Acme Traders', email: 'ap@acme.test', mobile: '+91 98765 43210', gst_no: '27AAAAA0000A1Z5' });
  assert.equal(c.phone, '+91 98765 43210');
  assert.equal(c.gstin, '27AAAAA0000A1Z5');
});

test('a forged Zoho callback cannot point Starlane at another host', () => {
  assert.ok(zoho.ACCOUNTS_HOST_RE.test('https://accounts.zoho.in'));
  assert.ok(zoho.API_HOST_RE.test('https://www.zohoapis.eu'));
  for (const bad of ['https://accounts.zoho.in.evil.test', 'http://accounts.zoho.in', 'https://evil.test', 'https://accounts.zoho.in/']) {
    assert.equal(zoho.ACCOUNTS_HOST_RE.test(bad), false, bad);
  }
  assert.equal(zoho.API_HOST_RE.test('https://www.zohoapis.com.evil.test'), false);
});

test('QuickBooks invoices take the paid date from the linked Payment, never a guess', () => {
  const paid = qbo.paidDates([
    { TxnDate: '2026-09-10', Line: [{ LinkedTxn: [{ TxnId: '130', TxnType: 'Invoice' }] }] },
    { TxnDate: '2026-09-25', Line: [{ LinkedTxn: [{ TxnId: '130', TxnType: 'Invoice' }, { TxnId: '9', TxnType: 'CreditMemo' }] }] },
  ]);
  assert.equal(paid.get('130'), '2026-09-25');
  assert.equal(paid.has('9'), false);
  const i = qbo.mapInvoice({ Id: '130', DocNumber: '1037', TxnDate: '2026-08-01', DueDate: '2026-08-31', TotalAmt: 362.07, Balance: 0, CustomerRef: { value: '3', name: 'Cool Cars' }, CurrencyRef: { value: 'USD' }, paidOn: '2026-09-25' });
  assert.equal(i.amount, 362.07);
  assert.equal(i.currency, 'USD');
  assert.equal(i.status, 'paid');
  assert.equal(i.paidOn, '2026-09-25');
});

test('Razorpay amounts are converted from subunits by the currency’s own exponent', () => {
  assert.equal(rzp.fromSubunits(1180000, 'INR'), 11800);
  assert.equal(rzp.fromSubunits(5000, 'JPY'), 5000);
  assert.equal(rzp.fromSubunits(12345, 'KWD'), 12.345);
  const link = rzp.mapInvoice({ id: 'plink_ABC123', amount: 500000, amount_paid: 200000, currency: 'INR', status: 'partially_paid', created_at: 1788220800, expire_by: 1790812800, reference_id: 'TS-9', customer: { name: 'Shree Ganesh Steel', contact: '+919812345678', email: 'acc@sgs.test' }, payments: [] });
  assert.equal(link.amount, 5000);
  assert.equal(link.balance, 3000);
  assert.equal(link.number, 'TS-9');
  assert.equal(link.customerName, 'Shree Ganesh Steel');
  assert.equal(link.paidOn, null, 'not fully paid, so no paid date');
  const inv = rzp.mapInvoice({ id: 'inv_X1', invoice_number: 'R-1', customer_id: 'cust_1', customer_details: { name: 'Mehta Agencies' }, amount: 100000, amount_paid: 100000, currency: 'INR', status: 'paid', issued_at: 1788220800, paid_at: 1788393600 });
  assert.equal(inv.balance, 0);
  assert.equal(inv.paidOn, '2026-09-03');
  assert.equal(inv.customerRef, 'cust_1');
});

test('an app invoice becomes an invoices row with paid and balance from the app’s numbers', () => {
  const row = toRow({ number: 'INV-1', customerName: '  Acme   Traders ', amount: 1000, balance: 250, currency: 'INR', issuedOn: '2026-10-01', dueOn: '2026-10-15', paidOn: null }, { asOf: Date.parse('2026-10-25T10:00:00Z') });
  assert.equal(row.customer_name, 'Acme Traders');
  assert.equal(row.payment_status, 'Pending');
  assert.equal(row.payment_amount, 750);
  assert.equal(row.days_overdue, 10);
  const paid = toRow({ number: 'INV-2', customerName: 'Acme', amount: 1000, balance: 0, currency: 'INR', issuedOn: '2026-10-01', dueOn: '2026-10-15', paidOn: '2026-10-12' });
  assert.equal(paid.payment_status, 'Paid');
  assert.equal(paid.payment_date, '2026-10-12');
  assert.equal(paid.days_overdue, 0);
});

test('WhatsApp deliveries need Meta’s signature, and each inbound message is read once', () => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: '106540352242922', display_phone_number: '15550783881' },
    contacts: [{ wa_id: '919812345678', profile: { name: 'Ravi' } }],
    messages: [{ from: '919812345678', id: 'wamid.A1', timestamp: '1788220800', type: 'text', text: { body: 'Will pay Friday' } }],
    statuses: [{ id: 'wamid.OUT', status: 'delivered' }],
  } }] }] });
  const sig = `sha256=${crypto.createHmac('sha256', 'app-secret').update(body).digest('hex')}`;
  assert.equal(wa.signatureValid(Buffer.from(body), sig, 'app-secret'), true);
  assert.equal(wa.signatureValid(Buffer.from(`${body} `), sig, 'app-secret'), false);
  assert.equal(wa.signatureValid(Buffer.from(body), sig, ''), false, 'no app secret = nothing is accepted');
  const msgs = wa.inboundMessages(JSON.parse(body));
  assert.equal(msgs.length, 1, 'delivery statuses are not messages');
  assert.equal(msgs[0].text, 'Will pay Friday');
  assert.equal(msgs[0].fromName, 'Ravi');
  assert.equal(msgs[0].phoneNumberId, '106540352242922');
});

test('no app connector can write or send: each declares read or receive only', async () => {
  for (const id of apps.APP_IDS) {
    const caps = apps.provider(id).connector.capabilities;
    assert.ok(!caps.includes('WRITE') && !caps.includes('EXECUTE'), `${id} declares ${caps}`);
  }
  const rt = createRuntime(wa.connector, { credentials: {} });
  await assert.rejects(rt.execute('SEND_EMAIL', {}, { idempotencyKey: 'k', approval: { approvedBy: 'owner' } }), /does not support EXECUTE/);
});

test('every app connector stays Coming soon, with no connect action, until its flag and credentials are set', () => {
  const off = {};
  for (const id of apps.APP_IDS) {
    const m = registry.getManifest(id, off);
    assert.equal(m.availability, 'not_available', id);
    assert.match(m.unavailableReason, /Coming soon/);
    assert.equal(m.connect, undefined, `${id} offers no connect action while not Live`);
    assert.deepEqual(registry.validateManifest(m), [], id);
  }
  // Flag on but the developer app is not configured: still not Live.
  assert.equal(registry.getManifest('zoho_books', { FEATURE_CONNECTOR_ZOHO_BOOKS_ENABLED: 'true', OUTBOUND_CREDENTIALS_KEY: 'k' }).availability, 'not_available');
  assert.deepEqual(apps.missingEnv('zoho_books', { FEATURE_CONNECTOR_ZOHO_BOOKS_ENABLED: 'true' }), ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'PUBLIC_API_URL', 'OUTBOUND_CREDENTIALS_KEY']);
  // Credentials set but the flag is off: still not Live.
  assert.equal(registry.getManifest('razorpay', { OUTBOUND_CREDENTIALS_KEY: 'k' }).availability, 'not_available');
  const live = { ...LIVE_ENV, OUTBOUND_CREDENTIALS_KEY: 'k' };
  for (const id of apps.APP_IDS) {
    const m = registry.getManifest(id, live);
    assert.equal(m.availability, 'available', id);
    assert.ok(m.connect && m.access.length, id);
    assert.deepEqual(registry.validateManifest(m), [], id);
  }
  // The catalog count is unchanged: these were already listed as planned.
  assert.equal(registry.listManifests(off).length, 45);
});

test('app health is derived from the account and its sync runs only', () => {
  const now = Date.parse('2026-11-05T10:00:00Z');
  assert.equal(deriveAppHealth({ account: null, now }), 'not_connected');
  assert.equal(deriveAppHealth({ account: { status: 'AUTH_REQUIRED' }, now }), 'error');
  assert.equal(deriveAppHealth({ account: { status: 'CONNECTED' }, now }), 'connected');
  assert.equal(deriveAppHealth({ account: { status: 'CONNECTED' }, latestRun: { status: 'running', started_at: new Date(now - 60000).toISOString() }, now }), 'syncing');
  assert.equal(deriveAppHealth({ account: { status: 'CONNECTED' }, latestRun: { status: 'failed', started_at: new Date(now - 60000).toISOString() }, lastSuccessAt: new Date(now - 3600000).toISOString(), now }), 'error');
  assert.equal(deriveAppHealth({ account: { status: 'CONNECTED' }, latestRun: { status: 'succeeded' }, lastSuccessAt: new Date(now - 600000).toISOString(), now }), 'healthy');
  assert.equal(deriveAppHealth({ account: { status: 'CONNECTED' }, latestRun: { status: 'succeeded' }, lastSuccessAt: new Date(now - 5 * 3600000).toISOString(), now }), 'delayed');
});

// ── End to end: mock vendors + real Postgres ───────────────────────────

function mockVendors() {
  const log = [];
  const state = {
    zohoInvoices: [
      { invoice_id: 'z1', customer_id: 'c1', customer_name: 'Acme Traders', invoice_number: 'ZB-001', total: 11800, balance: 11800, currency_code: 'INR', date: '2026-09-01', due_date: '2026-10-01', status: 'overdue' },
      { invoice_id: 'z2', customer_id: 'c2', customer_name: 'Bharat Steel', invoice_number: 'ZB-002', total: 5000, balance: 0, currency_code: 'INR', date: '2026-09-05', due_date: '2026-10-05', last_payment_date: '2026-09-28', status: 'paid' },
      { invoice_id: 'z3', customer_id: 'c1', customer_name: 'Acme Traders', invoice_number: 'ZB-003', total: 900, balance: 900, currency_code: 'INR', date: '2026-09-07', status: 'draft' },
      { invoice_id: 'z4', customer_id: 'c3', customer_name: 'Old Books Co', invoice_number: 'TALLY-77', total: 700, balance: 700, currency_code: 'INR', date: '2026-08-07', status: 'sent' },
    ],
    qboRefreshCount: 0,
    qboRefreshToken: 'qbo-refresh-1',
    zohoRevoked: false,
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      log.push({ method: req.method, path: u.pathname, auth: req.headers.authorization || null, body });
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const p = u.pathname;
      // Zoho
      if (p === '/zoho-accounts/oauth/v2/token') {
        const f = new URLSearchParams(body);
        if (f.get('client_secret') !== 'zoho-secret') return json(200, { error: 'invalid_client' });
        if (f.get('grant_type') === 'authorization_code') return f.get('code') === 'zoho-code' ? json(200, { access_token: 'zoho-at-1', refresh_token: 'zoho-rt', api_domain: 'https://www.zohoapis.in', expires_in: 3600 }) : json(200, { error: 'invalid_code' });
        if (state.zohoRevoked) return json(200, { error: 'invalid_code' });
        return json(200, { access_token: 'zoho-at-2', api_domain: 'https://www.zohoapis.in', expires_in: 3600 });
      }
      if (p.startsWith('/zoho-api/books/v3/')) {
        if (!/^Zoho-oauthtoken zoho-at-/.test(req.headers.authorization || '')) return json(401, { code: 57, message: 'You are not authorized' });
        if (p.endsWith('/organizations')) return json(200, { code: 0, organizations: [{ organization_id: '600123', name: 'Acme Distribution Pvt Ltd', currency_code: 'INR', is_default_org: true }] });
        if (u.searchParams.get('organization_id') !== '600123') return json(400, { code: 6041, message: 'org missing' });
        if (p.endsWith('/contacts')) return json(200, { code: 0, contacts: [{ contact_id: 'c1', contact_name: 'Acme Traders', email: 'ap@acme.test', mobile: '+91 98765 43210' }, { contact_id: 'c2', contact_name: 'Bharat Steel' }], page_context: { has_more_page: false } });
        if (p.endsWith('/invoices')) {
          const page = Number(u.searchParams.get('page'));
          const rows = page === 1 ? state.zohoInvoices.slice(0, 2) : state.zohoInvoices.slice(2);
          return json(200, { code: 0, invoices: rows, page_context: { page, has_more_page: page === 1 } });
        }
      }
      // Intuit
      if (p === '/intuit/oauth2/v1/tokens/bearer') {
        if (req.headers.authorization !== `Basic ${Buffer.from('qbo-client:qbo-secret').toString('base64')}`) return json(401, { error: 'invalid_client' });
        const f = new URLSearchParams(body);
        if (f.get('grant_type') === 'authorization_code') return f.get('code') === 'qbo-code' ? json(200, { access_token: 'qbo-at-1', refresh_token: state.qboRefreshToken, expires_in: 1 }) : json(400, { error: 'invalid_grant' });
        if (f.get('refresh_token') !== state.qboRefreshToken) return json(400, { error: 'invalid_grant' });
        state.qboRefreshCount++;
        state.qboRefreshToken = `qbo-refresh-${state.qboRefreshCount + 1}`; // Intuit rotates
        return json(200, { access_token: `qbo-at-${state.qboRefreshCount + 1}`, refresh_token: state.qboRefreshToken, expires_in: 3600 });
      }
      if (p.startsWith('/qbo/v3/company/4620816365/')) {
        if (!/^Bearer qbo-at-/.test(req.headers.authorization || '')) return json(401, { Fault: { Error: [{ Message: 'AuthenticationFailed' }] } });
        if (p.endsWith('/companyinfo/4620816365')) return json(200, { CompanyInfo: { CompanyName: 'Sandbox Company_US_1', Country: 'US' } });
        if (p.endsWith('/query')) {
          const q = u.searchParams.get('query');
          if (/from Customer/i.test(q)) return json(200, { QueryResponse: { Customer: [{ Id: '3', DisplayName: 'Cool Cars', PrimaryEmailAddr: { Address: 'cool@cars.test' } }] } });
          if (/from Invoice/i.test(q)) return json(200, { QueryResponse: { Invoice: [
            { Id: '130', DocNumber: '1037', TxnDate: '2026-08-01', DueDate: '2026-08-31', TotalAmt: 362.07, Balance: 0, CustomerRef: { value: '3', name: 'Cool Cars' }, CurrencyRef: { value: 'USD' } },
            { Id: '131', DocNumber: '1038', TxnDate: '2026-08-02', DueDate: '2026-09-01', TotalAmt: 0, Balance: 0, CustomerRef: { value: '3', name: 'Cool Cars' }, CurrencyRef: { value: 'USD' } },
          ] } });
          if (/from Payment/i.test(q)) return json(200, { QueryResponse: { Payment: [{ TxnDate: '2026-08-20', Line: [{ LinkedTxn: [{ TxnId: '130', TxnType: 'Invoice' }] }] }] } });
        }
      }
      // Razorpay
      if (p.startsWith('/rzp/v1/')) {
        if (req.headers.authorization !== `Basic ${Buffer.from('rzp_test_ABCDEFGH1234:rzp-secret-xyz').toString('base64')}`) return json(401, { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } });
        if (p === '/rzp/v1/payments') return json(200, { entity: 'collection', count: 0, items: [] });
        if (p === '/rzp/v1/invoices') return json(200, { entity: 'collection', count: 1, items: [{ id: 'inv_R1', invoice_number: 'RZ-1', customer_id: 'cust_9', customer_details: { name: 'Mehta Agencies', contact: '9811122233' }, amount: 250000, amount_paid: 0, currency: 'INR', status: 'issued', issued_at: 1788220800, expire_by: 1790812800 }] });
        if (p === '/rzp/v1/payment_links') return json(200, { payment_links: [{ id: 'plink_L1', reference_id: 'PL-7', amount: 100000, amount_paid: 100000, currency: 'INR', status: 'paid', created_at: 1788220800, customer: { name: 'Gupta & Sons', contact: '+919800011122' }, payments: [{ created_at: 1788307200 }] }, { id: 'plink_L2', amount: 5000, amount_paid: 0, currency: 'INR', status: 'cancelled', created_at: 1788220800, customer: { name: 'X' } }] });
      }
      // Meta
      if (p === '/meta/v21.0/106540352242922') {
        if (req.headers.authorization !== 'Bearer EAAG-test-token-0123456789') return json(401, { error: { message: 'Invalid OAuth access token' } });
        return json(200, { id: '106540352242922', display_phone_number: '+91 98000 00000', verified_name: 'Acme Distribution', quality_rating: 'GREEN' });
      }
      json(404, { error: 'no such mock route', path: p });
    });
  });
  return { server, log, state };
}

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

test('end to end: connect each app, sync into invoices, reconnect when access is refused, WhatsApp messages stored once', async (t) => {
  const { dbReady, createTenant, deleteTenant } = require('./helpers/decisionHarness');
  const ready = await dbReady();
  if (!ready.ok) { t.skip(`SKIP database: ${ready.reason}`); return; }
  const pool = ready.pool;
  const migrated = (await pool.query(`SELECT to_regclass('public.app_connector_accounts') AS t`)).rows[0].t;
  if (!migrated) { t.skip('SKIP database: migration 070 not applied'); return; }

  const saved = {};
  for (const [k, v] of Object.entries(LIVE_ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  const vendors = mockVendors();
  const mock = await listen(vendors.server);
  appHttp.__setTestOverrides({ urls: {
    zohoAccounts: `${mock}/zoho-accounts`, zohoApi: `${mock}/zoho-api`, intuitOauth: `${mock}/intuit`, intuitAppcenter: `${mock}/appcenter`,
    quickbooksApi: `${mock}/qbo`, razorpayApi: `${mock}/rzp`, metaGraph: `${mock}/meta`,
  } });

  const { connectorsRouter } = require('../lib/routes/connectors');
  const app = express();
  app.use((req, res, next) => (req.path === '/api/connectors/whatsapp_business/webhook' ? next() : express.json()(req, res, next)));
  const authMiddleware = (req, res, next) => { const u = req.get('x-test-user'); if (!u) return res.status(401).json({ error: 'auth' }); req.user = { userId: u }; next(); };
  app.use('/api/connectors', connectorsRouter({ pool, authMiddleware }));
  const api = http.createServer(app);
  const base = await listen(api);
  const call = async (user, method, path, body) => {
    const r = await fetch(`${base}${path}`, { method, redirect: 'manual', headers: { ...(user ? { 'x-test-user': user.id } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: r.status, body: json, location: r.headers.get('location') };
  };

  const a = await createTenant(pool, 'apps-a');
  const b = await createTenant(pool, 'apps-b');
  // An invoice Tally already holds: the Zoho copy must not duplicate it.
  await pool.query(`INSERT INTO invoices (user_id, customer_name, invoice_number, invoice_amount, payment_status, invoice_date, currency, source_type) VALUES ($1,'Old Books Co','TALLY-77',700,'Pending','2026-08-07','INR','tally')`, [a.id]);

  t.after(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    appHttp.__setTestOverrides(null);
    await new Promise((r) => api.close(r));
    await new Promise((r) => vendors.server.close(r));
    for (const u of [a, b]) {
      await pool.query('DELETE FROM starlane_connection_events WHERE user_id = $1', [u.id]).catch(() => {});
      await pool.query('DELETE FROM connector_sync_runs WHERE user_id = $1', [u.id]).catch(() => {});
      await pool.query('DELETE FROM invoices WHERE user_id = $1', [u.id]).catch(() => {});
      await pool.query('DELETE FROM customers WHERE user_id = $1', [u.id]).catch(() => {});
      await deleteTenant(pool, u.id);
    }
  });

  // ── Zoho Books: OAuth ──
  const cu = await call(a, 'GET', '/api/connectors/zoho_books/connect-url');
  assert.equal(cu.status, 200, JSON.stringify(cu.body));
  const consent = new URL(cu.body.url);
  assert.equal(consent.searchParams.get('scope'), 'ZohoBooks.invoices.READ,ZohoBooks.contacts.READ,ZohoBooks.settings.READ');
  assert.equal(consent.searchParams.get('redirect_uri'), 'https://api.starlane.test/api/connectors/zoho_books/callback');
  const state = consent.searchParams.get('state');

  const forged = await call(null, 'GET', `/api/connectors/zoho_books/callback?code=zoho-code&state=${encodeURIComponent(state.slice(0, -4) + 'AAAA')}`);
  assert.equal(forged.status, 400, 'a tampered state is refused');
  const wrongApp = await call(null, 'GET', `/api/connectors/quickbooks/callback?code=zoho-code&realmId=1&state=${encodeURIComponent(state)}`);
  assert.equal(wrongApp.status, 400, 'a Zoho state cannot complete a QuickBooks connect');

  const cb = await call(null, 'GET', `/api/connectors/zoho_books/callback?code=zoho-code&location=in&accounts-server=${encodeURIComponent('https://accounts.zoho.in')}&state=${encodeURIComponent(state)}`);
  assert.equal(cb.status, 302);
  assert.equal(cb.location, 'https://app.starlane.test/sources?app=zoho_books&result=connected');
  const acct = (await pool.query(`SELECT * FROM app_connector_accounts WHERE user_id = $1 AND connector_id = 'zoho_books'`, [a.id])).rows[0];
  assert.equal(acct.account_label, 'Acme Distribution Pvt Ltd');
  assert.equal(acct.external_account_id, '600123');
  assert.ok(!acct.credentials_enc.includes('zoho-rt'), 'the refresh token is stored encrypted');

  // The callback started the first sync; run one now and compare.
  await new Promise((r) => setTimeout(r, 300));
  let s = await call(a, 'POST', '/api/connectors/zoho_books/sync');
  if (s.status === 409 && s.body.code === 'SYNC_RUNNING') { await new Promise((r) => setTimeout(r, 500)); s = await call(a, 'POST', '/api/connectors/zoho_books/sync'); }
  assert.equal(s.status, 200, JSON.stringify(s.body));
  let inv = (await pool.query(`SELECT invoice_number, customer_name, invoice_amount::float AS amt, payment_status, payment_amount::float AS paid, payment_date::text AS pd, due_date::text AS due, source_id FROM invoices WHERE user_id = $1 AND source_type = 'zoho_books' ORDER BY invoice_number`, [a.id])).rows;
  assert.deepEqual(inv.map((r) => r.invoice_number), ['ZB-001', 'ZB-002'], 'drafts are skipped; the Tally invoice is not duplicated');
  assert.equal(inv[0].payment_status, 'Pending');
  assert.equal(inv[1].payment_status, 'Paid');
  assert.equal(inv[1].pd, '2026-09-28');
  assert.equal(s.body.counts.unchanged + s.body.counts.inserted, 2);
  assert.equal(s.body.counts.skippedOtherSource, 1);
  const acme = (await pool.query(`SELECT phone, email FROM customers WHERE user_id = $1 AND name = 'Acme Traders'`, [a.id])).rows[0];
  assert.equal(acme.phone, '9876543210');
  assert.equal(acme.email, 'ap@acme.test');

  // Re-sync with nothing changed: nothing changes.
  s = await call(a, 'POST', '/api/connectors/zoho_books/sync');
  assert.equal(s.body.counts.inserted, 0);
  assert.equal(s.body.counts.updated, 0);
  assert.equal(s.body.counts.unchanged, 2);
  // A payment in Zoho updates the same invoice.
  vendors.state.zohoInvoices[0] = { ...vendors.state.zohoInvoices[0], balance: 0, status: 'paid', last_payment_date: '2026-10-20' };
  s = await call(a, 'POST', '/api/connectors/zoho_books/sync');
  assert.equal(s.body.counts.updated, 1);
  inv = (await pool.query(`SELECT payment_status, payment_date::text AS pd FROM invoices WHERE user_id = $1 AND source_type = 'zoho_books' AND invoice_number = 'ZB-001'`, [a.id])).rows;
  assert.equal(inv.length, 1);
  assert.equal(inv[0].payment_status, 'Paid');
  assert.equal(inv[0].pd, '2026-10-20');

  // The other tenant sees none of it and cannot sync it.
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM invoices WHERE user_id = $1`, [b.id])).rows[0].n, 0);
  assert.equal((await call(b, 'POST', '/api/connectors/zoho_books/sync')).status, 409);

  // Zoho refuses the refresh token (revoked): the account asks to reconnect.
  vendors.state.zohoRevoked = true;
  await pool.query(`UPDATE app_connector_accounts SET credentials_enc = $2 WHERE user_id = $1 AND connector_id = 'zoho_books'`,
    [a.id, require('../lib/domain/outbound/credentials').encrypt({ refreshToken: 'zoho-rt', accessToken: 'zoho-at-old', expiresAt: Date.now() - 1000 })]);
  s = await call(a, 'POST', '/api/connectors/zoho_books/sync');
  assert.equal(s.status, 409);
  assert.equal(s.body.code, 'AUTH_REQUIRED');
  const { getConnectorStates } = require('../lib/connectors/state');
  let states = await getConnectorStates(pool, a.id);
  const zs = states.find((c) => c.id === 'zoho_books');
  assert.equal(zs.availability, 'available');
  assert.equal(zs.state.health, 'error');
  assert.match(zs.state.lastError, /Connect again/);

  // ── QuickBooks: OAuth with Intuit's rotating refresh token ──
  const qu = await call(a, 'GET', '/api/connectors/quickbooks/connect-url');
  const qstate = new URL(qu.body.url).searchParams.get('state');
  const qcb = await call(null, 'GET', `/api/connectors/quickbooks/callback?code=qbo-code&realmId=4620816365&state=${encodeURIComponent(qstate)}`);
  assert.equal(qcb.location, 'https://app.starlane.test/sources?app=quickbooks&result=connected');
  await new Promise((r) => setTimeout(r, 300));
  s = await call(a, 'POST', '/api/connectors/quickbooks/sync');
  if (s.status === 409 && s.body.code === 'SYNC_RUNNING') { await new Promise((r) => setTimeout(r, 500)); s = await call(a, 'POST', '/api/connectors/quickbooks/sync'); }
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const q = (await pool.query(`SELECT invoice_number, currency, payment_status, payment_date::text AS pd FROM invoices WHERE user_id = $1 AND source_type = 'quickbooks'`, [a.id])).rows;
  assert.deepEqual(q, [{ invoice_number: '1037', currency: 'USD', payment_status: 'Paid', pd: '2026-08-20' }], 'the voided zero invoice is skipped');
  assert.ok(vendors.state.qboRefreshCount >= 1, 'the 1-second access token was refreshed');
  const stored = require('../lib/domain/outbound/credentials').decrypt((await pool.query(`SELECT credentials_enc FROM app_connector_accounts WHERE user_id = $1 AND connector_id = 'quickbooks'`, [a.id])).rows[0].credentials_enc);
  assert.equal(stored.refreshToken, vendors.state.qboRefreshToken, 'the rotated refresh token was saved');

  // ── Razorpay: API key ──
  const badKey = await call(a, 'POST', '/api/connectors/razorpay/credentials', { keyId: 'rzp_test_ABCDEFGH1234', keySecret: 'wrong-secret' });
  assert.equal(badKey.status, 400);
  assert.match(badKey.body.error, /did not accept/);
  const rk = await call(a, 'POST', '/api/connectors/razorpay/credentials', { keyId: 'rzp_test_ABCDEFGH1234', keySecret: 'rzp-secret-xyz' });
  assert.equal(rk.status, 201, JSON.stringify(rk.body));
  assert.equal(rk.body.sync.counts.inserted, 2, 'the issued invoice and the paid link; the cancelled link is skipped');
  assert.ok(!JSON.stringify(rk.body).includes('rzp-secret-xyz'), 'the secret is never returned');
  const r = (await pool.query(`SELECT invoice_number, customer_name, invoice_amount::float AS amt, payment_status, payment_date::text AS pd FROM invoices WHERE user_id = $1 AND source_type = 'razorpay' ORDER BY invoice_number`, [a.id])).rows;
  assert.deepEqual(r, [
    { invoice_number: 'PL-7', customer_name: 'Gupta & Sons', amt: 1000, payment_status: 'Paid', pd: '2026-09-02' },
    { invoice_number: 'RZ-1', customer_name: 'Mehta Agencies', amt: 2500, payment_status: 'Pending', pd: null },
  ]);

  // ── WhatsApp Business: receive only ──
  const wbad = await call(a, 'POST', '/api/connectors/whatsapp_business/credentials', { phoneNumberId: '106540352242922', accessToken: 'EAAG-wrong-token-0123456789' });
  assert.equal(wbad.status, 400);
  const wk = await call(a, 'POST', '/api/connectors/whatsapp_business/credentials', { phoneNumberId: '106540352242922', accessToken: 'EAAG-test-token-0123456789' });
  assert.equal(wk.status, 201, JSON.stringify(wk.body));
  assert.equal(wk.body.account.label, 'Acme Distribution · +91 98000 00000');
  const dup = await call(b, 'POST', '/api/connectors/whatsapp_business/credentials', { phoneNumberId: '106540352242922', accessToken: 'EAAG-test-token-0123456789' });
  assert.equal(dup.status, 409, 'one number belongs to one tenant');

  const hs = await fetch(`${base}/api/connectors/whatsapp_business/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`);
  assert.equal(await hs.text(), '12345');
  assert.equal((await fetch(`${base}/api/connectors/whatsapp_business/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`)).status, 403);

  await pool.query(`INSERT INTO customers (user_id, name, phone) VALUES ($1, 'Ravi Kumar', '98123 45678')`, [a.id]);
  const delivery = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: '106540352242922' }, contacts: [{ wa_id: '919812345678', profile: { name: 'Ravi' } }],
    messages: [{ from: '919812345678', id: 'wamid.E2E1', timestamp: '1788220800', type: 'text', text: { body: 'Payment on Friday' } }],
  } }] }] });
  const sign = (b2) => `sha256=${crypto.createHmac('sha256', 'meta-app-secret').update(b2).digest('hex')}`;
  const post = (b2, sig) => fetch(`${base}/api/connectors/whatsapp_business/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: b2 });
  assert.equal((await post(delivery, 'sha256=00')).status, 401, 'unsigned deliveries are refused');
  const d1 = await (await post(delivery, sign(delivery))).json();
  assert.equal(d1.stored, 1);
  const d2 = await (await post(delivery, sign(delivery))).json();
  assert.equal(d2.duplicates, 1, 'Meta retrying the same message stores nothing new');
  const ev = (await pool.query(`SELECT payload FROM starlane_connection_events WHERE user_id = $1 AND source = 'whatsapp'`, [a.id])).rows;
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.text, 'Payment on Friday');
  assert.equal(ev[0].payload.customerName, 'Ravi Kumar');
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM starlane_connection_events WHERE user_id = $1`, [b.id])).rows[0].n, 0);

  states = await getConnectorStates(pool, a.id);
  assert.equal(states.find((c) => c.id === 'razorpay').state.health, 'healthy');
  assert.equal(states.find((c) => c.id === 'quickbooks').state.health, 'healthy');
  assert.equal(states.find((c) => c.id === 'whatsapp_business').state.messagesReceived, 1);

  // Read-only: the only non-GET requests went to OAuth token endpoints.
  const writes = vendors.log.filter((l) => l.method !== 'GET');
  assert.ok(writes.length > 0);
  for (const w of writes) assert.match(w.path, /\/oauth2?\/v\d\/token|\/oauth\/v2\/token|\/tokens\/bearer/, `${w.method} ${w.path}`);

  // Disconnect forgets the access.
  assert.equal((await call(a, 'DELETE', '/api/connectors/razorpay/connection')).status, 200);
  assert.equal((await call(a, 'POST', '/api/connectors/razorpay/sync')).status, 409);
});
