#!/usr/bin/env node
'use strict';
/*
 * Phase 2C.25 — Owner Approval & Canary Scope Record INTAKE check.
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves, statically and fail-closed, that the repo still REFUSES to claim
 * production-canary readiness and that the 2C.25 intake doc defines a complete,
 * forge-resistant contract for the owner-approval record and the canary-scope
 * record a future canary will require. Verdict derives ONLY from:
 *   (A) existence of the prior proof chain (2C.21..2C.24 docs + checkers + the
 *       runtime-truth config/service),
 *   (B) the 2C.24 binder still pinned at canary_ready=false with its decision
 *       booleans all "no" (re-derived from the 2C.24 binder markers — this checker
 *       spawns NO process, so the 2C.24 checker is executed SEPARATELY in Step 5/CI;
 *       here we re-verify its conservative markers statically),
 *   (C) runtime-truth invariants rebuilt from the PURE service (no DB, no network)
 *       and independently re-tallied from the raw registry arrays
 *       (live_proven == 0; production sync blocked; external send blocked),
 *   (D) machine-readable markers in the 2C.25 doc (decision booleans:
 *       approval_intake_ready=true, all others false; 15 owner-approval fields;
 *       17 canary-scope fields; 10 blocked actions) plus the fixed-value and rule
 *       phrase invariants for both contracts and the redacted-example tokens,
 *   (E) an overclaim scan of the doc, a secret/PII scan of this phase's files, a
 *       declared-path-scope gate, and a SHA-256 mutation guard over every file read.
 *
 * NO self-attestation feeds the verdict. The production_touched/railway_touched/
 * etc. booleans live in `informational_only_not_a_pass_condition`, DERIVED from the
 * path-scope, secret-scan, and mutation gates; `overall_pass` never reads them.
 * (Same doctrine as the 2C.21/2C.22/2C.23/2C.24 checkers.)
 *
 * SAFETY: read-only. Opens NO database, makes NO network call, writes NO file,
 * spawns NO process. The only env interaction is DELETING the external-send
 * FEATURE_* var in-process (never on disk) BEFORE the flag module loads, so the
 * external-send-disabled check is deterministic regardless of ambient env
 * (production_sync/execution are hard-false in the service). Output is
 * COUNTS / BOOLEANS / STATUS / MARKER NAMES only — never secrets, DB URLs, JWTs,
 * tokens, env values, PII, or raw row data.
 *
 * FAIL-CLOSED: any missing artifact, flipped decision marker, dropped required
 * contract field, removed blocked action, upgraded 2C.24 binder, non-zero
 * live_proven, unblocked sync/send, overclaim phrase, secret/PII shape in this
 * phase's files, or hash drift makes its gate false and the verdict false (exit 1).
 *
 * USAGE: node scripts/phase-2c-25-owner-approval-canary-scope-intake-check.js
 *        exit 0 = all gates pass; exit 1 = fail-closed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

// ── DETERMINISM: remove the external-send flag from the in-process env BEFORE the
// flag module is required (the FLAGS literal reads env at module-load). Never
// written to disk; reverted implicitly when the process exits.
delete process.env.FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED;

function read(rel) { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return ''; } }
function exists(rel) { try { fs.accessSync(path.join(ROOT, rel)); return true; } catch (e) { return false; } }
function sha256(rel) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex'); }
  catch (e) { return null; }
}
const all = (obj) => Object.values(obj).every((v) => v === true);

// ── Phase 2C.25 NEW files (path-scope gate + mutation guard + secret scan) ────
const PHASE_TOUCHED = [
  'docs/agent-mesh/phase-2c-25-owner-approval-canary-scope-intake.md',
  'scripts/phase-2c-25-owner-approval-canary-scope-intake-check.js',
];

// Every file this checker reads — all guarded against mutation by this run.
const GUARD_FILES = {
  doc:     'docs/agent-mesh/phase-2c-25-owner-approval-canary-scope-intake.md',
  checker: 'scripts/phase-2c-25-owner-approval-canary-scope-intake-check.js',
  doc24:   'docs/agent-mesh/phase-2c-24-production-canary-prerequisite-binder.md',
  check24: 'scripts/phase-2c-24-production-canary-prerequisite-check.js',
  doc23:   'docs/agent-mesh/phase-2c-23-owner-briefing-ga-decision-gate.md',
  check23: 'scripts/phase-2c-23-owner-briefing-ga-decision-check.js',
  config:  'lib/config/atlasRuntimeTruth.js',
  service: 'lib/services/runtimeTruth.service.js',
  flags:   'lib/featureFlags.js',
};

// ── MUTATION GUARD (part 1): hash everything BEFORE any work ──────────────────
const HASH_BEFORE = {};
for (const [k, rel] of Object.entries(GUARD_FILES)) HASH_BEFORE[k] = sha256(rel);

const src = {
  doc:   read(GUARD_FILES.doc),
  doc24: read(GUARD_FILES.doc24),
  flags: read(GUARD_FILES.flags),
};

// ── load the PURE runtime-truth modules (no DB / no network — safe require) ───
let registry = null, truth = null, validateRes = { ok: false }, loadError = null;
try {
  const svc = require(path.join(ROOT, GUARD_FILES.service));
  registry = require(path.join(ROOT, GUARD_FILES.config));
  truth = svc.buildRuntimeTruth({ generatedAt: '2026-01-01T00:00:00.000Z' });
  validateRes = svc.validateStatuses();
} catch (e) { loadError = String(e && e.message ? e.message : e); }

// ── Gate 01 — Prior proof chain exists (2C.21 .. 2C.24 + this intake doc) ─────
const PRIOR_ARTIFACTS = [
  'docs/agent-mesh/phase-2c-21-runtime-truth-api.md',
  'lib/config/atlasRuntimeTruth.js',
  'lib/services/runtimeTruth.service.js',
  'scripts/phase-2c-21-runtime-truth-check.js',
  'docs/agent-mesh/phase-2c-22-runtime-truth-live-contract-proof.md',
  'scripts/phase-2c-22-runtime-truth-live-contract-check.js',
  'docs/agent-mesh/phase-2c-23-owner-briefing-ga-decision-gate.md',
  'scripts/phase-2c-23-owner-briefing-ga-decision-check.js',
  'docs/agent-mesh/phase-2c-24-production-canary-prerequisite-binder.md',
  'scripts/phase-2c-24-production-canary-prerequisite-check.js',
];
const missingArtifacts = PRIOR_ARTIFACTS.filter((p) => !exists(p));
const g01 = {
  all_prior_artifacts_exist: missingArtifacts.length === 0,
  intake_doc_exists:         src.doc.length > 0,
  service_loads:             truth !== null && loadError === null,
};

// ── Gate 02 — 2C.24 binder still pins canary_ready=false (re-derived statically)
// Spawns no process; the 2C.24 checker is run SEPARATELY in Step 5/CI. Here we
// re-verify the 2C.24 binder's own conservative markers + checker presence.
const c24CanaryReady = (src.doc24.match(/^CANARY_READY:\s*(yes|no)\s*$/im) || [])[1] || null;
const c24ProdTouched = (src.doc24.match(/^PRODUCTION_TOUCHED:\s*(yes|no)\s*$/im) || [])[1] || null;
const c24Version = (src.doc24.match(/^BINDER_VERSION:\s*([0-9A-Za-z.]+)\s*$/im) || [])[1] || null;
const g02 = {
  binder_doc_present:          src.doc24.length > 0,
  binder_checker_present:      exists(GUARD_FILES.check24),
  binder_version_2c24:         c24Version === '2C.24',
  binder_canary_ready_no:      c24CanaryReady === 'no',
  binder_production_touched_no: c24ProdTouched === 'no',
  no_binder_upgrade:           !/^CANARY_READY:\s*yes\s*$/im.test(src.doc24) &&
                               !/^[A-Z_]*APPROVED:\s*yes\s*$/im.test(src.doc24),
};

// ── Gate 03 — Runtime Truth conservative: live_proven == 0 (rebuilt + retallied)
const rawArraysOk = !!registry && [registry.PACKS, registry.AGENTS, registry.WORKFLOWS].every(Array.isArray);
const rawAll = rawArraysOk ? [...registry.PACKS, ...registry.AGENTS, ...registry.WORKFLOWS] : [];
const rawLiveProven = rawAll.filter((e) => e.status === 'live_proven').length;
const builtArraysOk = !!truth && [truth.packs, truth.agents, truth.workflows].every(Array.isArray);
const summary = (truth && truth.summary) || null;
const g03 = {
  validate_ok:         validateRes.ok === true,
  live_proven_is_zero: !!summary && summary.live_proven === 0 && rawLiveProven === 0 && rawArraysOk,
  counts_sum_to_total: !!summary && rawArraysOk &&
                       (summary.live_proven + summary.live_limited + summary.planned + summary.blocked) === rawAll.length,
};

// ── Gate 04 — production sync blocked + external send blocked + toggles off ───
const sync = builtArraysOk ? truth.workflows.find((w) => w.id === 'workflow.neon_to_cortex_sync') : null;
const ext = builtArraysOk ? truth.workflows.find((w) => w.id === 'workflow.external_message_send') : null;
const g04 = {
  neon_sync_present:        !!sync,
  neon_sync_blocked:        !!sync && sync.status === 'blocked',
  external_send_blocked:    !!ext && ext.status === 'blocked',
  execution_disabled:       !!truth && truth.execution_enabled === false,
  production_sync_disabled: !!truth && truth.production_sync_enabled === false,
  external_send_disabled:   !!truth && truth.external_send_enabled === false,
  environment_redacted:     !!truth && truth.environment === 'safe_redacted',
};

// ── Gate 05 — 2C.25 decision markers (intake ready=true; everything else false)
function boolMarker(name) {
  const allM = src.doc.match(new RegExp('^' + name + ':\\s*(?:true|false)\\s*$', 'gim')) || [];
  const val = (src.doc.match(new RegExp('^' + name + ':\\s*(true|false)\\s*$', 'im')) || [])[1] || null;
  return { count: allM.length, val };
}
const air = boolMarker('approval_intake_ready');
const oarp = boolMarker('owner_approval_record_present');
const csrp = boolMarker('canary_scope_record_present');
const cr = boolMarker('canary_ready');
const pt = boolMarker('production_touched');
const psa = boolMarker('production_sync_approved');
const esa = boolMarker('external_send_approved');
const da = boolMarker('deploy_approved');
const phaseVersion = (src.doc.match(/^PHASE_2C_25_VERSION:\s*([0-9A-Za-z.]+)\s*$/im) || [])[1] || null;
const g05 = {
  version_pinned:                  phaseVersion === '2C.25',
  exactly_one_each:                [air, oarp, csrp, cr, pt, psa, esa, da].every((m) => m.count === 1),
  approval_intake_ready_true:      air.val === 'true',
  owner_approval_record_absent:    oarp.val === 'false',
  canary_scope_record_absent:      csrp.val === 'false',
  canary_ready_false:              cr.val === 'false',
  production_touched_false:        pt.val === 'false',
  production_sync_approved_false:  psa.val === 'false',
  external_send_approved_false:    esa.val === 'false',
  deploy_approved_false:           da.val === 'false',
  no_decision_upgrade:             !/^(owner_approval_record_present|canary_scope_record_present|canary_ready|production_touched|production_sync_approved|external_send_approved|deploy_approved):\s*true\s*$/im.test(src.doc),
};

// ── Gate 06 — Owner-approval contract: all 15 fields + fixed-value constraints ─
const OWNER_FIELDS = [
  'approval_record_id', 'approval_status', 'approver_role',
  'approver_identity_hash_or_redacted_id', 'approval_timestamp_utc', 'approval_scope',
  'approved_actions', 'explicitly_forbidden_actions', 'approval_expiry_utc',
  'rollback_required_before_load', 'external_send_allowed', 'production_sync_allowed',
  'deploy_allowed', 'raw_pii_allowed_in_record', 'secrets_allowed_in_record',
];
const docOwnerFields = (src.doc.match(/^OWNER_APPROVAL_FIELD:\s*([a-z_]+)\s*$/gim) || [])
  .map((l) => l.replace(/^OWNER_APPROVAL_FIELD:\s*/i, '').trim()).sort();
