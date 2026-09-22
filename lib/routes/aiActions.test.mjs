// Real-DB, real-HTTP test for Control Approvals (Priority 5): the existing
// GET /api/ai-actions list route and PATCH /api/ai-actions/:id decision
// route in server.js. Matches the lib/routes/scenarios.test.mjs /
// forecastV2.test.mjs pattern (real Neon DB via DATABASE_URL, real users),
// but drives the routes over real HTTP since their logic lives inline in
// server.js rather than in an importable module.
//
// Run:
//   node lib/routes/aiActions.test.mjs
//
// Never prints DATABASE_URL or JWT_SECRET.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('dotenv').config();
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const { buildSanitizedPgConfig } = require('../db/pgConfig');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name); }
}

const TEST_PORT = 3911;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

function mintToken(userId, email) {
  return jwt.sign({ userId, email }, process.env.JWT_SECRET, { expiresIn: '10m' });
}

function waitForServer(url, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(url);
        if (res.status) return resolve();
      } catch {
        // not up yet
      }
      if (Date.now() - start > timeoutMs) return reject(new Error('server did not start in time'));
      setTimeout(tick, 300);
    };
    tick();
  });
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET not set');
  const pool = new Pool(buildSanitizedPgConfig(process.env.DATABASE_URL));

  let server;
  try {
    // ---- pick two real tenants: userA needs >=2 real pending ai_actions so
    // we can decide one and leave the other untouched (list-scoping check),
    // userB is any other real tenant for the cross-tenant isolation check.
    const { rows: withPending } = await pool.query(
      `SELECT user_id, COUNT(*) AS c FROM ai_actions WHERE status = 'pending' GROUP BY user_id HAVING COUNT(*) >= 2 ORDER BY c DESC LIMIT 1`
    );
    if (withPending.length === 0) {
      console.log('SKIP: no tenant in DB has >=2 pending ai_actions — cannot run this test');
      process.exitCode = 0;
      return;
    }
    const userA = withPending[0].user_id;
    const { rows: otherUsers } = await pool.query('SELECT id FROM users WHERE id != $1 ORDER BY created_at ASC LIMIT 1', [userA]);
    if (otherUsers.length === 0) {
      console.log('SKIP: fewer than 2 users in DB — cannot run tenant isolation test');
      process.exitCode = 0;
      return;
    }
    const userB = otherUsers[0].id;
    console.log(`Using real users (non-secret ids): A=${userA} B=${userB}`);

    const { rows: pendingA } = await pool.query(
      `SELECT id FROM ai_actions WHERE user_id = $1 AND status = 'pending' ORDER BY created_at ASC LIMIT 2`,
      [userA]
    );
    const [targetId, untouchedId] = pendingA.map(r => r.id);

    const { rows: userARow } = await pool.query('SELECT email FROM users WHERE id = $1', [userA]);
    const { rows: userBRow } = await pool.query('SELECT email FROM users WHERE id = $1', [userB]);
    const tokenA = mintToken(userA, userARow[0]?.email || 'test-a@example.com');
    const tokenB = mintToken(userB, userBRow[0]?.email || 'test-b@example.com');

    // ---- start the real server as a child process on a dedicated test port ----
    server = spawn(process.execPath, ['server.js'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', () => {});
    server.stderr.on('data', () => {});
    await waitForServer(`${BASE}/api/ai-actions`, 20000);

    // ---- GET list: tenant scoping ----
    const listRes = await fetch(`${BASE}/api/ai-actions?status=pending`, { headers: { Authorization: `Bearer ${tokenA}` } });
    const listBody = await listRes.json();
    check('GET list: 200', listRes.status === 200);
    check('GET list: only userA rows returned', (listBody.actions || []).every(a => a.user_id === userA));
    check('GET list: contains the target pending action', (listBody.actions || []).some(a => a.id === targetId));

    // ---- tenant isolation: userB cannot decide userA's action ----
    const crossRes = await fetch(`${BASE}/api/ai-actions/${targetId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'rejected' }),
    });
    check('tenant isolation: cross-tenant PATCH is 404', crossRes.status === 404);
    const { rows: stillPending } = await pool.query('SELECT status FROM ai_actions WHERE id = $1', [targetId]);
    check('tenant isolation: cross-tenant PATCH did not mutate the row', stillPending[0].status === 'pending');

    // ---- audit_logs baseline count for this entity ----
    const { rows: auditBefore } = await pool.query('SELECT COUNT(*) c FROM audit_logs WHERE entity_id = $1', [targetId]);
    const auditCountBefore = Number(auditBefore[0].c);

    // ---- real decision: userA rejects their own action ----
    const decideRes = await fetch(`${BASE}/api/ai-actions/${targetId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'rejected' }),
    });
    const decideBody = await decideRes.json();
    check('decide: 200', decideRes.status === 200);
    check('decide: action status is rejected', decideBody.action?.status === 'rejected');

    // ---- moved out of the pending list ----
    const listAfter = await fetch(`${BASE}/api/ai-actions?status=pending`, { headers: { Authorization: `Bearer ${tokenA}` } });
    const listAfterBody = await listAfter.json();
    check('decide: rejected action no longer in pending list', !(listAfterBody.actions || []).some(a => a.id === targetId));
    if (untouchedId) {
      check('decide: sibling pending action untouched', (listAfterBody.actions || []).some(a => a.id === untouchedId));
    }

    // ---- audit log written exactly once ----
    // Small delay: the audit write happens after the HTTP response resolves
    // inside the route handler (awaited before res.json in our code, but we
    // still re-check against real DB state rather than trusting timing).
    const { rows: auditAfter } = await pool.query(
      "SELECT * FROM audit_logs WHERE entity_id = $1 AND action = 'ai_action_rejected' ORDER BY created_at DESC LIMIT 1",
      [targetId]
    );
    check('audit: a real ai_action_rejected row was written', auditAfter.length === 1);
    if (auditAfter.length === 1) {
      check('audit: correct user_id', auditAfter[0].user_id === userA);
      check('audit: entity_type is ai_action', auditAfter[0].entity_type === 'ai_action');
    }
    const { rows: auditAfterCount } = await pool.query('SELECT COUNT(*) c FROM audit_logs WHERE entity_id = $1', [targetId]);
    check('audit: exactly one new audit row for this decision', Number(auditAfterCount[0].c) === auditCountBefore + 1);

    // ---- idempotency: re-deciding is a clean 409, not a double-write ----
    const redecideRes = await fetch(`${BASE}/api/ai-actions/${targetId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    });
    check('idempotency: re-deciding an already-decided action is 409', redecideRes.status === 409);
    const { rows: auditAfterRedecide } = await pool.query('SELECT COUNT(*) c FROM audit_logs WHERE entity_id = $1', [targetId]);
    check('idempotency: 409 did not write a duplicate audit row', Number(auditAfterRedecide[0].c) === auditCountBefore + 1);
    const { rows: statusAfterRedecide } = await pool.query('SELECT status FROM ai_actions WHERE id = $1', [targetId]);
    check('idempotency: status is unchanged by the rejected re-decide attempt', statusAfterRedecide[0].status === 'rejected');

  } finally {
    if (server) server.kill();
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exitCode = 1;
});
