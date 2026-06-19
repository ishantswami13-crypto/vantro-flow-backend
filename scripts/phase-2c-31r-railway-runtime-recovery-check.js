// FILE: scripts/phase-2c-31r-railway-runtime-recovery-check.js
// ─────────────────────────────────────────────────────────────────────────────
// Phase 2C.31R — Railway Runtime Recovery gate (repository-side truth only).
//
// Verifies, from committed repository files only, that the Rust sidecar's
// build/start/health/port contract is internally consistent and Railway-compatible,
// that Node and Rust service configs stay separated in this monorepo, and that the
// deployment contract document makes no "already applied / deployment passed /
// production ready" overclaim. It re-derives facts from the actual source/config/
// docs — it does NOT trust self-declared booleans.
//
// READ-ONLY & OFFLINE: reads files + hashes them; opens no network, DB, Railway, or
// environment file; writes nothing; spawns no service; exposes no secret. The final
// PASS is reachable only after every gate passes.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const AUTO = path.join(ROOT, 'vantro-automation-rs');
const CHECKER_PATH = __filename;
const PROBE_PATH = path.join(ROOT, 'scripts', 'phase-2c-31r-rust-health-local-probe.js');

const F = {
  cargo: path.join(AUTO, 'Cargo.toml'),
  rwRust: path.join(AUTO, 'railway.toml'),
  nixRust: path.join(AUTO, 'nixpacks.toml'),
  config: path.join(AUTO, 'src', 'config.rs'),
  main: path.join(AUTO, 'src', 'main.rs'),
  health: path.join(AUTO, 'src', 'api', 'health.rs'),
  apiMod: path.join(AUTO, 'src', 'api', 'mod.rs'),
  rwRoot: path.join(ROOT, 'railway.toml'),
  nixRoot: path.join(ROOT, 'nixpacks.toml'),
  doc: path.join(ROOT, 'docs', 'deployment', 'phase-2c-31r-railway-runtime-recovery.md'),
};

const EXPECTED_GATES = 26;
const EXPECTED_SERVICES = ['vantro-flow-backend', 'vantro-automation-prod', 'vantro-node-staging', 'vantro-automation-staging'];

// overclaim phrases scanned in the DOC only (negation-aware)
const OVERCLAIM = [
  'settings are applied', 'settings applied', 'railway settings applied', 'already applied',
  'staging deployment passed', 'deployment passed', 'deployed successfully', 'is now deployed',
  'health check passed', 'health check passes', 'production ready', 'production-ready',
  'is live in production', 'verified in production', 'fix is applied in railway', 'is healthy in production',
];
const NEG = [' no ', 'no ', 'not ', 'never', 'pending', 'not yet', 'must ', 'intended', 'proposal',
  'requires', 'do not', 'without', 'n/a', 'would ', 'should ', 'after an approved', 'recommended',
  'nothing', 'claimed', 'asserted', 'propose', 'future'];

