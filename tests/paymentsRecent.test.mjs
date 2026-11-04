// GET /api/payments/recent — the small "payment landed" feed every signed-in
// page polls, instead of the whole invoice list. Tenant-scoped, recent only.
import { createRequire } from 'node:module';
import { makeChecker } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const { createTenant, deleteTenant, startServer, client } = require('./helpers/decisionHarness');
const { check, done } = makeChecker();

async function main() {
  if (!process.env.DATABASE_URL) { console.log('  SKIP needs DATABASE_URL'); return done(); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const tenants = [];
  let server;
  try {
    const a = await createTenant(pool, 'pr-a'); tenants.push(a);
    const b = await createTenant(pool, 'pr-b'); tenants.push(b);
    const today = new Date().toISOString().slice(0, 10);
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);
    const ins = (u, name, status, payDate) => pool.query(
      `INSERT INTO invoices (id, user_id, customer_name, invoice_amount, payment_amount, payment_status, payment_date, due_date, invoice_date)
       VALUES (gen_random_uuid(), $1, $2, 1000, $3, $4, $5, $6, $6)`, [u, name, status === 'Paid' ? 1000 : null, status, payDate, old]);
    await ins(a.id, 'Paid Today (Fixture)', 'Paid', today);
    await ins(a.id, 'Paid Long Ago (Fixture)', 'Paid', old);
    await ins(a.id, 'Still Open (Fixture)', 'Pending', null);
    await ins(b.id, 'Other Tenant (Fixture)', 'Paid', today);

    server = await startServer({});
    const A = client(server.base, a);
    const r = await A.get('/api/payments/recent');
    const names = (r.body.payments || []).map((p) => p.customer_name);
    check('lists only this tenant\'s invoices paid in the last two days', r.status === 200 && names.length === 1 && names[0] === 'Paid Today (Fixture)', r.body);
    check('carries the amount and no other invoice fields', r.body.payments?.[0]?.amount === 1000 && !('customer_phone' in (r.body.payments?.[0] || {})), r.body);
    const anon = await fetch(`${server.base}/api/payments/recent`);
    check('needs a signed-in user', anon.status === 401, anon.status);
  } finally {
    if (server) await server.stop();
    for (const t of tenants) await deleteTenant(pool, t.id);
    await pool.end();
  }
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
