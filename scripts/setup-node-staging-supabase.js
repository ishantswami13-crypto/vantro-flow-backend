'use strict';
// scripts/setup-node-staging-supabase.js
//
// Step 2 of the Node staging baseline setup (see docs/node-staging-baseline.md).
//
// After you have created a non-prod Supabase project at supabase.com, this
// script verifies that the required tables exist and seeds the harness test
// data that the perf lab needs for Node auth-gated (200) tests.
//
// Run AFTER you have applied migrations 001–005 manually in the Supabase SQL
// editor (paste each file from migrations/ in order).
//
// Usage:
//   SUPABASE_URL=https://xyz.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=eyJhbG... \
//   node scripts/setup-node-staging-supabase.js
//
// RULES:
//   - Never use the production Supabase URL (supabase.co with your project ID).
//   - Never use production service role key.
//   - Never commit secrets.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('[setup-supabase] ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  console.error('  Run: SUPABASE_URL=https://xyz.supabase.co SUPABASE_SERVICE_ROLE_KEY=eyJ... node scripts/setup-node-staging-supabase.js');
  process.exit(1);
}

if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(SUPABASE_URL)) {
  console.warn('[setup-supabase] WARNING: SUPABASE_URL does not match expected format https://<id>.supabase.co');
}

// Block the known production Supabase project ID.
// Replace 'alepdpyqesevldobjxbo' with your production project ID if different.
const PROD_PROJECT_ID = 'alepdpyqesevldobjxbo';
if (SUPABASE_URL.includes(PROD_PROJECT_ID)) {
  console.error('[setup-supabase] BLOCKED: SUPABASE_URL contains the production project ID.');
  console.error('  Use a separate non-prod Supabase project. Never seed harness data into production.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false }
});

// Deterministic harness UUIDs — match staging-seed.js and the perf lab scenarios
const OWNER_A = '11111111-1111-1111-1111-111111111111';
const OWNER_B = '22222222-2222-2222-2222-222222222222';
const CUST_A  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CUST_B  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function checkTable(table) {
  const { error } = await supabase.from(table).select('id').limit(1);
  if (error && error.code === '42P01') return false; // table does not exist
  if (error) throw new Error(`Table check failed for ${table}: ${error.message}`);
  return true;
}

