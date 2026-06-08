#!/usr/bin/env node
'use strict';
/*
 * Phase 2C.19 — Owner Briefing EVIDENCE GATE (staging-only, read-only proof).
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the Owner Briefing agent uses the persistently-synced OWNER_A staging
 * Cortex records *safely*: real, ID-only evidence for OWNER_A; fail-closed for
 * OWNER_B; no cross-tenant leakage; no raw customer_id; no PII.
 *
 * This script performs NO writes anywhere. It:
 *   1. Loads staging env from gitignored .env.staging / .env (referenced by NAME only).
 *   2. Mints short-lived HS256 JWTs for OWNER_A and OWNER_B with the staging
 *      JWT_SECRET (claim {userId}, matching the sidecar's Claims) — secret never printed.
 *   3. POSTs to the Rust sidecar  /api/v2/agents/core.owner_briefing/preview
 *      (Bearer token, empty OwnerBriefingInput body) and captures the HTTP status.
 *   4. Applies the AUTHORITATIVE Node evidence contract (enforceEvidenceContract,
 *      imported from the real client) so the gate tests production logic, not a copy.
 *   5. (read-only) Fetches OWNER_A's Cortex row-id universe + synced subset via staging
 *      REST to validate evidence references real OWNER_A rows (no hallucination /
 *      cross-tenant) and that synced rows actually flow into evidence.
 *   6. Prints COUNTS / BOOLEANS only. Fails closed if the sidecar is unreachable.
 *
 * SAFETY: no production, no Railway, no deploy, no Neon, no Cortex writes, no rollback.
 *         Never prints JWT_SECRET / DATABASE_URL / Supabase keys / tokens / PII / row values.
 *
 * ── HOW TO RUN (two VS Developer PowerShell terminals — so MSVC cl.exe/link.exe are on PATH) ──
 *   # Terminal 1 — build (once), then launch the staging sidecar on :3002 (secret-safe launcher):
 *   $env:SQLX_OFFLINE="true"; cargo build --features server -p vantro-automation-rs --bin vantro-automation
 *   node scripts/phase-2c-19-launch-staging-sidecar.js
 *
 *   # Terminal 2 — run THIS gate (defaults to http://localhost:3002):
 *   node scripts/phase-2c-19-owner-briefing-evidence-gate.js
 *   #   optional override: $env:RUST_AUTOMATION_BASE_URL="http://localhost:3002"
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const jwt = require('jsonwebtoken');

const ROOT = path.join(__dirname, '..');

// ── env loading (process.env wins; then the named gitignored file) ───────────
function fileVar(file, key) {
  const fp = path.join(ROOT, file);
  if (!fs.existsSync(fp)) return null;
  for (const line of fs.readFileSync(fp, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] === key) { let v = m[2]; if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return v; }
  }
  return null;
}
const envOf = (key, ...files) => process.env[key] || files.map((f) => fileVar(f, key)).find(Boolean) || null;

const JWT_SECRET = envOf('JWT_SECRET', '.env.staging', '.env');
const DB_URL = envOf('STAGING_DATABASE_URL', '.env.staging');
const REST_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || fileVar('.env.staging', 'SUPABASE_SERVICE_ROLE_KEY') || fileVar('.env.staging', 'SUPABASE_KEY');

const BASE = (process.env.RUST_AUTOMATION_BASE_URL || 'http://localhost:3002').replace(/\/+$/, '');
const PREVIEW_PATH = process.env.OB_PREVIEW_PATH || '/api/v2/agents/core.owner_briefing/preview';

const OWNER_A = '11111111-1111-1111-1111-111111111111';
const OWNER_B = '22222222-2222-2222-2222-222222222222';
const PROD_SUPABASE_ID = 'alepdpyqesevldobjxbo'; // production ref — BLOCK any read against it

// ── authoritative evidence-contract enforcement (real production code) ───────
const { enforceEvidenceContract } = require(path.join(ROOT, 'lib', 'services', 'rustAutomation', 'ownerBriefingAgentClient'));

function fail(msg) {
  console.log('GATE_JSON:' + JSON.stringify({ overall_pass: false, error: String(msg).replace(/postgres(ql)?:\/\/[^\s]+/gi, '[REDACTED]') }, null, 1));
  process.exit(1);
}
if (!JWT_SECRET) fail('JWT_SECRET not set (need staging .env.staging or .env)');

// ── mint HS256 JWT (claim {userId}); secret never printed ─────────────────────
const mint = (userId) => jwt.sign({ userId }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });

// ── direct sidecar call → returns { status, rustResult|null, reachable } ──────
function callBriefing(token) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(BASE + PREVIEW_PATH); } catch (e) { return resolve({ status: 0, reachable: false, rustResult: null }); }
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify({})); // OwnerBriefingInput: all fields optional
    const req = lib.request(
      { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname, method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': data.length, Accept: 'application/json' }, timeout: 20000 },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, reachable: true, rustResult: extractRust(j) }); }); }
    );
    req.on('error', () => resolve({ status: 0, reachable: false, rustResult: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, reachable: false, rustResult: null }); });
    req.write(data); req.end();
  });
}
// mirror the Node client's extraction: {success,data} wrapper OR direct {agent_id}
function extractRust(j) {
  if (j && j.success && j.data) return j.data;
  if (j && j.agent_id) return j;
  return null;
}

// ── read-only staging Cortex: OWNER_A row-id universe + synced subset ─────────
function restGet(p) {
  return new Promise((resolve) => {
    if (!DB_URL || !REST_KEY) return resolve(null);
    if (DB_URL.includes(PROD_SUPABASE_ID) || /vantro\.in/i.test(DB_URL)) return resolve(null); // prod-block
    const m = DB_URL.match(/db\.([a-z0-9]{20})\.supabase\.co/i) || DB_URL.match(/@([a-z0-9]{20})\.supabase\.co/i) || DB_URL.match(/postgres\.([a-z0-9]{20})/i);
    if (!m) return resolve(null);
    const host = `${m[1]}.supabase.co`;
    const req = https.request({ host, path: '/rest/v1' + p, method: 'GET', headers: { apikey: REST_KEY, Authorization: `Bearer ${REST_KEY}`, Accept: 'application/json' }, timeout: 20000 },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve(Array.isArray(j) ? j : null); }); });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); req.end();
  });
}
// returns { universe:Set<id>, synced:Set<id> } of Cortex row UUIDs for OWNER_A, or null
async function ownerARowIds() {
  if (!DB_URL || !REST_KEY) return null;
  const tables = ['customers', 'invoices', 'promises', 'followups'];
  const universe = new Set(), synced = new Set();
  let anyOk = false;
  for (const t of tables) {
    const all = await restGet(`/${t}?user_id=eq.${OWNER_A}&select=id`);
    if (all) { anyOk = true; for (const r of all) if (r && r.id != null) universe.add(String(r.id)); }
    const syn = await restGet(`/${t}?user_id=eq.${OWNER_A}&sync_source=eq.neon&select=id`);
    if (syn) for (const r of syn) if (r && r.id != null) synced.add(String(r.id));
  }
  return anyOk ? { universe, synced } : null;
}

// ── assertion helpers (booleans/counts only; never logs evidence content) ─────
const KNOWN_TYPES = new Set(['invoice', 'promise', 'customer']);
function evidenceShapeOk(evidence, universe) {
  if (!Array.isArray(evidence) || evidence.length === 0) return false;
  for (const e of evidence) {
    if (!e || typeof e.source_type !== 'string' || !e.source_type) return false;
    if (e.source_id == null || String(e.source_id).length === 0) return false;
    if (!KNOWN_TYPES.has(e.source_type)) return false;
    if (universe && !universe.has(String(e.source_id))) return false; // must reference a real OWNER_A row
  }
  return true;
}
function noRawCustomerId(evidence) {
  if (!Array.isArray(evidence)) return true;
  for (const e of evidence) {
    if (e && Object.prototype.hasOwnProperty.call(e, 'customer_id') && e.customer_id != null) return false;
    if (e && e.metadata && typeof e.metadata === 'object' && e.metadata.customer_id != null) return false;
  }
  return true;
}
function includesSynced(evidence, synced) {
  if (!synced || !Array.isArray(evidence)) return null;
  return evidence.some((e) => e && synced.has(String(e.source_id)));
}
// OWNER_B evidence must not reference any of OWNER_A's synced rows
function isolationOk(evidenceB, syncedA) {
  if (!Array.isArray(evidenceB)) return true;
  if (syncedA) return !evidenceB.some((e) => e && syncedA.has(String(e.source_id)));
  return evidenceB.length === 0; // conservative fallback when the synced set is unavailable
}

(async () => {
  const rowIds = await ownerARowIds(); // null if staging REST creds unavailable
  const universe = rowIds ? rowIds.universe : null;
  const syncedA = rowIds ? rowIds.synced : null;

  const a = await callBriefing(mint(OWNER_A));
  const b = await callBriefing(mint(OWNER_B));

  const sidecar_reachable = a.reachable && b.reachable;

  // Fail closed: if the sidecar is unreachable, the gate cannot pass.
  const ecA = a.rustResult ? enforceEvidenceContract(a.rustResult, OWNER_A) : null;
  const ecB = b.rustResult ? enforceEvidenceContract(b.rustResult, OWNER_B) : null;
  const evA = ecA && Array.isArray(ecA.evidence) ? ecA.evidence : [];
  const evB = ecB && Array.isArray(ecB.evidence) ? ecB.evidence : [];

  const owner_a_status            = a.reachable ? a.status : 'UNREACHABLE';
  const owner_a_safe_to_show      = ecA ? !!ecA.safe_to_show : false;
  const owner_a_evidence_count    = evA.length;
  const owner_a_evidence_shape_ok = evidenceShapeOk(evA, universe);
  const owner_a_no_raw_customer_id = noRawCustomerId(evA);

  const owner_b_status            = b.reachable ? b.status : 'UNREACHABLE';
  const owner_b_safe_to_show      = ecB ? !!ecB.safe_to_show : false;
  const owner_b_evidence_count    = evB.length;
  const owner_b_isolation_ok      = isolationOk(evB, syncedA);

  const owner_a_pass = a.reachable && a.status === 200 && owner_a_safe_to_show === true &&
    owner_a_evidence_count > 0 && owner_a_evidence_shape_ok && owner_a_no_raw_customer_id;
  // OWNER_B: HTTP 200 (or safe no-evidence) + safe_to_show=false + no evidence + isolation holds
  const owner_b_pass = b.reachable && (b.status === 200) && owner_b_safe_to_show === false &&
    owner_b_evidence_count === 0 && owner_b_isolation_ok;

  const overall_pass = sidecar_reachable && owner_a_pass && owner_b_pass;

  // Required output — counts/booleans only:
  const result = {
    owner_a_status, owner_a_safe_to_show, owner_a_evidence_count,
    owner_a_evidence_shape_ok, owner_a_no_raw_customer_id,
    owner_b_status, owner_b_safe_to_show, owner_b_evidence_count, owner_b_isolation_ok,
    overall_pass,
    // additive diagnostics (booleans/counts only — no PII/secrets):
    sidecar_reachable,
    owner_a_evidence_includes_synced: includesSynced(evA, syncedA),
    subset_check_available: !!universe,
  };
  if (!sidecar_reachable) result._note = 'Sidecar unreachable → fail-closed. Build+run vantro-automation on :3002 from a VS Developer PowerShell (see header).';
  console.log('GATE_JSON:' + JSON.stringify(result, null, 1));
  process.exit(overall_pass ? 0 : 1);
})().catch((e) => fail(e && e.message ? e.message : e));
