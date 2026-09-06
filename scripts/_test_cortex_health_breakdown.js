// One-off acceptance test for the by_action_type breakdown added to GET /api/cortex/health.
// Run against local DATABASE_URL only (never NEON_READONLY_URL / production).
// Seeds two synthetic users with synthetic ai_actions rows, spins up the real
// server on a scratch port, hits the endpoint with minted JWTs, asserts, then
// cleans up every row it created.
require('dotenv').config();
const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const http = require('http');

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
if (/neon_readonly|readonly/i.test(process.env.NEON_READONLY_URL || '') && DB_URL === process.env.NEON_READONLY_URL) {
  console.error('Refusing: DATABASE_URL appears to be the readonly URL'); process.exit(1);
}

const PORT = 3987;
const JWT_SECRET = process.env.JWT_SECRET;

function mint(userId, email) {
  return jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: '10m' });
}

function httpGet(path, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: 'localhost', port: PORT, path, method: 'GET', headers: { Authorization: `Bearer ${token}` } }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch (e) { reject(new Error('Bad JSON: ' + body)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForServer(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.request({ host: 'localhost', port: PORT, path: '/api/health', method: 'GET' }, res => { res.resume(); resolve(); });
        req.on('error', reject);
        req.end();
      });
      return true;
    } catch (e) { await new Promise(r => setTimeout(r, 250)); }
  }
  return false;
}

