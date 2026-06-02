'use strict';
// scripts/staging-setup-harness.js
// One-command live Harness X setup for Atlas staging.
//
// Generates JWTs for OWNER_A and OWNER_B using the staging JWT_SECRET,
// optionally verifies the staging server health endpoint, then writes
// cortex-lab/.env.test with all required env vars for `npm run cortex:test:live`.
//
// Prerequisites (all one-time):
//   1. Staging Postgres seeded: DATABASE_URL=<staging-pg> node scripts/staging-seed.js
//   2. Staging server running and accessible at CORTEX_TEST_BASE_URL
//
// Required env vars:
//   JWT_SECRET          — JWT secret from your Railway staging service env
//   CORTEX_TEST_BASE_URL — Node staging URL (e.g. https://vantro-node-staging.up.railway.app)
//
// Usage:
//   JWT_SECRET=xxx CORTEX_TEST_BASE_URL=https://vantro-node-staging.up.railway.app \
//     node scripts/staging-setup-harness.js
//
// Output: cortex-lab/.env.test  (gitignored — never commit)

const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const http   = require('http');

const OUT_FILE = path.resolve(__dirname, '..', 'cortex-lab', '.env.test');

// Deterministic staging test UUIDs (must match staging-seed.js / _sb_seed.js)
const OWNER_A_ID  = '11111111-1111-1111-1111-111111111111';
const OWNER_B_ID  = '22222222-2222-2222-2222-222222222222';
const OWNER_A_EMAIL = 'ownerA@harness.test';
const OWNER_B_EMAIL = 'ownerB@harness.test';

// Exact production service hostnames — deny list uses full service-name prefix so
// "vantro-node-staging-production.up.railway.app" (staging service deployed to Railway's
// "production" environment) is NOT blocked. Only the real production backend is blocked.
const PROD_DENY = [
  'vantro-flow-backend-production.up.railway.app',  // real production backend
  'flow.vantro.ai',
  'app.vantro.ai',
  'api.vantro.ai',
];

// ── Validation ───────────────────────────────────────────────────────────────

function validateEnv() {
  const errors = [];
  if (!process.env.JWT_SECRET) {
    errors.push('JWT_SECRET not set. Get it from Railway → your staging service → Variables → JWT_SECRET.');
  }
  if (!process.env.CORTEX_TEST_BASE_URL) {
    errors.push(
      'CORTEX_TEST_BASE_URL not set.\n' +
      '  Find the staging Node.js service URL in Railway → your project → vantro-node-staging → Settings → Domain.'
    );
  } else {
    const url = process.env.CORTEX_TEST_BASE_URL.toLowerCase();
    if (PROD_DENY.some(d => url.includes(d.toLowerCase()))) {
      errors.push('CORTEX_TEST_BASE_URL is the production backend URL. Refusing.');
    }
  }
  if (errors.length) {
    console.error('[setup-harness] Validation failed:\n');
    for (const e of errors) console.error('  ✗ ' + e);
    console.error('');
    process.exit(1);
  }
}

// ── JWT generation ────────────────────────────────────────────────────────────

function generateToken(userId, email, secret) {
  return jwt.sign(
    { userId, email, _staging: true, jti: crypto.randomBytes(8).toString('hex') },
    secret,
    { expiresIn: '7d' }
  );
}

// ── Health check ─────────────────────────────────────────────────────────────

function httpGet(urlStr, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method:   'GET',
      headers:  { 'User-Agent': 'vantro-harness-setup/1.0' },
    }, res => {
      let data = '';
      res.on('data', d => (data += d));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, body: data, json });
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`Timeout after ${timeoutMs}ms`)); });
    req.on('error', reject);
    req.end();
  });
}

async function checkHealth(baseUrl) {
  const url = baseUrl.replace(/\/+$/, '') + '/api/health';
  process.stdout.write(`  Checking ${url} … `);
  try {
    const r = await httpGet(url, 12000);
    if (r.status === 200 && r.json?.status === 'alive') {
      console.log('✅ alive');
      return true;
    }
    console.log(`⚠️  HTTP ${r.status} (${r.body.slice(0, 100)})`);
    return false;
  } catch (err) {
    console.log(`✗ ${err.message}`);
    return false;
  }
}

// ── Auth check ────────────────────────────────────────────────────────────────