const g06 = {
  all_fifteen_owner_fields:   JSON.stringify(docOwnerFields) === JSON.stringify([...OWNER_FIELDS].sort()),
  no_owner_field_dropped:     OWNER_FIELDS.every((f) => docOwnerFields.includes(f)),
  status_enum_present:        /approval_status:\s*pending\s*\|\s*approved\s*\|\s*rejected\s*\|\s*expired/i.test(src.doc),
  rollback_required_true:     /rollback_required_before_load:\s*true/i.test(src.doc),
  external_send_allowed_false: /external_send_allowed:\s*false/i.test(src.doc) && !/external_send_allowed:\s*true/i.test(src.doc),
  prod_sync_allowed_false:    /production_sync_allowed:\s*false/i.test(src.doc) && !/production_sync_allowed:\s*true/i.test(src.doc),
  deploy_allowed_false:       /deploy_allowed:\s*false/i.test(src.doc) && !/deploy_allowed:\s*true/i.test(src.doc),
  raw_pii_false:              /raw_pii_allowed_in_record:\s*false/i.test(src.doc) && !/raw_pii_allowed_in_record:\s*true/i.test(src.doc),
  secrets_false:              /secrets_allowed_in_record:\s*false/i.test(src.doc) && !/secrets_allowed_in_record:\s*true/i.test(src.doc),
};

