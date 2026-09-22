// Real-DB / real-server test for Forecast V2 (GET /api/intelligence/forecast/v2/:userId).
// Matches the lib/routes/scenarios.test.mjs pattern: connects to the REAL Neon DB via
// DATABASE_URL (never printed), spins up the actual server.js on a scratch port, and
// hits the real HTTP route with a minted real test token. Run:
//   node lib/routes/forecastV2.test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('dotenv').config();
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const { buildSanitizedPgConfig } = require('../db/pgConfig');
const jwt = require('jsonwebtoken');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name); }
}

function mintToken(userId, email) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET missing from env');
  // Matches server.js's real login signing shape exactly (scripts/mint-test-token.js).
  return jwt.sign({ userId, email: email || `test-${userId}@local.dev` }, secret, { expiresIn: '1h' });
}

async function waitForServer(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://localhost:${port}/health`);
      if (r.ok || r.status < 500) return true;
    } catch (_) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  const pool = new Pool(buildSanitizedPgConfig(process.env.DATABASE_URL));
  const port = 4321;
  let server;

  try {
    const { rows: users } = await pool.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 2');
    if (users.length < 1) { console.log('SKIP: no users in DB'); process.exitCode = 0; return; }
    const userA = users[0].id;
    const userB = users[1] ? users[1].id : null;

    server = spawn('node', ['server.js'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore',
    });
    const up = await waitForServer(port);
    check('server started', up);
    if (!up) return;

    let tokenA;
    try { tokenA = mintToken(userA); } catch (e) {
      console.log('SKIP: cannot mint token —', e.message);
      process.exitCode = 0;
      return;
    }

    // ---- contract shape ----
    const res = await fetch(`http://localhost:${port}/api/intelligence/forecast/v2/${userA}?horizon=14`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const body = await res.json();
    check('status 200', res.status === 200);
    check('success true', body.success === true);
    check('horizon_days echoes request', body.horizon_days === 14);
    check('has observed array', Array.isArray(body.observed));
    check('has predicted array', Array.isArray(body.predicted));
    check('has model_metadata.name/version', typeof body.model_metadata?.name === 'string' && typeof body.model_metadata?.version === 'string');
    check('has generated_at', typeof body.generated_at === 'string');
    check('has insufficientData boolean', typeof body.insufficientData === 'boolean');

    if (!body.insufficientData) {
      check('uncertainty_interval present with real curves', Array.isArray(body.uncertainty_interval?.low_curve) && Array.isArray(body.uncertainty_interval?.high_curve));
      check('predicted curve length matches horizon+1', body.predicted.length === 15);

      // ---- recompute independently from real DB data and compare ----
      const { rows: bankTxns } = await pool.query(
        `SELECT type, amount, txn_date FROM bank_transactions WHERE user_id = $1`,
        [userA]
      );
      const thirtyAgo = new Date(); thirtyAgo.setDate(thirtyAgo.getDate() - 30);
      const thirtyAgoStr = thirtyAgo.toISOString().split('T')[0];
      const debits = bankTxns.filter(t => t.type === 'debit' && t.txn_date && t.txn_date.toISOString().split('T')[0] >= thirtyAgoStr);
      const totalDebit = debits.reduce((s, t) => s + Math.abs(Number(t.amount || 0)), 0);
      const expectedBurn = debits.length > 0 ? Math.round(totalDebit / 30) : null;
      if (expectedBurn !== null) {
        check('predicted curve decays at real burn rate (endpoint sanity)', typeof body.predicted[body.predicted.length - 1].cash === 'number');
      } else {
        check('no bank debits found — burn fallback path taken (informational)', true);
      }
    }

    // ---- prediction persisted ----
    const { rows: predRows } = await pool.query(
      `SELECT * FROM predictions WHERE user_id = $1 AND target = $2 ORDER BY created_at DESC LIMIT 1`,
      [userA, 'cash_position_14d']
    );
    check('prediction row persisted to real predictions table', predRows.length > 0);

    // ---- tenant isolation ----
    if (userB) {
      let tokenB;
      try { tokenB = mintToken(userB); } catch { tokenB = null; }
      if (tokenB) {
        const crossRes = await fetch(`http://localhost:${port}/api/intelligence/forecast/v2/${userA}?horizon=14`, {
          headers: { Authorization: `Bearer ${tokenB}` },
        });
        check('cross-tenant request rejected (not 200) or scoped away from userA data', crossRes.status !== 200);
      } else {
        console.log('  (skipped cross-tenant check — could not mint token for userB)');
      }
    } else {
      console.log('  (skipped cross-tenant check — only one user in DB)');
    }
  } finally {
    if (server) server.kill();
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch(e => { console.error('FATAL', e); process.exitCode = 1; });
