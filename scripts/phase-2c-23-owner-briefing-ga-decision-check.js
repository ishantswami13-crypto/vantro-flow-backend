#!/usr/bin/env node
'use strict';
/*
 * Phase 2C.23 — Owner Briefing GA DECISION GATE check.
 * ─────────────────────────────────────────────────────────────────────────────
 * Pins the honest GA/canary decision for Owner Briefing to the weakest state the
 * repo's PROOF ARTIFACTS support. Verdict derives ONLY from:
 *   (A) existence of the prior proof artifacts (2C.12..2C.22),
 *   (B) machine-readable markers in the 2C.23 decision doc (DECISION_STATE,
 *       GA_READY, BLOCKER:, PROOF_GAP: — an upgraded state, a dropped blocker,
 *       or a dropped proof gap fails the run),
 *   (C) runtime-truth object invariants rebuilt from the PURE service (no DB,
 *       no network) and re-tallied from the raw registry arrays,
 *   (D) static source inspection of the flags, the preview endpoint block in
 *       server.js, and the authoritative evidence-contract client,
 *   (E) a SHA-256 mutation guard over every file this checker reads.
 *
 * NO self-attestation feeds the verdict. The production_touched/railway_touched/
 * etc. booleans in the output are DERIVED from the path-scope, secret-scan, and
 * mutation gates and live in `informational_only_not_a_pass_condition`, which
 * `overall_pass` never reads. (Same doctrine as the 2C.21/2C.22 checkers.)
 *
 * SAFETY: read-only. Opens NO database, makes NO network call, writes NO file,
 * spawns NO process. The only env interaction is DELETING three FEATURE_* vars
 * in-process (never on disk) so the flag-default gate is deterministic. Output
 * is COUNTS / BOOLEANS / STATUS / MARKER NAMES only — never secrets, DB URLs,
 * JWTs, tokens, env values, PII, or raw row data.
 *
 * FAIL-CLOSED: any missing artifact, marker mismatch, upgraded decision,
 * overclaim phrase, secret/PII shape in this phase's files, or hash drift makes
 * its gate false and the overall verdict false (exit 1). No "unknown but pass".
 *
 * USAGE: node scripts/phase-2c-23-owner-briefing-ga-decision-check.js
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

// ── Phase 2C.23 NEW files (path-scope gate + mutation guard + secret scan) ────
const PHASE_TOUCHED = [
  'docs/agent-mesh/phase-2c-23-owner-briefing-ga-decision-gate.md',
  'scripts/phase-2c-23-owner-briefing-ga-decision-check.js',
];

// Every file this checker reads — all guarded against mutation by this run.
const GUARD_FILES = {
  doc:      'docs/agent-mesh/phase-2c-23-owner-briefing-ga-decision-gate.md',
  checker:  'scripts/phase-2c-23-owner-briefing-ga-decision-check.js',
  config:   'lib/config/atlasRuntimeTruth.js',
  service:  'lib/services/runtimeTruth.service.js',
  flags:    'lib/featureFlags.js',
  server:   'server.js',
  client:   'lib/services/rustAutomation/ownerBriefingAgentClient.js',
  gate19:   'scripts/phase-2c-19-owner-briefing-evidence-gate.js',
  doc17:    'docs/agent-mesh/phase-2c-17-staging-pair-decoupling-and-canary-close.md',
  doc20:    'docs/agent-mesh/phase-2c-20-production-readiness-gate.md',
};

// ── MUTATION GUARD (part 1): hash everything BEFORE any work ──────────────────
const HASH_BEFORE = {};
for (const [k, rel] of Object.entries(GUARD_FILES)) HASH_BEFORE[k] = sha256(rel);

const src = {
  doc:    read(GUARD_FILES.doc),
  flags:  read(GUARD_FILES.flags),
  server: read(GUARD_FILES.server),
  client: read(GUARD_FILES.client),
  gate19: read(GUARD_FILES.gate19),
  doc17:  read(GUARD_FILES.doc17),
  doc20:  read(GUARD_FILES.doc20),
};

// ── load the PURE runtime-truth modules (no DB / no network — safe require) ───
let registry = null, truth = null, validateRes = { ok: false }, loadError = null;
try {
  const svc = require(path.join(ROOT, GUARD_FILES.service));
  registry = require(path.join(ROOT, GUARD_FILES.config));
  truth = svc.buildRuntimeTruth({ generatedAt: '2026-01-01T00:00:00.000Z' });
  validateRes = svc.validateStatuses();
} catch (e) { loadError = String(e && e.message ? e.message : e); }

// ── Gate 01 — Prior proof artifacts exist (2C.12 .. 2C.22 + this phase) ───────
const PRIOR_ARTIFACTS = [
  'docs/agent-mesh/phase-2c-12-owner-briefing-rag-evidence-contract.md',
  'docs/agent-mesh/phase-2c-15-production-owner-briefing-rollout.md',
  'docs/agent-mesh/phase-2c-16-production-rust-sidecar-separation.md',
  'docs/agent-mesh/phase-2c-17-staging-pair-decoupling-and-canary-close.md',
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
];
const missingArtifacts = PRIOR_ARTIFACTS.filter((p) => !exists(p));
const g01 = {
  all_prior_artifacts_exist: missingArtifacts.length === 0,
  decision_doc_exists:       src.doc.length > 0,
  service_loads:             truth !== null && loadError === null,
};

// ── Gate 02 — Decision model integrity (markers parsed from the doc) ──────────
// Every marker is counted CASE-INSENSITIVELY across the WHOLE doc (uniqueness),
// then read, then guarded by a doc-wide negative for its upgrade shape — so a
// duplicate, lowercase-lookalike, or appended ": yes"/": present" line anywhere
// in the doc fails the gate. (Hardened per the 2C.23 adversarial review.)
const dsAll  = src.doc.match(/DECISION_STATE:\s*[a-z_]+/gi) || [];
const gaAll  = src.doc.match(/GA_READY:\s*(?:yes|no)/gi) || [];
const pcrAll = src.doc.match(/PRODUCTION_CANARY_READY:\s*(?:yes|no)/gi) || [];
const spAll  = src.doc.match(/STAGING_PROVEN:\s*(?:yes|no)/gi) || [];
const ccpAll = src.doc.match(/CANARY_CLOSE_PROOF:\s*[a-z_]+/gi) || [];
const decisionState = (src.doc.match(/DECISION_STATE:\s*([a-z_]+)/) || [])[1] || null;
const gaReady = (src.doc.match(/GA_READY:\s*(yes|no)/) || [])[1] || null;
const canaryReady = (src.doc.match(/PRODUCTION_CANARY_READY:\s*(yes|no)/) || [])[1] || null;
const stagingProven = (src.doc.match(/STAGING_PROVEN:\s*(yes|no)/) || [])[1] || null;
const canaryCloseProof = (src.doc.match(/CANARY_CLOSE_PROOF:\s*([a-z_]+)/) || [])[1] || null;
const FOUR_STATES = ['ga_ready', 'production_canary_ready', 'staging_proven_only', 'blocked'];
const g02 = {
  model_declares_four_states: FOUR_STATES.every((s) => src.doc.includes(s)) &&
                              /DECISION_MODEL_STATES:/.test(src.doc),
  exactly_one_decision_state: dsAll.length === 1,
  exactly_one_ga_ready_marker: gaAll.length === 1,
  exactly_one_canary_ready_marker: pcrAll.length === 1,
  exactly_one_staging_proven_marker: spAll.length === 1,
  exactly_one_canary_close_marker: ccpAll.length === 1,
  state_in_enum:              FOUR_STATES.includes(decisionState),
  state_is_staging_proven_only: decisionState === 'staging_proven_only',
  not_ga_ready_state:         decisionState !== 'ga_ready',
  not_canary_ready_state:     decisionState !== 'production_canary_ready',
  ga_ready_is_no:             gaReady === 'no',
  canary_ready_is_no:         canaryReady === 'no',
  staging_proven_is_yes:      stagingProven === 'yes',
  canary_close_proof_absent:  canaryCloseProof === 'absent',
  no_upgrade_markers_docwide: !/GA_READY:\s*yes/i.test(src.doc) &&
                              !/PRODUCTION_CANARY_READY:\s*yes/i.test(src.doc) &&
                              !/CANARY_CLOSE_PROOF:\s*present/i.test(src.doc) &&
                              !/DECISION_STATE:\s*(?:ga_ready|production_canary_ready)/i.test(src.doc) &&
                              !/\bga_ready\s*:\s*yes/i.test(src.doc) &&
                              !/\bproduction_canary_ready\s*:\s*yes/i.test(src.doc),
};

// ── Gate 03 — Runtime Truth conservative (rebuilt + independently re-tallied) ─
// Array/summary shapes are guarded so a malformed registry degrades to empty
// inputs (failing the gates) instead of throwing past the JSON envelope.
const rawArraysOk = !!registry && [registry.PACKS, registry.AGENTS, registry.WORKFLOWS].every(Array.isArray);
const rawAll = rawArraysOk ? [...registry.PACKS, ...registry.AGENTS, ...registry.WORKFLOWS] : [];
const rawLiveProven = rawAll.filter((e) => e.status === 'live_proven').length;
const builtArraysOk = !!truth && [truth.packs, truth.agents, truth.workflows].every(Array.isArray);
const entities = builtArraysOk ? [...truth.packs, ...truth.agents, ...truth.workflows] : [];
const summary = (truth && truth.summary) || null;
const liveLimitedIds = entities.filter((e) => e.status === 'live_limited').map((e) => e.id).sort();
const EXPECTED_LIVE_LIMITED = ['core.owner_briefing', 'workflow.owner_briefing_preview'].sort();
const ob = builtArraysOk ? truth.agents.find((a) => a.id === 'core.owner_briefing') : null;
const liveCount = entities.filter((e) => e.status === 'live_proven' || e.status === 'live_limited').length;
const g03 = {
  validate_ok:                validateRes.ok === true,
  live_proven_is_zero:        !!summary && summary.live_proven === 0 && rawLiveProven === 0 && rawArraysOk,
  owner_briefing_present:     !!ob,
  owner_briefing_live_limited: !!ob && ob.status === 'live_limited',
  owner_briefing_not_live_proven: !!ob && ob.status !== 'live_proven',
  exactly_two_live_limited:   liveLimitedIds.length === 2 &&
                              JSON.stringify(liveLimitedIds) === JSON.stringify(EXPECTED_LIVE_LIMITED),
  planned_blocked_not_live:   !!summary && liveCount === (summary.live_proven + summary.live_limited),
  counts_sum_to_total:        !!summary && rawArraysOk && (summary.live_proven + summary.live_limited +
                              summary.planned + summary.blocked) === rawAll.length,
};

// ── Gate 04 — Owner Briefing not marked GA anywhere that matters ──────────────
const obLimits = ob && Array.isArray(ob.limitations) ? ob.limitations.join(' || ') : '';
const previewWf = builtArraysOk ? truth.workflows.find((w) => w.id === 'workflow.owner_briefing_preview') : null;
const previewLimits = previewWf && Array.isArray(previewWf.limitations) ? previewWf.limitations.join(' || ') : '';
const g04 = {
  registry_agent_says_not_ga:    obLimits.includes('NOT GA'),
  registry_workflow_says_not_ga: previewLimits.includes('NOT GA'),
  registry_says_canary_pending:  /canary is still pending/i.test(obLimits),
  doc17_ga_not_declared:         src.doc17.includes('GA NOT YET declared'),
  doc23_no_ga_claim:             !/GA_READY:\s*yes/i.test(src.doc) &&
                                 !/\b(declared GA|GA declared|is GA[- ]ready|generally available)\b/i.test(src.doc),
};

// ── Gate 05 — Pipeline + external send blocked; unsafe toggles all off ─────────
const sync = builtArraysOk ? truth.workflows.find((w) => w.id === 'workflow.neon_to_cortex_sync') : null;
const ext = builtArraysOk ? truth.workflows.find((w) => w.id === 'workflow.external_message_send') : null;
const g05 = {
  neon_sync_present:        !!sync,
  neon_sync_blocked:        !!sync && sync.status === 'blocked',
  neon_sync_reason_canary:  !!sync && sync.blocked_reason === 'production_canary',
  external_send_blocked:    !!ext && ext.status === 'blocked',
  execution_disabled:       !!truth && truth.execution_enabled === false,
  production_sync_disabled: !!truth && truth.production_sync_enabled === false,
  external_send_disabled:   !!truth && truth.external_send_enabled === false,
  environment_redacted:     !!truth && truth.environment === 'safe_redacted',
};

// ── Gate 06 — Production blockers enumerated (doc markers + 2C.20 cross-check) ─
const EXPECTED_BLOCKERS = [
  'real_tenant_map',
  'production_connectivity_proof',
  'production_schema_parity',
  'canary_scope',
  'explicit_owner_approval',
  'rollback_procedure',
  'observability_audit_proof',
];
const docBlockers = (src.doc.match(/^BLOCKER:\s*([a-z_]+)\s*$/gm) || [])
  .map((l) => l.replace(/^BLOCKER:\s*/, '').trim()).sort();
