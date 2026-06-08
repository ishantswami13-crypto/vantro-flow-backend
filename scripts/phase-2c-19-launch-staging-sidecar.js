#!/usr/bin/env node
'use strict';
/*
 * Phase 2C.19 — secret-safe STAGING sidecar launcher (HARDENED).
 * ─────────────────────────────────────────────────────────────────────────────
 * Starts `vantro-automation` on :3002 against the STAGING Cortex DB so the Owner
 * Briefing evidence gate can run. The staging project's direct host
 * `db.<ref>.supabase.co` is IPv6-ONLY (no A record), so on IPv4-only paths the
 * IPv4 Supabase SESSION POOLER is required. This launcher therefore builds the
 * session-pooler URL IN MEMORY from the ref+password in .env.staging and injects
 * it as a session-only DATABASE_URL. It NEVER prints/writes the URL, password,
 * JWT, key, or any env value — SAFE BOOLEANS/LABELS ONLY.
 *
 * Pooler generation is configurable but VALIDATED against an allowlist (default
 * `aws-1`, region `ap-southeast-1` — the wrong `aws-0` assumption is NOT hardcoded;
 * `aws-0-*` returns Supavisor `tenant_not_found` for this project).
 *
 * FAILS CLOSED on: missing staging creds, production ref/domain, an un-buildable
 * or non-pooler (IPv6-only direct) host, invalid pooler generation/region, or a
 * missing binary. No deploy, no Railway, no production, no writes. Env files are
 * never modified.
 *
 * USAGE (VS Developer PowerShell, from I:\Vantro\vantro-flow-backend):
 *   # Terminal 1 — build (once) then launch (defaults: aws-1 / ap-southeast-1):
 *   $env:SQLX_OFFLINE="true"; cargo build --features server -p vantro-automation-rs --bin vantro-automation
 *   node scripts/phase-2c-19-launch-staging-sidecar.js
 *   #   optional, allowlist-validated: $env:POOLER_GENERATION="aws-1"; $env:POOLER_REGION="ap-southeast-1"
 *
 *   # Terminal 2 — run the gate:
 *   node scripts/phase-2c-19-owner-briefing-evidence-gate.js
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = '3002';
const PROD_SUPABASE_ID = 'alepdpyqesevldobjxbo'; // production Supabase ref — BLOCK
const PROD_DOMAIN_RE = /vantro\.in/i;

// Supavisor session-pooler config — validated against allowlists (NOT hardcoded aws-0).
const POOLER_GEN_ALLOW = new Set(['aws-0', 'aws-1', 'aws-2', 'aws-3']);
const POOLER_REGION_ALLOW = new Set([
  'ap-southeast-1', 'ap-south-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2',
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1', 'sa-east-1',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-central-2', 'eu-north-1',
]);
const POOLER_GENERATION = process.env.POOLER_GENERATION || 'aws-1';
const POOLER_REGION = process.env.POOLER_REGION || 'ap-southeast-1';

// ── env helpers (load by NAME only; never log key/value) ──────────────────────
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
function fileVar(file, key) {
  const fp = path.join(ROOT, file);
  if (!fs.existsSync(fp)) return null;
  for (const line of fs.readFileSync(fp, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] === key) { let v = m[2]; if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return v; }
  }
  return null;
}

// ── classify / safety helpers (operate on the URL but NEVER print it) ─────────
function hostTypeOf(urlStr) {
  try {
    const h = new URL(urlStr).hostname;
    if (/\.pooler\.supabase\.com$/i.test(h)) return 'pooler';
    if (/^db\.[a-z0-9]{20}\.supabase\.co$/i.test(h)) return 'direct_db';
    if (/[a-z0-9]{20}\.supabase\.co$/i.test(h)) return 'supabase_other';
    return 'other';
  } catch (e) { return 'invalid'; }
}
function looksProd(urlStr) {
  return !!urlStr && (urlStr.includes(PROD_SUPABASE_ID) || PROD_DOMAIN_RE.test(urlStr));
}
// Build the STAGING session-pooler URL IN MEMORY from the ref+password of the
// direct URL. Returns null if it can't be built safely. Never printed/written.
function buildPoolerUrl(directUrl, generation, region) {
  let u; try { u = new URL(directUrl); } catch (e) { return null; }
  if (/\.pooler\.supabase\.com$/i.test(u.hostname)) return directUrl; // already pooler — respect explicit override
  const hm = u.hostname.match(/db\.([a-z0-9]{20})\.supabase\.co/i) || u.hostname.match(/([a-z0-9]{20})\.supabase\.co/i);
  const ref = hm ? hm[1] : null;
  const password = u.password; // kept percent-encoded exactly as in the source URL
  if (!ref || !password) return null;
  const search = u.search || '?sslmode=require';
  return `postgresql://postgres.${ref}:${password}@${generation}-${region}.pooler.supabase.com:5432/postgres${search}`;
}

// ── 1. Load .env.staging SILENTLY (existing process.env vars win) ─────────────
const envFileLoaded = loadEnvFile('.env.staging');

// ── 2. Resolve the staging DB URL by NAME, then build the pooler URL in memory ─
const stagingUrl = process.env.STAGING_DATABASE_URL || fileVar('.env.staging', 'STAGING_DATABASE_URL');
const pooler_config_ok = POOLER_GEN_ALLOW.has(POOLER_GENERATION) && POOLER_REGION_ALLOW.has(POOLER_REGION);
const raw_host_type = stagingUrl ? hostTypeOf(stagingUrl) : 'none';

let resolvedUrl = null;
let resolve_reason = 'ok';
if (!stagingUrl) {
  resolve_reason = 'no_staging_url';
} else if (looksProd(stagingUrl)) {
  resolve_reason = 'prod_ref_detected';
} else if (!pooler_config_ok) {
  resolve_reason = 'invalid_pooler_config';
} else if (raw_host_type === 'pooler') {
  resolvedUrl = stagingUrl; // already a pooler URL — respect it
} else if (raw_host_type === 'direct_db' || raw_host_type === 'supabase_other') {
  resolvedUrl = buildPoolerUrl(stagingUrl, POOLER_GENERATION, POOLER_REGION);
  if (!resolvedUrl) resolve_reason = 'cannot_build_pooler';
} else {
  resolve_reason = 'unsupported_host';
}

// Never inherit / pin a production DATABASE_URL — only the resolved staging pooler.
const prod_detected = looksProd(stagingUrl || '') || looksProd(resolvedUrl || '');
if (resolvedUrl && !prod_detected) {
  process.env.DATABASE_URL = resolvedUrl;       // in memory only
  process.env.STAGING_DATABASE_URL = resolvedUrl;
}

// JWT_SECRET: resolve like the gate (.env.staging already loaded → fall back to .env, key-only).
if (!process.env.JWT_SECRET) {
  const fromBase = fileVar('.env', 'JWT_SECRET');
  if (fromBase) process.env.JWT_SECRET = fromBase;
}

// ── 3. Safe booleans/labels (NEVER a URL/secret) ──────────────────────────────
const final_host_type = resolvedUrl ? hostTypeOf(resolvedUrl) : raw_host_type;
const is_pooler = final_host_type === 'pooler';
const staging_db_present = !!resolvedUrl;
const jwt_present = !!process.env.JWT_SECRET;
const production_blocked = !prod_detected;
const debugBin = path.join(ROOT, 'target', 'debug', 'vantro-automation.exe');
const releaseBin = path.join(ROOT, 'target', 'release', 'vantro-automation.exe');
const binPath = fs.existsSync(debugBin) ? debugBin : (fs.existsSync(releaseBin) ? releaseBin : null);
const binary_found = !!binPath;

// ── 4. Sidecar runtime env (no secrets here; safe to set) ─────────────────────
process.env.RUST_AUTOMATION_API_ENABLED = 'true';
process.env.RUST_AUTOMATION_PORT = PORT;
if (!process.env.PORT) process.env.PORT = PORT;

function status(extra) {
  console.log('SIDECAR_LAUNCH:' + JSON.stringify(Object.assign({
    message: 'staging sidecar launcher (hardened)',
    port: Number(PORT),
    host_type: is_pooler ? 'pooler' : final_host_type,
    is_pooler,
    pooler_generation: is_pooler ? POOLER_GENERATION : null,
    region: is_pooler ? POOLER_REGION : null,
    pooler_config_ok,
    env_file_loaded: envFileLoaded,
    staging_db_present,
    jwt_present,
    production_blocked,
    binary_found,
    resolve_reason,
  }, extra || {}), null, 1));
}

// ── 5. FAIL-CLOSED guards (booleans only; values never printed) ───────────────
if (!staging_db_present || !jwt_present) {
  status({ launched: false, message: 'cannot launch: staging DB url/JWT missing or pooler not buildable' });
  console.error('Missing/unbuildable staging env. Ensure .env.staging has STAGING_DATABASE_URL and JWT_SECRET is available. (values intentionally not printed)');
  process.exit(2);
}
if (!pooler_config_ok) {
  status({ launched: false, message: 'invalid POOLER_GENERATION/POOLER_REGION (not in allowlist)' });
  console.error('Refusing to launch: POOLER_GENERATION/POOLER_REGION not in allowlist.');
  process.exit(6);
}
if (!production_blocked) {
  status({ launched: false, message: 'BLOCKED: resolved DATABASE_URL references PRODUCTION — refusing to launch' });
  console.error('Refusing to launch: production Supabase ref / vantro.in detected. (value intentionally not printed)');
  process.exit(5);
}
if (final_host_type === 'direct_db') {
  status({ launched: false, message: 'BLOCKED: direct db.<ref> host is IPv6-only; session pooler required' });
  console.error('Refusing to launch: the direct Supabase host is IPv6-only. Use the IPv4 session pooler (default aws-1/ap-southeast-1).');
  process.exit(7);
}
if (!is_pooler) {
  status({ launched: false, message: 'BLOCKED: resolved host is not a Supabase session pooler' });
  console.error('Refusing to launch: resolved DATABASE_URL is not a session-pooler host.');
  process.exit(7);
}
if (!binary_found) {
  status({ launched: false });
  console.error('Binary missing. Run  SQLX_OFFLINE=true cargo build --features server -p vantro-automation-rs --bin vantro-automation  from VS Developer PowerShell.');
  process.exit(3);
}

// ── 6. Spawn the sidecar with inherited stdio + sanitized env ─────────────────
status({ launched: true });
const child = spawn(binPath, [], { cwd: ROOT, stdio: 'inherit', env: process.env });
child.on('error', (e) => { console.error('Failed to start sidecar: ' + e.code); process.exit(4); });
child.on('exit', (code, sig) => { console.error(`[sidecar] exited code=${code == null ? 'null' : code}${sig ? ' signal=' + sig : ''}`); process.exit(code == null ? 1 : code); });
const stop = () => { try { child.kill(); } catch (e) {} };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// ── 7. Readiness probe → emit sidecar_listening ONCE (safe boolean) ───────────
(function pollReady(deadline) {
  const tryOnce = () => {
    const s = net.connect({ host: '127.0.0.1', port: Number(PORT) });
    let done = false;
    const fin = (ok) => {
      if (done) return; done = true; try { s.destroy(); } catch (e) {}
      if (ok) { console.log('SIDECAR_READY:' + JSON.stringify({ sidecar_listening: true, port: Number(PORT) })); }
      else if (Date.now() < deadline) { setTimeout(tryOnce, 700); }
      else { console.log('SIDECAR_READY:' + JSON.stringify({ sidecar_listening: false, port: Number(PORT) })); }
    };
    s.on('connect', () => fin(true));
    s.on('error', () => fin(false));
    s.setTimeout(1500, () => fin(false));
  };
  tryOnce();
})(Date.now() + 45000);
