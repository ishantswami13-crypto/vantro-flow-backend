#!/usr/bin/env node
'use strict';
/*
 * Phase 2C.19 — secret-safe local launcher for the STAGING Rust sidecar.
 * ─────────────────────────────────────────────────────────────────────────────
 * One command to start `vantro-automation` on :3002 against the STAGING Cortex DB
 * so the Owner Briefing evidence gate can run. Loads .env.staging SILENTLY and
 * passes it to the child; prints booleans/status only — NEVER any env value.
 *
 * SAFETY: no deploy, no Railway, no production, no rollback, no Cortex/Neon writes
 *         (the sidecar's briefing endpoint is read-only). Secrets are referenced by
 *         NAME only and forwarded to the child process; they are never printed/logged.
 *
 * USAGE (VS Developer PowerShell, from I:\Vantro\vantro-flow-backend):
 *   # Terminal 1 — build (once) then launch:
 *   $env:SQLX_OFFLINE="true"; cargo build --features server -p vantro-automation-rs --bin vantro-automation
 *   node scripts/phase-2c-19-launch-staging-sidecar.js
 *
 *   # Terminal 2 — run the gate:
 *   node scripts/phase-2c-19-owner-briefing-evidence-gate.js
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = '3002';

// ── 1. Load .env.staging SILENTLY into process.env (existing vars win) ────────
function loadEnvFile(file) {
  const fp = path.join(ROOT, file);
  if (!fs.existsSync(fp)) return false;
  for (const line of fs.readFileSync(fp, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v; // never log key/value
  }
  return true;
}
// read a single key from a file WITHOUT importing the whole file (avoids pulling
// .env's PRODUCTION DATABASE_URL into the staging sidecar). Never logs the value.
function fileVar(file, key) {
  const fp = path.join(ROOT, file);
  if (!fs.existsSync(fp)) return null;
  for (const line of fs.readFileSync(fp, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] === key) { let v = m[2]; if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return v; }
  }
  return null;
}
const PROD_SUPABASE_ID = 'alepdpyqesevldobjxbo'; // production Supabase ref — BLOCK

const envFileLoaded = loadEnvFile('.env.staging');

// ── 2/3. Pin DATABASE_URL to STAGING (never inherit .env's prod DATABASE_URL) ──
// Staging launcher: always prefer STAGING_DATABASE_URL; only fall back to an
// existing DATABASE_URL if no staging URL is present (then prod-blocked below).
if (process.env.STAGING_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.STAGING_DATABASE_URL;
}
// JWT_SECRET: resolve like the gate (.env.staging already loaded → fall back to .env, key-only).
if (!process.env.JWT_SECRET) {
  const fromBase = fileVar('.env', 'JWT_SECRET');
  if (fromBase) process.env.JWT_SECRET = fromBase;
}
const database_url_present = !!process.env.DATABASE_URL;
const jwt_secret_present = !!process.env.JWT_SECRET;

// ── PROD-BLOCK: refuse to launch the sidecar against a production database ────
const prod_blocked_ok = !(process.env.DATABASE_URL &&
  (process.env.DATABASE_URL.includes(PROD_SUPABASE_ID) || /vantro\.in/i.test(process.env.DATABASE_URL)));

// ── 4. Set sidecar runtime env (no secrets here; safe to set) ─────────────────
process.env.RUST_AUTOMATION_API_ENABLED = 'true';
process.env.RUST_AUTOMATION_PORT = PORT;
if (!process.env.PORT) process.env.PORT = PORT;

// ── 5. Locate the built binary (prefer debug, fall back to release) ───────────
const debugBin = path.join(ROOT, 'target', 'debug', 'vantro-automation.exe');
const releaseBin = path.join(ROOT, 'target', 'release', 'vantro-automation.exe');
const binPath = fs.existsSync(debugBin) ? debugBin : (fs.existsSync(releaseBin) ? releaseBin : null);
const binary_found = !!binPath;

// ── 8. Safe status (booleans only — never echo values) ────────────────────────
function status(extra) {
  console.log('SIDECAR_LAUNCH:' + JSON.stringify(Object.assign({
    message: 'staging sidecar launching',
    port: Number(PORT),
    binary_found,
    env_file_loaded: envFileLoaded,
    database_url_present,
    jwt_secret_present,
    prod_blocked_ok,
    rust_automation_api_enabled: true,
  }, extra || {}), null, 1));
}

// ── 2 (validation). Required env present? ─────────────────────────────────────
if (!database_url_present || !jwt_secret_present) {
  status({ message: 'cannot launch: required staging env missing', launched: false });
  console.error('Missing required staging env. Ensure .env.staging has STAGING_DATABASE_URL and JWT_SECRET is available (.env.staging or .env). (values intentionally not printed)');
  process.exit(2);
}

// ── PROD-BLOCK guard: never launch against production ─────────────────────────
if (!prod_blocked_ok) {
  status({ message: 'BLOCKED: resolved DATABASE_URL looks like PRODUCTION — refusing to launch', launched: false });
  console.error('Refusing to launch: the resolved DATABASE_URL references the production Supabase ref / vantro.in. (value intentionally not printed)');
  process.exit(5);
}

// ── 6. Binary missing → safe message, do not spawn ────────────────────────────
if (!binary_found) {
  status({ launched: false });
  console.error('Binary missing. Run  SQLX_OFFLINE=true cargo build --features server -p vantro-automation-rs --bin vantro-automation  from VS Developer PowerShell.');
  process.exit(3);
}

// ── 7. Spawn the sidecar with inherited stdio + sanitized env ─────────────────
status({ launched: true });
const child = spawn(binPath, [], { cwd: ROOT, stdio: 'inherit', env: process.env });
child.on('error', (e) => { console.error('Failed to start sidecar: ' + e.code); process.exit(4); });
child.on('exit', (code, sig) => { console.error(`[sidecar] exited code=${code == null ? 'null' : code}${sig ? ' signal=' + sig : ''}`); process.exit(code == null ? 1 : code); });
// keep the launcher attached so Ctrl-C in Terminal 1 stops the sidecar
const stop = () => { try { child.kill(); } catch (e) {} };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
