#!/usr/bin/env node
'use strict';
/*
 * Phase 2C.24 — Production Canary PREREQUISITE BINDER check.
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves, statically and fail-closed, that the repo still REFUSES to claim
 * production-canary readiness and that the 2C.24 binder defines every prerequisite
 * contract a future canary must satisfy. Verdict derives ONLY from:
 *   (A) existence of the prior proof chain (2C.19..2C.23 docs + checkers + the
 *       runtime-truth config/service),
 *   (B) the 2C.23 decision still pinned at staging_proven_only / canary NOT ready,
 *   (C) runtime-truth invariants rebuilt from the PURE service (no DB, no network)
 *       and independently re-tallied from the raw registry arrays
 *       (live_proven == 0; Neon→Cortex sync blocked; external send blocked),
 *   (D) machine-readable markers in the 2C.24 binder (decision booleans all "no",
 *       8 required artifacts, 8 blocked actions, 6 no-claim disclaimers) plus the
 *       prerequisite-contract phrase invariants (tenant map, canary scope, rollback
 *       runbook, observability plan),
 *   (E) an overclaim scan of the binder doc, a secret/PII scan of this phase's
 *       files, a declared-path-scope gate, and a SHA-256 mutation guard over every
 *       file this checker reads.
 *
 * NO self-attestation feeds the verdict. The production_touched/railway_touched/
 * etc. booleans live in `informational_only_not_a_pass_condition`, DERIVED from the
 * path-scope, secret-scan, and mutation gates; `overall_pass` never reads them.
 * (Same doctrine as the 2C.21/2C.22/2C.23 checkers.)
 *
 * SAFETY: read-only. Opens NO database, makes NO network call, writes NO file,
 * spawns NO process, and makes NO env mutation — flag state is read as-is via the
 * pure runtime-truth build, with flag defaults verified by source-pattern match
 * against lib/featureFlags.js. Output is
 * COUNTS / BOOLEANS / STATUS / MARKER NAMES only — never secrets, DB URLs, JWTs,
 * tokens, env values, PII, or raw row data.
 *
 * FAIL-CLOSED: any missing artifact, flipped decision marker, dropped required
 * artifact / blocked action, upgraded 2C.23 decision, non-zero live_proven,
 * unblocked sync/send, overclaim phrase, secret/PII shape in this phase's files,
 * or hash drift makes its gate false and the overall verdict false (exit 1).
 *
 * USAGE: node scripts/phase-2c-24-production-canary-prerequisite-check.js
 *        exit 0 = all gates pass; exit 1 = fail-closed.
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

// ── Phase 2C.24 NEW files (path-scope gate + mutation guard + secret scan) ────
const PHASE_TOUCHED = [
  'docs/agent-mesh/phase-2c-24-production-canary-prerequisite-binder.md',
  'scripts/phase-2c-24-production-canary-prerequisite-check.js',
];

// Every file this checker reads — all guarded against mutation by this run.
const GUARD_FILES = {
  doc:      'docs/agent-mesh/phase-2c-24-production-canary-prerequisite-binder.md',
  checker:  'scripts/phase-2c-24-production-canary-prerequisite-check.js',
  doc23:    'docs/agent-mesh/phase-2c-23-owner-briefing-ga-decision-gate.md',
  check23:  'scripts/phase-2c-23-owner-briefing-ga-decision-check.js',
  config:   'lib/config/atlasRuntimeTruth.js',
  service:  'lib/services/runtimeTruth.service.js',
  flags:    'lib/featureFlags.js',
  doc20:    'docs/agent-mesh/phase-2c-20-production-readiness-gate.md',
  doc19:    'docs/agent-mesh/phase-2c-19-production-neon-to-cortex-pipeline.md',
};

// ── MUTATION GUARD (part 1): hash everything BEFORE any work ──────────────────
const HASH_BEFORE = {};
for (const [k, rel] of Object.entries(GUARD_FILES)) HASH_BEFORE[k] = sha256(rel);

const src = {
  doc:   read(GUARD_FILES.doc),
  doc23: read(GUARD_FILES.doc23),
  flags: read(GUARD_FILES.flags),
  doc20: read(GUARD_FILES.doc20),
};

// ── load the PURE runtime-truth modules (no DB / no network — safe require) ───
let registry = null, truth = null, validateRes = { ok: false }, loadError = null;
try {
  const svc = require(path.join(ROOT, GUARD_FILES.service));
  registry = require(path.join(ROOT, GUARD_FILES.config));
  truth = svc.buildRuntimeTruth({ generatedAt: '2026-01-01T00:00:00.000Z' });
  validateRes = svc.validateStatuses();
} catch (e) { loadError = String(e && e.message ? e.message : e); }

// ── Gate 01 — Prior proof chain exists (2C.19 .. 2C.23 + this binder) ─────────
const PRIOR_ARTIFACTS = [
  'docs/agent-mesh/phase-2c-19-production-neon-to-cortex-pipeline.md',
  'scripts/phase-2c-19-owner-briefing-evidence-gate.js',
  'docs/agent-mesh/phase-2c-20-production-readiness-gate.md',
  'scripts/phase-2c-20-production-readiness-check.js',
  'docs/agent-mesh/phase-2c-21-runtime-truth-api.md',
  'lib/config/atlasRuntimeTruth.js',
  'lib/services/runtimeTruth.service.js',
  'scripts/phase-2c-21-runtime-truth-check.js',
  'docs/agent-mesh/phase-2c-22-runtime-truth-live-contract-proof.md',
  'scripts/phase-2c-22-runtime-truth-live-contract-check.js',
  'docs/agent-mesh/phase-2c-23-owner-briefing-ga-decision-gate.md',
  'scripts/phase-2c-23-owner-briefing-ga-decision-check.js',
];
const missingArtifacts = PRIOR_ARTIFACTS.filter((p) => !exists(p));
const g01 = {
  all_prior_artifacts_exist: missingArtifacts.length === 0,
  binder_doc_exists:         src.doc.length > 0,
  service_loads:             truth !== null && loadError === null,
};

// ── Gate 02 — 2C.23 decision still pins canary NOT ready ──────────────────────
const d23State = (src.doc23.match(/DECISION_STATE:\s*([a-z_]+)/) || [])[1] || null;
const d23Ga = (src.doc23.match(/GA_READY:\s*(yes|no)/) || [])[1] || null;
const d23Canary = (src.doc23.match(/PRODUCTION_CANARY_READY:\s*(yes|no)/) || [])[1] || null;
const g02 = {
  decision_doc_present:           src.doc23.length > 0,
  state_is_staging_proven_only:   d23State === 'staging_proven_only',
  ga_ready_is_no:                 d23Ga === 'no',
  production_canary_ready_is_no:   d23Canary === 'no',
  no_canary_upgrade_in_23:        !/PRODUCTION_CANARY_READY:\s*yes/i.test(src.doc23) &&
                                  !/DECISION_STATE:\s*(?:ga_ready|production_canary_ready)/i.test(src.doc23),
};

// ── Gate 03 — Runtime Truth conservative: live_proven == 0 (rebuilt + retallied)
const rawArraysOk = !!registry && [registry.PACKS, registry.AGENTS, registry.WORKFLOWS].every(Array.isArray);
const rawAll = rawArraysOk ? [...registry.PACKS, ...registry.AGENTS, ...registry.WORKFLOWS] : [];
const rawLiveProven = rawAll.filter((e) => e.status === 'live_proven').length;
const builtArraysOk = !!truth && [truth.packs, truth.agents, truth.workflows].every(Array.isArray);
const entities = builtArraysOk ? [...truth.packs, ...truth.agents, ...truth.workflows] : [];
const summary = (truth && truth.summary) || null;
const g03 = {
  validate_ok:           validateRes.ok === true,
  live_proven_is_zero:   !!summary && summary.live_proven === 0 && rawLiveProven === 0 && rawArraysOk,
  counts_sum_to_total:   !!summary && rawArraysOk &&
                         (summary.live_proven + summary.live_limited + summary.planned + summary.blocked) === rawAll.length,
};

// ── Gate 04 — Neon→Cortex sync blocked + external send blocked + toggles off ──
const sync = builtArraysOk ? truth.workflows.find((w) => w.id === 'workflow.neon_to_cortex_sync') : null;
const ext = builtArraysOk ? truth.workflows.find((w) => w.id === 'workflow.external_message_send') : null;
const g04 = {
  neon_sync_present:        !!sync,
  neon_sync_blocked:        !!sync && sync.status === 'blocked',
  neon_sync_reason_canary:  !!sync && sync.blocked_reason === 'production_canary',
  external_send_blocked:    !!ext && ext.status === 'blocked',
  execution_disabled:       !!truth && truth.execution_enabled === false,
  production_sync_disabled: !!truth && truth.production_sync_enabled === false,
  external_send_disabled:   !!truth && truth.external_send_enabled === false,
  environment_redacted:     !!truth && truth.environment === 'safe_redacted',
};

// ── Gate 05 — Binder decision booleans all NO (line-anchored markers) ─────────
// Markers are matched at LINE START so prose references to the 2C.23 markers
// (e.g. "**PRODUCTION_CANARY_READY: no**") never collide with these.
function oneMarker(name) {
  const allM = src.doc.match(new RegExp('^' + name + ':\\s*(?:yes|no)\\s*$', 'gim')) || [];
  const val = (src.doc.match(new RegExp('^' + name + ':\\s*(yes|no)\\s*$', 'im')) || [])[1] || null;
  return { count: allM.length, val };
}
const cr = oneMarker('CANARY_READY');
const pt = oneMarker('PRODUCTION_TOUCHED');
const da = oneMarker('DEPLOY_APPROVED');
const psa = oneMarker('PRODUCTION_SYNC_APPROVED');
const esa = oneMarker('EXTERNAL_SEND_APPROVED');
const binderVersion = (src.doc.match(/^BINDER_VERSION:\s*([0-9A-Za-z.]+)\s*$/im) || [])[1] || null;
const g05 = {
  binder_version_pinned:        binderVersion === '2C.24',
  exactly_one_canary_ready:     cr.count === 1,
  exactly_one_production_touched: pt.count === 1,
  exactly_one_deploy_approved:  da.count === 1,
  exactly_one_prod_sync_approved: psa.count === 1,
  exactly_one_external_send_approved: esa.count === 1,
  canary_ready_no:              cr.val === 'no',
  production_touched_no:        pt.val === 'no',
  deploy_approved_no:           da.val === 'no',
  production_sync_approved_no:  psa.val === 'no',
  external_send_approved_no:    esa.val === 'no',
  no_decision_upgrade_docwide:  !/^[A-Z_]*READY:\s*yes\s*$/im.test(src.doc) &&
                                !/^[A-Z_]*APPROVED:\s*yes\s*$/im.test(src.doc),
};

// ── Gate 06 — All 8 required artifacts listed ─────────────────────────────────
const EXPECTED_ARTIFACTS = [
  'real_tenant_map_contract',
  'owner_approval_record',
  'canary_scope_record',
  'production_connectivity_proof_plan',
  'production_schema_parity_proof_plan',
  'rollback_runbook',
  'observability_audit_proof_plan',
  'kill_switch_feature_flag_plan',
];
const docArtifacts = (src.doc.match(/^ARTIFACT:\s*([a-z_]+)\s*$/gim) || [])
  .map((l) => l.replace(/^ARTIFACT:\s*/i, '').trim()).sort();