// ── Gate 07 — Owner-approval RULES (no implied/default approval; fail-closed) ──
const OWNER_RULES = [
  /no default approval/i,
  /no implied approval/i,
  /no approval from branch existence/i,
  /no approval from CI green/i,
  /no approval from Claude\/Codex/i,
  /no approval from stale docs/i,
  /approval must be explicit and owner-recorded/i,
  /expired approval fails closed/i,
  /missing approver identity fails closed/i,
  /missing timestamp fails closed/i,
  /allowlist, not a broad wildcard/i,
];
const ownerRulesMissing = OWNER_RULES.filter((re) => !re.test(src.doc));
const g07 = {
  all_owner_rules_present:    ownerRulesMissing.length === 0,
  forbidden_includes_external: /explicitly_forbidden_actions must include[^.]*external sending/i.test(src.doc),
  forbidden_includes_deploy:   /explicitly_forbidden_actions must include[^.]*deploy/i.test(src.doc),
  forbidden_includes_railway:  /explicitly_forbidden_actions must include[^.]*railway\/env change/i.test(src.doc),
  forbidden_includes_ga:       /GA claim unless separately\s+approved/i.test(src.doc),
};

// ── Gate 08 — Canary-scope contract: all 17 fields + fixed-value constraints ──
const SCOPE_FIELDS = [
  'canary_scope_id', 'tenant_count', 'tenant_consent_record_present',
  'tenant_identifier_hash_or_redacted_id', 'source_org_identifier_hash_or_redacted_id',
  'target_owner_user_hash_or_redacted_id', 'batch_limit', 'dry_run_required_first',
  'persistent_load_allowed', 'rollback_batch_strategy_present', 'observation_window_required',
  'external_send_allowed', 'scheduled_sync_allowed', 'automatic_sync_allowed',
  'production_sync_flag_default_off', 'raw_pii_allowed_in_record', 'secrets_allowed_in_record',
];
const docScopeFields = (src.doc.match(/^CANARY_SCOPE_FIELD:\s*([a-z_]+)\s*$/gim) || [])
  .map((l) => l.replace(/^CANARY_SCOPE_FIELD:\s*/i, '').trim()).sort();
