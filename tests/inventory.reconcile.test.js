// FILE: tests/inventory.reconcile.test.js
// The auto-reconcile that runs when the owner opens the app (/api/auth/me ->
// reconcileBusinessData) must not change stock the owner did not change.
// Synthetic tenants on a real Postgres over real HTTP.
//
//   1. Stock typed into a product (no movement behind it) survives the
//      recount, and later movements count from it, not from 0.
//   2. An open purchase order tracked in purchase_line_items books nothing;
//      a received line books exactly its received quantity, once.
//   3. A plain bill with no tracked lines keeps the legacy behaviour.
//
// Run: DATABASE_URL=... JWT_SECRET=... node --test tests/inventory.reconcile.test.js
// Skips (never passes silently) when no database is configured.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dbReady, createTenant, deleteTenant, startServer, client } = require('./helpers/decisionHarness');
const { deleteSupplierDelayData } = require('./fixtures/supplierDelay');

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
      await env.pool.query('DELETE FROM bank_transactions WHERE user_id = $1', [t.id]).catch(() => {});
      await deleteSupplierDelayData(env.pool, t.id).catch(() => {});
      await deleteTenant(env.pool, t.id).catch(() => {});
    }
    await env.pool.end();
  }
});

async function tenant(label) {
  const user = await createTenant(env.pool, `reconcile-${label}`);
  tenants.push(user);
  return { user, api: client(server.base, user) };
}

// The reconcile runs at most once per tenant per 5 minutes per process, so
// "the owner opens the app again later" is a fresh server process.
async function reopenApp(user) {
  await server.stop();
  server = await startServer({ FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED: 'false' });
  await waitUntilUp(server);
  const api = client(server.base, user);
  await openApp(api);
  return api;
}

// startServer gives up quietly after 30 s; under a loaded full-suite run a
// restarted server can take longer, so wait for it explicitly.
async function waitUntilUp(srv) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${srv.base}/api/health`)).status < 500) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not come up:\n${srv.log().slice(-1500)}`);
}

async function openApp(api) {
  const me = await api.get('/api/auth/me');
  assert.equal(me.status, 200, JSON.stringify(me.body));
  await new Promise((r) => setTimeout(r, 1500)); // reconcile runs in the background
}

const stockOf = async (userId) => Object.fromEntries((await env.pool.query(
  'SELECT name, current_stock::float AS s FROM products WHERE user_id = $1', [userId])).rows.map((r) => [r.name, r.s]));

test('stock with no movement behind it survives opening the app, and later movements count from it', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const { user, api } = await tenant('opening');

  // Typed straight into the table (an import, an older client) and through
  // the products form.
  await env.pool.query(`INSERT INTO products (user_id, name, unit, current_stock) VALUES ($1, 'Imported Bolt', 'pcs', 40)`, [user.id]);
  const created = await api.post('/api/products', { name: 'Brake Cable', current_stock: 10 });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const legacyId = (await env.pool.query(`SELECT id FROM products WHERE user_id = $1 AND name = 'Imported Bolt'`, [user.id])).rows[0].id;

  // A sale of 3 bolts before any reconcile has ever run for them.
  const move = await api.post('/api/stock/move', { product_id: legacyId, movement_type: 'out', quantity: 3, reference: 'SALE-1' });
  assert.equal(move.status, 200, JSON.stringify(move.body));

  await openApp(api);
  assert.deepEqual(await stockOf(user.id), { 'Imported Bolt': 37, 'Brake Cable': 10 });

  const opening = await env.pool.query(`SELECT reference, quantity::float AS q FROM stock_movements WHERE user_id = $1 AND reference LIKE 'OPENING-%' ORDER BY q`, [user.id]);
  assert.deepEqual(opening.rows.map((r) => r.q), [10, 40], 'each opening balance is in the ledger exactly once');

  // Opening the app again changes nothing and records nothing new.
  const before = (await env.pool.query('SELECT COUNT(*)::int AS n FROM stock_movements WHERE user_id = $1', [user.id])).rows[0].n;
  await reopenApp(user);
  const after = (await env.pool.query('SELECT COUNT(*)::int AS n FROM stock_movements WHERE user_id = $1', [user.id])).rows[0].n;
  assert.equal(after, before, 'no duplicate movements');
  assert.deepEqual(await stockOf(user.id), { 'Imported Bolt': 37, 'Brake Cable': 10 });
});

test('an open purchase order books nothing into stock; received lines book what was received', async (t) => {
  if (!env.ok) return t.skip(`no database: ${env.reason}`);
  const { user, api } = await tenant('po');
  const frame = (await env.pool.query(`INSERT INTO products (user_id, name, unit, current_stock) VALUES ($1, 'Frame', 'pcs', 10) RETURNING id`, [user.id])).rows[0].id;
  const po = (await env.pool.query(
    `INSERT INTO purchases (user_id, supplier_name, amount, status, purchase_date, bill_number, items, notes)
     VALUES ($1, 'Shenzhen Frame Co', 165000, 'unpaid', CURRENT_DATE, 'PO-1', $2::jsonb, 'Open PO') RETURNING id`,
    [user.id, JSON.stringify([{ description: 'Frame', qty: 50, price: 3300 }])])).rows[0].id;
  const line = (await env.pool.query(
    `INSERT INTO purchase_line_items (user_id, purchase_id, product_id, quantity, unit_price, expected_at) VALUES ($1,$2,$3,50,3300, now() + interval '4 days') RETURNING id`,
    [user.id, po, frame])).rows[0].id;
  // A plain bill with no tracked lines: the legacy behaviour still books it.
  await env.pool.query(
    `INSERT INTO purchases (user_id, supplier_name, amount, status, purchase_date, bill_number, items) VALUES ($1, 'Local Hardware', 400, 'paid', CURRENT_DATE, 'BILL-2', $2::jsonb)`,
    [user.id, JSON.stringify([{ description: 'Frame', qty: 2, price: 200 }])]);

  await openApp(api);
  assert.deepEqual(await stockOf(user.id), { Frame: 12 }, '10 on hand + 2 from the plain bill; the 50 inbound frames are not in stock');
  const fromPo = await env.pool.query(`SELECT 1 FROM stock_movements WHERE user_id = $1 AND reference IN ('PO-1', $2)`, [user.id, `PLI-${line}`]);
  assert.equal(fromPo.rows.length, 0, 'nothing booked from the open purchase order');

  // 20 frames arrive. The next time the app opens they are booked, once.
  await env.pool.query(`UPDATE purchase_line_items SET received_quantity = 20, received_at = now() WHERE id = $1`, [line]);
  await reopenApp(user);
  assert.deepEqual(await stockOf(user.id), { Frame: 32 });
  await reopenApp(user);
  assert.deepEqual(await stockOf(user.id), { Frame: 32 }, 'idempotent');
});
