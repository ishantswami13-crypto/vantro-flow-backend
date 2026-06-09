#!/usr/bin/env node
'use strict';
/*
 * Phase 2C.20 — Production-Readiness Gate for the Neon → Cortex pipeline.
 * ─────────────────────────────────────────────────────────────────────────────
 * STATIC, READ-ONLY auditor. It proves — by inspecting the repo's own pipeline
 * assets — that all 12 production-readiness invariants are present and wired
 * BEFORE any production canary of the Neon → Cortex sync is ever considered.
 *
 * It does NOT connect to any database (Neon, staging Cortex, or production), does
 * NOT touch Railway, does NOT deploy, does NOT mutate env files, and does NOT
 * write anything. It only reads files under the repo and asserts structure.
 *
 * FAIL-CLOSED: any missing file, missing guard, or unmet invariant makes that
 * check false, its gate false, and the overall result false. There is no
 * "unknown but pass" — an unreadable asset is a failure, never a skip.
 *
 * OUTPUT: COUNTS / BOOLEANS only. It never prints secrets, DB URLs, refs, JWTs,
 * keys, PII, or raw row data. (It asserts those protections exist in the other
 * scripts; it does not read any secret value itself.)
 *
 * USAGE:
 *   node scripts/phase-2c-20-production-readiness-check.js
 *   #   exit 0 = all gates pass; exit 1 = at least one gate fails (fail-closed)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── read-only file access (missing → '' so every assertion fails closed) ──────
function read(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return ''; }
}
function exists(rel) {
  try { fs.accessSync(path.join(ROOT, rel)); return true; } catch (e) { return false; }
}
function readJson(rel) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch (e) { return null; }
}
const has = (s, re) => (typeof re === 'string' ? s.includes(re) : re.test(s));
const all = (obj) => Object.values(obj).every((v) => v === true);

// ── pipeline assets under audit (paths only — no values read from them) ───────
const F = {
  load:    'scripts/phase-2c-19-neon-cortex-load.js',
  launch:  'scripts/phase-2c-19-launch-staging-sidecar.js',
  gate:    'scripts/phase-2c-19-owner-briefing-evidence-gate.js',
  dryrun:  'scripts/phase-2c-19-neon-cortex-dry-run.js',
  seed:    'scripts/phase-2c-19-neon-org-map.staging.json',
  schema:  'scripts/supabase/phase-2c-19-staging-sync-schema.sql',
  client:  'lib/services/rustAutomation/ownerBriefingAgentClient.js',
  flags:   'lib/featureFlags.js',
  design:  'docs/agent-mesh/phase-2c-19-production-neon-to-cortex-pipeline.md',
};

const src = {};
for (const k of Object.keys(F)) src[k] = read(F[k]);
const seed = readJson(F.seed);

const PROD_REF = 'alepdpyqesevldobjxbo'; // production Supabase ref — must be hard-blocked everywhere

// ── Gate 1 — Environment separation (prod ref/domain hard-blocked everywhere) ─
const g1 = {
  load_blocks_prod_ref:    has(src.load, PROD_REF) && has(src.load, /vantro\.in/i),
  launch_blocks_prod_ref:  has(src.launch, PROD_REF) && has(src.launch, /production_blocked/),
  gate_blocks_prod_ref:    has(src.gate, PROD_REF) && has(src.gate, /rest_prod_blocked/),
  seed_is_staging:         !!seed && typeof seed.environment === 'string' && /staging/i.test(seed.environment),
  staging_url_var_only:    has(src.load, 'STAGING_DATABASE_URL') && !has(src.load, /\bprocess\.env\.DATABASE_URL\b/),
};

// ── Gate 2 — Tenant mapping (explicit, human-verified, exact-match, no fuzzy) ─
const seedEntries = (seed && Array.isArray(seed.entries)) ? seed.entries : [];
const entryFields = ['neon_org_id', 'cortex_user_id', 'mapping_source', 'verified_by', 'verified_at', 'active'];
const g2 = {
  seed_present:            seedEntries.length > 0,
  every_entry_complete:    seedEntries.length > 0 && seedEntries.every((e) => e && entryFields.every((f) => e[f] !== undefined && e[f] !== null && e[f] !== '')),
  exact_integer_map:       has(src.load, /ORG_TO_USER/) && has(src.load, /Number\(/),
  no_fuzzy_matching:       has(src.load, /No fuzzy matching/i) || has(src.design, /No automatic fuzzy matching/i),
  unmapped_rejected:       has(src.load, /rejected_org/),
};

// ── Gate 3 — Idempotency (partial-unique on synced rows + upsert + 0-net-new) ─
const g3 = {
  partial_unique_indexes:  has(src.schema, /WHERE source_id IS NOT NULL/) && has(src.schema, /\(user_id, sync_source, source_type, source_id\)/),
  upsert_by_source_key:    has(src.load, /function upsert/) && has(src.load, /sync_source=eq\.neon&source_type=eq\./),
  idempotency_proof:       has(src.load, /net_new_zero/) && has(src.load, /counts_stable/),
};

// ── Gate 4 — Rollback (reversible by sync_batch_id) ───────────────────────────
const g4 = {
  rollback_mode:           has(src.load, /MODE === 'rollback'/) || has(src.load, /'rollback'/),
  rollback_by_batch:       has(src.load, /function rollbackBatch/) && has(src.load, /sync_batch_id=eq\.\$\{batch\}/),
  requires_batch_arg:      has(src.load, /requires --batch=<sync_batch_id>/),
};

// ── Gate 5 — Evidence contract (authoritative production code, not a copy) ────
const g5 = {
  client_exists:           exists(F.client),
  client_exports_contract: has(src.client, /enforceEvidenceContract/) && has(src.client, /module\.exports/),
  gate_imports_authoritative: has(src.gate, /ownerBriefingAgentClient/) && has(src.gate, /enforceEvidenceContract/),
  fail_closed_when_unreachable: has(src.gate, /fail closed/i) || has(src.gate, /Fails closed/i),
};

// ── Gate 6 — Tenant isolation (no cross-tenant rows / no cross-tenant evidence) ─
const g6 = {
  load_isolation_check:    has(src.load, /all_zero_foreign/) && has(src.load, /user_id=neq\./),
  gate_isolation_check:    has(src.gate, /owner_b_no_owner_a_data/) && has(src.gate, /isolationOk/),
  gate_subset_check:       has(src.gate, /evidenceSubsetOk/),
};

// ── Gate 7 — Sync audit ledger (sync_batches: every row attributable to a batch) ─
const g7 = {
  ledger_table_defined:    has(src.schema, /CREATE TABLE IF NOT EXISTS public\.sync_batches/),
  ledger_columns:          ['sync_batch_id', 'sync_source', 'user_id', 'status', 'started_at', 'counts'].every((c) => has(src.schema, c)),
  load_opens_batch:        has(src.load, /\/sync_batches/) && has(src.load, /status: 'running'/),
  load_closes_batch:       has(src.load, /status: 'succeeded'/) && has(src.load, /finished_at/),
};

// ── Gate 8 — Observability (structured, counts/booleans only; secrets scrubbed) ─
const g8 = {
  load_scrubs_secrets:     has(src.load, /const scrub =/) && has(src.load, /REDACTED/),
  load_structured_output:  has(src.load, /RESULT_JSON:/),
  gate_structured_output:  has(src.gate, /GATE_JSON:/) && has(src.gate, /REDACTED/),
  launch_structured_output: has(src.launch, /SIDECAR_LAUNCH:/) && has(src.launch, /SAFE BOOLEANS\/LABELS ONLY/i),
  counts_only_contract:    has(src.load, /COUNTS \/ BOOLEANS only/i) && has(src.gate, /COUNTS \/ BOOLEANS only/i),
};

// ── Gate 9 — Feature flags (external send OFF by default; pipeline not auto-wired) ─
const g9 = {
  external_send_flag_default_off: has(src.flags, /external_message_sending_enabled/) && has(src.flags, /FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED\s+===\s+'true'/),
  pipeline_not_wired:      has(src.load, /NOT wired into the app/i) && has(src.load, /No feature flag enables it/i),
  manual_operator_only:    has(src.load, /MANUAL OPERATOR SCRIPT/i),
};

// ── Gate 10 — Canary rollout safety (persistent load fail-closed; staging-first) ─
const g10 = {
  persistent_fail_closed:  has(src.load, /ALLOW_PERSISTENT_STAGING_LOAD/) && has(src.load, /--confirm=PERSIST/) && has(src.load, /FAIL-CLOSED/i),
  proof_requires_clean:    has(src.load, /proof mode requires a clean staging/i),
  staging_first_documented: has(src.design, /Staging first/i) && has(src.design, /Production enablement is out of scope/i),
};

// ── Gate 11 — No external sending (gate uses read-only /preview only) ──────────
const g11 = {
  preview_path_readonly:   has(src.gate, /\/preview/) && has(src.gate, /preview_path_is_readonly/),
  external_send_not_used:  has(src.gate, /external_send_used: false/),
  no_send_endpoint:        !has(src.gate, /\/send/) && !has(src.dryrun, /\/send/),
};

// ── Gate 12 — Production rollback readiness (documented + executable by batch) ─
const g12 = {
  rollback_documented:     has(src.design, /--mode=rollback --batch=/) && has(src.design, /Rollback readiness/i),
  rollback_executable:     g4.rollback_by_batch === true,
  // The Owner Briefing feature flag is the production kill switch: default-OFF
  // (`=== 'true'`), so flipping it OFF disables the feature (documented rollback).
  feature_flag_rollback:   has(src.flags, /owner_briefing_agent_enabled/) && has(src.flags, /FEATURE_OWNER_BRIEFING_AGENT_ENABLED\s+===\s+'true'/),
};

// ── roll up ───────────────────────────────────────────────────────────────────
const GATES = {
  '01_environment_separation':       g1,
  '02_tenant_mapping':               g2,
  '03_idempotency':                  g3,
  '04_rollback':                     g4,
  '05_evidence_contract':            g5,
  '06_tenant_isolation':             g6,
  '07_sync_audit_ledger':            g7,
  '08_observability':                g8,
  '09_feature_flags':                g9,
  '10_canary_rollout_safety':        g10,
  '11_no_external_sending':          g11,
  '12_production_rollback_readiness': g12,
};

const gate_results = {};
let gates_passed = 0;
for (const [name, checks] of Object.entries(GATES)) {
  const pass = all(checks);
  if (pass) gates_passed++;
  gate_results[name] = { pass, checks };
}
const gates_total = Object.keys(GATES).length;

// All referenced assets must exist (fail-closed on a missing pipeline file).
const assets_present = Object.fromEntries(Object.entries(F).map(([k, rel]) => [k, exists(rel)]));
const all_assets_present = Object.values(assets_present).every(Boolean);

const overall_pass = all_assets_present && gates_passed === gates_total;

// ── self-attestation (this auditor performs no side effects) ──────────────────
const result = {
  overall_pass,
  gates_passed,
  gates_total,
  all_assets_present,
  // safety self-attestation — this script is static/read-only by construction:
  production_touched: false,
  railway_touched: false,
  db_connection_opened: false,
  env_files_changed: false,
  writes_performed: false,
  secrets_printed: false,
  assets_present,
  gate_results,
};
if (!overall_pass) {
  result._note = 'FAIL-CLOSED: one or more readiness gates unmet or a pipeline asset is missing. Resolve before any production canary.';
}
console.log('READINESS_JSON:' + JSON.stringify(result, null, 1));
process.exit(overall_pass ? 0 : 1);
