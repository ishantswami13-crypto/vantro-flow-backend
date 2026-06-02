#!/usr/bin/env node
// generate-test-tokens.js — log in two staging test accounts and write
// cortex-lab/.env.test so that `npm run cortex:test:live` has credentials.
//
// Usage:
//   node scripts/generate-test-tokens.js \
//     --base-url https://vantro-flow-backend-staging.up.railway.app \
//     --owner-a harness-a@yourdomain.com:StrongPassword1 \
//     --owner-b harness-b@yourdomain.com:StrongPassword2
//
// Requirements:
//   - Two accounts must already exist on the staging server.
//     Create them via the signup flow (website or curl) + OTP verification.
//   - The staging server must NOT be the production URL.
//
// Output: cortex-lab/.env.test (gitignored)

'use strict';

const https = require('https');
const http  = require('http');
const path  = require('path');
const fs    = require('fs');

const OUTPUT_FILE = path.resolve(__dirname, '..', 'cortex-lab', '.env.test');

const PROD_DENY = [
  'vantro-flow-backend-production',
  'flow.vantro.ai',
  'app.vantro.ai',
  'api.vantro.ai',
];

// ── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { baseUrl: null, ownerA: null, ownerB: null };
  for (let i = 2; i < argv.length; i++) {
    const raw = argv[i];
    if (raw.startsWith('--base-url=')) { a.baseUrl = raw.slice(11); }
    else if (raw === '--base-url' && argv[i + 1]) { a.baseUrl = argv[++i]; }
    else if (raw.startsWith('--owner-a=')) { a.ownerA = raw.slice(10); }
    else if (raw === '--owner-a' && argv[i + 1]) { a.ownerA = argv[++i]; }
    else if (raw.startsWith('--owner-b=')) { a.ownerB = raw.slice(10); }
    else if (raw === '--owner-b' && argv[i + 1]) { a.ownerB = argv[++i]; }
  }
  return a;
}

function splitCred(str) {
  const idx = str.indexOf(':');
  if (idx < 0) return null;
  return { email: str.slice(0, idx).trim(), password: str.slice(idx + 1).trim() };
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function post(baseUrl, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    let url;
    try { url = new URL(pathname, baseUrl); } catch (e) { return reject(e); }

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent':     'vantro-harness-setup/1.0',
      },
    }, res => {
      let data = '';
      res.on('data', d => (data += d));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(data) });
        } catch {
          reject(new Error(`Non-JSON (${res.statusCode}): ${data.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Login logic ──────────────────────────────────────────────────────────────

async function login(baseUrl, email, password, label) {
  process.stdout.write(`  Logging in ${label} (${email}) … `);
  let res;
  try {
    res = await post(baseUrl, '/api/auth/login', { email, password });
  } catch (err) {
    console.error(`NETWORK ERROR: ${err.message}`);
    process.exit(1);
  }

  if (res.status === 200 && res.json.token) {
    console.log(`OK`);
    return res.json.token;
  }

  console.error(`FAILED (HTTP ${res.status})`);
  const msg = res.json?.error || JSON.stringify(res.json);
  console.error(`  → ${msg}`);

  if (res.status === 401) {
    console.error(
      `  Account may not exist or OTP not verified.\n` +
      `  Create the account via POST /api/auth/signup then complete OTP verification,\n` +
      `  then re-run this script.`
    );
  }
  process.exit(1);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  if (!args.baseUrl || !args.ownerA || !args.ownerB) {
    console.error(
      'Usage: node scripts/generate-test-tokens.js \\\n' +
      '  --base-url https://vantro-flow-backend-staging.up.railway.app \\\n' +
      '  --owner-a email@example.com:Password1 \\\n' +
      '  --owner-b email2@example.com:Password2'
    );
    process.exit(1);
  }

  const baseUrl = args.baseUrl.replace(/\/$/, '');

  if (PROD_DENY.some(d => baseUrl.toLowerCase().includes(d.toLowerCase()))) {
    console.error(`ERROR: --base-url looks like a production host. Refusing.`);
    console.error(`  Matched against: ${PROD_DENY.join(', ')}`);
    process.exit(1);
  }
  // "vantro-node-staging-production.up.railway.app" is Railway's staging service URL —
  // "production" is Railway's environment name, not the Vantro production backend.
  // Only block the real production service by its full hostname.
  if (baseUrl.toLowerCase().includes('vantro-flow-backend-production.up.railway.app')) {
    console.error(`ERROR: --base-url is the Vantro production backend. Refusing.`);
    process.exit(1);
  }

  const credA = splitCred(args.ownerA);
  const credB = splitCred(args.ownerB);
  if (!credA) { console.error('ERROR: --owner-a must be EMAIL:PASSWORD'); process.exit(1); }
  if (!credB) { console.error('ERROR: --owner-b must be EMAIL:PASSWORD'); process.exit(1); }

  console.log(`\nVantro Harness X — live mode token setup`);
  console.log(`Target: ${baseUrl}\n`);

  const tokenA = await login(baseUrl, credA.email, credA.password, 'Owner A');
  const tokenB = await login(baseUrl, credB.email, credB.password, 'Owner B');

  const content = [
    `# cortex-lab/.env.test — generated by scripts/generate-test-tokens.js`,
    `# DO NOT COMMIT. This file is gitignored.`,
    `# Regenerate with: node scripts/generate-test-tokens.js --base-url ... --owner-a ... --owner-b ...`,
    ``,
    `CORTEX_TEST_BASE_URL=${baseUrl}`,
    `CORTEX_TEST_TOKEN_OWNER_A=${tokenA}`,
    `CORTEX_TEST_TOKEN_OWNER_B=${tokenB}`,
    ``,
    `# Required to allow write tests (seed credit sales, cleanup)`,
    `CORTEX_TEST_DB_ALLOW_WRITE=true`,
    ``,
    `# Optional: separate test Supabase for DB-level event/audit verification`,
    `# Must be a DIFFERENT project from your main SUPABASE_URL.`,
    `# If unset, live mode skips DB-level assertions (auth + cross-tenant probes still run).`,
    `# CORTEX_TEST_SUPABASE_URL=https://your-test-project.supabase.co`,
    `# CORTEX_TEST_SUPABASE_KEY=your-test-service-role-key`,
    ``,
    `# Safety: never run live mode against production`,
    `CORTEX_TEST_REQUIRE_NON_PROD=true`,
    ``,
    `# NODE_ENV must NOT be "production" for live mode`,
    `NODE_ENV=development`,
    ``,
  ].join('\n');

  fs.writeFileSync(OUTPUT_FILE, content, 'utf8');

  console.log(`\nWritten to: ${OUTPUT_FILE}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Run:  npm run cortex:test:live`);
  console.log(`  2. Check cortex-lab/reports/latest.md for results`);
  console.log(`  3. If 'db client unavailable' warnings appear, set CORTEX_TEST_SUPABASE_URL/KEY`);
  console.log(`     (optional — auth + cross-tenant tests run without it)\n`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