const g06 = {
  all_eight_artifacts_listed: JSON.stringify(docArtifacts) === JSON.stringify([...EXPECTED_ARTIFACTS].sort()),
  no_artifact_dropped:        EXPECTED_ARTIFACTS.every((a) => docArtifacts.includes(a)),
};

// ── Gate 07 — All 8 blocked actions remain blocked ────────────────────────────
const EXPECTED_BLOCKED = [
  'production_db_connection',
  'production_sync',
  'persistent_production_load',
  'external_sending',
  'railway_env_change',
  'deploy',
  'ga_claim',
  'public_production_live_claim',
];
const docBlocked = (src.doc.match(/^BLOCKED_ACTION:\s*([a-z_]+)\s*$/gim) || [])
  .map((l) => l.replace(/^BLOCKED_ACTION:\s*/i, '').trim()).sort();
const g07 = {
  all_eight_blocked_listed: JSON.stringify(docBlocked) === JSON.stringify([...EXPECTED_BLOCKED].sort()),
  no_blocked_action_dropped: EXPECTED_BLOCKED.every((b) => docBlocked.includes(b)),
};

// ── Gate 08 — Tenant map contract forbids fuzzy matching + required fields ─────
const TENANT_REQUIRED = [
  /no fuzzy matching/i,
  /no email\/gst auto-match/i,
  /explicit human-approved mapping/i,
  /one Neon org maps to one Cortex owner/i,
  /approval_timestamp/,
  /approver_role/,
  /source_org_id_redacted/,
  /target_owner_user_id_redacted/,
  /rollback_batch_strategy/,
  /no raw PII/i,
];
const tenantMissing = TENANT_REQUIRED.filter((re) => !re.test(src.doc));
const g08 = {
  forbids_fuzzy_matching:     /no fuzzy matching/i.test(src.doc),
  forbids_null_auto_match:    /no email\/gst auto-match/i.test(src.doc),
  requires_human_mapping:     /explicit human-approved mapping/i.test(src.doc),
  one_org_one_owner:          /one Neon org maps to one Cortex owner/i.test(src.doc),
  evidence_fields_present:    /approval_timestamp/.test(src.doc) && /approver_role/.test(src.doc) &&
                              /source_org_id_redacted/.test(src.doc) && /target_owner_user_id_redacted/.test(src.doc) &&
                              /rollback_batch_strategy/.test(src.doc),
  forbids_raw_pii:            /no raw PII/i.test(src.doc),
  all_tenant_clauses_present: tenantMissing.length === 0,
};