const g08 = {
  all_seventeen_scope_fields: JSON.stringify(docScopeFields) === JSON.stringify([...SCOPE_FIELDS].sort()),
  no_scope_field_dropped:     SCOPE_FIELDS.every((f) => docScopeFields.includes(f)),
  tenant_count_one:           /tenant_count:\s*1\b/.test(src.doc),
  batch_limit_one:            /batch_limit:\s*1\b/.test(src.doc),
  dry_run_required_true:      /dry_run_required_first:\s*true/i.test(src.doc),
  persistent_load_false:      /persistent_load_allowed:\s*false/i.test(src.doc) && !/persistent_load_allowed:\s*true/i.test(src.doc),
  observation_required_true:  /observation_window_required:\s*true/i.test(src.doc),
  prod_sync_flag_default_off: /production_sync_flag_default_off:\s*true/i.test(src.doc),
  scheduled_sync_false:       /scheduled_sync_allowed:\s*false/i.test(src.doc) && !/scheduled_sync_allowed:\s*true/i.test(src.doc),
  automatic_sync_false:       /automatic_sync_allowed:\s*false/i.test(src.doc) && !/automatic_sync_allowed:\s*true/i.test(src.doc),
};

// ── Gate 09 — Canary-scope RULES (one tenant, one batch, no fuzzy, dry-run) ───
const SCOPE_RULES = [
  /one consenting tenant only/i,
  /one batch only/i,
  /no fuzzy matching/i,
  /no null\/incomplete identifier matching/i,
  /no email\/GST auto-match/i,
  /dry-run proof must exist before persistent load/i,
  /rollback command must be ready before load/i,
  /observation artifacts required before any GA claim/i,
];
const scopeRulesMissing = SCOPE_RULES.filter((re) => !re.test(src.doc));
const g09 = {
  all_scope_rules_present: scopeRulesMissing.length === 0,
};