const g06 = {
  all_seven_blockers_listed: JSON.stringify(docBlockers) === JSON.stringify([...EXPECTED_BLOCKERS].sort()),
  doc20_lists_tenant_map:    /tenant map/i.test(src.doc20),
  doc20_lists_connectivity:  /connectivity proof/i.test(src.doc20),
  doc20_lists_schema_parity: /schema parity/i.test(src.doc20),
  doc20_lists_canary_scope:  /canary scope/i.test(src.doc20),
  doc20_lists_owner_approval: /owner approval/i.test(src.doc20),
};

// ── Gate 07 — Proof gaps enumerated (cannot be silently dropped) ──────────────
const EXPECTED_GAPS = [
  'no_canary_observation_artifacts',
  'confidence_gate_not_discriminating',
  'seeded_test_tenants_only',
  'flag_state_unprovable_from_repo',
  'evidence_data_source_unresolved',
  'harness_scores_not_committed',
];
const docGaps = (src.doc.match(/^PROOF_GAP:\s*([a-z_]+)\s*$/gm) || [])
  .map((l) => l.replace(/^PROOF_GAP:\s*/, '').trim()).sort();
const g07 = {
  all_six_gaps_listed: JSON.stringify(docGaps) === JSON.stringify([...EXPECTED_GAPS].sort()),
};

