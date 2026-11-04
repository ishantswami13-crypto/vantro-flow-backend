// FILE: tests/autoReconcile.test.js
// The auto-reconcile that runs behind /auth/me and the data pages: purchases
// and sales become stock movements, paid invoices/sales/purchases become
// matched bank transactions, and product stock is recounted, over real HTTP
// against a real Postgres. Guards the batched rewrite (one read per table,
// chunked inserts, write only changed stock) against the per-row original.
//
// Run: DATABASE_URL=... JWT_SECRET=... node --test tests/autoReconcile.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { dbReady, createTenant, deleteTenant, startServer, client } = require('./helpers/decisionHarness');

let env;
let server;
const tenants = [];

test.before(async () => {
  env = await dbReady();
  if (!env.ok) return;
  server = await startServer({ FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED: 'false' });
});

test.after(async () => {
  if (server) await server.stop();
  if (env?.ok) {
    for (const t of tenants) {
      for (const tbl of ['bank_transactions', 'stock_movements', 'products', 'purchases', 'sales', 'invoices']) {
        await env.pool.query(`DELETE FROM ${tbl} WHERE user_id = $1`, [t.id]).catch(() => {});
      }
      await deleteTenant(env.pool, t.id).catch(() => {});
    }
    await env.pool.end();
  }
});

test('a data page reconciles stock and bank matches once, scoped to the tenant', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const a = await createTenant(env.pool, 'reconcile-a'); tenants.push(a);
  const b = await createTenant(env.pool, 'reconcile-b'); tenants.push(b);
  const q = (sql, p) => env.pool.query(sql, p);

  // Tenant B has a product with the same name; it must not be touched.
  const other = await q(`INSERT INTO products (user_id, name, current_stock) VALUES ($1,'Steel Rod',99) RETURNING id`, [b.id]);
  // Tenant A: an existing product (different case), stale stock.
  await q(`INSERT INTO products (user_id, name, current_stock) VALUES ($1,'steel rod',5)`, [a.id]);
  await q(
    `INSERT INTO purchases (user_id, supplier_name, amount, paid_amount, status, bill_number, items) VALUES
       ($1,'Steel Co',1000,1000,'paid','B-1',$2), ($1,'Paint Co',500,0,'unpaid','B-2',$3)`,
    [a.id, JSON.stringify([{ description: 'Steel Rod', qty: 10, unit_price: 100 }]), JSON.stringify([{ description: 'Blue Paint', qty: 4, unit_price: 125 }])]
  );
  await q(
    `INSERT INTO sales (user_id, customer_name, amount, paid_amount, status, invoice_number, items, sale_date) VALUES
       ($1,'Acme',300,300,'paid','S-1',$2,CURRENT_DATE)`,
    [a.id, JSON.stringify([{ description: 'STEEL ROD', qty: 3, unit_price: 100 }])]
  );
  await q(
    `INSERT INTO invoices (user_id, customer_name, invoice_amount, payment_status, payment_amount, invoice_number, payment_date) VALUES
       ($1,'Acme',300,'Paid',300,'INV-1','2026-10-01'), ($1,'Beta',800,'Pending',NULL,'INV-2',NULL)`,
    [a.id]
  );

  const ca = client(server.base, a);
  const r = await ca.get(`/api/invoices/${a.id}`);
  assert.ok(r.status < 500, `invoices page loads (${r.status})`);

  const products = (await q(`SELECT name, current_stock::numeric AS s FROM products WHERE user_id = $1 ORDER BY name`, [a.id])).rows;
  assert.deepEqual(products.map((p) => [p.name, Number(p.s)]), [['Blue Paint', 4], ['steel rod', 7]], 'in 10 + 4, out 3; existing product matched case-insensitively');

  const moves = (await q(`SELECT movement_type, quantity::numeric AS q, reference FROM stock_movements WHERE user_id = $1 ORDER BY reference, movement_type`, [a.id])).rows;
  assert.deepEqual(moves.map((m) => [m.reference, m.movement_type, Number(m.q)]), [['B-1', 'in', 10], ['B-2', 'in', 4], ['S-1', 'out', 3]]);

  const txns = (await q(`SELECT matched_type, type, amount::numeric AS a FROM bank_transactions WHERE user_id = $1 ORDER BY matched_type`, [a.id])).rows;
  assert.deepEqual(txns.map((x) => [x.matched_type, x.type, Number(x.a)]), [['invoice', 'credit', 300], ['purchase', 'debit', 1000], ['sale', 'credit', 300]], 'only paid records are matched');

  const untouched = (await q(`SELECT current_stock::numeric AS s FROM products WHERE id = $1`, [other.rows[0].id])).rows[0];
  assert.equal(Number(untouched.s), 99, 'another tenant’s product is not recounted');

  // Concurrent callers share the same run; nothing is duplicated.
  await Promise.all([ca.get(`/api/invoices/${a.id}`), ca.get(`/api/invoices/${a.id}`)]);
  assert.equal((await q(`SELECT COUNT(*)::int AS n FROM stock_movements WHERE user_id = $1`, [a.id])).rows[0].n, 3);
  assert.equal((await q(`SELECT COUNT(*)::int AS n FROM bank_transactions WHERE user_id = $1`, [a.id])).rows[0].n, 3);
});
