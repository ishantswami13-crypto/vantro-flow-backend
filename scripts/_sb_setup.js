'use strict';
// One-shot: drop stale CI-schema tables, apply minimal base, run migrations 001-005, seed data.
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref   = process.env.SB_REF;
const ROOT  = 'I:/Vantro/vantro-flow-backend';

const OWNER_A = '11111111-1111-1111-1111-111111111111';
const OWNER_B = '22222222-2222-2222-2222-222222222222';
const CUST_A  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CUST_B  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function sqlApi(query) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ query });
    const opts = { hostname: 'api.supabase.com',
      path: '/v1/projects/' + ref + '/database/query', method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload) } };
    const r = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject); r.write(payload); r.end();
  });
}

async function runSQL(label, sql) {
  const r = await sqlApi(sql);
  if (r.status === 200 || r.status === 201) { console.log('  OK:', label); return; }
  let msg; try { msg = JSON.parse(r.body)?.message || r.body.slice(0, 400); } catch { msg = r.body.slice(0, 400); }
  throw new Error('FAILED [' + label + ']: ' + msg);
}

async function main() {
  // Step 0: Drop stale CI-schema tables that were created with wrong/simplified columns.
  // These were created by sqlx-test-schema.sql (CI-only schema, not production migrations).
  // Migration 001 needs to create them with the full Cortex column set.
  console.log('[0/3] Dropping stale CI-schema tables...');
  await runSQL('drop stale tables', `
    DROP TABLE IF EXISTS ai_actions   CASCADE;
    DROP TABLE IF EXISTS promises     CASCADE;
    DROP TABLE IF EXISTS call_logs    CASCADE;
    DROP TABLE IF EXISTS customers    CASCADE;
    DROP TABLE IF EXISTS products     CASCADE;
    DROP TABLE IF EXISTS purchases    CASCADE;
    DROP TABLE IF EXISTS invoices     CASCADE;
    DROP TABLE IF EXISTS suppliers    CASCADE;
  `);

  // Step 1: Apply minimal Supabase base (FK targets only — no Cortex tables)
  console.log('[1/3] Applying minimal base (FK targets only)...');
  await runSQL('supabase-staging-base.sql', fs.readFileSync(ROOT + '/db/supabase-staging-base.sql', 'utf8'));

  // Step 2: Apply migrations 001-005
  console.log('[2/3] Applying migrations...');
  const migrations = [
    ['001 cortex foundation',   '001_cortex_foundation.sql'],
    ['002 cortex extension',    '002_cortex_extension.sql'],
    ['003 evaluation',          '003_evaluation.sql'],
    ['004 schema repair',       '004_schema_repair.sql'],
    ['005 cortex x extensions', '005_cortex_x_extensions.sql'],
  ];
  for (const [label, file] of migrations) {
    await runSQL(label, fs.readFileSync(path.join(ROOT, 'migrations', file), 'utf8'));
  }

  // Step 3: Seed harness data
  console.log('[3/3] Seeding harness data...');
  const SEED = `
    INSERT INTO users (id, email) VALUES
      ('${OWNER_A}', 'ownerA@harness.test'),
      ('${OWNER_B}', 'ownerB@harness.test')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO customers (id, user_id, name, phone, credit_limit, advance_required) VALUES
      ('${CUST_A}', '${OWNER_A}', 'Risky Traders (node-staging)', '9990001111', 100000, false),
      ('${CUST_B}', '${OWNER_B}', 'Other Biz (node-staging)',     '8880002222',  50000, false)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO invoices (user_id, customer_id, invoice_amount, total_amount, amount_paid, payment_status, days_overdue, due_date) VALUES
      ('${OWNER_A}', '${CUST_A}', 40000, 40000, 0, 'Overdue', 21, '2026-05-01'),
      ('${OWNER_A}', '${CUST_A}', 32000, 32000, 0, 'Pending',  0, '2026-07-15'),
      ('${OWNER_B}', '${CUST_B}',  5000,  5000, 0, 'Pending',  0, '2026-08-10');

    INSERT INTO promises (user_id, customer_id, status, promised_date) VALUES
      ('${OWNER_A}', '${CUST_A}', 'broken', '2026-05-10'),
      ('${OWNER_A}', '${CUST_A}', 'broken', '2026-05-15'),
      ('${OWNER_A}', '${CUST_A}', 'kept',   '2026-05-20');

    INSERT INTO call_logs (user_id, customer_id, did_pick_up) VALUES
      ('${OWNER_A}', '${CUST_A}', true),
      ('${OWNER_A}', '${CUST_A}', false);

    INSERT INTO products (user_id, name, current_stock, low_stock_alert) VALUES
      ('${OWNER_A}', 'Widget (node-staging)', 2, 10);

    INSERT INTO purchases (user_id) VALUES ('${OWNER_A}');

    INSERT INTO ai_actions (user_id, customer_id, action_type, title, priority, status, suggested_by, risk_level) VALUES
      ('${OWNER_A}', '${CUST_A}', 'SEND_FIRM_REMINDER',
       'Chase Risky Traders — 21d overdue (node-staging)', 'high', 'pending', 'rule', 'high');
  `;
  await runSQL('harness seed data', SEED);

  // Verify row counts
  const counts = await sqlApi(`
    SELECT
      (SELECT COUNT(*) FROM users     WHERE id = '${OWNER_A}') AS u,
      (SELECT COUNT(*) FROM customers WHERE user_id = '${OWNER_A}') AS c,
      (SELECT COUNT(*) FROM invoices  WHERE user_id = '${OWNER_A}') AS i,
      (SELECT COUNT(*) FROM promises  WHERE user_id = '${OWNER_A}') AS p,
      (SELECT COUNT(*) FROM ai_actions WHERE user_id = '${OWNER_A}') AS a
  `);
  const row = JSON.parse(counts.body)[0];
  console.log(`  Verification: users=${row.u} customers=${row.c} invoices=${row.i} promises=${row.p} ai_actions=${row.a}`);

  console.log('\n[done] Supabase non-prod setup complete!');
  console.log('  Project: https://' + ref + '.supabase.co');
  console.log('  Test owner_id:', OWNER_A);
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