// ── Gate 08 — Overclaim guard (registry allowed-claims + this phase's doc) ────
const lc = (truth && truth.launch_claims) || { allowed: [], blocked: [] };
const allowedJoined = (lc.allowed || []).join(' || ').toLowerCase();
const blockedJoined = (lc.blocked || []).join(' || ').toLowerCase();
const OVERCLAIM_PHRASES = [
  '216 live agents', 'fully autonomous', 'production-live neon', 'live external whatsapp',
  'bank-grade', 'military-grade', '100+ live', '200+ live',
];
const DOC_FORBIDDEN_CLAIMS = [
  /216 live agents/i, /fully autonomous/i, /bank-grade/i, /military-grade/i,
  /production canary approved/i, /production sync enabled/i, /external sending enabled/i,
  /\bproduction-live\b/i,
];
const overclaimInAllowed = OVERCLAIM_PHRASES.filter((p) => allowedJoined.includes(p));
const docOverclaims = DOC_FORBIDDEN_CLAIMS.filter((re) => re.test(src.doc)).length;
const g08 = {
  no_overclaim_in_allowed:  overclaimInAllowed.length === 0,
  blocked_list_still_blocks: blockedJoined.includes('216 live agents') &&
                             blockedJoined.includes('fully autonomous') &&
                             /neon/.test(blockedJoined) && /whatsapp|twilio|external/.test(blockedJoined),
  doc_free_of_overclaims:   docOverclaims === 0,
};