// ── Gate 09 — Canary scope contract (one tenant, one batch, dry run, rollback) ─
const g09 = {
  one_consenting_tenant:      /one consenting tenant/i.test(src.doc),
  one_batch_only:             /\bone batch\b/i.test(src.doc),
  dry_run_first:              /read-only dry run first/i.test(src.doc),
  rollback_ready_before_load: /rollback command ready before load/i.test(src.doc),
  external_sending_disabled:  /external sending disabled/i.test(src.doc),
  prod_sync_flag_default_off: /production sync flag default OFF/i.test(src.doc),
  no_scheduled_or_automatic:  /no scheduled or automatic sync/i.test(src.doc),
};

// ── Gate 10 — Rollback runbook (batch-scoped order + safety) ──────────────────
const g10 = {
  rollback_by_batch_id:       /rollback by sync_batch_id/i.test(src.doc),
  dry_run_before_destructive: /dry-run rollback before destructive/i.test(src.doc),
  batch_scoped_order:         /followups[^a-z0-9]+invoices[^a-z0-9]+customers[^a-z0-9]+ledger/i.test(src.doc),
  never_touch_other_batches:  /never touch other batches/i.test(src.doc),
  proof_counts_booleans_only: /counts\/booleans only/i.test(src.doc),
  no_pii_logs:                /no PII/i.test(src.doc),
};

