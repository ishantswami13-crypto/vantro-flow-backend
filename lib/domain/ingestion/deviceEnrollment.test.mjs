// Real-DB, real-HTTP test for connector device enrollment (Tally connect
// flow): POST /api/connectors/tally/enrollment, POST
// /api/connectors/tally/claim, GET /api/connectors/tally/devices,
// POST /api/connectors/tally/devices/:deviceId/revoke, and the
// VantroDevice branch of connectorOrUserAuth. Matches the
// lib/routes/prepared.test.mjs pattern (real Neon DB via DATABASE_URL,
// real HTTP server spawned on a test port). Writes real rows to
// connector_enrollments/connector_devices for a real tenant and cleans
// them up afterward.
//
// Run:
//   node lib/domain/ingestion/deviceEnrollment.test.mjs
//
// Never prints DATABASE_URL or JWT_SECRET.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('dotenv').config();
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const { buildSanitizedPgConfig } = require('../../db/pgConfig');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name); }
}

const TEST_PORT = 3913;
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

  const createdEnrollmentIds = [];
  const createdDeviceIds = [];
  let server;
  try {
    const { rows: users } = await pool.query('SELECT id, email FROM users ORDER BY created_at ASC LIMIT 2');
    if (users.length < 2) {
      console.log('SKIP: fewer than 2 users in DB — cannot run tenant isolation test');
      process.exitCode = 0;
      return;
    }
    const [userA, userB] = users;
    console.log(`Using real users (non-secret ids): A=${userA.id} B=${userB.id}`);

    const tokenA = mintToken(userA.id, userA.email);
    const tokenB = mintToken(userB.id, userB.email);

    server = spawn(process.execPath, ['server.js'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', () => {});
    server.stderr.on('data', () => {});
    await waitForServer(`${BASE}/api/connectors/tally/devices`, 20000);

    // ---- unauthenticated enrollment: 401 ----
    const noAuthEnroll = await fetch(`${BASE}/api/connectors/tally/enrollment`, { method: 'POST' });
    check('enrollment: unauthenticated is 401', noAuthEnroll.status === 401);

    // ---- create enrollment (real) ----
    const enrollRes = await fetch(`${BASE}/api/connectors/tally/enrollment`, {
      method: 'POST', headers: { Authorization: `Bearer ${tokenA}` },
    });
    const enrollBody = await enrollRes.json();
    check('enrollment: 201', enrollRes.status === 201);
    check('enrollment: has a real code', typeof enrollBody.enrollmentCode === 'string' && enrollBody.enrollmentCode.length > 10);
    check('enrollment: has a future expiry', new Date(enrollBody.expiresAt).getTime() > Date.now());

    {
      const { rows } = await pool.query('SELECT id FROM connector_enrollments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [userA.id]);
      if (rows[0]) createdEnrollmentIds.push(rows[0].id);
    }

    // ---- claim with wrong code: rejected ----
    const badClaim = await fetch(`${BASE}/api/connectors/tally/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enrollmentCode: 'not-a-real-code', deviceName: 'Nope' }),
    });
    check('claim: unknown code is 400', badClaim.status === 400);

    // ---- claim (real, no auth needed — the code is the proof) ----
    const claimRes = await fetch(`${BASE}/api/connectors/tally/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enrollmentCode: enrollBody.enrollmentCode, deviceName: 'Test Runner PC' }),
    });
    const claimBody = await claimRes.json();
    check('claim: 201', claimRes.status === 201);
    check('claim: returns deviceId + deviceSecret', !!claimBody.deviceId && !!claimBody.deviceSecret);
    if (claimBody.deviceId) createdDeviceIds.push(claimBody.deviceId);

    // ---- claim-once: second claim of the same code fails ----
    const secondClaim = await fetch(`${BASE}/api/connectors/tally/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enrollmentCode: enrollBody.enrollmentCode, deviceName: 'Second Device' }),
    });
    check('claim: second claim of same code is 400 (claim-once)', secondClaim.status === 400);

    // ---- listDevices scoped to tenant ----
    const listA = await fetch(`${BASE}/api/connectors/tally/devices`, { headers: { Authorization: `Bearer ${tokenA}` } });
    const listABody = await listA.json();
    check('devices list: 200', listA.status === 200);
    check('devices list: contains the newly claimed device', (listABody.devices || []).some((d) => d.id === claimBody.deviceId));
    check('devices list: never returns secret material', (listABody.devices || []).every((d) => !('token_hash' in d) && !('deviceSecret' in d)));

    const listB = await fetch(`${BASE}/api/connectors/tally/devices`, { headers: { Authorization: `Bearer ${tokenB}` } });
    const listBBody = await listB.json();
    check('devices list: tenant isolation — userB never sees userA device', !(listBBody.devices || []).some((d) => d.id === claimBody.deviceId));

    // ---- device authentication: correct secret works ----
    const goodAuthRes = await fetch(`${BASE}/api/connectors/tally/devices`, {
      headers: { Authorization: `VantroDevice ${claimBody.deviceId}.${claimBody.deviceSecret}` },
    });
    // devices route is authMiddleware-only (never accepts device creds) per
    // server.js's own comment — assert it correctly rejects a device
    // credential here rather than silently accepting it.
    check('devices list: device credential is rejected on a user-only route', goodAuthRes.status === 401 || goodAuthRes.status === 403);

    // Use the heartbeat route (connectorOrUserAuth) to prove device auth
    // actually authenticates when used on a route that accepts it.
    const heartbeatGood = await fetch(`${BASE}/api/connections/heartbeat`, {
      method: 'POST',
      headers: { Authorization: `VantroDevice ${claimBody.deviceId}.${claimBody.deviceSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceType: 'TALLY', status: 'CONNECTED' }),
    });
    check('device auth: correct secret authenticates on connectorOrUserAuth route', heartbeatGood.status !== 401 && heartbeatGood.status !== 503);

    // ---- device authentication: incorrect secret rejected ----
    const heartbeatBad = await fetch(`${BASE}/api/connections/heartbeat`, {
      method: 'POST',
      headers: { Authorization: `VantroDevice ${claimBody.deviceId}.wrong-secret-value-not-real`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceType: 'TALLY', status: 'CONNECTED' }),
    });
    check('device auth: incorrect secret is 401', heartbeatBad.status === 401);

    // ---- revoke: scoped to owner, then device auth stops working ----
    const revokeWrongUser = await fetch(`${BASE}/api/connectors/tally/devices/${claimBody.deviceId}/revoke`, {
      method: 'POST', headers: { Authorization: `Bearer ${tokenB}` },
    });
    check('revoke: other tenant cannot revoke (404)', revokeWrongUser.status === 404);

    const revokeOk = await fetch(`${BASE}/api/connectors/tally/devices/${claimBody.deviceId}/revoke`, {
      method: 'POST', headers: { Authorization: `Bearer ${tokenA}` },
    });
    check('revoke: owner revokes successfully (200)', revokeOk.status === 200);

    const revokeAgain = await fetch(`${BASE}/api/connectors/tally/devices/${claimBody.deviceId}/revoke`, {
      method: 'POST', headers: { Authorization: `Bearer ${tokenA}` },
    });
    check('revoke: revoking an already-revoked device is 404', revokeAgain.status === 404);

    const heartbeatAfterRevoke = await fetch(`${BASE}/api/connections/heartbeat`, {
      method: 'POST',
      headers: { Authorization: `VantroDevice ${claimBody.deviceId}.${claimBody.deviceSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceType: 'TALLY', status: 'CONNECTED' }),
    });
    check('device auth: revoked device is rejected (401)', heartbeatAfterRevoke.status === 401);

  } finally {
    // Clean up rows this test created — no destructive DB cleanup beyond that.
    for (const id of createdDeviceIds) {
      try { await pool.query('DELETE FROM connector_devices WHERE id = $1', [id]); } catch {}
    }
    for (const id of createdEnrollmentIds) {
      try { await pool.query('DELETE FROM connector_enrollments WHERE id = $1', [id]); } catch {}
    }
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
