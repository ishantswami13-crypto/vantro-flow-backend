'use strict';
// scripts/staging-seed.js
// Seeds minimal NON-PRODUCTION test data into staging Postgres after migrations.
// Based on db/harness-seed.sql but adapted for the full Cortex schema (migration 001
// adds promised_date DATE NOT NULL on promises — seed must include it).
//
// Idempotent: uses INSERT ... ON CONFLICT DO NOTHING throughout.
// All data is clearly fake (harness.test emails, deterministic UUIDs).
//
// Usage:
//   DATABASE_URL=<staging-postgres-url> node scripts/staging-seed.js

const { Client } = require('pg');

const DB_URL = process.env.DATABASE_URL;

if (!DB_URL) {
  console.error('[staging-seed] ERROR: DATABASE_URL is not set.');
  process.exit(1);
}

if (/supabase\.co/i.test(DB_URL) || /vantro\.in/i.test(DB_URL)) {
  console.error('[staging-seed] BLOCKED: DATABASE_URL looks like production. Aborting.');
  process.exit(1);
}

// Deterministic UUIDs — same across runs, enables idempotent ON CONFLICT DO NOTHING.
// These are test identifiers, clearly labelled.
const OWNER_A    = '11111111-1111-1111-1111-111111111111';
const OWNER_B    = '22222222-2222-2222-2222-222222222222';
const CUST_A     = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CUST_B     = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function run() {
  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    console.log('[staging-seed] Connected to staging Postgres.');

    // ── users ────────────────────────────────────────────────────────────────
    console.log('\n[staging-seed] Seeding users...');
    await client.query(`
      INSERT INTO users (id, email, name) VALUES
        ($1, 'ownerA@harness.test', 'Owner A (staging)'),
        ($2, 'ownerB@harness.test', 'Owner B (staging)')
      ON CONFLICT (id) DO NOTHING
    `, [OWNER_A, OWNER_B]);
    console.log('  2 users: OK');

    // ── customers ────────────────────────────────────────────────────────────
    console.log('[staging-seed] Seeding customers...');
    await client.query(`
      INSERT INTO customers
        (id, user_id, name, phone, credit_limit, advance_required)
      VALUES
        ($1, $2, 'Risky Traders (staging)', '9990001111', 100000, false),
        ($3, $4, 'Other Biz (staging)',     '8880002222',  50000, false)
      ON CONFLICT (id) DO NOTHING
    `, [CUST_A, OWNER_A, CUST_B, OWNER_B]);
    console.log('  2 customers: OK');

    // ── invoices ─────────────────────────────────────────────────────────────
    console.log('[staging-seed] Seeding invoices...');
    await client.query(`
      INSERT INTO invoices
        (user_id, customer_id, invoice_amount, total_amount, amount_paid,
         payment_status, days_overdue, due_date)
      VALUES
        ($1, $2, 40000, 40000, 0, 'Overdue',  21, '2026-05-01'),
        ($1, $2, 32000, 32000, 0, 'Pending',   0, '2026-07-15'),
        ($3, $4,  5000,  5000, 0, 'Pending',   0, '2026-08-10')
    `, [OWNER_A, CUST_A, OWNER_B, CUST_B]);
    console.log('  3 invoices (1 overdue, 2 pending): OK');

    // ── promises ─────────────────────────────────────────────────────────────
    // promised_date DATE NOT NULL added by migration 001 — must be included.
    console.log('[staging-seed] Seeding promises...');
    await client.query(`
      INSERT INTO promises (user_id, customer_id, status, promised_date) VALUES
        ($1, $2, 'broken', '2026-05-10'),
        ($1, $2, 'broken', '2026-05-15'),
        ($1, $2, 'kept',   '2026-05-20')
    `, [OWNER_A, CUST_A]);
    console.log('  3 promises (2 broken, 1 kept): OK');

    // ── call_logs ────────────────────────────────────────────────────────────
    console.log('[staging-seed] Seeding call_logs...');
    await client.query(`
      INSERT INTO call_logs (user_id, customer_id, did_pick_up) VALUES
        ($1, $2, true),
        ($1, $2, false)
    `, [OWNER_A, CUST_A]);
    console.log('  2 call_logs: OK');

    // ── products ─────────────────────────────────────────────────────────────
    console.log('[staging-seed] Seeding products...');
    await client.query(`
      INSERT INTO products (user_id, name, current_stock, low_stock_alert) VALUES
        ($1, 'Widget (staging)', 2, 10)
    `, [OWNER_A]);
    console.log('  1 product (low-stock): OK');

    // ── purchases ────────────────────────────────────────────────────────────
    console.log('[staging-seed] Seeding purchases...');
    await client.query(`
      INSERT INTO purchases (user_id) VALUES ($1)
    `, [OWNER_A]);
    console.log('  1 purchase (today): OK');

    // ── ai_actions ───────────────────────────────────────────────────────────
    console.log('[staging-seed] Seeding ai_actions...');
    await client.query(`
      INSERT INTO ai_actions
        (user_id, customer_id, action_type, title, priority, status, suggested_by, risk_level)
      VALUES
        ($1, $2,
         'SEND_FIRM_REMINDER',
         'Chase Risky Traders — 21 days overdue (staging)',
         'high', 'pending', 'rule', 'high')
    `, [OWNER_A, CUST_A]);
    console.log('  1 ai_action (high priority, pending): OK');

    // ── verify row counts ────────────────────────────────────────────────────
    console.log('\n[staging-seed] Verification:');
    const checks = [
      ['users', OWNER_A],
      ['customers', CUST_A],
    ];
    for (const [tbl, uid] of checks) {
      const r = await client.query(`SELECT COUNT(*) AS n FROM ${tbl} WHERE id = $1`, [uid]);
      console.log(`  ${tbl}: ${r.rows[0].n} row(s) for test ID`);
    }
    const counts = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM invoices  WHERE user_id=$1) AS invoices,
        (SELECT COUNT(*) FROM promises  WHERE user_id=$1) AS promises,
        (SELECT COUNT(*) FROM products  WHERE user_id=$1) AS products,
        (SELECT COUNT(*) FROM purchases WHERE user_id=$1) AS purchases,
        (SELECT COUNT(*) FROM ai_actions WHERE user_id=$1) AS ai_actions,
        (SELECT COUNT(*) FROM call_logs  WHERE user_id=$1) AS call_logs
    `, [OWNER_A]);
    const r = counts.rows[0];
    console.log(`  invoices=${r.invoices} promises=${r.promises} products=${r.products} purchases=${r.purchases} ai_actions=${r.ai_actions} call_logs=${r.call_logs}`);

    console.log('\n[staging-seed] Seed complete. Test owner: ' + OWNER_A);
    console.log('  Next: node scripts/staging-jwt.js');
  } catch (err) {
    console.error('[staging-seed] Fatal:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
