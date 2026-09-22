// Real-DB, real-HTTP test for Prepared V1 (Priority 6):
// GET /api/intelligence/prepared/:userId — read-only, so this test never
// mutates ai_actions/watches/predictions rows (unlike aiActions.test.mjs,
// which decides a real action). Matches the scenarios.test.mjs /
// forecastV2.test.mjs pattern (real Neon DB via DATABASE_URL, real users).
//
// Run:
//   node lib/routes/prepared.test.mjs
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

const TEST_PORT = 3912;
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
    // Real tenant with at least one pending ai_action, so needs_you is
    // non-empty and we can assert real field mapping.
    const { rows: withPending } = await pool.query(
      `SELECT user_id, COUNT(*) AS c FROM ai_actions WHERE status = 'pending' GROUP BY user_id ORDER BY c DESC LIMIT 1`
    );
    if (withPending.length === 0) {
      console.log('SKIP: no tenant in DB has a pending ai_action — cannot verify needs_you mapping');
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
      `SELECT id, action_type FROM ai_actions WHERE user_id = $1 AND status = 'pending' ORDER BY created_at ASC LIMIT 1`,
      [userA]
    );
    const expectedPendingId = pendingA[0].id;

    const { rows: userARow } = await pool.query('SELECT email FROM users WHERE id = $1', [userA]);
    const { rows: userBRow } = await pool.query('SELECT email FROM users WHERE id = $1', [userB]);
    const tokenA = mintToken(userA, userARow[0]?.email || 'test-a@example.com');
    const tokenB = mintToken(userB, userBRow[0]?.email || 'test-b@example.com');

    server = spawn(process.execPath, ['server.js'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', () => {});
    server.stderr.on('data', () => {});
    await waitForServer(`${BASE}/api/intelligence/prepared/${userA}`, 20000);

    // ---- happy path: real data, own tenant ----
    const res = await fetch(`${BASE}/api/intelligence/prepared/${userA}`, { headers: { Authorization: `Bearer ${tokenA}` } });
    const body = await res.json();
    check('GET: 200', res.status === 200);
    check('GET: has all five tabs', ['for_you', 'needs_you', 'upcoming', 'completed', 'dismissed'].every(k => Array.isArray(body[k])));
    check('GET: needs_you contains the real pending action', body.needs_you.some(c => c.id === expectedPendingId));
    check('GET: needs_you card traces to real fields', body.needs_you.every(c => c.source === 'ai_actions' && c.status === 'pending'));
    check('GET: upcoming is always an honest empty array (no backing capability)', Array.isArray(body.upcoming) && body.upcoming.length === 0);
    check('GET: counts match array lengths', body.counts.needs_you === body.needs_you.length && body.counts.for_you === body.for_you.length);
    check('GET: no fabricated score field present', body.needs_you.every(c => !('preparednessScore' in c)) && body.for_you.every(c => !('preparednessScore' in c)));

    // ---- tenant isolation ----
    const crossRes = await fetch(`${BASE}/api/intelligence/prepared/${userA}`, { headers: { Authorization: `Bearer ${tokenB}` } });
    check('tenant isolation: userB requesting userA prepared items is 403', crossRes.status === 403);

    const ownRes = await fetch(`${BASE}/api/intelligence/prepared/${userB}`, { headers: { Authorization: `Bearer ${tokenB}` } });
    check('tenant isolation: userB requesting their own prepared items is 200', ownRes.status === 200);
    const ownBody = await ownRes.json();
    check('tenant isolation: userB never sees userA action ids', !(ownBody.needs_you || []).some(c => c.id === expectedPendingId));

    // ---- unauthenticated ----
    const noAuthRes = await fetch(`${BASE}/api/intelligence/prepared/${userA}`);
    check('unauthenticated: 401', noAuthRes.status === 401);

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
