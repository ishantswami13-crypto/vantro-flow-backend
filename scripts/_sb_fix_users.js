'use strict';
const https = require('https');
const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref   = process.env.SB_REF;

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

async function main() {
  // Check current users columns
  const cur = await sqlApi(
    "SELECT column_name FROM information_schema.columns WHERE table_name='users' AND table_schema='public' ORDER BY ordinal_position"
  );
  const cols = JSON.parse(cur.body).map(c => c.column_name);
  console.log('Current users columns:', cols.join(', '));

  // Add all missing columns that server.js references in coreColumns and fullColumns
  const alter = await sqlApi(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS phone            TEXT,
      ADD COLUMN IF NOT EXISTS business_name    TEXT,
      ADD COLUMN IF NOT EXISTS plan             TEXT DEFAULT 'free',
      ADD COLUMN IF NOT EXISTS gstin            TEXT,
      ADD COLUMN IF NOT EXISTS industry         TEXT,
      ADD COLUMN IF NOT EXISTS business_size    TEXT,
      ADD COLUMN IF NOT EXISTS gst_registered   BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS has_workers      BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS owner_name       TEXT,
      ADD COLUMN IF NOT EXISTS city             TEXT,
      ADD COLUMN IF NOT EXISTS onboarding_done  BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS name             TEXT,
      ADD COLUMN IF NOT EXISTS password         TEXT
  `);
  if (alter.status === 200 || alter.status === 201) {
    console.log('ALTER TABLE users: OK');
  } else {
    const msg = JSON.parse(alter.body)?.message || alter.body.slice(0, 200);
    throw new Error('ALTER failed: ' + msg);
  }

  // Verify
  const check = await sqlApi(
    "SELECT column_name FROM information_schema.columns WHERE table_name='users' AND table_schema='public' ORDER BY ordinal_position"
  );
  const newCols = JSON.parse(check.body).map(c => c.column_name);
  console.log('Updated columns:', newCols.join(', '));
  console.log('users table ready for /api/auth/me');
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
