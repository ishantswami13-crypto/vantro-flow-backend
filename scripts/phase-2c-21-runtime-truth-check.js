#!/usr/bin/env node
'use strict';
/*
 * Phase 2C.21 — Runtime Truth foundation check (HARDENED).
 * ─────────────────────────────────────────────────────────────────────────────
 * This checker proves safety from TWO independent sources of evidence:
 *   (A) STATIC SOURCE INSPECTION of the runtime/response-building files
 *       (lib/config/atlasRuntimeTruth.js, lib/services/runtimeTruth.service.js)
 *       and of the extracted /api/atlas/runtime-truth endpoint block in server.js
 *       — scanning for forbidden DB / network / filesystem / child-process /
 *       process.env / secret patterns.
 *   (B) RUNTIME OBJECT INVARIANTS built from the PURE service (no DB, no network),
 *       independently re-tallied from the raw registry arrays and deep-scanned for
 *       PII / secret shapes in keys and values.
 *
 * IT DOES NOT trust any self-attestation field. There is NO "production_touched:
 * false" literal feeding the verdict. Where a self-attestation-style claim is
 * shown at all, it is DERIVED from the independent gates and lives in an
 * `informational_only_not_a_pass_condition` block that `overall_pass` never reads.
 *
 * A SHA-256 mutation guard hashes every Phase 2C.21 file before and after the run
 * and fails if the checker itself changed anything on disk.
 *
 * It opens NO database, performs NO network call, writes NO file, and prints
 * COUNTS / BOOLEANS / HASHES only — never secrets, DB URLs, JWTs, PII, or raw rows.
 *
 * FAIL-CLOSED: missing file, missing route, unknown status, inconsistent count, or
 * any forbidden pattern in a Phase 2C.21 runtime file makes its gate false and the
 * overall result false. No "unknown but pass".
 *
 * USAGE:
 *   node scripts/phase-2c-21-runtime-truth-check.js
 *   #   exit 0 = all gates pass; exit 1 = at least one gate fails (fail-closed)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

function read(rel) { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return ''; } }
function exists(rel) { try { fs.accessSync(path.join(ROOT, rel)); return true; } catch (e) { return false; } }
function sha256(rel) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex'); }
  catch (e) { return null; }
}
const all = (obj) => Object.values(obj).every((v) => v === true);
const reAny = (s, res) => res.some((re) => re.test(s));

// Phase 2C.21 changed/new files — used for the hash guard and the path-scope gate.
const PHASE_FILES = {
  config:  'lib/config/atlasRuntimeTruth.js',
  service: 'lib/services/runtimeTruth.service.js',
  checker: 'scripts/phase-2c-21-runtime-truth-check.js',
  doc:     'docs/agent-mesh/phase-2c-21-runtime-truth-api.md',
  flags:   'lib/featureFlags.js',
  server:  'server.js',
};

// ── MUTATION GUARD (part 1): hash every Phase 2C.21 file BEFORE any work ───────
const HASH_BEFORE = {};
for (const [k, rel] of Object.entries(PHASE_FILES)) HASH_BEFORE[k] = sha256(rel);

// ── read source (missing → '' so every assertion fails closed) ────────────────
const src = {
  config:  read(PHASE_FILES.config),
  service: read(PHASE_FILES.service),
  flags:   read(PHASE_FILES.flags),
  server:  read(PHASE_FILES.server),
};

// ── load the PURE service + registry (no DB / no network — safe to require) ────
let svc = null, registry = null, truth = null, validateRes = { ok: false, offenders: [] }, loadError = null;
try {
  svc = require(path.join(ROOT, PHASE_FILES.service));
  registry = require(path.join(ROOT, PHASE_FILES.config));
  truth = svc.buildRuntimeTruth({ generatedAt: '2026-01-01T00:00:00.000Z' });
  validateRes = svc.validateStatuses();
} catch (e) { loadError = String(e && e.message ? e.message : e); }

const ALLOWED = ['live_proven', 'live_limited', 'planned', 'blocked'];
const entities = truth ? [...truth.packs, ...truth.agents, ...truth.workflows] : [];

// ── extract the endpoint block from server.js (fail-closed if markers absent) ──
const EP_START = src.server.indexOf('ATLAS RUNTIME TRUTH');
const EP_END   = EP_START > -1 ? src.server.indexOf('app.listen(PORT', EP_START) : -1;
const endpointBlock = (EP_START > -1 && EP_END > -1) ? src.server.slice(EP_START, EP_END) : '';

// ── Gate 01 — Assets exist + pure service loads ───────────────────────────────
const g01 = {
  config_exists:        exists(PHASE_FILES.config),
  service_exists:       exists(PHASE_FILES.service),
  doc_exists:           exists(PHASE_FILES.doc),
  service_loads:        truth !== null && loadError === null,
  endpoint_block_found: endpointBlock.length > 0,
};

// ── Gate 02 — Strict status enum only (built AND raw registry) ─────────────────
const rawAll = registry ? [...registry.PACKS, ...registry.AGENTS, ...registry.WORKFLOWS] : [];
const g02 = {
  validate_ok:                 validateRes.ok === true,
  built_statuses_allowed:      entities.length > 0 && entities.every((e) => ALLOWED.includes(e.status)),
  registry_statuses_allowed:   rawAll.length > 0 && rawAll.every((e) => ALLOWED.includes(e.status)),
  enum_is_exactly_four:        !!registry && Array.isArray(registry.ALLOWED_STATUSES) &&
                               registry.ALLOWED_STATUSES.length === 4 &&
                               ALLOWED.every((s) => registry.ALLOWED_STATUSES.includes(s)),
};

// ── Gate 03 — Counts independently recomputed from the RAW registry arrays ─────
function tally(arr) {
  const c = { live_proven: 0, live_limited: 0, planned: 0, blocked: 0 };
  for (const e of arr) if (c[e.status] !== undefined) c[e.status] += 1;
  return c;
}
const rawTally = tally(rawAll);
const s = truth ? truth.summary : {};
const liveEntities = entities.filter((e) => e.status === 'live_proven' || e.status === 'live_limited');
const g03 = {
  packs_total_matches_registry:     !!truth && !!registry && s.packs_total === registry.PACKS.length && s.packs_total === truth.packs.length,
  agents_total_matches_registry:    !!truth && !!registry && s.agents_total === registry.AGENTS.length && s.agents_total === truth.agents.length,
  workflows_total_matches_registry: !!truth && !!registry && s.workflows_total === registry.WORKFLOWS.length && s.workflows_total === truth.workflows.length,
  live_proven_matches_raw:          !!truth && s.live_proven === rawTally.live_proven,
  live_limited_matches_raw:         !!truth && s.live_limited === rawTally.live_limited,
  planned_matches_raw:              !!truth && s.planned === rawTally.planned,
  blocked_matches_raw:              !!truth && s.blocked === rawTally.blocked,
  live_proven_is_zero:              !!truth && s.live_proven === 0,
  counts_sum_to_total:              !!truth && (s.live_proven + s.live_limited + s.planned + s.blocked) === rawAll.length,
  only_live_status_counted_live:    !!truth && liveEntities.length === (s.live_proven + s.live_limited) &&
                                    liveEntities.every((e) => e.status === 'live_proven' || e.status === 'live_limited'),
};

// ── Gate 04 — Unsafe toggles disabled (built object + source default-off) ──────
const g04 = {
  execution_disabled:        !!truth && truth.execution_enabled === false,
  production_sync_disabled:   !!truth && truth.production_sync_enabled === false,
  external_send_disabled:     !!truth && truth.external_send_enabled === false,
  environment_redacted:       !!truth && truth.environment === 'safe_redacted',
  external_flag_default_off:  /external_message_sending_enabled\s*:\s*process\.env\.FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED\s*===\s*'true'/.test(src.flags),
};

// ── Gate 05 — Owner Briefing references real 2C.19/2C.20 proof, not a fake claim ─
const ob = truth ? truth.agents.find((a) => a.id === 'core.owner_briefing') : null;
const g05 = {
  present:          !!ob,
  is_live_limited:  !!ob && ob.status === 'live_limited',
  references_2c19:  !!ob && ob.proof_refs.includes('phase-2c-19-owner-briefing-evidence-gate'),
  references_2c20:  !!ob && ob.proof_refs.includes('phase-2c-20-production-readiness-gate'),
  not_live_proven:  !!ob && ob.status !== 'live_proven',
};

// ── Gate 06 — Neon→Cortex pipeline blocked for production canary ──────────────
const sync = truth ? truth.workflows.find((w) => w.id === 'workflow.neon_to_cortex_sync') : null;
const g06 = {
  present:       !!sync,
  blocked:       !!sync && sync.status === 'blocked',
  reason_canary: !!sync && sync.blocked_reason === 'production_canary',
};

// ── Gate 07 — Overclaim regression: blocked phrases must NOT appear in allowed ──
const lc = truth ? truth.launch_claims : { allowed: [], blocked: [] };
const allowedJoined = (lc.allowed || []).join(' || ').toLowerCase();
const blockedJoined = (lc.blocked || []).join(' || ').toLowerCase();
const OVERCLAIM_PHRASES = [
  '216 live agents',
  'fully autonomous finance operations',
  'production-live neon',
  'live external whatsapp',
  'bank-grade',
  'military-grade',
  '100+ live',
  '200+ live',
];
const overclaimInAllowed = OVERCLAIM_PHRASES.filter((p) => allowedJoined.includes(p));
const g07 = {
  has_allowed_claims:       Array.isArray(lc.allowed) && lc.allowed.length > 0,
  has_blocked_claims:       Array.isArray(lc.blocked) && lc.blocked.length > 0,
  no_overclaim_in_allowed:  overclaimInAllowed.length === 0,
  blocks_216_live:          blockedJoined.includes('216 live agents'),
  blocks_fully_autonomous:  blockedJoined.includes('fully autonomous'),
  blocks_prod_sync:         /neon.*cortex/.test(blockedJoined),
  blocks_external_send:     /external|whatsapp|twilio/.test(blockedJoined),
};

// ── Gate 08 — Independent static scan of runtime files for forbidden patterns ──
// Scanned: config + service + extracted endpoint block. (NOT the checker itself —
// it legitimately contains these tokens as search literals — and NOT the doc.)
const scanTargets = { config: src.config, service: src.service, endpoint: endpointBlock };
const FORBIDDEN = [
  ['pg_require',     /require\(\s*['"]pg['"]\s*\)/],
  ['postgres',      /postgres/i],
  ['Pool',          /\bPool\b/],
  ['Client',        /\bClient\b/],
  ['createClient',  /createClient/],
  ['supabase',      /supabase/i],
  ['fetch_call',    /\bfetch\s*\(/],
  ['axios',         /axios/i],
  ['http_request',  /https?\.request/],
  ['child_process', /child_process/],
  ['exec_call',     /\bexec\s*\(/],
  ['spawn_call',    /\bspawn\s*\(/],
  ['writeFile',     /writeFile/],
  ['appendFile',    /appendFile/],
  ['unlink',        /unlink/],
  ['rm_call',       /\brm\s*\(/],
  ['process_env',   /process\.env/],
  ['db_url',        /postgres(?:ql)?:\/\//i],
  ['jwt',           /eyJ[A-Za-z0-9_-]{10,}/],
  ['secret_env',    /process\.env\.[A-Za-z_]*(SECRET|TOKEN|PASSWORD|KEY|URL)/],
  ['private_key',   /BEGIN [A-Z ]*PRIVATE KEY/],
];
const forbiddenViolations = [];
for (const [tname, text] of Object.entries(scanTargets)) {
  for (const [pname, re] of FORBIDDEN) if (re.test(text)) forbiddenViolations.push(`${tname}:${pname}`);
}
const g08 = {
  config_present:        src.config.length > 0,
  service_present:       src.service.length > 0,
  endpoint_present:      endpointBlock.length > 0,
  no_forbidden_patterns: forbiddenViolations.length === 0,
};

// ── Gate 09 — Deep PII/secret scan of the BUILT runtime object (keys + values) ─
function walk(node, keys, vals) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, keys, vals)); return; }
  if (typeof node === 'object') { for (const [k, v] of Object.entries(node)) { keys.push(k); walk(v, keys, vals); } return; }
  if (typeof node === 'string') vals.push(node);
}
const OBJ_KEYS = [], OBJ_VALS = [];
if (truth) walk(truth, OBJ_KEYS, OBJ_VALS);
const FORBIDDEN_KEY = /(database_url|jwt_secret|supabase|railway|password|secret|token)/i;
const VALUE_PATTERNS = [
  /postgres(?:ql)?:\/\//i,                       // DB URL
  /eyJ[A-Za-z0-9_-]{10,}/,                        // JWT
  /\bbearer\s+[A-Za-z0-9._-]{10,}/i,              // bearer token
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, // email
  /\b\d{10,}\b/,                                  // long digit run (phone / id)
  /\+\d[\d -]{8,}\d/,                             // international phone
  /\b(?:sk|rk|pk)_live_[A-Za-z0-9]+/i,            // Stripe live key
  /\brzp_live_[A-Za-z0-9]+/i,                     // Razorpay live key
  /\bsk-[A-Za-z0-9]{16,}/,                        // generic API key
  /BEGIN [A-Z ]*PRIVATE KEY/,                     // private key
];
const badKeyCount = OBJ_KEYS.filter((k) => FORBIDDEN_KEY.test(k)).length;
const badValCount = OBJ_VALS.filter((v) => reAny(v, VALUE_PATTERNS)).length;
const g09 = {
  built_object_present: !!truth,
  no_forbidden_keys:    badKeyCount === 0,
  no_pii_in_values:     badValCount === 0,
  environment_safe:     !!truth && truth.environment === 'safe_redacted',
};

// ── Gate 10 — Endpoint source: flag-gated, read-only, calls service not DB ─────
const flagIdx  = endpointBlock.indexOf('runtime_truth_api_enabled');
const fourIdx  = endpointBlock.indexOf('status(404)');
const buildIdx = endpointBlock.indexOf('buildRuntimeTruth(');
const g10 = {
  path_present:               endpointBlock.includes("'/api/atlas/runtime-truth'"),
  auth_middleware_used:       /app\.get\(\s*'\/api\/atlas\/runtime-truth'\s*,\s*authMiddleware/.test(endpointBlock),
  flag_gate_present:          flagIdx > -1,
  returns_404_when_disabled:  fourIdx > -1,
  flag_checked_before_build:  flagIdx > -1 && buildIdx > -1 && flagIdx < buildIdx,
  fourohfour_before_build:    fourIdx > -1 && buildIdx > -1 && fourIdx < buildIdx,
  calls_runtime_truth_service: endpointBlock.includes('runtimeTruth.service') && buildIdx > -1,
  no_db_or_sync_in_endpoint:  !/getPool|pool\.query|supabase|\bneon\b|sync_batch|production_sync/i.test(endpointBlock),
};

// ── Gate 11 — Feature flag source: defined, default OFF, no new default-ON flag ─
let flagDefaultOffRuntime = false;
try { flagDefaultOffRuntime = require(path.join(ROOT, PHASE_FILES.flags)).isEnabled('runtime_truth_api_enabled') === false; } catch (e) {}
const defaultOnCount = (src.flags.match(/!==\s*'false'/g) || []).length;
const g11 = {
  flag_name_present:        /runtime_truth_api_enabled/.test(src.flags) && /FEATURE_RUNTIME_TRUTH_API_ENABLED/.test(src.flags),
  flag_default_off_source:  /runtime_truth_api_enabled\s*:\s*process\.env\.FEATURE_RUNTIME_TRUTH_API_ENABLED\s*===\s*'true'/.test(src.flags),
  flag_default_off_runtime: flagDefaultOffRuntime === true,
  external_send_default_off:/external_message_sending_enabled\s*:\s*process\.env\.FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED\s*===\s*'true'/.test(src.flags),
  // exactly one default-ON flag exists and it is the documented prompt_guard —
  // proves this phase introduced no default-ON external-send / production-sync flag.
  only_prompt_guard_default_on: defaultOnCount === 1 &&
    /prompt_guard_enabled\s*:\s*process\.env\.FEATURE_PROMPT_GUARD_ENABLED\s*!==\s*'false'/.test(src.flags),
};

// ── Gate 12 — Conservative labeling (exactly the two proven live_limited items) ─
const liveLimitedIds = entities.filter((e) => e.status === 'live_limited').map((e) => e.id).sort();
const EXPECTED_LIVE = ['core.owner_briefing', 'workflow.owner_briefing_preview'].sort();
const dqA = truth ? truth.agents.find((a) => a.id === 'core.data_quality') : null;
const pgA = truth ? truth.agents.find((a) => a.id === 'core.policy_guard') : null;
const crA = truth ? truth.agents.find((a) => a.id === 'core.cost_router') : null;
const g12 = {
  exactly_two_live_limited:  liveLimitedIds.length === 2,
  live_limited_ids_exact:    JSON.stringify(liveLimitedIds) === JSON.stringify(EXPECTED_LIVE),
  data_quality_planned:      !!dqA && dqA.status === 'planned',
  policy_guard_planned:      !!pgA && pgA.status === 'planned',
  cost_router_planned:       !!crA && crA.status === 'planned',
  no_pack_live_limited:      !!truth && truth.packs.every((p) => p.status !== 'live_limited'),
};

// ── Gate 13 — Path scope: no env / Railway / frontend file in the touched set ──
const TOUCHED = Object.values(PHASE_FILES);
const g13 = {
  no_env_file:        !TOUCHED.some((p) => /\.env(\.|$)/.test(p)),
  no_railway_file:    !TOUCHED.some((p) => /railway\.toml|nixpacks\.toml/.test(p)),
  no_frontend_file:   !TOUCHED.some((p) => /frontend|vercel/i.test(p)),
  backend_paths_only: TOUCHED.every((p) => /^(lib\/|scripts\/|docs\/|server\.js$)/.test(p)),
};

// ── MUTATION GUARD (part 2): re-hash AFTER all checks; assert nothing changed ──
const HASH_AFTER = {};
for (const [k, rel] of Object.entries(PHASE_FILES)) HASH_AFTER[k] = sha256(rel);
const mutatedByChecker = Object.keys(PHASE_FILES)
  .filter((k) => HASH_BEFORE[k] === null || HASH_AFTER[k] === null || HASH_BEFORE[k] !== HASH_AFTER[k]);
const g14 = {
  all_hashes_captured:        Object.values(HASH_BEFORE).every((h) => typeof h === 'string') &&
                              Object.values(HASH_AFTER).every((h) => typeof h === 'string'),
  files_unchanged_during_run: mutatedByChecker.length === 0,
};

// ── roll up ───────────────────────────────────────────────────────────────────
const GATES = {
  '01_assets_exist':               g01,
  '02_status_enum_only':           g02,
  '03_counts_independent':         g03,
  '04_unsafe_toggles_disabled':    g04,
  '05_owner_briefing_proof_gated': g05,
  '06_neon_cortex_blocked':        g06,
  '07_overclaim_regression':       g07,
  '08_no_forbidden_source_patterns': g08,
  '09_no_pii_in_runtime_object':   g09,
  '10_endpoint_source':            g10,
  '11_feature_flag_source':        g11,
  '12_conservative_labeling':      g12,
  '13_path_scope':                 g13,
  '14_mutation_guard':             g14,
};

const gate_results = {};
let gates_passed = 0;
for (const [name, checks] of Object.entries(GATES)) {
  const pass = all(checks);
  if (pass) gates_passed++;
  gate_results[name] = { pass, checks };
}
const gates_total = Object.keys(GATES).length;

// overall_pass derives ONLY from independent gates + module load + endpoint block.
const overall_pass = loadError === null && endpointBlock.length > 0 && gates_passed === gates_total;

// short hashes for auditability (not sensitive)
const hashes = {};
for (const k of Object.keys(PHASE_FILES)) {
  hashes[k] = {
    before: HASH_BEFORE[k] ? HASH_BEFORE[k].slice(0, 12) : null,
    after:  HASH_AFTER[k] ? HASH_AFTER[k].slice(0, 12) : null,
  };
}

const result = {
  overall_pass,
  gates_passed,
  gates_total,
  truth_version: truth ? truth.truth_version : null,
  summary: truth ? truth.summary : null,
  load_error: loadError,
  // diagnostics (counts / names only — never PII values)
  forbidden_source_violations: forbiddenViolations,
  pii_key_hits: badKeyCount,
  pii_value_hits: badValCount,
  overclaim_phrases_in_allowed: overclaimInAllowed,
  files_mutated_by_checker: mutatedByChecker,
  phase_file_hashes: hashes,
  // ── informational ONLY — DERIVED from the independent gates above; NEVER used
  //    to compute overall_pass. (Replaces the old hardcoded self-attestation.) ──
  informational_only_not_a_pass_condition: {
    note: 'Each value below is DERIVED from an independent gate; it is display-only and is not part of overall_pass.',
    runtime_files_free_of_db_network_fs_imports: g08.no_forbidden_patterns,   // ← static source scan
    checker_did_not_modify_any_file:             g14.files_unchanged_during_run, // ← sha256 before/after
    built_object_free_of_pii:                    g09.no_forbidden_keys && g09.no_pii_in_values, // ← deep object scan
    endpoint_is_flag_gated_read_only:            g10.flag_checked_before_build && g10.no_db_or_sync_in_endpoint, // ← endpoint source
    no_db_connection_opened:                     g08.no_forbidden_patterns && g10.no_db_or_sync_in_endpoint, // ← derived, not asserted
  },
  gate_results,
};
if (!overall_pass) {
  result._note = 'FAIL-CLOSED: one or more independent gates unmet. The verdict relies on static source + runtime-object checks, never on self-attestation.';
}
console.log('RUNTIME_TRUTH_JSON:' + JSON.stringify(result, null, 1));
process.exit(overall_pass ? 0 : 1);
