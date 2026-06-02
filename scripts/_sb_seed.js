'use strict';
const https = require('https');
const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref   = process.env.SB_REF;

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

async function run(label, sql) {
  const r = await sqlApi(sql);
  if (r.status === 200 || r.status === 201) { console.log('  OK:', label); return JSON.parse(r.body); }
  let msg; try { msg = JSON.parse(r.body)?.message || r.body.slice(0, 300); } catch { msg = r.body.slice(0, 300); }
  throw new Error('FAILED [' + label + ']: ' + msg);
}

async function main() {
  console.log('[seed] Seeding non-prod Supabase (project:', ref, ')');

  await run('users',
    `INSERT INTO users(id,email) VALUES
       ('${OWNER_A}','ownerA@harness.test'),
       ('${OWNER_B}','ownerB@harness.test')
     ON CONFLICT(id) DO NOTHING`);

  await run('customers',
    `INSERT INTO customers(id,user_id,name,phone,credit_limit,advance_required) VALUES
       ('${CUST_A}','${OWNER_A}','Risky Traders (node-staging)','9990001111',100000,false),
       ('${CUST_B}','${OWNER_B}','Other Biz (node-staging)',    '8880002222', 50000,false)
     ON CONFLICT(id) DO NOTHING`);

  // customer_id omitted — not in minimal base schema; Node bootstrap doesn't query it
  await run('invoices',
    `INSERT INTO invoices(user_id,invoice_amount,total_amount,amount_paid,payment_status,days_overdue,due_date) VALUES
       ('${OWNER_A}',40000,40000,0,'Overdue',21,'2026-05-01'),
       ('${OWNER_A}',32000,32000,0,'Pending', 0,'2026-07-15'),
       ('${OWNER_B}', 5000, 5000,0,'Pending', 0,'2026-08-10')`);

  await run('promises',
    `INSERT INTO promises(user_id,customer_id,status,promised_date) VALUES
       ('${OWNER_A}','${CUST_A}','broken','2026-05-10'),
       ('${OWNER_A}','${CUST_A}','broken','2026-05-15'),
       ('${OWNER_A}','${CUST_A}','kept',  '2026-05-20')`);

  // customer_id omitted — not in minimal base schema; Node bootstrap doesn't query call_logs
  await run('call_logs',
    `INSERT INTO call_logs(user_id,did_pick_up) VALUES
       ('${OWNER_A}',true),
       ('${OWNER_A}',false)`);

  await run('products',
    `INSERT INTO products(user_id,name,current_stock,low_stock_alert) VALUES
       ('${OWNER_A}','Widget (node-staging)',2,10)`);

  await run('purchases',
    `INSERT INTO purchases(user_id) VALUES ('${OWNER_A}')`);

  await run('ai_actions',
    `INSERT INTO ai_actions(user_id,customer_id,action_type,title,priority,status,suggested_by,risk_level) VALUES
       ('${OWNER_A}','${CUST_A}','SEND_FIRM_REMINDER',
        'Chase Risky Traders 21d overdue (node-staging)','high','pending','rule','high')`);

  const v = await run('verify row counts',
    `SELECT
       (SELECT COUNT(*) FROM invoices   WHERE user_id='${OWNER_A}') AS invoices,
       (SELECT COUNT(*) FROM promises   WHERE user_id='${OWNER_A}') AS promises,
       (SELECT COUNT(*) FROM products   WHERE user_id='${OWNER_A}') AS products,
       (SELECT COUNT(*) FROM purchases  WHERE user_id='${OWNER_A}') AS purchases,
       (SELECT COUNT(*) FROM ai_actions WHERE user_id='${OWNER_A}') AS ai_actions,
       (SELECT COUNT(*) FROM call_logs  WHERE user_id='${OWNER_A}') AS call_logs`);

  console.log('  Verification:', JSON.stringify(v[0]));
  console.log('\n[seed] Complete! Test owner_id:', OWNER_A);
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