// ── Gate 10 — Record examples are redacted / demo-only ────────────────────────
const DEMO_TOKENS = [
  /owner_hash_demo_only/, /tenant_hash_demo_only/, /source_org_hash_demo_only/,
  /target_owner_user_hash_demo_only/, /appr_demo_only/, /scope_demo_only/,
];
const demoMissing = DEMO_TOKENS.filter((re) => !re.test(src.doc));
const g10 = {
  demo_tokens_present:     demoMissing.length === 0,
  example_status_pending:  /"approval_status":\s*"pending"/.test(src.doc),
  example_not_approved:    !/"approval_status":\s*"approved"/.test(src.doc),
};

// ── Gate 11 — Blocked-after-2C.25 actions all listed ──────────────────────────
const EXPECTED_BLOCKED = [
  'production_db_connection', 'production_schema_parity_proof', 'production_connectivity_proof',
  'persistent_production_load', 'production_sync', 'external_sending',
  'railway_env_change', 'deploy', 'ga_claim', 'public_production_live_claim',
];
const docBlocked = (src.doc.match(/^BLOCKED_AFTER_2C25:\s*([a-z_]+)\s*$/gim) || [])
  .map((l) => l.replace(/^BLOCKED_AFTER_2C25:\s*/i, '').trim()).sort();
const g11 = {
  all_ten_blocked_listed:  JSON.stringify(docBlocked) === JSON.stringify([...EXPECTED_BLOCKED].sort()),
  no_blocked_action_dropped: EXPECTED_BLOCKED.every((b) => docBlocked.includes(b)),
};

// ── Gate 12 — Overclaim guard (DOC only; this checker embeds the literals as
// detection regexes, so it is excluded — same self-exclusion doctrine as 2C.24).
const DOC_FORBIDDEN_CLAIMS = [
  /216 live agents/i, /fully autonomous/i, /bank-grade/i, /military-grade/i,
  /\bproduction-live\b/i, /generally available/i,
  /production canary approved/i, /production sync enabled/i, /external sending enabled/i,
  /^CANARY_READY:\s*yes/im, /production_canary_ready:\s*(?:yes|true)/i,
  /^canary_ready:\s*true/im, /^owner_approval_record_present:\s*true/im,
  /^canary_scope_record_present:\s*true/im, /^deploy_approved:\s*true/im,
  /^production_sync_approved:\s*true/im, /^external_send_approved:\s*true/im,
];
const docOverclaims = DOC_FORBIDDEN_CLAIMS.filter((re) => re.test(src.doc)).length;
const g12 = {
  doc_free_of_overclaims: docOverclaims === 0,
};

