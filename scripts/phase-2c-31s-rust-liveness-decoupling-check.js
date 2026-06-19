// FILE: scripts/phase-2c-31s-rust-liveness-decoupling-check.js
// ─────────────────────────────────────────────────────────────────────────────
// Phase 2C.31S — Rust liveness-decoupling gate (repository-side truth only).
//
// Verifies, from committed source only, that the Rust sidecar creates its DB pool
// LAZILY (no eager connect before HTTP bind), that `/health` stays a pure DB-independent
// liveness route bound on 0.0.0.0 with Railway PORT precedence retained, that DB-backed
// operations still require a DB, and that the contract doc makes no "staging passed /
// production repaired / Node staging connected / 2C.32 can merge" overclaim.
//
// READ-ONLY & OFFLINE: reads + hashes files only; no network/DB/Railway/env-file access;
// writes nothing; spawns nothing; exposes no secret. Exit is FAIL-CLOSED, derived from the
// actual gate records (no mutable `overall` boolean).
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const AUTO = path.join(ROOT, 'vantro-automation-rs', 'src');
const CHECKER_PATH = __filename;
const F = {
  pool: path.join(AUTO, 'db', 'pool.rs'),
  main: path.join(AUTO, 'main.rs'),
  health: path.join(AUTO, 'api', 'health.rs'),
  apiMod: path.join(AUTO, 'api', 'mod.rs'),
  config: path.join(AUTO, 'config.rs'),
  doc: path.join(ROOT, 'docs', 'deployment', 'phase-2c-31s-rust-liveness-decoupling.md'),
};
const EXPECTED_GATES = 18;

const OVERCLAIM = [
  'staging deployment passed', 'staging passed', 'staging rust passed', 'staging rust deployment passed',
  'production rust repaired', 'production repaired', 'production rust is repaired',
  'node staging connected', 'node staging is connected',
  'phase 2c.32 can merge', '2c.32 can merge', 'safe to merge phase 2c.32',
  'production ready', 'production-ready', 'railway is proven', 'railway proven',
  'deployed successfully', 'health check passed', 'is now live',
];
const NEG = [' no ', 'no ', 'not ', 'never', 'pending', 'not yet', 'must not', 'cannot', 'does not',
  'is not', 'are not', 'nothing', 'asserted', 'without', 'n/a', 'not proven', 'not applied',
  'not repaired', 'not connected', 'not performed', 'must first', 'only after', 'remains blocked'];