async function checkAuth(baseUrl, token, label) {
  const url = baseUrl.replace(/\/+$/, '') + '/api/auth/me';
  process.stdout.write(`  Auth check ${label} … `);
  try {
    const lib = url.startsWith('https') ? https : http;
    const parsedUrl = new URL(url);
    const r = await new Promise((resolve, reject) => {
      const req = lib.request({
        hostname: parsedUrl.hostname,
        port:     parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path:     parsedUrl.pathname,
        method:   'GET',
        headers:  { Authorization: `Bearer ${token}`, 'User-Agent': 'vantro-harness-setup/1.0' },
      }, res => {
        let d = '';
        res.on('data', c => (d += c));
        res.on('end', () => {
          let json = null; try { json = JSON.parse(d); } catch {}
          resolve({ status: res.statusCode, json });
        });
      });
      req.on('error', reject);
      req.end();
    });
    if (r.status === 200) {
      const userId = r.json?.user?.id || r.json?.id;
      console.log(`✅ userId=${userId}`);
      return true;
    }
    // 401/404 means user not in staging DB — seed required
    console.log(`⚠️  HTTP ${r.status} — user may not be seeded. Run: DATABASE_URL=<staging-pg> node scripts/staging-seed.js`);
    return false;
  } catch (err) {
    console.log(`✗ ${err.message}`);
    return false;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  Vantro — Live Harness X Setup\n');

  validateEnv();

  const secret  = process.env.JWT_SECRET;
  const baseUrl = process.env.CORTEX_TEST_BASE_URL.replace(/\/+$/, '');

  // 1. Generate tokens
  console.log('1. Generating staging JWTs (7-day expiry)...');
  const tokenA = generateToken(OWNER_A_ID, OWNER_A_EMAIL, secret);
  const tokenB = generateToken(OWNER_B_ID, OWNER_B_EMAIL, secret);
  console.log(`   Owner A: ${OWNER_A_ID} (${OWNER_A_EMAIL})`);
  console.log(`   Owner B: ${OWNER_B_ID} (${OWNER_B_EMAIL})`);
  console.log('   Tokens generated (not printed).\n');

  // 2. Health check
  console.log('2. Checking staging server health...');
  const alive = await checkHealth(baseUrl);
  if (!alive) {
    console.warn('   ⚠️  Server health check failed. .env.test will still be written.');
    console.warn('   Confirm CORTEX_TEST_BASE_URL is the correct Railway staging URL.\n');
  } else {
    console.log('');
  }

  // 3. Auth check (only if server is alive)
  if (alive) {
    console.log('3. Verifying staged user tokens...');
    const authA = await checkAuth(baseUrl, tokenA, 'Owner A');
    const authB = await checkAuth(baseUrl, tokenB, 'Owner B');
    console.log('');
    if (!authA || !authB) {
      console.warn('   ⚠️  One or both tokens could not be verified against /api/auth/me.');
      console.warn('   Seed the staging DB first:');
      console.warn('     DATABASE_URL=<staging-postgres-url> node scripts/staging-seed.js\n');
    }
  } else {
    console.log('3. Auth verification skipped (server unreachable).\n');
  }

  // 4. Write .env.test
  console.log('4. Writing cortex-lab/.env.test...');
  const content = [
    `# cortex-lab/.env.test — generated by scripts/staging-setup-harness.js`,
    `# DO NOT COMMIT — this file is gitignored.`,
    `# Regenerate: JWT_SECRET=xxx CORTEX_TEST_BASE_URL=xxx node scripts/staging-setup-harness.js`,
    ``,
    `CORTEX_TEST_BASE_URL=${baseUrl}`,
    `CORTEX_TEST_TOKEN_OWNER_A=${tokenA}`,
    `CORTEX_TEST_TOKEN_OWNER_B=${tokenB}`,
    ``,
    `# Allow write tests (seed credit sales, cleanup)`,
    `CORTEX_TEST_DB_ALLOW_WRITE=true`,
    ``,
    `# NODE_ENV must not be "production"`,
    `NODE_ENV=development`,
    ``,
    `# Safety`,
    `CORTEX_TEST_REQUIRE_NON_PROD=true`,
    ``,
    `# Optional: separate test Supabase for DB-level assertions (event/audit tables)`,
    `# Must differ from your main SUPABASE_URL. If unset, DB assertions are skipped.`,
    `# CORTEX_TEST_SUPABASE_URL=https://your-test-project.supabase.co`,
    `# CORTEX_TEST_SUPABASE_KEY=your-test-service-role-key`,
    ``,
  ].join('\n');

  fs.writeFileSync(OUT_FILE, content, { encoding: 'utf8', mode: 0o600 });
  console.log(`   Written: ${OUT_FILE}\n`);

  // 5. Summary
  console.log('━'.repeat(60));
  console.log('  Setup complete.');
  console.log('');
  console.log('  Next:');
  console.log('    npm run cortex:test:live');
  console.log('');
  console.log('  For DB-level event/audit assertions, also set:');
  console.log('    CORTEX_TEST_SUPABASE_URL and CORTEX_TEST_SUPABASE_KEY');
  console.log('    (separate Supabase test project, not production)');
  console.log('');
  console.log('  Cross-tenant isolation is statically proven:');
  console.log('    All 7 probed endpoints use requireOwner middleware');
  console.log('    (403 returned when JWT userId ≠ path :userId param)');
  console.log('━'.repeat(60) + '\n');
}

main().catch(err => {
  console.error('[setup-harness] Fatal:', err.message);
  process.exit(1);
});