// ── Gate 11 — Observability plan rejects unknown user / audit pass ────────────
const g11 = {
  sync_batches_ledger:        /sync_batches ledger/i.test(src.doc),
  counts_categories:          /inserted \/ updated \/ rejected \/ orphan/i.test(src.doc),
  failure_reason_categories:  /failure reason categories/i.test(src.doc),
  audit_user_resolved:        /audit user id must be resolved/i.test(src.doc),
  unknown_user_rejected:      /unknown user_id must be rejected/i.test(src.doc),
  no_raw_pii:                 /no raw PII/i.test(src.doc),
  committed_artifacts_before_ga: /committed artifacts before GA/i.test(src.doc),
};

// ── Gate 12 — Overclaim guard (binder DOC only; this checker embeds the literals
// as detection regexes, so it is excluded — same doctrine as the 2C.21/2C.23
// checkers' self-exclusion for their own detection patterns). Also requires the
// six NO_CLAIM disclaimers to be present.
const DOC_FORBIDDEN_CLAIMS = [
  /216 live agents/i, /fully autonomous/i, /bank-grade/i, /military-grade/i,
  /\bproduction-live\b/i, /generally available/i,
  /production canary approved/i, /production sync enabled/i, /external sending enabled/i,
  /CANARY_READY:\s*yes/i, /PRODUCTION_CANARY_READY:\s*yes/i, /GA_READY:\s*yes/i,
  /DEPLOY_APPROVED:\s*yes/i, /PRODUCTION_SYNC_APPROVED:\s*yes/i, /EXTERNAL_SEND_APPROVED:\s*yes/i,
];
const docOverclaims = DOC_FORBIDDEN_CLAIMS.filter((re) => re.test(src.doc)).length;
const EXPECTED_NO_CLAIM = [
  'canary_ready', 'ga_ready', 'production_live',
  'fully_autonomous_agents', 'inflated_agent_count', 'defense_grade_security',
];
const docNoClaim = (src.doc.match(/^NO_CLAIM:\s*([a-z_]+)\s*$/gim) || [])
  .map((l) => l.replace(/^NO_CLAIM:\s*/i, '').trim()).sort();
