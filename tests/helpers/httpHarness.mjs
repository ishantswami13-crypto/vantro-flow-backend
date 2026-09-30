// Shared harness for real-DB, real-HTTP tests: boots server.js as a child
// process on a dedicated port, seeds its own isolated tenants (so a test never
// SKIPs for lack of pre-existing data), mints JWTs the same way the auth routes
// do, and cleans up everything it created.
//
// Never prints DATABASE_URL or JWT_SECRET.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
require('dotenv').config();
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { buildSanitizedPgConfig } = require('../../lib/db/pgConfig');

export function makeChecker() {
  let pass = 0; let fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log('  ✅', name); }
    else { fail++; console.log('  ❌', name, detail !== undefined ? `— ${JSON.stringify(detail)}` : ''); }
  };
  const done = () => {
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
  };
  return { check, done };
}

export function openPool() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET not set');
  return new Pool(buildSanitizedPgConfig(process.env.DATABASE_URL));
}

export async function seedUser(pool, label) {
  const id = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@test.starlane.invalid`;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, business_name, created_at) VALUES ($1, $2, 'x', $3, NOW())`,
    [id, email, `Test ${label}`],
  );
  return { id, email, token: jwt.sign({ userId: id, email }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
}

export async function deleteUsers(pool, ids) {
  // Tables reference users ON DELETE CASCADE, except a few older ones.
  for (const id of ids) {
    await pool.query('DELETE FROM activity_logs WHERE user_id = $1', [id]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = $1', [id]).catch((e) => console.log('  (cleanup)', e.message));
  }
}

export async function startServer(port, extraEnv = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  const base = `http://127.0.0.1:${port}`;
  const start = Date.now();
  for (;;) {
    try { const r = await fetch(`${base}/api/live`); if (r.status) break; } catch { /* not up yet */ }
    if (child.exitCode !== null) throw new Error(`server exited early:\n${logs.slice(-2000)}`);
    if (Date.now() - start > 30000) { child.kill(); throw new Error(`server did not start:\n${logs.slice(-2000)}`); }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { base, stop: () => child.kill(), logs: () => logs };
}