// ── Gate 13 — No secrets/PII shapes in this phase's files ─────────────────────
// The DOC is scanned in full with value patterns. The checker is scanned with a
// curated literal-secret subset whose patterns cannot self-match their own source
// (same exclusion the 2C.24 checker documents for itself).
const VALUE_PATTERNS = [
  /postgres(?:ql)?:\/\//i, /eyJ[A-Za-z0-9_-]{10,}/, /\bbearer\s+[A-Za-z0-9._-]{10,}/i,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, /\b\d{10,}\b/, /\+\d[\d -]{8,}\d/,
  /\b(?:sk|rk|pk|rzp)_live_[A-Za-z0-9]{4,}/i, /\bsk-[A-Za-z0-9]{16,}/, /BEGIN [A-Z ]*PRIVATE KEY/,
];
const docPiiHits = VALUE_PATTERNS.filter((re) => re.test(src.doc)).length;
const checkerSrc = read(GUARD_FILES.checker);
const CHECKER_SECRET_LITERALS = [
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,   // real JWT (header.payload with dot)
  /postgres(?:ql)?:\/\/[A-Za-z0-9]/,              // literal DB URL with host char
  /\b(?:sk|rk|pk|rzp)_live_[A-Za-z0-9]{8,}/,      // contiguous live API key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,           // PEM block with dashes
];
const checkerSecretHits = CHECKER_SECRET_LITERALS.filter((re) => re.test(checkerSrc)).length;
const g13 = {
  doc_free_of_secret_pii_shapes:   docPiiHits === 0,
  checker_present:                 checkerSrc.length > 0,
  checker_free_of_secret_literals: checkerSecretHits === 0,
};

// ── Gate 14 — DECLARED path scope (static; actual tree verified externally) ───
// HONESTY NOTE: validates the DECLARED phase file list + on-disk existence. It
// spawns no process, so it cannot run git; actual working-tree scope is verified
// EXTERNALLY (git status / git diff --name-only) in the phase report and review.
const g14 = {
  declared_files_exist:        PHASE_TOUCHED.every((p) => exists(p)),
  no_env_file_declared:        !PHASE_TOUCHED.some((p) => /\.env(\.|$)/.test(p)),
  no_railway_file_declared:    !PHASE_TOUCHED.some((p) => /railway\.toml|nixpacks\.toml|Procfile/i.test(p)),
  no_frontend_file_declared:   !PHASE_TOUCHED.some((p) => /frontend|vercel|next\.config/i.test(p)),
  no_deploy_file_declared:     !PHASE_TOUCHED.some((p) => /\.github\/workflows|deploy/i.test(p)),
  backend_paths_only_declared: PHASE_TOUCHED.every((p) => /^(scripts\/|docs\/)/.test(p)),
};

// ── MUTATION GUARD (part 2): re-hash AFTER all checks ─────────────────────────
const HASH_AFTER = {};
for (const [k, rel] of Object.entries(GUARD_FILES)) HASH_AFTER[k] = sha256(rel);
const mutated = Object.keys(GUARD_FILES)
  .filter((k) => HASH_BEFORE[k] === null || HASH_AFTER[k] === null || HASH_BEFORE[k] !== HASH_AFTER[k]);
const g15 = {
  all_hashes_captured:        Object.values(HASH_BEFORE).every((h) => typeof h === 'string'),
  files_unchanged_during_run: mutated.length === 0,
};