// secret/PII patterns scanned in doc + probe
const SECRET = [
  { n: 'email', re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i },
  { n: 'pg_url', re: /postgres(ql)?:\/\/[^\s]/i },
  { n: 'long_digits', re: /\d{10,}/ },
  { n: 'kv_secret', re: /(password|secret|token|api[_-]?key)\s*[=:]\s*["']?[A-Za-z0-9._\-]{6,}/i },
];

// forbidden runtime tokens for the CHECKER itself (concatenated so this file never
// contains the contiguous literal → no self-trip)
const FORBIDDEN_CHECKER = [
  'child' + '_process', 'spa' + 'wn(', 'exe' + 'cSync', 'exe' + 'c(', '.que' + 'ry(',
  'write' + 'FileSync', 'append' + 'FileSync', 'create' + 'WriteStream', '.conn' + 'ect(',
  'http.' + 'request', 'https.' + 'get', 'fet' + 'ch(', 'DATA' + 'BASE_URL', "require('h" + "ttps')",
];
const FORBIDDEN_SELF_KEYS = ['checker_pass', 'self_certified', 'is_safe', 'verified_safe', 'production_ready', 'deployment_passed'];

const read = (p) => fs.readFileSync(p, 'utf8');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
// strip TOML line comments so directive extraction never matches commentary
// (e.g. a comment that quotes `startCommand = "node server.js"` or mentions cargo).
// Use /#.*/ (no $ anchor): files are CRLF, and `.` won't cross \r while `$` won't
// anchor before \r, so /#.*$/ would leave commented directives intact on CRLF lines.
const stripToml = (s) => String(s).split('\n').map((l) => l.replace(/#.*/, '')).join('\n');
const clauses = (t) => String(t).toLowerCase().split(/[\n.,;:!?|#]|—|--/).map((s) => s.trim()).filter(Boolean);
const hasNeg = (c) => NEG.some((n) => c.includes(n));

const results = [];
const add = (id, name, pass, detail) => results.push({ id, name, pass: pass === true, detail: detail || {} });

let loadError = null;
let txt = {};
const before = {};
try {
  for (const k of Object.keys(F)) txt[k] = read(F[k]);
  txt.checker = read(CHECKER_PATH);
  txt.probe = fs.existsSync(PROBE_PATH) ? read(PROBE_PATH) : '';
  for (const k of Object.keys(F)) before[k] = sha(F[k]);
  before.checker = sha(CHECKER_PATH);
} catch (e) {
  loadError = String(e && e.message ? e.message : e);
}

if (loadError) {
  for (let i = 1; i <= EXPECTED_GATES; i += 1) add('G' + String(i).padStart(2, '0'), 'load_error', false, { loadError });
} else {
  const norm = (s) => s.replace(/[ \t]+/g, ' ');
  const cargo = norm(txt.cargo); const rwRust = txt.rwRust; const nixRust = txt.nixRust;
  const cfg = txt.config; const main = txt.main; const health = txt.health; const apiMod = txt.apiMod;
  const rwRoot = txt.rwRoot; const nixRoot = txt.nixRoot; const doc = txt.doc;

  // G01 — file scope
  add('G01', 'file_scope', Object.keys(F).every((k) => fs.existsSync(F[k])) && fs.existsSync(CHECKER_PATH), {});
  // G02 — Rust manifest declares the server bin
  add('G02', 'bin_declared', /\[\[bin\]\]/.test(cargo) && /name\s*=\s*"vantro-automation"/.test(cargo) &&
    /path\s*=\s*"src\/main\.rs"/.test(cargo) && /required-features\s*=\s*\["server"\]/.test(cargo), {});
  // G03 — declared bin source exists
  add('G03', 'bin_source_exists', fs.existsSync(F.main), {});
  // G04 — nixpacks build copies the REAL artifact to the runtime path
  add('G04', 'nixpacks_copies_real_binary', /cp\s+target\/[^\s]*release\/vantro-automation\s+bin\/cortex-core/.test(nixRust), {});
  // G05 — start command consistent across both Rust configs and == /app/bin/cortex-core
  const rwStart = (stripToml(rwRust).match(/startCommand\s*=\s*"([^"]+)"/) || [])[1];
  const nixStart = (stripToml(nixRust).match(/\[start\][\s\S]*?cmd\s*=\s*"([^"]+)"/) || [])[1];
  add('G05', 'start_cmd_consistent', rwStart === '/app/bin/cortex-core' && nixStart === '/app/bin/cortex-core', { rwStart, nixStart });
  // G06 — start does not reference target/release directly (slim runtime)
  add('G06', 'start_not_target_release', !!rwStart && !rwStart.includes('target/'), {});
  // G07 — health route present + mounted + configured
  add('G07', 'health_route', /route\("\/health"/.test(health) && /health::routes\(\)/.test(apiMod) && /healthcheckPath\s*=\s*"\/health"/.test(rwRust), {});
  // G08 — health handler DB/secret-independent
  add('G08', 'health_db_independent', !/sqlx|PgPool|\.fetch_|\.execute\(|State<|env::var|DATABASE|jwt|secret/i.test(health), {});
  // G09 — bind 0.0.0.0, not localhost
  add('G09', 'bind_all_interfaces', /"0\.0\.0\.0:\{\}"/.test(main) && !/127\.0\.0\.1/.test(main), {});
  // G10 — PORT precedence Railway-compatible (PORT before RUST_AUTOMATION_PORT)
  const iPort = cfg.indexOf('env::var("PORT")');
  const iRap = cfg.indexOf('env::var("RUST_AUTOMATION_PORT")');
  add('G10', 'port_precedence', iPort >= 0 && iRap >= 0 && iPort < iRap && /unwrap_or\(3002\)/.test(cfg), { iPort, iRap });
  // G11 — health timeout configured
  add('G11', 'health_timeout', /healthcheckTimeout\s*=\s*30/.test(rwRust), {});
  // G12 — root railway is Node
  add('G12', 'root_railway_node', /startCommand\s*=\s*"node server\.js"/.test(rwRoot), {});
  // G13 — root nixpacks is Node
  add('G13', 'root_nixpacks_node', /providers\s*=\s*\["node"\]/.test(nixRoot), {});
  // G14 — Rust nixpacks is Rust
  add('G14', 'rust_nixpacks_rust', /providers\s*=\s*\["rust"\]/.test(nixRust), {});
  // G15 — no Rust collision in root configs (root must not build Rust)
  const rootCombined = (stripToml(rwRoot) + '\n' + stripToml(nixRoot)).toLowerCase();
  add('G15', 'no_root_rust_collision', !/cargo|cortex-core|vantro-automation|providers\s*=\s*\["rust"\]/.test(rootCombined), {});
  // G16 — Rust railway points config at the Rust nixpacks
  add('G16', 'rust_config_path', /nixpacksConfigPath\s*=\s*"vantro-automation-rs\/nixpacks\.toml"/.test(rwRust), {});
  // G17 — doc documents all four services
  add('G17', 'doc_services', EXPECTED_SERVICES.every((s) => doc.includes(s)), {});
  // G18 — doc documents liveness/readiness/rollback/owner-approval/health/port
  const dl = doc.toLowerCase();
  add('G18', 'doc_contract_terms', ['liveness', 'readiness', 'rollback', 'owner', '/health', 'port'].every((t) => dl.includes(t)), {});
  // G19/G20 — no overclaim (negation-aware, doc only)
  const ocHits = [];
  clauses(doc).forEach((c) => OVERCLAIM.forEach((p) => { if (c.includes(p) && !hasNeg(c)) ocHits.push(p); }));
  add('G19', 'no_applied_overclaim', ocHits.filter((p) => /applied|passed|deployed|now deployed/.test(p)).length === 0, { hits: ocHits.slice(0, 6) });
  add('G20', 'no_production_overclaim', ocHits.filter((p) => /production|live|healthy/.test(p)).length === 0, { hits: ocHits.slice(0, 6) });
  // G21 — no secrets/PII. kv_secret scans the DOC only (the probe legitimately sets
  // throwaway, clearly-non-secret test creds in env); email/pg_url/long-digits scan both.
  const secHits = [
    ...SECRET.filter((s) => s.n !== 'kv_secret' && s.re.test(doc + '\n' + txt.probe)).map((s) => s.n),
    ...SECRET.filter((s) => s.n === 'kv_secret' && s.re.test(doc)).map((s) => s.n),
  ];
  add('G21', 'no_secrets', secHits.length === 0, { hits: secHits });
  // G22 — checker performs no network/DB/Railway runtime side effects
  add('G22', 'checker_offline', !FORBIDDEN_CHECKER.some((t) => txt.checker.includes(t)), {});
  // G23 — probe is localhost-only, no .env.staging, has a timeout
  const probe = txt.probe;
  add('G23', 'probe_safe', probe.length > 0 && probe.includes('127.0.0.1') && !probe.includes('.env.staging') &&
    !/postgres(ql)?:\/\//i.test(probe) && /(setTimeout|timeout)/i.test(probe), { probe_present: probe.length > 0 });
  // G24 — no self-attestation: real files non-empty + no forbidden self-cert keys in doc
  const filesNonEmpty = Object.keys(F).every((k) => txt[k] && txt[k].length > 0);
  add('G24', 'no_self_attestation', filesNonEmpty && !FORBIDDEN_SELF_KEYS.some((k) => dl.includes(k.replace(/_/g, ' ')) || doc.includes(k)), {});
  // G25 — no vacuous pass: structure non-empty
  add('G25', 'no_vacuous', EXPECTED_SERVICES.length === 4 && Object.keys(F).length >= 10 && OVERCLAIM.length > 0, {});
  // G26 — files unchanged during run
  const after = {}; for (const k of Object.keys(F)) after[k] = sha(F[k]); after.checker = sha(CHECKER_PATH);
  const mutated = Object.keys(before).filter((k) => before[k] !== after[k]);
  add('G26', 'files_unchanged', mutated.length === 0, { mutated });
}

// ── fail-closed aggregation ─────────────────────────────────────────────────────
// The exit is derived DIRECTLY from the actual gate records — there is NO standalone
// mutable `overall` boolean that the exit branches on. A failed gate, a wrong gate
// count, duplicate gate ids, or a load error each independently force a non-zero exit.
// Hardcoding the display `overall_pass` field to true CANNOT reach the success path,
// because the success path is guarded below by `failed.length`/count/uniqueness.
const failed = results.filter((r) => !r.pass);
const uniqueIdCount = new Set(results.map((r) => r.id)).size;
const countOk = results.length === EXPECTED_GATES && uniqueIdCount === EXPECTED_GATES;

const summary = {
  phase: '2C.31R',
  // display-only — the exit logic re-derives from `failed` and does NOT read this field
  overall_pass: !loadError && failed.length === 0 && countOk,
  gates_passed: results.length - failed.length,
  gates_total: results.length,
  expected_gate_count: EXPECTED_GATES,
  unique_gate_ids: uniqueIdCount,
  load_error: loadError,
  rust_package: 'vantro-automation-rs',
  rust_binary: 'vantro-automation',
  start_path: '/app/bin/cortex-core',
  health_route: '/health',
  expected_services: EXPECTED_SERVICES,
  failed_gate_ids: failed.map((r) => r.id),
  failed_gates: failed.map((r) => ({ id: r.id, name: r.name, detail: r.detail })),
};
console.log('RAILWAY_RECOVERY_JSON:' + JSON.stringify(summary, null, 1));

if (loadError || failed.length > 0 || !countOk) {
  const why = loadError
    ? ('load_error ' + loadError)
    : (failed.length > 0
      ? ('failed=[' + failed.map((f) => f.id).join(',') + ']')
      : ('gate_integrity gates=' + results.length + '/' + EXPECTED_GATES + ' unique=' + uniqueIdCount));
  console.error('❌ RAILWAY_RECOVERY_FAIL: ' + why + '.');
  process.exit(failed.length || 1);
}
console.log('✅ RAILWAY_RECOVERY_PASS: all ' + EXPECTED_GATES + ' repository-side gates passed.');
process.exit(0);
