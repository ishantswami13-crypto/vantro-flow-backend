#!/usr/bin/env node
'use strict';
/*
 * Phase 2C.22 — Runtime Truth LIVE CONTRACT proof.
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the GET /api/atlas/runtime-truth contract behaves safely over REAL HTTP,
 * locally and staging-safe — NEVER booting the server.js monolith (which would
 * validateSecurityEnvironment(), bind the port, run runAutoMigrations(), and open
 * a DB connection). Instead it stands up a tiny localhost HTTP server on an
 * ephemeral 127.0.0.1 port using ONLY Node built-ins (http + crypto), and wires:
 *
 *   - auth: a faithful HS256 mirror of server.js authMiddleware/verifyJWT
 *           (Bearer token; missing → 401 'Missing token'; bad → 401 'Invalid…').
 *   - flag gate + payload: the REAL production modules —
 *           lib/featureFlags.js (isEnabled) and lib/services/runtimeTruth.service.js
 *           (buildRuntimeTruth). No reimplementation of business logic.
 *
 * It then proves OFF→404, no/invalid-token→401, ON+token→200, asserts the SERVED
 * payload byte-equals the pure builder output (no drift), and deep-scans the
 * payload for secrets/PII/overclaims. A static cross-check confirms server.js's
 * real route uses the same authMiddleware + flag gate + service call, so the
 * harness faithfully represents production wiring.
 *
 * SAFETY: no DB, no network egress, no Railway, no env-file writes, no prod. The
 * only process env touched is the in-process FEATURE_RUNTIME_TRUTH_API_ENABLED
 * toggle (never written to disk). Output is COUNTS / BOOLEANS only — never the
 * token, the test secret, secrets, PII, or raw row data.
 *
 * FAIL-CLOSED: any missing/odd result fails its gate and the overall verdict.
 * A SHA-256 mutation guard proves this script + its doc are unchanged by the run.
 *
 * USAGE: node scripts/phase-2c-22-runtime-truth-live-contract-check.js
 *        exit 0 = all gates pass; exit 1 = fail-closed.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const FLAGS_PATH = path.join(ROOT, 'lib', 'featureFlags.js');
const SERVICE_PATH = path.join(ROOT, 'lib', 'services', 'runtimeTruth.service.js');
const SERVER_PATH = path.join(ROOT, 'server.js');

// ── mutation guard (part 1): hash Phase 2C.22 files BEFORE any work ───────────
const PHASE_FILES = {
  check: 'scripts/phase-2c-22-runtime-truth-live-contract-check.js',
  doc:   'docs/agent-mesh/phase-2c-22-runtime-truth-live-contract-proof.md',
};
function sha256(rel) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex'); }
  catch (e) { return null; }
}
const HASH_BEFORE = {};
for (const [k, rel] of Object.entries(PHASE_FILES)) HASH_BEFORE[k] = sha256(rel);

// ── local-only HS256 mirror of the repo's jsonwebtoken auth (test fixture) ────
// TEST_SECRET is a throwaway local fixture — NOT a real secret, and never printed.
const TEST_SECRET = 'p2c22-local-harness-fixture-not-a-real-secret';
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function signJWT(payload, secret) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', secret).update(h + '.' + p).digest());
  return `${h}.${p}.${sig}`;
}
function verifyJWT(token, secret) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('malformed');
  const expected = b64url(crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest());
  const a = Buffer.from(parts[2]); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('bad signature');
  return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}
const VALID_TOKEN = signJWT({ userId: 'local-test-user' }, TEST_SECRET);

// ── in-process flag control (reloads the REAL featureFlags module) ────────────
function setFlag(on) {
  if (on) process.env.FEATURE_RUNTIME_TRUTH_API_ENABLED = 'true';
  else delete process.env.FEATURE_RUNTIME_TRUTH_API_ENABLED;
  delete require.cache[require.resolve(FLAGS_PATH)];
}

// ── request handler: auth mirror first, THEN real flag gate + real builder ────
function handler(req, res) {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method !== 'GET' || req.url !== '/api/atlas/runtime-truth') { res.writeHead(404); return res.end('nope'); }
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return send(401, { error: 'Missing token' });
  try { verifyJWT(token, TEST_SECRET); } catch { return send(401, { error: 'Invalid or expired token' }); }
  const { isEnabled } = require(FLAGS_PATH);          // REAL feature flags
  if (!isEnabled('runtime_truth_api_enabled')) return send(404, { error: 'Not found' });
  const { buildRuntimeTruth } = require(SERVICE_PATH); // REAL pure builder
  return send(200, buildRuntimeTruth({ generatedAt: new Date().toISOString() }));
}

function httpGet(port, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/api/atlas/runtime-truth', method: 'GET', headers: headers || {} }, (res) => {
      let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => {
        let json = null; try { json = JSON.parse(data); } catch (e) {}
        resolve({ status: res.statusCode, json, hasBody: data.length > 0 });
      });
    });
    r.on('error', reject); r.end();
  });
}

// ── PII / secret patterns for the served payload (keys + values) ──────────────
const FORBIDDEN_KEY = /(database_url|jwt_secret|supabase|railway|password|secret|token)/i;
const VALUE_PATTERNS = [
  /postgres(?:ql)?:\/\//i, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, /\bbearer\s+[A-Za-z0-9._-]{10,}/i,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, /\b\d{10,}\b/, /\+\d[\d -]{8,}\d/,
  /\b(?:sk|rk|pk|rzp)_live_[A-Za-z0-9]{8,}/i, /\bsk-[A-Za-z0-9]{16,}/, /BEGIN [A-Z ]*PRIVATE KEY/,
];
function walk(node, keys, vals) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) return node.forEach((n) => walk(n, keys, vals));
  if (typeof node === 'object') { for (const [k, v] of Object.entries(node)) { keys.push(k); walk(v, keys, vals); } return; }
  if (typeof node === 'string') vals.push(node);
}
const OVERCLAIM = ['216 live agents', 'fully autonomous finance operations', 'production-live neon', 'live external whatsapp', 'bank-grade', 'military-grade', '100+ live', '200+ live'];

(async function main() {
  const gates = {};
  const diagnostics = { offStatus: null, onStatus: null, noTokenStatus: null, badTokenStatus: null, offNoTokenStatus: null };
  let servedSummary = null;
  let driftField = null;

  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    const serverSrc = (() => { try { return fs.readFileSync(SERVER_PATH, 'utf8'); } catch (e) { return ''; } })();

    // ── (0) static cross-check: harness mirrors the REAL server.js route ──
    gates.endpoint_in_server_source = /app\.get\(\s*'\/api\/atlas\/runtime-truth'\s*,\s*authMiddleware/.test(serverSrc);
    gates.server_route_flag_gated = serverSrc.includes("_fe('runtime_truth_api_enabled')") && serverSrc.includes('status(404)');
    gates.server_route_calls_builder = serverSrc.includes('buildRuntimeTruth') && serverSrc.includes('runtimeTruth.service');

    // ── (1) OFF behavior: authenticated request → generic 404, no truth leak ──
    setFlag(false);
    const off = await httpGet(port, { authorization: `Bearer ${VALID_TOKEN}` });
    diagnostics.offStatus = off.status;
    const offKeys = off.json ? Object.keys(off.json) : [];
    gates.off_returns_404 = off.status === 404;
    gates.off_body_is_generic = !!off.json && off.json.error === 'Not found' && offKeys.length === 1;
    gates.off_no_truth_leak = !offKeys.some((k) => ['platform', 'summary', 'packs', 'agents', 'workflows', 'launch_claims', 'truth_version'].includes(k));

    // ── (2) AUTH behavior (independent of flag) ──
    setFlag(true);
    const noTok = await httpGet(port, {});
    diagnostics.noTokenStatus = noTok.status;
    const badTok = await httpGet(port, { authorization: 'Bearer not.a.valid.token' });
    diagnostics.badTokenStatus = badTok.status;
    setFlag(false);
    const offNoTok = await httpGet(port, {}); // auth runs BEFORE flag gate → 401 even when OFF
    diagnostics.offNoTokenStatus = offNoTok.status;
    gates.no_token_401 = noTok.status === 401 && noTok.json && noTok.json.error === 'Missing token';
    gates.bad_token_401 = badTok.status === 401 && badTok.json && badTok.json.error === 'Invalid or expired token';
    gates.auth_precedes_flag = offNoTok.status === 401; // missing token short-circuits before 404

    // ── (3) ON behavior: authenticated request → 200 + JSON truth payload ──
    setFlag(true);
    const on = await httpGet(port, { authorization: `Bearer ${VALID_TOKEN}` });
    diagnostics.onStatus = on.status;
    const served = on.json;
    gates.on_returns_200 = on.status === 200;
    gates.on_body_is_json_contract = !!served && served.platform === 'atlas' && !!served.summary && Array.isArray(served.packs);

    // ── (4) served payload == pure builder output (no drift) ──
    let builderMatches = false;
    if (served) {
      const { buildRuntimeTruth } = require(SERVICE_PATH);
      const expected = buildRuntimeTruth({ generatedAt: served.generated_at });
      const se = JSON.stringify(served), ee = JSON.stringify(expected);
      builderMatches = se === ee;
      if (!builderMatches) {
        for (const k of Object.keys(expected)) { if (JSON.stringify(served[k]) !== JSON.stringify(expected[k])) { driftField = k; break; } }
      }
    }
    gates.served_matches_builder = builderMatches;

    // ── (5) payload invariants: redaction, no PII/secrets, no overclaims ──
    if (served) {
      const KEYS = [], VALS = []; walk(served, KEYS, VALS);
      const badKeys = KEYS.filter((k) => FORBIDDEN_KEY.test(k)).length;
      const badVals = VALS.filter((v) => VALUE_PATTERNS.some((re) => re.test(v))).length;
      const ents = [...served.packs, ...served.agents, ...served.workflows];
      const liveLimited = ents.filter((e) => e.status === 'live_limited').map((e) => e.id).sort();
      const sync = served.workflows.find((w) => w.id === 'workflow.neon_to_cortex_sync');
      const ext = served.workflows.find((w) => w.id === 'workflow.external_message_send');
      const allowedJoined = (served.launch_claims.allowed || []).join(' || ').toLowerCase();

      servedSummary = served.summary;
      gates.environment_redacted = served.environment === 'safe_redacted';
      gates.no_forbidden_keys = badKeys === 0;
      gates.no_pii_values = badVals === 0;
      gates.no_overclaim_in_allowed = OVERCLAIM.every((p) => !allowedJoined.includes(p));
      gates.live_proven_zero = served.summary.live_proven === 0;
      gates.exactly_two_live_limited = liveLimited.length === 2 &&
        JSON.stringify(liveLimited) === JSON.stringify(['core.owner_briefing', 'workflow.owner_briefing_preview'].sort());
      gates.neon_sync_blocked = !!sync && sync.status === 'blocked';
      gates.external_send_blocked = !!ext && ext.status === 'blocked';
      gates.toggles_all_off = served.execution_enabled === false && served.external_send_enabled === false && served.production_sync_enabled === false;
    } else {
      gates.environment_redacted = false; gates.no_forbidden_keys = false; gates.no_pii_values = false;
      gates.no_overclaim_in_allowed = false; gates.live_proven_zero = false; gates.exactly_two_live_limited = false;
      gates.neon_sync_blocked = false; gates.external_send_blocked = false; gates.toggles_all_off = false;
    }
  } finally {
    await new Promise((r) => server.close(r));
    setFlag(false); // leave the in-process flag OFF
  }

  // ── mutation guard (part 2): re-hash; assert nothing changed ──
  const HASH_AFTER = {}; for (const [k, rel] of Object.entries(PHASE_FILES)) HASH_AFTER[k] = sha256(rel);
  const mutated = Object.keys(PHASE_FILES).filter((k) => HASH_BEFORE[k] === null || HASH_BEFORE[k] !== HASH_AFTER[k]);
  gates.check_script_present = HASH_BEFORE.check !== null;
  gates.files_unchanged_during_run = mutated.length === 0;

  const overall_pass = Object.values(gates).every((v) => v === true);

  const result = {
    overall_pass,
    gates_passed: Object.values(gates).filter(Boolean).length,
    gates_total: Object.keys(gates).length,
    http_status: diagnostics,            // { offStatus:404, onStatus:200, noTokenStatus:401, ... }
    served_summary: servedSummary,       // counts only
    drift_field: driftField,             // null = no drift
    files_mutated_by_check: mutated,
    // informational only — derived from gates, NOT a pass condition
    informational_only_not_a_pass_condition: {
      note: 'Booted no monolith, opened no DB, made no external network call; the harness used Node built-ins + the real pure modules. Derived from the gates above.',
      booted_real_server_monolith: false,
      served_equals_pure_builder: gates.served_matches_builder === true,
      payload_clean: gates.no_forbidden_keys === true && gates.no_pii_values === true,
    },
    gates,
  };
  if (!overall_pass) result._note = 'FAIL-CLOSED: one or more live-contract gates unmet.';
  console.log('LIVE_CONTRACT_JSON:' + JSON.stringify(result, null, 1));
  process.exit(overall_pass ? 0 : 1);
})().catch((e) => {
  console.log('LIVE_CONTRACT_JSON:' + JSON.stringify({ overall_pass: false, fatal: String(e && e.message ? e.message : e) }, null, 1));
  process.exit(1);
});