// ── roll up ───────────────────────────────────────────────────────────────────
const GATES = {
  '01_prior_proof_chain_exists':     g01,
  '02_binder_still_canary_blocked':  g02,
  '03_runtime_truth_conservative':   g03,
  '04_sync_and_send_blocked':        g04,
  '05_intake_decision_markers':      g05,
  '06_owner_approval_contract':      g06,
  '07_owner_approval_rules':         g07,
  '08_canary_scope_contract':        g08,
  '09_canary_scope_rules':           g09,
  '10_examples_redacted_demo':       g10,
  '11_blocked_actions_remain':       g11,
  '12_overclaim_guard':              g12,
  '13_no_secrets_pii_in_new_files':  g13,
  '14_declared_path_scope':          g14,
  '15_mutation_guard':               g15,
};
const gate_results = {};
let gates_passed = 0;
for (const [name, checks] of Object.entries(GATES)) {
  const pass = all(checks);
  if (pass) gates_passed++;
  gate_results[name] = { pass, checks };
}
const gates_total = Object.keys(GATES).length;
const overall_pass = loadError === null && gates_passed === gates_total;

const hashes = {};
for (const k of Object.keys(GUARD_FILES)) {
  hashes[k] = {
    before: HASH_BEFORE[k] ? HASH_BEFORE[k].slice(0, 12) : null,
    after:  HASH_AFTER[k] ? HASH_AFTER[k].slice(0, 12) : null,
  };
}

const result = {
  overall_pass,
  gates_passed,
  gates_total,
  // intake decision — PARSED from the doc markers, then gated above (not hardcoded)
  intake_decision: {
    phase_version:                phaseVersion,
    approval_intake_ready:        air.val === 'true',
    owner_approval_record_present: oarp.val === 'true',
    canary_scope_record_present:  csrp.val === 'true',
    canary_ready:                 cr.val === 'true',
    production_touched:           pt.val === 'true',
    production_sync_approved:     psa.val === 'true',
    external_send_approved:       esa.val === 'true',
    deploy_approved:              da.val === 'true',
    owner_approval_fields_count:  docOwnerFields.length,
    canary_scope_fields_count:    docScopeFields.length,
    blocked_actions_count:        docBlocked.length,
  },
  prior_binder_2c24: {
    binder_version:   c24Version,
    canary_ready:     c24CanaryReady === 'yes',
    production_touched: c24ProdTouched === 'yes',
  },
  runtime_truth_summary: summary,
  load_error: loadError,
  // diagnostics (counts / names only — never values)
  missing_prior_artifacts: missingArtifacts,
  owner_approval_fields: docOwnerFields,
  canary_scope_fields: docScopeFields,
  blocked_actions: docBlocked,
  owner_rules_missing: ownerRulesMissing.length,
  scope_rules_missing: scopeRulesMissing.length,
  demo_tokens_missing: demoMissing.length,
  doc_overclaim_hits: docOverclaims,
  doc_pii_pattern_hits: docPiiHits,
  files_mutated_by_check: mutated,
  guard_file_hashes: hashes,
  // ── informational ONLY — DERIVED from the gates above; NEVER feeds the verdict
  informational_only_not_a_pass_condition: {
    note: 'Display-only, never part of overall_pass. Scope booleans derive from the DECLARED phase file list (gate 14) + secret scans (gate 13) + the mutation guard (gate 15); the ACTUAL working-tree scope is verified externally via git status/diff in the phase report.',
    production_touched: (g14.backend_paths_only_declared && g15.files_unchanged_during_run) ? false : null,
    railway_touched:    g14.no_railway_file_declared ? false : null,
    env_files_changed:  g14.no_env_file_declared ? false : null,
    frontend_touched:   g14.no_frontend_file_declared ? false : null,
    deploy_triggered:   g14.no_deploy_file_declared ? false : null,
    secrets_exposed:    (g13.doc_free_of_secret_pii_shapes && g13.checker_free_of_secret_literals) ? false : null,
  },
  gate_results,
};
if (!overall_pass) {
  result._note = 'FAIL-CLOSED: one or more intake gates unmet. A production canary still requires a NEW phase that records explicit owner approval AND produces the required production-access proofs — never an edit to this intake doc alone.';
}
console.log('CANARY_INTAKE_JSON:' + JSON.stringify(result, null, 1));
process.exit(overall_pass ? 0 : 1);
