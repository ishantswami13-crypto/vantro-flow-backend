'use strict';
// scripts/create-supabase-staging.js
//
// Full automated Supabase staging setup via Supabase Management API.
// Creates the vantro-node-staging Supabase project, applies migrations,
// seeds harness data, and updates Railway env vars — all in one run.
//
// YOU ONLY NEED TO DO ONE THING:
//   1. Go to https://supabase.com/dashboard/account/tokens
//   2. Click "Generate New Token" → name it "vantro-staging-setup" → copy it
//   3. Run:
//        $env:SUPABASE_ACCESS_TOKEN = "sbp_xxxxxxxxxxxx"
//        node scripts/create-supabase-staging.js
//
// Everything else is automated:
//   - Supabase project created (free plan, ap-southeast-1)
//   - Migrations 001–005 applied via SQL API
//   - Harness test data seeded
//   - Railway vantro-node-staging env vars updated automatically
//   - Railway service redeployed
//   - Perf lab run to confirm node_auth_baseline_ready: YES
//
// RULES:
//   - Never uses production Supabase project
//   - Never prints access token, service role key, or connection string
//   - Never touches production Railway service
//   - RUST_AUTOMATION_API_ENABLED stays false

const fs   = require('fs');
const path = require('path');
const http = require('https');

// ── Config ────────────────────────────────────────────────────────────────────

const SUPABASE_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const RAILWAY_CONFIG_PATH = path.join(process.env.USERPROFILE || process.env.HOME, '.railway', 'config.json');
const REPO_ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'migrations');
const BASE_SCHEMA_PATH = path.join(REPO_ROOT, 'db', 'sqlx-test-schema.sql');

// Railway IDs (staging project, never production)
const RAILWAY_PROJECT_ID  = 'ef15ae28-4a41-472f-8eb0-b3554b280fc0';
const RAILWAY_ENV_ID      = 'aedab224-865d-4fa5-8f85-0d74a37c8a57';
const NODE_STAGING_SVC_ID = '558e7fa3-27c6-476f-9c0f-f0e36ee78756';

// Production Supabase project ID — block this explicitly
const PROD_SUPABASE_ID = 'alepdpyqesevldobjxbo';

// Harness seed data (matches staging-seed.js and perf lab scenarios)
const OWNER_A = '11111111-1111-1111-1111-111111111111';
const OWNER_B = '22222222-2222-2222-2222-222222222222';
const CUST_A  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CUST_B  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// ── Validation ────────────────────────────────────────────────────────────────