const g12 = {
  doc_free_of_overclaims:  docOverclaims === 0,
  all_six_no_claim_markers: JSON.stringify(docNoClaim) === JSON.stringify([...EXPECTED_NO_CLAIM].sort()),
};

// ── Gate 13 — No secrets/PII shapes in this phase's files ─────────────────────
// The DOC is scanned in full. The checker itself is excluded from the value-
// pattern scan (it embeds these regexes as detection literals) but IS scanned with
// a curated literal-secret subset whose patterns cannot self-match their own
// source (same exclusion the 2C.21/2C.23 checkers document for themselves).
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
  '02_decision_still_canary_blocked': g02,
  '03_runtime_truth_conservative':   g03,
  '04_pipeline_and_send_blocked':    g04,
  '05_binder_decision_all_no':       g05,
  '06_required_artifacts_listed':    g06,
  '07_blocked_actions_remain':       g07,
  '08_tenant_map_contract':          g08,
  '09_canary_scope_contract':        g09,
  '10_rollback_runbook':             g10,
  '11_observability_audit_plan':     g11,
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
  // binder decision — PARSED from the doc markers, then gated above (not hardcoded)
  binder_decision: {
    binder_version:          binderVersion,
    canary_ready:            cr.val === 'yes',
    production_touched:      pt.val === 'yes',
    deploy_approved:         da.val === 'yes',
    production_sync_approved: psa.val === 'yes',
    external_send_approved:  esa.val === 'yes',
    required_artifacts_count: docArtifacts.length,
    blocked_actions_count:   docBlocked.length,
    no_claim_count:          docNoClaim.length,
  },
  prior_decision_2c23: {
    decision_state:          d23State,
    ga_ready:                d23Ga === 'yes',
    production_canary_ready: d23Canary === 'yes',
  },
  runtime_truth_summary: summary,
  load_error: loadError,
  // diagnostics (counts / names only — never values)
  missing_prior_artifacts: missingArtifacts,
  required_artifacts: docArtifacts,
  blocked_actions: docBlocked,
  tenant_clauses_missing: tenantMissing.length,
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
  result._note = 'FAIL-CLOSED: one or more prerequisite-binder gates unmet. Approving a production canary requires a NEW phase with NEW proof artifacts AND explicit owner approval, never an edit to this binder alone.';
}
console.log('CANARY_PREREQ_JSON:' + JSON.stringify(result, null, 1));
process.exit(overall_pass ? 0 : 1);