async function main() {
  const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const userAEmail = `cortex-test-a-${Date.now()}@example.invalid`;
  const userBEmail = `cortex-test-b-${Date.now()}@example.invalid`;
  const insertedActionIds = [];
  let userAId, userBId;

  try {
    // ---- seed ----
    const uA = await client.query('insert into users (email) values ($1) returning id', [userAEmail]);
    userAId = uA.rows[0].id;
    const uB = await client.query('insert into users (email) values ($1) returning id', [userBEmail]);
    userBId = uB.rows[0].id;

    // User A: 3 CREDIT_RISK_ALERT (2 effective, 1 ineffective), 1 CASHFLOW_GAP_ALERT (1 unknown outcome value edge-case not used; outcome must be non-null per query filter)
    const seedRows = [
      // type, outcome, user
      ['CREDIT_RISK_ALERT', 'effective', userAId],
      ['CREDIT_RISK_ALERT', 'effective', userAId],
      ['CREDIT_RISK_ALERT', 'ineffective', userAId],
      ['CASHFLOW_GAP_ALERT', 'effective', userAId],
      ['CASHFLOW_GAP_ALERT', 'ineffective', userAId],
      // User B - should NEVER show up in A's breakdown
      ['CREDIT_RISK_ALERT', 'effective', userBId],
      ['CREDIT_RISK_ALERT', 'effective', userBId],
      ['CREDIT_RISK_ALERT', 'effective', userBId],
    ];
    for (const [action_type, outcome, uid] of seedRows) {
      const r = await client.query(
        `insert into ai_actions (user_id, action_type, title, status, suggested_by, requires_approval, risk_level, outcome, outcome_at)
         values ($1,$2,'test','done','system',false,'low',$3, now()) returning id`,
        [uid, action_type, outcome]
      );
      insertedActionIds.push(r.rows[0].id);
    }

    // ---- start server ----
    const entry = process.env.TEST_SERVER_ENTRY || (__dirname + '/../launch-local.cjs');
    const child = spawn(process.execPath, [entry], {
      cwd: __dirname + '/..',
      env: { ...process.env, PORT: String(PORT) },
      stdio: 'pipe',
    });
    let serverOut = '';
    child.stdout.on('data', d => serverOut += d);
    child.stderr.on('data', d => serverOut += d);

    const up = await waitForServer();
    if (!up) { console.log(serverOut); throw new Error('Server did not start'); }

    const tokenA = mint(userAId, userAEmail);
    const tokenB = mint(userBId, userBEmail);

    // ---- Test 1 & 3: breakdown numbers + unchanged top-level fields ----
    const resA = await httpGet('/api/cortex/health', tokenA);
    console.log('TEST1/3 status:', resA.status, JSON.stringify(resA.json));
    if (resA.status !== 200) { console.log('--- server output ---\n' + serverOut); }
    const statsA = resA.json.stats;
    console.log('statsA:', JSON.stringify(statsA, null, 2));

    const expectCreditRisk = { effective: 2, ineffective: 1, unknown: 0, rate: 67 };
    const expectCashflow = { effective: 1, ineffective: 1, unknown: 0, rate: 50 };
    const t1ok =
      statsA.by_action_type.CREDIT_RISK_ALERT.effective === expectCreditRisk.effective &&
      statsA.by_action_type.CREDIT_RISK_ALERT.ineffective === expectCreditRisk.ineffective &&
      statsA.by_action_type.CREDIT_RISK_ALERT.rate === expectCreditRisk.rate &&
      statsA.by_action_type.CASHFLOW_GAP_ALERT.effective === expectCashflow.effective &&
      statsA.by_action_type.CASHFLOW_GAP_ALERT.ineffective === expectCashflow.ineffective &&
      statsA.by_action_type.CASHFLOW_GAP_ALERT.rate === expectCashflow.rate;
    console.log('TEST1 (per-type counts match manual arithmetic):', t1ok ? 'PASS' : 'FAIL');

    const t3ok = ['evaluated_actions', 'effectiveness_rate', 'effective_count', 'ineffective_count', 'pending_actions', 'pending_by_priority', 'customer_scores', 'active_plans', 'memory_entries']
      .every(k => Object.prototype.hasOwnProperty.call(statsA, k));
    console.log('TEST3 (existing top-level fields unchanged/present):', t3ok ? 'PASS' : 'FAIL');
    console.log('  evaluated_actions=', statsA.evaluated_actions, 'effective_count=', statsA.effective_count, 'ineffective_count=', statsA.ineffective_count, 'effectiveness_rate=', statsA.effectiveness_rate);

    // ---- Test 4: tenant isolation ----
    const resB = await httpGet('/api/cortex/health', tokenB);
    const statsB = resB.json.stats;
    console.log('statsB.by_action_type:', JSON.stringify(statsB.by_action_type));
    const t4ok = statsB.by_action_type.CREDIT_RISK_ALERT &&
      statsB.by_action_type.CREDIT_RISK_ALERT.effective === 3 &&
      statsB.by_action_type.CREDIT_RISK_ALERT.ineffective === 0 &&
      !statsB.by_action_type.CASHFLOW_GAP_ALERT; // B never had this type
    console.log('TEST4 (tenant isolation, B has no A data and vice versa):', t4ok ? 'PASS' : 'FAIL');

    // ---- Test 2: zero-data user ----
    const uC = await client.query('insert into users (email) values ($1) returning id', [`cortex-test-c-${Date.now()}@example.invalid`]);
    const userCId = uC.rows[0].id;
    const tokenC = mint(userCId, 'c@example.invalid');
    const resC = await httpGet('/api/cortex/health', tokenC);
    const statsC = resC.json.stats;
    console.log('statsC:', JSON.stringify(statsC));
    const t2ok = resC.status === 200 && statsC.evaluated_actions === 0 && statsC.effectiveness_rate === null &&
      typeof statsC.by_action_type === 'object' && Object.keys(statsC.by_action_type).length === 0;
    console.log('TEST2 (zero-data user well-formed, no throw):', t2ok ? 'PASS' : 'FAIL');
    await client.query('delete from users where id = $1', [userCId]);

    child.kill();

    const allPass = t1ok && t3ok && t4ok && t2ok;
    console.log('\nOVERALL:', allPass ? 'ALL PASS' : 'SOME FAILED');
  } finally {
    // ---- cleanup ----
    if (insertedActionIds.length) await client.query('delete from ai_actions where id = any($1::uuid[])', [insertedActionIds]);
    if (userAId) await client.query('delete from users where id = $1', [userAId]);
    if (userBId) await client.query('delete from users where id = $1', [userBId]);
    await client.end();
  }
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
