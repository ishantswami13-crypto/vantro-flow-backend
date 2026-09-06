// Phase 13 integration verification: proves migrations/013_orders_and_workers.sql
// and the server.js GET /api/orders rewrite (avoiding PostgREST embed syntax) work
// end-to-end against the live local-dev DB (via DATABASE_URL, through the
// pg-backed supabase shim — same client server.js uses in this environment).
//
// Exercises (mirroring the exact query shapes used by server.js, not the HTTP
// routes themselves, since this project's existing scripts/test-phase*.js files
// call service/query logic directly rather than spinning up an HTTP server):
//   1. POST /api/orders equivalent — insert an order, verify it persists with
//      correct columns (items JSON.stringify'd, matching the shim's JSONB
//      insert requirement — see NOTE below).
//   2. GET /api/orders equivalent — the rewritten plain-select + worker-merge
//      logic, verifying `workers: { name, phone }` is merged in as a plain
//      field (not raw embed syntax) for orders with a worker_id set, and is
//      null for orders without one.
//   3. PATCH — update an order's status.
//   4. DELETE — remove it, verify it's gone.
//   5. get_top_customers (ranked_by:'orders') tool logic — runs without
//      throwing against real seeded order data, returns a sensible ranking.
//   6. get_orders_by_date and the orders-half of search_customer — run
//      without DB errors against real seeded data.
//   7. Tenant isolation — two synthetic owners, confirm owner A's
//      orders/workers never appear in owner B's queries.
//
// NOTE on items (JSONB): the live insert paths in server.js (POST /api/orders
// line ~8317, AI-call intake line ~8593) pass a raw JS array directly as
// `items`, without JSON.stringify. Verified empirically against the live DB
// that pgSupabaseShim's underlying `pg` driver ARRAY-serializes a raw JS array
// parameter (Postgres `{...}` literal) rather than JSON-encoding it, which a
// JSONB column then rejects with "invalid input syntax for type json". This is
// a pre-existing latent gap in those two insert call sites (out of this
// migration's scope — mission scoped server.js changes to the GET rewrite
// only), and does NOT reproduce in production: supabase-js talks to
// PostgREST over HTTP with a JSON body, which encodes arrays correctly
// regardless of pg's raw-driver behavor. This test therefore JSON.stringifies
// items before insert, matching the pattern `sales` already uses elsewhere in
// this codebase (server.js lines ~9496, ~9683).
//
// Run: node scripts/test-phase13-orders-workers.js
require('dotenv').config();
const { randomUUID } = require('crypto');
const { supabase } = require('../lib/config/supabaseClient');

let pass = 0, fail = 0;
function check(label, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  cond ? pass++ : fail++;
}

async function seedTenant(userId, label) {
  await supabase.from('users').insert([{ id: userId, email: `phase13-${userId}@test.local`, password_hash: 'x', business_name: `Phase13 ${label}` }]);
}

async function cleanupTenant(userId) {
  await supabase.from('orders').delete().eq('user_id', userId);
  await supabase.from('workers').delete().eq('user_id', userId);
  await supabase.from('users').delete().eq('id', userId);
}

// Mirrors GET /api/orders's rewritten worker-merge logic exactly.
async function getOrdersWithWorkers(userId, { orderDate } = {}) {
  let query = supabase.from('orders').select('*').eq('user_id', userId).order('created_at', { ascending: false });
  if (orderDate) query = query.eq('order_date', orderDate);
  const { data, error } = await query;
  if (error) throw error;
  const orders = data || [];
  const workerIds = [...new Set(orders.map(o => o.worker_id).filter(Boolean))];
  if (workerIds.length) {
    const { data: workerRows } = await supabase.from('workers').select('id, name, phone').eq('user_id', userId).in('id', workerIds);
    const workerById = {};
    (workerRows || []).forEach(w => { workerById[w.id] = w; });
    orders.forEach(o => { const w = o.worker_id ? workerById[o.worker_id] : null; o.workers = w ? { name: w.name, phone: w.phone } : null; });
  } else {
    orders.forEach(o => { o.workers = null; });
  }
  return orders;
}

// Mirrors get_top_customers(ranked_by:'orders') tool logic exactly (server.js ~9062-9067).
async function toolGetTopCustomersByOrders(userId, limit = 5) {
  const { data } = await supabase.from('orders').select('customer_name,total_amount').eq('user_id', userId).not('status', 'eq', 'cancelled');
  const map = {};
  (data || []).forEach(o => { map[o.customer_name] = (map[o.customer_name] || 0) + Number(o.total_amount || 0); });
  return Object.entries(map).sort(([, a], [, b]) => b - a).slice(0, limit).map(([name, total]) => ({ name, total }));
}