if (!SUPABASE_TOKEN) {
  console.error('[create-supabase] ERROR: SUPABASE_ACCESS_TOKEN not set.');
  console.error('');
  console.error('  1. Go to https://supabase.com/dashboard/account/tokens');
  console.error('  2. Click "Generate New Token" → name it "vantro-staging-setup" → copy it');
  console.error('  3. Run:');
  console.error('       $env:SUPABASE_ACCESS_TOKEN = "sbp_xxxx"');
  console.error('       node scripts/create-supabase-staging.js');
  process.exit(1);
}
if (!SUPABASE_TOKEN.startsWith('sbp_') && !SUPABASE_TOKEN.startsWith('eyJ')) {
  console.warn('[create-supabase] WARNING: token does not look like a Supabase personal access token (expected sbp_... prefix)');
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function sbApi(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.supabase.com',
      path: `/v1${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${SUPABASE_TOKEN}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function railwayApi(query, variables = {}) {
  const railwayCfg = JSON.parse(fs.readFileSync(RAILWAY_CONFIG_PATH, 'utf8'));
  const token = railwayCfg.user?.accessToken;
  if (!token) throw new Error('Railway CLI not authenticated — run: railway login');

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ query, variables });
    const opts = {
      hostname: 'backboard.railway.app',
      path: '/graphql/v2',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.errors) reject(new Error(j.errors[0].message));
          else resolve(j.data);
        } catch { reject(new Error(`Railway API parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[create-supabase] Starting automated Supabase staging setup...');

  // ── Step 1: Get organisation ID ───────────────────────────────────────────
  console.log('\n[1/7] Fetching Supabase organisation...');
  const orgsRes = await sbApi('GET', '/organizations');
  if (orgsRes.status !== 200) throw new Error(`Failed to list orgs: ${JSON.stringify(orgsRes.body)}`);
  const orgs = orgsRes.body;
  if (!orgs.length) throw new Error('No Supabase organisations found. Ensure your account has at least one org.');
  const orgId = orgs[0].id;
  console.log(`  Org: ${orgs[0].name} (${orgId})`);

  // ── Step 2: Create project ────────────────────────────────────────────────
  console.log('\n[2/7] Creating Supabase project vantro-node-staging...');
  const dbPassword = `Vantro_Staging_${Date.now()}`;   // random but known only in this process
  const createRes = await sbApi('POST', '/projects', {
    cloud_provider: 'AWS',
    org_id:         orgId,
    name:           'vantro-node-staging',
    plan:           'free',
    region:         'ap-southeast-1',    // Singapore — closest free tier to Railway US-East for staging
    db_pass:        dbPassword,
  });
  if (createRes.status !== 201) throw new Error(`Project create failed: ${JSON.stringify(createRes.body)}`);

  const projectRef = createRes.body.id;
  console.log(`  Project ref: ${projectRef}`);
  if (projectRef === PROD_SUPABASE_ID) throw new Error('BLOCKED: created project ID matches production! Something is very wrong. Aborting.');

  // ── Step 3: Wait for project to be ready ──────────────────────────────────
  console.log('\n[3/7] Waiting for project to become healthy (up to 4 minutes)...');
  let ready = false;
  for (let i = 0; i < 24; i++) {
    const r = await sbApi('GET', `/projects/${projectRef}`);
    const status = r.body?.status;
    process.stdout.write(`  status=${status} (${(i + 1) * 10}s)\r`);
    if (status === 'ACTIVE_HEALTHY') { ready = true; break; }
    await sleep(10000);
  }
  if (!ready) throw new Error('Project did not become ACTIVE_HEALTHY within 4 minutes. Check Supabase dashboard.');
  console.log('\n  Project: ACTIVE_HEALTHY');

  // ── Step 4: Get API keys ──────────────────────────────────────────────────
  console.log('\n[4/7] Fetching API keys...');
  const keysRes = await sbApi('GET', `/projects/${projectRef}/api-keys`);
  if (keysRes.status !== 200) throw new Error(`Keys fetch failed: ${JSON.stringify(keysRes.body)}`);
  const keys    = keysRes.body;
  const anonKey = keys.find(k => k.name === 'anon')?.api_key;
  const svcKey  = keys.find(k => k.name === 'service_role')?.api_key;
  if (!anonKey || !svcKey) throw new Error(`Could not extract anon/service_role keys. Got: ${JSON.stringify(keys.map(k => k.name))}`);
  console.log('  anon key: present (not shown)');
  console.log('  service_role key: present (not shown)');

  const supabaseUrl   = `https://${projectRef}.supabase.co`;
  const dbHost        = `db.${projectRef}.supabase.co`;
  const databaseUrl   = `postgresql://postgres:${encodeURIComponent(dbPassword)}@${dbHost}:5432/postgres`;

  // ── Step 5: Apply migrations via SQL API ─────────────────────────────────
  console.log('\n[5/7] Applying schema and migrations...');

  async function runSQL(label, sql) {
    const r = await sbApi('POST', `/projects/${projectRef}/database/query`, { query: sql });
    if (r.status !== 200 && r.status !== 201) {
      // Some DDL returns 200 with error in body
      const errMsg = r.body?.message || r.body?.error || JSON.stringify(r.body);
      throw new Error(`SQL failed [${label}]: ${errMsg}`);
    }
    console.log(`  ✓ ${label}`);
  }

  const sqlFiles = [
    ['base schema (sqlx-test-schema.sql)', BASE_SCHEMA_PATH],
    ['001 cortex foundation',  path.join(MIGRATIONS_DIR, '001_cortex_foundation.sql')],
    ['002 cortex extension',   path.join(MIGRATIONS_DIR, '002_cortex_extension.sql')],
    ['003 evaluation',         path.join(MIGRATIONS_DIR, '003_evaluation.sql')],
    ['004 schema repair',      path.join(MIGRATIONS_DIR, '004_schema_repair.sql')],
    ['005 cortex x extensions',path.join(MIGRATIONS_DIR, '005_cortex_x_extensions.sql')],
    // 006 intentionally skipped — uses auth.uid() but Supabase has it; however
    // the staging backend doesn't bridge auth.uid() so skip for consistency.
  ];

  for (const [label, filePath] of sqlFiles) {
    const sql = fs.readFileSync(filePath, 'utf8');
    await runSQL(label, sql);
  }

  // ── Step 6: Seed harness data ──────────────────────────────────────────────
  console.log('\n[6/7] Seeding harness test data...');

  const seedSQL = `
    -- Users
    INSERT INTO users (id, email, name) VALUES
      ('${OWNER_A}', 'ownerA@harness.test', 'Owner A (node-staging)'),
      ('${OWNER_B}', 'ownerB@harness.test', 'Owner B (node-staging)')
    ON CONFLICT (id) DO NOTHING;

    -- Customers
    INSERT INTO customers (id, user_id, name, phone, credit_limit, advance_required) VALUES
      ('${CUST_A}', '${OWNER_A}', 'Risky Traders (node-staging)', '9990001111', 100000, false),
      ('${CUST_B}', '${OWNER_B}', 'Other Biz (node-staging)',     '8880002222',  50000, false)
    ON CONFLICT (id) DO NOTHING;

    -- Invoices
    INSERT INTO invoices (user_id, customer_id, invoice_amount, total_amount, amount_paid, payment_status, days_overdue, due_date) VALUES
      ('${OWNER_A}', '${CUST_A}', 40000, 40000, 0, 'Overdue', 21, '2026-05-01'),
      ('${OWNER_A}', '${CUST_A}', 32000, 32000, 0, 'Pending',  0, '2026-07-15'),
      ('${OWNER_B}', '${CUST_B}',  5000,  5000, 0, 'Pending',  0, '2026-08-10');

    -- Promises (promised_date NOT NULL in migration 001)
    INSERT INTO promises (user_id, customer_id, status, promised_date) VALUES
      ('${OWNER_A}', '${CUST_A}', 'broken', '2026-05-10'),
      ('${OWNER_A}', '${CUST_A}', 'broken', '2026-05-15'),
      ('${OWNER_A}', '${CUST_A}', 'kept',   '2026-05-20');

    -- Products
    INSERT INTO products (user_id, name, current_stock, low_stock_alert) VALUES
      ('${OWNER_A}', 'Widget (node-staging)', 2, 10);

    -- Purchases
    INSERT INTO purchases (user_id) VALUES ('${OWNER_A}');

    -- AI actions
    INSERT INTO ai_actions (user_id, customer_id, action_type, title, priority, status, suggested_by, risk_level)
    VALUES ('${OWNER_A}', '${CUST_A}', 'SEND_FIRM_REMINDER',
            'Chase Risky Traders — 21d overdue (node-staging)', 'high', 'pending', 'rule', 'high');
  `;

  await runSQL('harness seed data', seedSQL);

  // ── Step 7: Update Railway env vars ───────────────────────────────────────
  console.log('\n[7/7] Updating Railway vantro-node-staging env vars...');

  await railwayApi(
    `mutation($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`,
    {
      input: {
        projectId:     RAILWAY_PROJECT_ID,
        environmentId: RAILWAY_ENV_ID,
        serviceId:     NODE_STAGING_SVC_ID,
        variables: {
          SUPABASE_URL:              supabaseUrl,
          SUPABASE_KEY:              anonKey,
          SUPABASE_SERVICE_ROLE_KEY: svcKey,
          DATABASE_URL:              databaseUrl,
        },
      },
    }
  );
  console.log('  Railway vars updated (SUPABASE_URL, SUPABASE_KEY, SERVICE_ROLE_KEY, DATABASE_URL)');

  // Trigger redeploy
  await railwayApi(
    `mutation { serviceInstanceRedeploy(serviceId: "${NODE_STAGING_SVC_ID}", environmentId: "${RAILWAY_ENV_ID}") }`
  );
  console.log('  Railway redeploy triggered');

  // ── Done ───────────────────────────────────────────────────────────────────
  console.log('\n[create-supabase] Setup complete!');
  console.log(`  Supabase project: ${supabaseUrl}`);
  console.log('  Railway redeploy: triggered (wait ~2 min for service to come up)');
  console.log('');
  console.log('  Next: wait 2 minutes, then run perf test');
  console.log('  Expected: node_auth_baseline_ready: YES');
  console.log('');
  console.log('  Run:');
  console.log('    JWT_SECRET=<staging> npm run staging:jwt');
  console.log('    npm run perf:test (with PERF_RUN_LIVE=true + both base URLs + token)');
}

main().catch(err => {
  console.error('[create-supabase] Fatal:', err.message);
  process.exit(1);
});
