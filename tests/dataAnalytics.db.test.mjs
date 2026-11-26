// L4 analytics (lib/data/analytics) against a real Postgres (DATABASE_URL,
// local only, migrations applied): fact loading, the daily receivables
// snapshot with monthly partitions, and the cube's rules (tenant scope, no
// cross-currency sums, last-snapshot-per-period, whitelists). Expected numbers
// are worked out by hand in the comments.
import { createRequire } from 'module';
import { makeChecker, openPool, seedUser, deleteUsers, startServer } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
require('../lib/db/testDatabaseGuard').assertTestDatabase(process.env.DATABASE_URL);
const { cube, parseSpec, refreshAnalytics, sweepAnalytics, describe } = require('../lib/data/analytics');
const { check, done } = makeChecker();

const rejects = (fn) => { try { fn(); return false; } catch { return true; } };

async function main() {
  if (!process.env.DATABASE_URL) { console.log('SKIP analytics DB checks: DATABASE_URL not set'); return done(); }
  const pool = openPool();
  const users = [];
  let server = null;
  try {
    const a = await seedUser(pool, 'cube-a');
    const b = await seedUser(pool, 'cube-b');
    users.push(a.id, b.id);
    const ins = (uid, name, amount, paid, status, invDate, due, paidOn, currency = null) => pool.query(
      `INSERT INTO invoices (user_id, customer_name, invoice_amount, payment_amount, payment_status, invoice_date, due_date, payment_date, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [uid, name, amount, paid, status, invDate, due, paidOn, currency]);
    // Tenant A
    //   Oct: Sharma 100000 paid (inv 10-01, due 10-31, paid 11-10 -> 40 days to pay, 10 late)
    //        Gupta   60000 paid (inv 10-05, due 11-04, paid 11-04 -> 30 days, 0 late)
    //   Nov: Sharma  80000 open (inv 11-02, due 12-02)
    //        Gupta   20000 cancelled (inv 11-03)
    //        Acme    USD 1000 open (inv 11-15, due 11-20)
    await ins(a.id, 'Sharma Traders', 100000, 100000, 'Paid', '2026-10-01', '2026-10-31', '2026-11-10');
    await ins(a.id, 'Gupta & Sons', 60000, 60000, 'Paid', '2026-10-05', '2026-11-04', '2026-11-04');
    await ins(a.id, 'Sharma Traders', 80000, null, 'Pending', '2026-11-02', '2026-12-02', null);
    await ins(a.id, 'Gupta & Sons', 20000, null, 'Cancelled', '2026-11-03', '2026-12-03', null);
    await ins(a.id, 'Acme Inc', 1000, null, 'Pending', '2026-11-15', '2026-11-20', null, 'USD');
    await ins(b.id, 'B Customer', 777, null, 'Pending', '2026-11-01', '2026-11-30', null);

    console.log('invoice facts');
    const byMonth = await cube(a.id, { fact: 'invoices', measures: 'invoiced,collected,count', by: 'month' }, { pool, asOf: '2026-11-25' });
    const oct = byMonth.rows.find((r) => r.month === '2026-10-01' && r.currency === null);
    const novBase = byMonth.rows.find((r) => r.month === '2026-11-01' && r.currency === null);
    const novUsd = byMonth.rows.find((r) => r.month === '2026-11-01' && r.currency === 'USD');
    check('money measures are split by currency even when not asked', byMonth.currencyAdded === true && byMonth.by.includes('currency'));
    check('October: invoiced 160000, collected 160000, 2 invoices', oct && oct.invoiced === 160000 && oct.collected === 160000 && oct.count === 2, oct);
    check('November base currency: invoiced 100000 (incl. cancelled), collected 0', novBase && novBase.invoiced === 100000 && novBase.collected === 0, novBase);
    check('November USD stays separate: 1000', novUsd && novUsd.invoiced === 1000, novUsd);
    check("tenant B's invoice is never counted", !byMonth.rows.some((r) => r.invoiced === 777));

    const timing = await cube(a.id, { fact: 'invoices', measures: 'avg_days_to_pay,avg_days_late,on_time_rate', by: 'customer', filters: { status: 'paid' } }, { pool, asOf: '2026-11-25' });
    const sharma = timing.rows.find((r) => r.customer === 'Sharma Traders');
    const gupta = timing.rows.find((r) => r.customer === 'Gupta & Sons');
    check('non-money measures do not force a currency split', timing.currencyAdded === false);
    check('Sharma: 40 days to pay, 10 days late, 0% on time', sharma && sharma.avg_days_to_pay === 40 && sharma.avg_days_late === 10 && sharma.on_time_rate === 0, sharma);
    check('Gupta: 30 days to pay, 0 late, 100% on time', gupta && gupta.avg_days_to_pay === 30 && gupta.avg_days_late === 0 && gupta.on_time_rate === 1, gupta);
    const outstanding = await cube(a.id, { fact: 'invoices', measures: 'outstanding', by: 'status', time: 'due', from: '2026-11-01', to: '2026-12-31' }, { pool, asOf: '2026-11-25' });
    const openBase = outstanding.rows.find((r) => r.status === 'open' && r.currency === null);
    const cancelled = outstanding.rows.find((r) => r.status === 'cancelled');
    check('outstanding by status over due dates: open 80000, cancelled 0', openBase && openBase.outstanding === 80000 && cancelled && cancelled.outstanding === 0, outstanding.rows);

    console.log('\ndaily snapshots and partitions');
    // Day 1 (11-25): Sharma 80000 current; Acme USD 1000 overdue.
    // Day 2 (12-03): Sharma 80000 now 1 day overdue.
    // Day 3 (12-05): Sharma pays in full -> nothing open in base currency.
    await refreshAnalytics(a.id, { pool, asOf: '2026-12-03' });
    await pool.query("UPDATE invoices SET payment_status = 'Paid', payment_amount = invoice_amount, payment_date = '2026-12-05' WHERE user_id = $1 AND customer_name = 'Sharma Traders' AND payment_status = 'Pending'", [a.id]);
    await refreshAnalytics(a.id, { pool, asOf: '2026-12-05' });
    const parts = await pool.query("SELECT relname FROM pg_class WHERE relname IN ('fact_receivables_daily_202611', 'fact_receivables_daily_202612') ORDER BY 1");
    check('a monthly partition is created for each month written', parts.rows.length === 2, parts.rows);
    const locked = await pool.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'fact_receivables_daily_202612'");
    check('new partitions are locked down (row-level security on)', locked.rows[0] && locked.rows[0].relrowsecurity === true);
    const daily = await cube(a.id, { fact: 'receivables_daily', measures: 'open_amount,overdue_amount', by: 'day' }, { pool, asOf: '2026-12-05' });
    const d = (day, cur = null) => daily.rows.find((r) => r.day === day && r.currency === cur);
    check('11-25: base open 80000, overdue 0', d('2026-11-25')?.open_amount === 80000 && d('2026-11-25')?.overdue_amount === 0, daily.rows);
    check('12-03: base open 80000, overdue 80000', d('2026-12-03')?.open_amount === 80000 && d('2026-12-03')?.overdue_amount === 80000);
    check('12-05: no base-currency row (nothing open), USD still 1000', !d('2026-12-05') && d('2026-12-05', 'USD')?.open_amount === 1000);
    const monthly = await cube(a.id, { fact: 'receivables_daily', measures: 'open_amount', by: 'month', filters: { currency: '' } }, { pool, asOf: '2026-12-05' });
    check('monthly snapshot uses the last day of each month, not a sum of days (Nov 80000; Dec 0 -> no row)',
      monthly.rows.length === 1 && monthly.rows[0].month === '2026-11-01' && monthly.rows[0].open_amount === 80000, monthly.rows);
    const latest = await cube(a.id, { fact: 'receivables_daily', measures: 'open_amount,customers', filters: { customer: 'name:sharma traders' } }, { pool, asOf: '2026-12-05' });
    check('a customer paid off reads as nothing open on the latest day, not its last balance', latest.rows.length === 0, latest.rows);

    console.log('\nspec validation');
    check('unknown measures are refused', rejects(() => parseSpec({ fact: 'invoices', measures: 'sum(password)' })));
    check('unknown dimensions are refused', rejects(() => parseSpec({ fact: 'invoices', measures: 'count', by: 'user_id' })));
    check('two time grains are refused', rejects(() => parseSpec({ fact: 'invoices', measures: 'count', by: 'month,week' })));
    check('bad dates are refused', rejects(() => parseSpec({ fact: 'invoices', measures: 'count', from: "2026-01-01' or 1=1" })));
    check('describe() lists both facts', Object.keys(describe()).join() === 'invoices,receivables_daily');
    const sw = await sweepAnalytics(pool, { asOf: '2026-12-05' });
    check('the analytics sweep finds nothing to do for an up-to-date tenant', !sw.failed.length);

    console.log('\nHTTP');
    server = await startServer(44000 + Math.floor(Math.random() * 2000), { STARLANE_DATA_LAYER_ENABLED: 'true', READ_MODEL_SWEEP_MS: '600000' });
    const get = (path, token) => fetch(`${server.base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const r1 = await get('/api/data/cube?fact=invoices&measures=invoiced&by=customer', b.token);
    const j1 = await r1.json();
    check('GET /api/data/cube answers for the caller only', r1.status === 200 && j1.rows.length === 1 && j1.rows[0].invoiced === 777, j1);
    check('a bad cube spec is a 400', (await get('/api/data/cube?fact=invoices&measures=drop', b.token)).status === 400);
    check('GET /api/data/cube/schema lists facts', (await (await get('/api/data/cube/schema', b.token)).json()).facts.invoices.measures.includes('invoiced'));
  } finally {
    if (server) server.stop();
    for (const t of ['fact_invoices', 'fact_receivables_daily', 'fact_snapshot_days', 'rm_receivables_customer', 'rm_receivables_tenant', 'rm_refresh_state']) {
      await pool.query(`DELETE FROM ${t} WHERE user_id = ANY($1)`, [users]).catch(() => {});
    }
    await deleteUsers(pool, users);
    await pool.end();
  }
  done();
}

main().catch((err) => { console.error(err); process.exit(1); });