// ── Gate 09 — Flag defaults safe (source patterns + deterministic runtime) ────
// In-process env DELETE only (never written to disk) so the default check cannot
// be skewed by a shell export; then reload the real flags module.
let runtimeDefaultsOff = false;
try {
  delete process.env.FEATURE_RUNTIME_TRUTH_API_ENABLED;
  delete process.env.FEATURE_OWNER_BRIEFING_AGENT_ENABLED;
  delete process.env.FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED;
  const flagsPath = require.resolve(path.join(ROOT, GUARD_FILES.flags));
  delete require.cache[flagsPath];
  const { isEnabled } = require(flagsPath);
  runtimeDefaultsOff = isEnabled('runtime_truth_api_enabled') === false &&
                       isEnabled('owner_briefing_agent_enabled') === false &&
                       isEnabled('external_message_sending_enabled') === false;
} catch (e) { runtimeDefaultsOff = false; }
const defaultOnCount = (src.flags.match(/!==\s*'false'/g) || []).length;
const g09 = {
  owner_briefing_default_off_source: /owner_briefing_agent_enabled\s*:\s*process\.env\.FEATURE_OWNER_BRIEFING_AGENT_ENABLED\s*===\s*'true'/.test(src.flags),
  runtime_truth_default_off_source:  /runtime_truth_api_enabled\s*:\s*process\.env\.FEATURE_RUNTIME_TRUTH_API_ENABLED\s*===\s*'true'/.test(src.flags),
  external_send_default_off_source:  /external_message_sending_enabled\s*:\s*process\.env\.FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED\s*===\s*'true'/.test(src.flags),
  runtime_defaults_off:              runtimeDefaultsOff === true,
  only_prompt_guard_default_on:      defaultOnCount === 1 &&
    /prompt_guard_enabled\s*:\s*process\.env\.FEATURE_PROMPT_GUARD_ENABLED\s*!==\s*'false'/.test(src.flags),
  // No alternate default-ON idiom anywhere in the flags source (a future
  // `: true`, `|| true`, `?? 'true'`, or `!process.env.X` default would
  // bypass the !== 'false' count above — fail closed on any of them).
  no_alternate_default_on_idiom:     !/:\s*true\s*[,}\n]/.test(src.flags) &&
                                     !/\|\|\s*true\b/.test(src.flags) &&
                                     !/\?\?\s*'?true'?/.test(src.flags) &&
                                     !/:\s*!process\.env/.test(src.flags),
};

