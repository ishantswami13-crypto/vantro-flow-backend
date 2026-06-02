'use strict';
// scripts/apply-rls-supabase.js
// Applies migration 006 (RLS) to the Supabase database via the Management API.
// This script targets Supabase ONLY — the migration uses auth.uid() which is
// Supabase-specific and will fail on plain Postgres (e.g. Railway).
//
// IMPORTANT: Run against a NON-PRODUCTION Supabase project first.
// To get SUPABASE_ACCESS_TOKEN: https://supabase.com/dashboard/account/tokens
//
// Usage (shadow / non-prod project):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx SB_PROJECT_REF=your-ref \
//     node scripts/apply-rls-supabase.js
//
// Usage (PRODUCTION — confirm with flag):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx SB_PROJECT_REF=your-prod-ref \
//     CONFIRM_PRODUCTION=I-UNDERSTAND node scripts/apply-rls-supabase.js
//
// After applying, smoke-test in Supabase SQL Editor:
//   SET ROLE anon;
//   SELECT count(*) FROM ai_actions; -- must return 0 (no auth.uid() → blocked)
//   RESET ROLE;

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const TOKEN    = process.env.SUPABASE_ACCESS_TOKEN;
const REF      = process.env.SB_PROJECT_REF;
const CONFIRM  = process.env.CONFIRM_PRODUCTION;

const PROD_REFS = ['alepdpyqesevldobjxbo']; // production Supabase project ref

if (!TOKEN || !REF) {
  console.error(
    'Usage: SUPABASE_ACCESS_TOKEN=sbp_xxx SB_PROJECT_REF=your-ref \\\n' +
    '  node scripts/apply-rls-supabase.js\n\n' +
    'Get your access token at: https://supabase.com/dashboard/account/tokens\n' +
    'Get your project ref from: Supabase Dashboard → Settings → General → Reference ID'
  );
  process.exit(1);
}

if (PROD_REFS.includes(REF) && CONFIRM !== 'I-UNDERSTAND') {
  console.error(
    `BLOCKED: SB_PROJECT_REF=${REF} is the production Supabase project.\n` +
    `If you truly intend to apply RLS to production, set:\n` +
    `  CONFIRM_PRODUCTION=I-UNDERSTAND\n\n` +
    `Recommendation: apply to a shadow/staging Supabase project first, verify,\n` +
    `then apply to production with the CONFIRM_PRODUCTION flag.`
  );
  process.exit(1);
}

const RLS_SQL_PATH = path.resolve(__dirname, '..', 'migrations', '006_cortex_rls.sql');

function postSql(sql) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ query: sql });
    const req = https.request({
      hostname: 'api.supabase.com',
      path:     `/v1/projects/${REF}/database/query`,
      method:   'POST',
      headers:  {
        Authorization:  `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let data = '';
      res.on('data', d => (data += d));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, body: data, json });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  console.log('\n  Vantro — Apply RLS Migration 006 to Supabase\n');
  console.log(`  Project: ${REF}`);
  if (PROD_REFS.includes(REF)) {
    console.log('  ⚠️  PRODUCTION project — CONFIRM_PRODUCTION=I-UNDERSTAND is set');
  } else {
    console.log('  Non-production project (safe)');
  }
  console.log('');

  const sql = fs.readFileSync(RLS_SQL_PATH, 'utf8');
  console.log('  Applying 006_cortex_rls.sql via Supabase Management API...');

  let r;
  try {
    r = await postSql(sql);
  } catch (err) {
    console.error('  Fatal network error:', err.message);
    process.exit(1);
  }

  if (r.status === 200 || r.status === 201) {
    console.log('  ✅ Migration applied successfully.\n');
    console.log('  Next — smoke test in Supabase SQL Editor:');
    console.log('    SET ROLE anon;');
    console.log('    SELECT count(*) FROM ai_actions;  -- must return 0');
    console.log('    RESET ROLE;\n');
    console.log('  Then verify the Node backend still works (service role bypasses RLS):');
    console.log('    node scripts/security-smoke-test.js');
    console.log('');
  } else {
    const msg = r.json?.message || r.json?.error || r.body.slice(0, 400);
    console.error(`  ✗ Failed (HTTP ${r.status}): ${msg}`);

    if (r.status === 401) {
      console.error('  → SUPABASE_ACCESS_TOKEN is invalid or expired.');
      console.error('    Get a new token at: https://supabase.com/dashboard/account/tokens');
    } else if (r.status === 403) {
      console.error('  → Insufficient permissions. Use a token with database:write scope.');
    } else if (msg.includes('already exists')) {
      console.log('  → Migration may already be applied (policies already exist). Verify manually.');
    }

    process.exit(1);
  }
}

main().catch(err => {
  console.error('[apply-rls] Fatal:', err.message);
  process.exit(1);
});