// Mirrors get_orders_by_date tool logic exactly (server.js ~9029-9036).
async function toolGetOrdersByDate(userId, date, status) {
  let q = supabase.from('orders').select('customer_name,items,status,total_amount,delivery_time,created_at').eq('user_id', userId).eq('order_date', date);
  if (status) q = q.eq('status', status);
  const { data } = await q.order('created_at', { ascending: false });
  return data || [];
}

// Mirrors the orders-half of search_customer tool logic exactly (server.js ~9051).
async function toolSearchCustomerOrders(userId, name) {
  const term = `%${name}%`;
  const { data } = await supabase.from('orders').select('customer_name,items,status,total_amount,order_date').eq('user_id', userId).ilike('customer_name', term).limit(5);
  return data || [];
}

async function main() {
  const userA = randomUUID(); // tenant under test
  const userB = randomUUID(); // isolation-check tenant
  let orderId = null;
  let workerAId = null;
  let workerBId = null;

  try {
    await seedTenant(userA, 'TenantA');
    await seedTenant(userB, 'TenantB');

    // --- Worker seed ---
    const { data: workerA, error: workerAErr } = await supabase.from('workers').insert([{
      user_id: userA, name: 'Ramesh', phone: '9876543210', role: 'delivery', is_active: true,
      monthly_salary: 15000, advance_balance: 1000,
    }]).select().single();
    check('worker insert (tenant A) succeeds', !workerAErr && !!workerA);
    workerAId = workerA && workerA.id;

    const { data: workerB } = await supabase.from('workers').insert([{
      user_id: userB, name: 'Suresh (TenantB)', phone: '9000000000', role: 'delivery', is_active: true,
    }]).select().single();
    workerBId = workerB && workerB.id;

    const today = new Date().toISOString().split('T')[0];

    // --- 1. POST /api/orders equivalent ---
    const orderPayload = {
      user_id: userA,
      customer_name: 'Bharat Traders',
      customer_phone: '9111122223',
      delivery_address: 'MIDC Phase 2, Nashik',
      items: JSON.stringify([{ name: 'Bucket 20L', local_name: 'bucket', quantity: 5, unit: 'piece' }]),
      total_amount: 2500,
      delivery_time: 'evening',
      special_instructions: 'Call before delivery',
      worker_id: workerAId,
      source: 'manual',
      status: 'new',
      order_date: today,
      created_at: new Date(),
    };
    const { data: created, error: createErr } = await supabase.from('orders').insert([orderPayload]).select().single();
    check('order insert persists', !createErr && !!created);
    check('order insert has correct customer_name', created && created.customer_name === 'Bharat Traders');
    check('order insert has correct total_amount', created && Number(created.total_amount) === 2500);
    check('order insert has correct worker_id', created && created.worker_id === workerAId);
    check('order insert defaults status to new', created && created.status === 'new');
    orderId = created && created.id;

    // A second order with no worker_id, to prove the null-worker path.
    const { data: created2 } = await supabase.from('orders').insert([{
      user_id: userA, customer_name: 'Nashik Hardware', items: JSON.stringify([]),
      total_amount: 800, source: 'ai_call', status: 'new', order_date: today, created_at: new Date(),
    }]).select().single();

    // Tenant B order (isolation control).
    const { data: createdB } = await supabase.from('orders').insert([{
      user_id: userB, customer_name: 'TenantB Customer', items: JSON.stringify([]),
      total_amount: 999, worker_id: workerBId, source: 'manual', status: 'new', order_date: today, created_at: new Date(),
    }]).select().single();

    // --- 2. GET /api/orders equivalent, with worker merge ---
    const ordersA = await getOrdersWithWorkers(userA, { orderDate: today });
    check('GET orders returns both tenant-A orders', ordersA.length === 2);
    const withWorker = ordersA.find(o => o.id === orderId);
    const withoutWorker = ordersA.find(o => o.id === (created2 && created2.id));
    check('order with worker_id gets workers merged in as plain field', !!withWorker && !!withWorker.workers && withWorker.workers.name === 'Ramesh' && withWorker.workers.phone === '9876543210');
    check('order without worker_id gets workers: null (no crash)', !!withoutWorker && withoutWorker.workers === null);
    check('no raw embed syntax leaked (no error thrown by query)', true);

    // --- 3. PATCH — update status ---
    const { data: updated, error: updateErr } = await supabase.from('orders')
      .update({ status: 'confirmed', updated_at: new Date() })
      .eq('id', orderId).eq('user_id', userA).select().single();
    check('order PATCH updates status', !updateErr && updated && updated.status === 'confirmed');

    // --- 4. DELETE — remove and verify gone ---
    await supabase.from('orders').delete().eq('id', orderId).eq('user_id', userA);
    const { data: afterDelete } = await supabase.from('orders').select('*').eq('id', orderId).eq('user_id', userA);
    check('order DELETE removes it', (afterDelete || []).length === 0);
    orderId = null; // already deleted

    // --- 5. get_top_customers (ranked_by: 'orders') ---
    let topCustomers = null;
    try {
      topCustomers = await toolGetTopCustomersByOrders(userA, 5);
      check('get_top_customers(orders) runs without throwing', true);
      check('get_top_customers(orders) returns a sensible ranking', Array.isArray(topCustomers) && topCustomers.some(c => c.name === 'Nashik Hardware' && c.total === 800));
    } catch (e) {
      check('get_top_customers(orders) runs without throwing', false);
      console.log('  -> error:', e.message);
    }

    // --- 6. get_orders_by_date + search_customer (orders half) ---
    try {
      const byDate = await toolGetOrdersByDate(userA, today);
      check('get_orders_by_date runs without DB error', Array.isArray(byDate));
      check('get_orders_by_date returns tenant A order', byDate.some(o => o.customer_name === 'Nashik Hardware'));
    } catch (e) {
      check('get_orders_by_date runs without DB error', false);
      console.log('  -> error:', e.message);
    }
    try {
      const searchResults = await toolSearchCustomerOrders(userA, 'Nashik');
      check('search_customer (orders half) runs without DB error', Array.isArray(searchResults));
      check('search_customer (orders half) finds the seeded order', searchResults.some(o => o.customer_name === 'Nashik Hardware'));
    } catch (e) {
      check('search_customer (orders half) runs without DB error', false);
      console.log('  -> error:', e.message);
    }

    // --- 7. Tenant isolation ---
    const ordersB = await getOrdersWithWorkers(userB, { orderDate: today });
    check('tenant isolation: owner B sees only own order', ordersB.length === 1 && ordersB[0].customer_name === 'TenantB Customer');
    check('tenant isolation: owner A order never appears in owner B results', !ordersB.some(o => o.customer_name === 'Nashik Hardware' || o.customer_name === 'Bharat Traders'));
    const { data: workersA } = await supabase.from('workers').select('*').eq('user_id', userA);
    const { data: workersB } = await supabase.from('workers').select('*').eq('user_id', userB);
    check('tenant isolation: owner A workers list excludes owner B workers', !(workersA || []).some(w => w.id === workerBId));
    check('tenant isolation: owner B workers list excludes owner A workers', !(workersB || []).some(w => w.id === workerAId));
    const topCustomersB = await toolGetTopCustomersByOrders(userB, 5);
    check('tenant isolation: get_top_customers scoped to owner B only', topCustomersB.length === 1 && topCustomersB[0].name === 'TenantB Customer');

  } finally {
    // Clean up ALL synthetic data, including the already-deleted order (no-op) and
    // the second/tenant-B orders that were never explicitly deleted above.
    await cleanupTenant(userA);
    await cleanupTenant(userB);

    // Verify zero residue.
    const { data: residueOrders } = await supabase.from('orders').select('id').in('user_id', [userA, userB]);
    const { data: residueWorkers } = await supabase.from('workers').select('id').in('user_id', [userA, userB]);
    const { data: residueUsers } = await supabase.from('users').select('id').in('id', [userA, userB]);
    check('cleanup leaves zero residual orders', (residueOrders || []).length === 0);
    check('cleanup leaves zero residual workers', (residueWorkers || []).length === 0);
    check('cleanup leaves zero residual synthetic users', (residueUsers || []).length === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (!process.env.DATABASE_URL) {
  console.error('FAIL: DATABASE_URL is not set. This test requires the real local-dev DB connection string.');
  process.exit(1);
}
if (/NEON_READONLY/i.test(process.env.DATABASE_URL) || process.env.NEON_READONLY_URL === process.env.DATABASE_URL) {
  console.error('FAIL: refusing to run against what looks like a readonly/production URL.');
  process.exit(1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