// ── Gate 10 — Preview endpoint source: auth-gated, flag-gated, read-only ──────
const EP_MARK = "app.get('/api/agents/core.owner_briefing/preview'";
const epStart = src.server.indexOf(EP_MARK);
let epBlock = '';
if (epStart > -1) {
  const rest = src.server.slice(epStart + EP_MARK.length);
  const nextRoute = rest.search(/\bapp\.(get|post|put|delete|patch|all|use)\(/);
  epBlock = EP_MARK + (nextRoute > -1 ? rest.slice(0, nextRoute) : rest.slice(0, 8000));
}
const epFlagIdx = epBlock.indexOf("_fe('owner_briefing_agent_enabled')");
const ep404Idx = epBlock.indexOf('status(404)');
const epAuditIdx = epBlock.indexOf("'AGENT_PREVIEW'");
const g10 = {
  endpoint_present:        epBlock.length > 0,
  auth_middleware_on_route: /app\.get\(\s*'\/api\/agents\/core\.owner_briefing\/preview'\s*,\s*authMiddleware/.test(src.server),
  flag_gate_present:       epFlagIdx > -1,
  returns_404_when_off:    ep404Idx > -1,
  flag_gate_before_work:   epFlagIdx > -1 && epAuditIdx > -1 && epFlagIdx < epAuditIdx,
  user_id_from_jwt:        epBlock.includes('req.user?.id') || epBlock.includes('req.user.id'),
  audit_action_present:    epAuditIdx > -1,
  no_send_markers:         !/twilio|whatsapp|sendMessage|external_message/i.test(epBlock),
  no_db_in_endpoint:       !/getPool|pool\.query|supabase|createClient/i.test(epBlock),
};

// ── Gate 11 — Evidence contract authoritative + fail-closed ───────────────────
const g11 = {
  client_exists:            src.client.length > 0,
  contract_version_pinned:  /CONTRACT_VERSION\s*=\s*'2c\.12'/.test(src.client),
  confidence_threshold_pinned: /CONFIDENCE_THRESHOLD\s*=\s*0\.65/.test(src.client),
  enforce_fn_present:       /function\s+enforceEvidenceContract\s*\(/.test(src.client),
  safe_to_show_composite:   /hasEvidence\s*&&\s*safeClaimCount\s*>\s*0\s*&&\s*overallConf\s*>=\s*CONFIDENCE_THRESHOLD/.test(src.client),
  fail_closed_fallback:     src.client.includes('UNAVAILABLE_BRIEFING') && src.client.includes('RUST_UNAVAILABLE'),
  gate19_imports_authoritative: /require\([^)]*ownerBriefingAgentClient[^)]*\)/.test(src.gate19) &&
                                src.gate19.includes('enforceEvidenceContract'),
};

// ── Gate 12 — No secrets/PII shapes in this phase's files ─────────────────────
// The DOC is scanned in full. The checker itself is excluded from the value-
// pattern scan because it legitimately embeds these regexes as detection
// literals (same exclusion the 2C.21 checker documents for itself).
const VALUE_PATTERNS = [
  /postgres(?:ql)?:\/\//i, /eyJ[A-Za-z0-9_-]{10,}/, /\bbearer\s+[A-Za-z0-9._-]{10,}/i,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, /\b\d{10,}\b/, /\+\d[\d -]{8,}\d/,
  /\b(?:sk|rk|pk|rzp)_live_[A-Za-z0-9]{4,}/i, /\bsk-[A-Za-z0-9]{16,}/, /BEGIN [A-Z ]*PRIVATE KEY/,
];
const docPiiHits = VALUE_PATTERNS.filter((re) => re.test(src.doc)).length;
// The checker IS additionally scanned with a curated literal-secret subset whose
// patterns cannot self-match their own source (contiguous-credential shapes the
// embedded detection regexes never form). Real secrets in the checker fail here.
const checkerSrc = read(GUARD_FILES.checker);
const CHECKER_SECRET_LITERALS = [
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,   // real JWT (header.payload with dot)
  /postgres(?:ql)?:\/\/[A-Za-z0-9]/,              // literal DB URL with host char
  /\b(?:sk|rk|pk|rzp)_live_[A-Za-z0-9]{8,}/,      // contiguous live API key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,           // PEM block with dashes
];
const checkerSecretHits = CHECKER_SECRET_LITERALS.filter((re) => re.test(checkerSrc)).length;
const g12 = {
  doc_free_of_secret_pii_shapes:    docPiiHits === 0,
  checker_present:                  checkerSrc.length > 0,
  checker_free_of_secret_literals:  checkerSecretHits === 0,
};

// ── Gate 13 — DECLARED path scope (static; see honesty note) ──────────────────
// HONESTY NOTE: this gate validates the DECLARED phase file list (a constant in
// this script) plus the on-disk existence of exactly those files. It cannot see
// the actual working tree — this checker spawns no process, so it cannot run
// git. Actual working-tree scope is verified EXTERNALLY (git status / git diff
// --name-only) in the phase report and by review. The gate still has teeth: it
// fails if the declared list ever names an env/Railway/frontend/deploy path or
// strays outside scripts/ + docs/, and it anchors the informational scope
// booleans below to an inspectable declaration rather than free prose.
const g13 = {
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
const g14 = {
  all_hashes_captured:        Object.values(HASH_BEFORE).every((h) => typeof h === 'string'),
  files_unchanged_during_run: mutated.length === 0,
};

// ── roll up ───────────────────────────────────────────────────────────────────
const GATES = {
  '01_prior_proof_artifacts_exist':   g01,
  '02_decision_model_integrity':      g02,
  '03_runtime_truth_conservative':    g03,
  '04_owner_briefing_not_ga':         g04,
  '05_pipeline_and_send_blocked':     g05,
  '06_blockers_enumerated':           g06,
  '07_proof_gaps_enumerated':         g07,
  '08_overclaim_guard':               g08,
  '09_flags_default_safe':            g09,
  '10_endpoint_source_safe':          g10,
  '11_evidence_contract_authoritative': g11,
  '12_no_secrets_pii_in_new_files':   g12,
  '13_declared_path_scope':           g13,
  '14_mutation_guard':                g14,
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
  // decision — PARSED from the doc markers, then gated above (not hardcoded)
  decision: {
    decision_state:          decisionState,
    ga_ready:                gaReady === 'yes',
    production_canary_ready: canaryReady === 'yes',
    staging_proven:          stagingProven === 'yes',
    canary_close_proof:      canaryCloseProof,
    blockers_count:          docBlockers.length,
    blockers:                docBlockers,
    proof_gaps_count:        docGaps.length,
    proof_gaps:              docGaps,
  },
  runtime_truth_summary: summary,
  load_error: loadError,
  // diagnostics (counts / marker names only — never values)
  missing_prior_artifacts: missingArtifacts,
  overclaim_phrases_in_allowed: overclaimInAllowed,
  doc_overclaim_hits: docOverclaims,
  doc_pii_pattern_hits: docPiiHits,
  files_mutated_by_check: mutated,
  guard_file_hashes: hashes,
  // ── informational ONLY — DERIVED from the gates above; NEVER feeds the verdict
  informational_only_not_a_pass_condition: {
    note: 'Display-only, never part of overall_pass. Scope booleans derive from the DECLARED phase file list (gate 13) + secret scans (gate 12) + the mutation guard (gate 14); the ACTUAL working-tree scope is verified externally via git status/diff in the phase report.',
    production_touched:  (g13.backend_paths_only_declared && g14.files_unchanged_during_run) ? false : null,
    railway_touched:     g13.no_railway_file_declared ? false : null,
    env_files_changed:   g13.no_env_file_declared ? false : null,
    frontend_touched:    g13.no_frontend_file_declared ? false : null,
    deploy_triggered:    g13.no_deploy_file_declared ? false : null,
    secrets_exposed:     (g12.doc_free_of_secret_pii_shapes && g12.checker_free_of_secret_literals) ? false : null,
  },
  gate_results,
};
if (!overall_pass) {
  result._note = 'FAIL-CLOSED: one or more GA-decision gates unmet. Upgrading the decision state requires a NEW phase with NEW proof artifacts, never an edit to this gate alone.';
}
console.log('GA_DECISION_JSON:' + JSON.stringify(result, null, 1));
process.exit(overall_pass ? 0 : 1);