async function run() {
  console.log('[setup-supabase] Verifying non-prod Supabase project...');
  console.log(`  URL: ${SUPABASE_URL.replace(/\/\/[^.]+/, '//***')}`);

  // Verify migrations were applied
  const required = ['users', 'customers', 'invoices', 'purchases', 'products',
                    'ai_actions', 'promises', 'call_logs', 'customers'];
  console.log('\n[setup-supabase] Checking required tables...');
  for (const t of required) {
    const exists = await checkTable(t);
    console.log(`  ${exists ? '✓' : '✗'} ${t}`);
    if (!exists) {
      console.error(`\n[setup-supabase] Table "${t}" missing.`);
      console.error('  Apply migrations first in the Supabase SQL editor:');
      console.error('  db/sqlx-test-schema.sql → then migrations 001–005 in order');
      process.exit(1);
    }
  }

  // Upsert users (auth.users is handled by Supabase Auth; public.users is our app table)
  console.log('\n[setup-supabase] Seeding users...');
  const { error: uErr } = await supabase.from('users').upsert([
    { id: OWNER_A, email: 'ownerA@harness.test', name: 'Owner A (node-staging)' },
    { id: OWNER_B, email: 'ownerB@harness.test', name: 'Owner B (node-staging)' },
  ], { onConflict: 'id' });
  if (uErr) { console.error('[setup-supabase] users error:', uErr.message); process.exit(1); }
  console.log('  2 users: OK');

  // Customers
  console.log('[setup-supabase] Seeding customers...');
  const { error: cErr } = await supabase.from('customers').upsert([
    { id: CUST_A, user_id: OWNER_A, name: 'Risky Traders (node-staging)', phone: '9990001111', credit_limit: 100000, advance_required: false },
    { id: CUST_B, user_id: OWNER_B, name: 'Other Biz (node-staging)',     phone: '8880002222', credit_limit:  50000, advance_required: false },
  ], { onConflict: 'id' });
  if (cErr) { console.error('[setup-supabase] customers error:', cErr.message); process.exit(1); }
  console.log('  2 customers: OK');

  // Invoices
  console.log('[setup-supabase] Seeding invoices...');
  const { error: iErr } = await supabase.from('invoices').insert([
    { user_id: OWNER_A, customer_id: CUST_A, invoice_amount: 40000, total_amount: 40000, amount_paid: 0, payment_status: 'Overdue',  days_overdue: 21, due_date: '2026-05-01' },
    { user_id: OWNER_A, customer_id: CUST_A, invoice_amount: 32000, total_amount: 32000, amount_paid: 0, payment_status: 'Pending',   days_overdue:  0, due_date: '2026-07-15' },
    { user_id: OWNER_B, customer_id: CUST_B, invoice_amount:  5000, total_amount:  5000, amount_paid: 0, payment_status: 'Pending',   days_overdue:  0, due_date: '2026-08-10' },
  ]);
  if (iErr) { console.error('[setup-supabase] invoices error:', iErr.message); process.exit(1); }
  console.log('  3 invoices: OK');

  // Promises (include promised_date — NOT NULL in migration 001)
  console.log('[setup-supabase] Seeding promises...');
  const { error: pErr } = await supabase.from('promises').insert([
    { user_id: OWNER_A, customer_id: CUST_A, status: 'broken', promised_date: '2026-05-10' },
    { user_id: OWNER_A, customer_id: CUST_A, status: 'broken', promised_date: '2026-05-15' },
    { user_id: OWNER_A, customer_id: CUST_A, status: 'kept',   promised_date: '2026-05-20' },
  ]);
  if (pErr) { console.error('[setup-supabase] promises error:', pErr.message); process.exit(1); }
  console.log('  3 promises: OK');

  // Products
  console.log('[setup-supabase] Seeding products...');
  const { error: prodErr } = await supabase.from('products').insert([
    { user_id: OWNER_A, name: 'Widget (node-staging)', current_stock: 2, low_stock_alert: 10 },
  ]);
  if (prodErr) { console.error('[setup-supabase] products error:', prodErr.message); process.exit(1); }
  console.log('  1 product: OK');

  // Purchases
  console.log('[setup-supabase] Seeding purchases...');
  const { error: purErr } = await supabase.from('purchases').insert([{ user_id: OWNER_A }]);
  if (purErr) { console.error('[setup-supabase] purchases error:', purErr.message); process.exit(1); }
  console.log('  1 purchase: OK');

  // AI actions
  console.log('[setup-supabase] Seeding ai_actions...');
  const { error: aErr } = await supabase.from('ai_actions').insert([
    { user_id: OWNER_A, customer_id: CUST_A, action_type: 'SEND_FIRM_REMINDER',
      title: 'Chase Risky Traders — 21d overdue (node-staging)', priority: 'high', status: 'pending', suggested_by: 'rule', risk_level: 'high' },
  ]);
  if (aErr) { console.error('[setup-supabase] ai_actions error:', aErr.message); process.exit(1); }
  console.log('  1 ai_action: OK');

  // Verify row counts
  console.log('\n[setup-supabase] Verification:');
  const checks = [
    ['invoices',   OWNER_A],
    ['promises',   OWNER_A],
    ['products',   OWNER_A],
    ['purchases',  OWNER_A],
    ['ai_actions', OWNER_A],
  ];
  for (const [tbl, uid] of checks) {
    const { count } = await supabase.from(tbl).select('*', { count: 'exact', head: true }).eq('user_id', uid);
    console.log(`  ${tbl}: ${count} row(s) for ownerA`);
  }

  console.log('\n[setup-supabase] Non-prod Supabase seed complete.');
  console.log('  Test owner_id:', OWNER_A);
  console.log('\n  Next: update Railway vantro-node-staging env vars:');
  console.log('    SUPABASE_URL=<this project URL>');
  console.log('    SUPABASE_KEY=<anon key>');
  console.log('    SUPABASE_SERVICE_ROLE_KEY=<service role key>');
  console.log('    DATABASE_URL=postgresql://postgres:<pw>@db.<id>.supabase.co:5432/postgres');
  console.log('\n  Then re-run: npm run perf:test (with PERF_NODE_BASE_URL set)');
  console.log('  Expected: node_auth_baseline_ready: YES');
}

run().catch(err => {
  console.error('[setup-supabase] Fatal:', err.message);
  process.exit(1);
});