const SECRET = [
  { n: 'email', re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i },
  { n: 'pg_url', re: /postgres(ql)?:\/\/[^\s]/i },
  { n: 'long_digits', re: /\d{10,}/ },
  { n: 'kv_secret', re: /(password|secret|token|api[_-]?key)\s*[=:]\s*["']?[A-Za-z0-9._\-]{8,}/i },
];
const FORBIDDEN_CHECKER = [
  'child' + '_process', 'spa' + 'wn(', 'exe' + 'cSync', 'exe' + 'c(', '.que' + 'ry(',
  'write' + 'FileSync', 'append' + 'FileSync', 'create' + 'WriteStream', '.conn' + 'ect(',
  'http.' + 'request', 'https.' + 'get', 'fet' + 'ch(', 'DATA' + 'BASE_URL', "require('h" + "ttps')",
];
const FORBIDDEN_SELF_KEYS = ['checker_pass', 'self_certified', 'is_safe', 'verified_safe', 'staging_passed', 'production_repaired'];

const read = (p) => fs.readFileSync(p, 'utf8');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const clauses = (t) => String(t).toLowerCase().split(/[\n.,;:!?|#]|—|--/).map((s) => s.trim()).filter(Boolean);
const hasNeg = (c) => NEG.some((n) => c.includes(n));

// eager-connect + db-url literals built by concatenation so this checker's own source
// never contains the contiguous token its offline self-scan (G14) forbids.
const EAGER_CONNECT = '.conn' + 'ect(';
const DBURL_REQUIRE = 'require("' + 'DATA' + 'BASE_URL")';

const results = [];
const add = (id, name, pass, detail) => results.push({ id, name, pass: pass === true, detail: detail || {} });

let loadError = null;
const txt = {};
const before = {};
try {
  for (const k of Object.keys(F)) txt[k] = read(F[k]);
  txt.checker = read(CHECKER_PATH);
  for (const k of Object.keys(F)) before[k] = sha(F[k]);
  before.checker = sha(CHECKER_PATH);
} catch (e) { loadError = String(e && e.message ? e.message : e); }

if (loadError) {
  for (let i = 1; i <= EXPECTED_GATES; i += 1) add('G' + String(i).padStart(2, '0'), 'load_error', false, { loadError });
} else {
  const pool = txt.pool; const main = txt.main; const health = txt.health; const apiMod = txt.apiMod; const cfg = txt.config; const doc = txt.doc;

  // G01 — file scope
  add('G01', 'file_scope', Object.keys(F).every((k) => fs.existsSync(F[k])) && fs.existsSync(CHECKER_PATH), {});
  // G02 — pool created lazily
  add('G02', 'pool_lazy', pool.includes('connect_lazy'), {});
  // G03 — pool has NO eager connect call (.connect_lazy( does not contain the eager token)
  add('G03', 'pool_no_eager_connect', !pool.includes(EAGER_CONNECT), {});
  // G04 — main does not await the pool before binding; pool still created; listener binds
  add('G04', 'main_no_await_pool', !/create_pool\([^)]*\)\s*\.await/.test(main) && main.includes('create_pool') && main.includes('TcpListener::bind'), {});
  // G05 — main has no direct eager DB connect
  add('G05', 'main_no_eager_connect', !main.includes(EAGER_CONNECT), {});
  // G06 — /health route present and mounted
  add('G06', 'health_route_present', /route\("\/health"/.test(health) && /health::routes\(\)/.test(apiMod), {});
  // G07 — /health handler DB/secret-independent
  add('G07', 'health_db_independent', !/sqlx|PgPool|\.fetch_|\.execute\(|State<|env::var|DATABASE|jwt|secret|create_pool/i.test(health), {});
  // G08 — /health not renamed: every route(...) in health.rs targets "/health"
  const healthRoutes = (health.match(/route\("([^"]+)"/g) || []).map((m) => m.replace(/route\("/, '').replace(/"$/, ''));
  add('G08', 'health_not_renamed', healthRoutes.length >= 1 && healthRoutes.every((r) => r === '/health'), { healthRoutes });
  // G09 — bind host 0.0.0.0, not localhost
  add('G09', 'bind_all_interfaces', /"0\.0\.0\.0:\{\}"/.test(main) && !/127\.0\.0\.1/.test(main), {});
  // G10 — PORT precedence retained (regression guard from 2C.31R)
  const iPort = cfg.indexOf('env::var("PORT")'); const iRap = cfg.indexOf('env::var("RUST_AUTOMATION_PORT")');
  add('G10', 'port_precedence', iPort >= 0 && iRap >= 0 && iPort < iRap && /unwrap_or\(3002\)/.test(cfg), { iPort, iRap });
  // G11 — DB still required (not bypassed): connection URL still validated + db-url var required
  add('G11', 'db_still_required', cfg.includes(DBURL_REQUIRE) && pool.includes('map_err'), {});
  // G12 — no overclaim (doc, negation-aware)
  const ocHits = [];
  clauses(doc).forEach((c) => OVERCLAIM.forEach((p) => { if (c.includes(p) && !hasNeg(c)) ocHits.push(p); }));
  add('G12', 'no_overclaim', ocHits.length === 0, { hits: ocHits.slice(0, 6) });
  // G13 — no secrets/PII (doc + checker for email/pg/digits; kv_secret in doc only)
  const secHits = [
    ...SECRET.filter((s) => s.n !== 'kv_secret' && s.re.test(doc + '\n' + txt.checker)).map((s) => s.n),
    ...SECRET.filter((s) => s.n === 'kv_secret' && s.re.test(doc)).map((s) => s.n),
  ];
  add('G13', 'no_secrets', secHits.length === 0, { hits: secHits });
  // G14 — checker performs no network/DB/Railway runtime side effects
  add('G14', 'checker_offline', !FORBIDDEN_CHECKER.some((t) => txt.checker.includes(t)), {});
  // G15 — scope boundary declared (no server.js/migration/frontend/Runtime Truth drift)
  add('G15', 'scope_boundary', ['server.js', 'migration', 'frontend', 'Runtime Truth'].every((t) => doc.includes(t)), {});
  // G16 — no self-attestation: files non-empty + no forbidden self-cert keys in doc
  const filesNonEmpty = Object.keys(F).every((k) => txt[k] && txt[k].length > 0);
  const dl = doc.toLowerCase();
  add('G16', 'no_self_attestation', filesNonEmpty && !FORBIDDEN_SELF_KEYS.some((k) => doc.includes(k) || dl.includes(k.replace(/_/g, ' '))), {});
  // G17 — no vacuous pass
  add('G17', 'no_vacuous', OVERCLAIM.length > 0 && Object.keys(F).length >= 6 && pool.length > 0 && main.length > 0 && health.length > 0, {});
  // G18 — files unchanged during run
  const after = {}; for (const k of Object.keys(F)) after[k] = sha(F[k]); after.checker = sha(CHECKER_PATH);
  add('G18', 'files_unchanged', Object.keys(before).filter((k) => before[k] !== after[k]).length === 0, {});
}

// ── fail-closed aggregation (exit derived from gate records; no mutable `overall`) ──
const failed = results.filter((r) => !r.pass);
const uniqueIdCount = new Set(results.map((r) => r.id)).size;
const countOk = results.length === EXPECTED_GATES && uniqueIdCount === EXPECTED_GATES;

const summary = {
  phase: '2C.31S',
  overall_pass: !loadError && failed.length === 0 && countOk, // display-only; exit re-derives from `failed`
  gates_passed: results.length - failed.length,
  gates_total: results.length,
  expected_gate_count: EXPECTED_GATES,
  unique_gate_ids: uniqueIdCount,
  load_error: loadError,
  health_route: '/health',
  failed_gate_ids: failed.map((r) => r.id),
  failed_gates: failed.map((r) => ({ id: r.id, name: r.name, detail: r.detail })),
};
console.log('LIVENESS_DECOUPLING_JSON:' + JSON.stringify(summary, null, 1));

if (loadError || failed.length > 0 || !countOk) {
  const why = loadError ? ('load_error ' + loadError)
    : (failed.length > 0 ? ('failed=[' + failed.map((f) => f.id).join(',') + ']')
      : ('gate_integrity gates=' + results.length + '/' + EXPECTED_GATES + ' unique=' + uniqueIdCount));
  console.error('❌ LIVENESS_DECOUPLING_FAIL: ' + why + '.');
  process.exit(failed.length || 1);
}
console.log('✅ LIVENESS_DECOUPLING_PASS: all ' + EXPECTED_GATES + ' repository-side gates passed.');
process.exit(0);
