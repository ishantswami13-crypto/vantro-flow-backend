// L3 read models (lib/data/readModels) against a real Postgres (DATABASE_URL,
// local only, migrations applied). Numbers are worked out by hand below and
// checked against the model, then the HTTP endpoints are checked end to end.
import { createRequire } from 'module';
import { makeChecker, openPool, seedUser, deleteUsers, startServer } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
require('../lib/db/testDatabaseGuard').assertTestDatabase(process.env.DATABASE_URL);
const { withTenant } = require('../lib/data/tenantDb');
const { appendEvent, createDispatcher } = require('../lib/data/events');
const { getReceivables, ensureFresh, receivablesConsumer, sweepStale, receivables } = require('../lib/data/readModels');
const { check, done } = makeChecker();

const AS_OF = '2026-12-01';

async function main() {
  if (!process.env.DATABASE_URL) { console.log('SKIP read model DB checks: DATABASE_URL not set'); return done(); }
  const pool = openPool();
  const users = [];
  let server = null;
  try {
    const a = await seedUser(pool, 'rm-a');
    const b = await seedUser(pool, 'rm-b');
    users.push(a.id, b.id);
    const ins = (uid, name, amount, paid, status, due, currency = null, paidOn = null) => pool.query(
      `INSERT INTO invoices (user_id, customer_name, invoice_amount, payment_amount, payment_status, due_date, currency, payment_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [uid, name, amount, paid, status, due, currency, paidOn]);
    // Tenant A, as of 2026-12-01:
    //   Sharma: 100000 due 11-21 (10 days late) + 50000 part-paid 20000, due 09-01 (91 days) -> open 130000, all overdue
    //   Gupta: 75000.50 due 12-15 (not yet due) + 40000 paid (paid on 11-20, closed)
    //   " sharma " is the same customer by name; 9999 cancelled is ignored
    //   Kiran: 30000 due "not a date" -> current, undated
    //   Acme: USD 1200 due 11-01 (30 days) -> separate currency, never added to INR
    await ins(a.id, 'Sharma Traders', 100000, null, 'Pending', '2026-11-21');
    await ins(a.id, ' sharma traders ', 50000, 20000, 'Partial', '2026-09-01');
    await ins(a.id, 'Gupta & Sons', 75000.5, null, 'Pending', '2026-12-15');
    await ins(a.id, 'Gupta & Sons', 40000, 40000, 'Paid', '2026-11-10', null, '2026-11-20');
    await ins(a.id, 'Sharma Traders', 9999, null, 'Cancelled', '2026-10-01');
    await ins(a.id, 'Kiran Electricals', 30000, null, 'Pending', 'not a date');
    await ins(a.id, 'Acme Inc', 1200, null, 'Pending', '2026-11-01', 'usd');
    await ins(b.id, 'Other Tenant Customer', 555, null, 'Pending', '2026-11-01');

    console.log('rebuild and numbers');
    const out = await getReceivables(a.id, { asOf: AS_OF, pool });
    check('the first read builds the model itself', out.rebuiltForThisRequest === true);
    const inr = out.summary.byCurrency.find((c) => c.currency === null);
    const usd = out.summary.byCurrency.find((c) => c.currency === 'USD');
    check('base-currency open = 130000 + 75000.50 + 30000 = 235000.50', inr && inr.openAmount === 235000.5, inr);
    check('base-currency overdue = 130000', inr && inr.overdueAmount === 130000, inr && inr.overdueAmount);
    check('ageing: current 105000.50, 1-30 100000, 90+ 30000', inr && inr.ageing.current === 105000.5 && inr.ageing.d1_30 === 100000 && inr.ageing.d90Plus === 30000 && inr.ageing.d31_60 === 0, inr && inr.ageing);
    check('3 open customers, 1 overdue, 1 undated invoice', inr && inr.customersOpen === 3 && inr.customersOverdue === 1 && inr.undatedInvoices === 1, inr);
    check('USD is kept separate: 1200 open, 1200 overdue in 1-30', usd && usd.openAmount === 1200 && usd.ageing.d1_30 === 1200, usd);
    const sharma = out.customers.customers.find((c) => c.name.toLowerCase().includes('sharma'));
    check('name variants of one customer are merged: Sharma open 130000, 2 invoices', sharma && sharma.openAmount === 130000 && sharma.openInvoices === 2, sharma);
    check('oldest due date and days overdue are exact (2026-09-01, 91)', sharma && sharma.oldestDueDate === '2026-09-01' && sharma.maxDaysOverdue === 91, sharma);
    check('customers sort by overdue first', out.customers.customers[0].name.toLowerCase().includes('sharma'));
    const gupta = out.customers.customers.find((c) => c.name === 'Gupta & Sons');
    check('last payment date comes from paid invoices (2026-11-20)', gupta && gupta.lastPaymentDate === '2026-11-20', gupta);
    check("another tenant's invoices are never included", !out.customers.customers.some((c) => c.name.includes('Other Tenant')));
    const outB = await getReceivables(b.id, { asOf: AS_OF, pool });
    check('tenant B sees only its own 555', outB.summary.byCurrency.length === 1 && outB.summary.byCurrency[0].openAmount === 555);

    console.log('\nfreshness');
    const again = await getReceivables(a.id, { asOf: AS_OF, pool });
    check('an unchanged tenant is served without a rebuild', again.rebuiltForThisRequest === false);
    // Deliberately leaves updated_at alone, like many writers in server.js.
    await pool.query("UPDATE invoices SET payment_status = 'Paid', payment_amount = invoice_amount WHERE user_id = $1 AND customer_name = 'Kiran Electricals'", [a.id]);
    const afterPay = await getReceivables(a.id, { asOf: AS_OF, pool });
    check('a write that emits no event and leaves updated_at alone is noticed on the next read (open drops by 30000)', afterPay.rebuiltForThisRequest && afterPay.summary.byCurrency.find((c) => c.currency === null).openAmount === 205000.5);
    await pool.query("DELETE FROM invoices WHERE user_id = $1 AND customer_name = 'Acme Inc'", [a.id]);
    const afterDelete = await getReceivables(a.id, { asOf: AS_OF, pool });
    check('a deleted invoice is noticed too (USD row gone)', afterDelete.rebuiltForThisRequest && !afterDelete.summary.byCurrency.some((c) => c.currency === 'USD'));
    const nextDay = await getReceivables(a.id, { asOf: '2026-12-16', pool });
    check('ageing rolls over with the as-of day (Gupta becomes 1 day overdue)', nextDay.rebuiltForThisRequest && nextDay.customers.customers.find((c) => c.name === 'Gupta & Sons').overdueAmount === 75000.5);
    await ensureFresh(a.id, { asOf: AS_OF, pool });

    console.log('\nevent consumer and sweep');
    await pool.query("UPDATE invoices SET payment_amount = 50000, payment_status = 'Partial' WHERE user_id = $1 AND due_date = '2026-11-21'", [a.id]);
    const name = `test.rm-${a.id.slice(0, 8)}`;
    const d = createDispatcher({ pool, consumers: [receivablesConsumer({ name, asOf: AS_OF })], log: () => {} });
    await withTenant(a.id, (db) => appendEvent(db, { stream: 'invoice:x', type: 'payment.recorded', payload: { amount: 50000 } }), { pool });
    await d.runAll();
    const st = await withTenant(a.id, (db) => receivables.isStale(db, { asOf: AS_OF }), { pool });
    const view = await withTenant(a.id, (db) => receivables.readSummary(db), { pool });
    check('a payment event rebuilds the model in the background', !st && view.byCurrency.find((c) => c.currency === null).openAmount === 155000.5, view.byCurrency);
    await pool.query('DELETE FROM event_consumers WHERE name = $1', [name]);
    await pool.query("UPDATE invoices SET payment_notes = 'called' WHERE user_id = $1", [b.id]);
    const sw = await sweepStale(pool, { asOf: AS_OF, limit: 1000 });
    const bFresh = !(await withTenant(b.id, (db) => receivables.isStale(db, { asOf: AS_OF }), { pool }));
    check('the sweep rebuilds tenants whose invoices changed without an event', sw.rebuilt >= 1 && bFresh && sw.failed.length === 0, sw);

    console.log('\nHTTP');
    server = await startServer(40000 + Math.floor(Math.random() * 2000), { STARLANE_DATA_LAYER_ENABLED: 'true', READ_MODEL_SWEEP_MS: '600000' });
    const get = (path, token) => fetch(`${server.base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    check('no token gets 401', (await get('/api/data/receivables')).status === 401);
    const ra = await get('/api/data/receivables', a.token);
    const ja = await ra.json();
    check('GET /api/data/receivables returns the tenant summary', ra.status === 200 && ja.summary.byCurrency.length >= 1 && ja.topOverdueCustomers.length >= 1, ja);
    const rb = await (await get('/api/data/receivables/customers', b.token)).json();
    check("tenant B's customer list has only its own customer", rb.total === 1 && rb.customers[0].name === 'Other Tenant Customer', rb);
    check('a bad sort is a 400', (await get('/api/data/receivables/customers?sort=drop', a.token)).status === 400);
    const status = await (await get('/api/data/status', a.token)).json();
    check('the background data layer is running on the server', status.running === true, status);
    server.stop();
    server = await startServer(42000 + Math.floor(Math.random() * 2000), {});
    check('with the flag off the endpoints are 404', (await fetch(`${server.base}/api/data/receivables`, { headers: { Authorization: `Bearer ${a.token}` } })).status === 404);
  } finally {
    if (server) server.stop();
    await pool.query('DELETE FROM rm_receivables_customer WHERE user_id = ANY($1)', [users]).catch(() => {});
    await pool.query('DELETE FROM rm_receivables_tenant WHERE user_id = ANY($1)', [users]).catch(() => {});
    await pool.query('DELETE FROM rm_refresh_state WHERE user_id = ANY($1)', [users]).catch(() => {});
    await pool.query('DELETE FROM event_log WHERE user_id = ANY($1)', [users]).catch(() => {});
    await deleteUsers(pool, users);
    await pool.end();
  }
  done();
}

main().catch((err) => { console.error(err); process.exit(1); });
