#!/usr/bin/env node
'use strict';
/*
 * Phase 2C.26 — Atlas Pack Registry backend-contract check (FAIL-CLOSED).
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves, statically and fail-closed, that the Atlas Pack Civilization Layer is
 * defined as READ-ONLY, proof-gated backend truth that NEVER executes or activates
 * a pack. The verdict derives ONLY from independent evidence:
 *   (A) the PURE pack-registry service + config loaded with NO DB / NO network /
 *       NO env reads, with counts re-tallied independently from the raw PACKS array
 *       (live_proven == 0, execution_allowed == 0, activation_allowed == 0);
 *   (B) structural invariants over every pack (allowed status/family/category/
 *       proof-level/CTA enums, all required fields present, no forbidden CTA, no
 *       executable preview/custom/roadmap/connector/partner pack);
 *   (C) the required pack families + the 23 minimum packs all present, and the
 *       Trader / Enterprise / Custom packs visible (read-only) in the service output;
 *   (D) the optional server route, when present, is GET-only, auth-gated, and
 *       feature-gated default-OFF, with NO POST/PATCH/DELETE pack route and no
 *       DB / sync / execution token in its block;
 *   (E) the feature flag is defined default-OFF and introduces no new default-ON flag;
 *   (F) prior-phase conservatism still holds — 2C.21 runtime-truth live_proven == 0
 *       (rebuilt from its pure service), 2C.23 GA_READY/PRODUCTION_CANARY_READY == no,
 *       2C.24 CANARY_READY == no, 2C.25 owner/scope records still absent
 *       (re-derived from the prior docs' own machine-readable markers);
 *   (G) an overclaim scan of the config/service/doc, a secret/PII + purity scan of
 *       this phase's code files, a DECLARED-path-scope gate, and a SHA-256 mutation
 *       guard over every file this checker reads.
 *
 * NO self-attestation feeds the verdict. The production_touched/railway_touched/etc.
 * booleans live in `informational_only_not_a_pass_condition`, DERIVED from the path-
 * scope, secret-scan, and mutation gates; `overall_pass` never reads them. (Same
 * doctrine as the 2C.21/2C.22/2C.23/2C.24/2C.25 checkers.)
 *
 * SAFETY: read-only. Opens NO database, makes NO network call, writes NO file,
 * spawns NO process. The only env interaction is DELETING the pack-registry API
 * FEATURE_* var in-process (never on disk) BEFORE the flag module loads, so the
 * default-OFF check is deterministic. Output is COUNTS / BOOLEANS / STATUS / NAMES
 * only — never secrets, DB URLs, JWTs, tokens, env values, PII, or raw row data.
 *
 * FAIL-CLOSED: any missing artifact, unknown status, executable/activatable pack,
 * forbidden CTA, dropped family/pack, unsafe route, default-ON flag, flipped prior-
 * phase marker, overclaim phrase, secret/PII/impure pattern, or hash drift makes its
 * gate false and the verdict false (exit 1).
 *
 * USAGE: node scripts/phase-2c-26-atlas-pack-registry-check.js
 *        exit 0 = all gates pass; exit 1 = fail-closed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

// DETERMINISM: ensure the pack-registry API flag is unset in-process BEFORE the
// flag module reads env at load. Never written to disk; reverts on process exit.
delete process.env.FEATURE_ATLAS_PACK_REGISTRY_API_ENABLED;

function read(rel) { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return ''; } }
function exists(rel) { try { fs.accessSync(path.join(ROOT, rel)); return true; } catch (e) { return false; } }
function sha256(rel) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex'); }
  catch (e) { return null; }
}
const all = (obj) => Object.values(obj).every((v) => v === true);

// ── Phase 2C.26 NEW/CHANGED files (path-scope gate) ───────────────────────────
const PHASE_TOUCHED = [
  'lib/config/atlasPackRegistry.js',
  'lib/services/atlasPackRegistry.service.js',
  'docs/agent-mesh/phase-2c-26-atlas-pack-registry-backend-contract.md',
  'scripts/phase-2c-26-atlas-pack-registry-check.js',
  'lib/featureFlags.js',
  'server.js',
];

// Every file this checker reads — all guarded against mutation by this run.
const GUARD_FILES = {
  config:     'lib/config/atlasPackRegistry.js',
  service:    'lib/services/atlasPackRegistry.service.js',
  doc:        'docs/agent-mesh/phase-2c-26-atlas-pack-registry-backend-contract.md',
  checker:    'scripts/phase-2c-26-atlas-pack-registry-check.js',
  flags:      'lib/featureFlags.js',
  server:     'server.js',
  rt_config:  'lib/config/atlasRuntimeTruth.js',
  rt_service: 'lib/services/runtimeTruth.service.js',
  doc23:      'docs/agent-mesh/phase-2c-23-owner-briefing-ga-decision-gate.md',
  doc24:      'docs/agent-mesh/phase-2c-24-production-canary-prerequisite-binder.md',
  doc25:      'docs/agent-mesh/phase-2c-25-owner-approval-canary-scope-intake.md',
};

// ── MUTATION GUARD (part 1): hash everything BEFORE any work ──────────────────
const HASH_BEFORE = {};
for (const [k, rel] of Object.entries(GUARD_FILES)) HASH_BEFORE[k] = sha256(rel);

const src = {
  config:  read(GUARD_FILES.config),
  service: read(GUARD_FILES.service),
  doc:     read(GUARD_FILES.doc),
  flags:   read(GUARD_FILES.flags),
  server:  read(GUARD_FILES.server),
  doc23:   read(GUARD_FILES.doc23),
  doc24:   read(GUARD_FILES.doc24),
  doc25:   read(GUARD_FILES.doc25),
};

// ── load the PURE pack-registry modules (no DB / no network — safe require) ────
let cfg = null, packSvc = null, packTruth = null, packList = null;
let validateRes = { ok: false, offenders: {} }, loadError = null;
try {
  cfg = require(path.join(ROOT, GUARD_FILES.config));
  packSvc = require(path.join(ROOT, GUARD_FILES.service));
  packTruth = packSvc.buildAtlasPackRegistryTruth({ generatedAt: '2026-01-01T00:00:00.000Z' });
  packList = packSvc.listAtlasPacks();
  validateRes = packSvc.validatePackRegistry();
} catch (e) { loadError = String(e && e.message ? e.message : e); }

const rawPacks = cfg && Array.isArray(cfg.PACKS) ? cfg.PACKS : [];
const summary = packTruth ? packTruth.summary : null;
const listed = Array.isArray(packList) ? packList : [];

const EXPECTED_STATUSES = [
  'live_proven', 'live_limited', 'preview', 'connector_required',
  'custom_required', 'partner_required', 'roadmap', 'disabled',
];
const EXPECTED_FAMILIES = [
  'global_core', 'trader', 'enterprise', 'custom', 'business_type', 'business_size',
  'industry', 'region', 'role', 'workflow', 'agent_swarm', 'partner_custom_deployment',
];
const MIN_PACKS = [
  'global_core', 'trader_pack', 'enterprise_pack', 'custom_pack',
  'business_type_distributor', 'business_type_manufacturer',
  'business_size_startup', 'business_size_smb', 'business_size_enterprise',
  'industry_wholesale_distribution', 'industry_manufacturing',
  'region_global', 'region_india', 'region_us', 'region_uae', 'region_uk_eu',
  'role_owner', 'role_finance',
  'workflow_owner_briefing', 'workflow_collections',
  'agent_swarm_finance_ops', 'agent_swarm_inventory_ops',
  'partner_custom_deployment',
];
const NON_EXECUTABLE_STATUSES = ['preview', 'connector_required', 'custom_required', 'partner_required', 'roadmap', 'disabled'];

// ── Gate 01 — Assets exist + pure service loads ───────────────────────────────
const g01 = {
  config_exists:  exists(GUARD_FILES.config),
  service_exists: exists(GUARD_FILES.service),
  doc_exists:     src.doc.length > 0,
  checker_exists: exists(GUARD_FILES.checker),
  service_loads:  packTruth !== null && Array.isArray(packList) && loadError === null,
};

// ── Gate 02 — Allowed pack-status enum only ───────────────────────────────────
const g02 = {
  allowed_statuses_exactly_eight: !!cfg && Array.isArray(cfg.ALLOWED_PACK_STATUSES) &&
    cfg.ALLOWED_PACK_STATUSES.length === 8 && EXPECTED_STATUSES.every((s) => cfg.ALLOWED_PACK_STATUSES.includes(s)),
  every_pack_status_allowed: rawPacks.length > 0 && rawPacks.every((p) => EXPECTED_STATUSES.includes(p.status)),
  validate_ok: validateRes.ok === true,
};

// ── Gate 03 — Required pack families present ──────────────────────────────────
const presentFamilies = new Set(rawPacks.map((p) => p.family));
const g03 = {
  allowed_families_exactly_twelve: !!cfg && Array.isArray(cfg.ALLOWED_PACK_FAMILIES) &&
    cfg.ALLOWED_PACK_FAMILIES.length === 12 && EXPECTED_FAMILIES.every((f) => cfg.ALLOWED_PACK_FAMILIES.includes(f)),
  all_required_families_present: EXPECTED_FAMILIES.every((f) => presentFamilies.has(f)),
  every_pack_family_allowed: rawPacks.length > 0 && rawPacks.every((p) => EXPECTED_FAMILIES.includes(p.family)),
};

// ── Gate 04 — Minimum packs present (all 23, unique ids) ──────────────────────
const ids = rawPacks.map((p) => p.id);
const idSet = new Set(ids);
const g04 = {
  all_minimum_packs_present: MIN_PACKS.every((id) => idSet.has(id)),
  pack_count_at_least_minimum: rawPacks.length >= MIN_PACKS.length,
  ids_unique: idSet.size === ids.length,
};

// ── Gate 05 — live_proven / execution / activation counts == 0 (service + raw) ─
const rawLiveProven = rawPacks.filter((p) => p.status === 'live_proven').length;
const rawExec = rawPacks.filter((p) => p.execution_allowed === true).length;
const rawActiv = rawPacks.filter((p) => p.activation_allowed === true).length;
const g05 = {
  service_live_proven_zero:      !!summary && summary.live_proven_count === 0,
  service_execution_allowed_zero: !!summary && summary.execution_allowed_count === 0,
  service_activation_allowed_zero: !!summary && summary.activation_allowed_count === 0,
  raw_live_proven_zero:  rawPacks.length > 0 && rawLiveProven === 0,
  raw_execution_zero:    rawPacks.length > 0 && rawExec === 0,
  raw_activation_zero:   rawPacks.length > 0 && rawActiv === 0,
};

// ── Gate 06 — No pack is executable or activatable ────────────────────────────
const g06 = {
  no_pack_execution_allowed:  rawPacks.length > 0 && rawPacks.every((p) => p.execution_allowed === false),
  no_pack_activation_allowed: rawPacks.length > 0 && rawPacks.every((p) => p.activation_allowed === false),
  non_live_not_activatable:   rawPacks.length > 0 && rawPacks.every((p) => p.status === 'live_proven' || p.activation_allowed === false),
  preview_family_not_executable: rawPacks.length > 0 && rawPacks
    .filter((p) => NON_EXECUTABLE_STATUSES.includes(p.status))
    .every((p) => p.execution_allowed === false && p.activation_allowed === false),
};

// ── Gate 07 — Trader / Enterprise / Custom visible (read-only) ────────────────
const findL = (id) => listed.find((p) => p.id === id) || null;
const tr = findL('trader_pack'), en = findL('enterprise_pack'), cu = findL('custom_pack');
const g07 = {
  trader_visible_read_only:     !!tr && tr.execution_allowed === false && tr.activation_allowed === false,
  enterprise_visible_read_only: !!en && en.execution_allowed === false && en.activation_allowed === false,
  custom_visible_read_only:     !!cu && cu.execution_allowed === false && cu.activation_allowed === false,
  doc_trader_visible_yes:     /^TRADER_PACK_VISIBLE:\s*yes\s*$/im.test(src.doc),
  doc_enterprise_visible_yes: /^ENTERPRISE_PACK_VISIBLE:\s*yes\s*$/im.test(src.doc),
  doc_custom_visible_yes:     /^CUSTOM_PACK_VISIBLE:\s*yes\s*$/im.test(src.doc),
};

// ── Gate 08 — Every pack carries all required fields with valid values ────────
const REQUIRED = (cfg && Array.isArray(cfg.REQUIRED_PACK_FIELDS)) ? cfg.REQUIRED_PACK_FIELDS : [];
const missingFields = [];
for (const p of rawPacks) {
  for (const f of REQUIRED) {
    if (!Object.prototype.hasOwnProperty.call(p, f) || p[f] === undefined) missingFields.push(p.id + ':' + f);
  }
}
const ARRAY_FIELDS = ['included_agents', 'included_workflows', 'required_data_sources', 'approval_requirements', 'evidence_requirements', 'audit_requirements'];
const g08 = {
  required_fields_count_21:   REQUIRED.length === 21,
  every_pack_has_all_fields:  rawPacks.length > 0 && missingFields.length === 0,
  proof_level_values_valid:   !!cfg && rawPacks.length > 0 && rawPacks.every((p) => cfg.ALLOWED_PROOF_LEVELS.includes(p.proof_level)),
  category_values_valid:      !!cfg && rawPacks.length > 0 && rawPacks.every((p) => cfg.ALLOWED_PACK_CATEGORIES.includes(p.category)),
  setup_values_valid:         !!cfg && rawPacks.length > 0 && rawPacks.every((p) => cfg.ALLOWED_SETUP_COMPLEXITY.includes(p.setup_complexity)),
  automation_values_valid:    !!cfg && rawPacks.length > 0 && rawPacks.every((p) => cfg.ALLOWED_AUTOMATION_DEPTH.includes(p.automation_depth)),
  risk_values_valid:          !!cfg && rawPacks.length > 0 && rawPacks.every((p) => cfg.ALLOWED_RISK_LEVEL.includes(p.risk_level)),
  blocked_reason_nonempty:    rawPacks.length > 0 && rawPacks.every((p) => typeof p.blocked_reason === 'string' && p.blocked_reason.length > 0),
  array_fields_are_arrays:    rawPacks.length > 0 && rawPacks.every((p) => ARRAY_FIELDS.every((k) => Array.isArray(p[k]))),
};

// ── Gate 09 — Safe CTA only; no execution-implying CTA ────────────────────────
const allowedCtas = (cfg && Array.isArray(cfg.ALLOWED_SAFE_CTAS)) ? cfg.ALLOWED_SAFE_CTAS : [];
const forbiddenCtas = (cfg && Array.isArray(cfg.FORBIDDEN_CTAS)) ? cfg.FORBIDDEN_CTAS.map((c) => c.toLowerCase()) : [];
const REQUIRED_FORBIDDEN_CTAS = ['run now', 'execute', 'launch agent', 'start automation', 'send', 'sync production'];
const g09 = {
  every_cta_allowed:       rawPacks.length > 0 && rawPacks.every((p) => allowedCtas.includes(p.safe_cta)),
  no_forbidden_cta_used:   rawPacks.length > 0 && rawPacks.every((p) => typeof p.safe_cta === 'string' && !forbiddenCtas.some((c) => p.safe_cta.toLowerCase().includes(c))),
  forbidden_list_complete: REQUIRED_FORBIDDEN_CTAS.every((c) => forbiddenCtas.includes(c)),
};

// ── Gate 10 — workflow_owner_briefing honest (not live_proven; not executable) ─
const wob = rawPacks.find((p) => p.id === 'workflow_owner_briefing') || null;
const g10 = {
  present:                     !!wob,
  not_live_proven:             !!wob && wob.status !== 'live_proven',
  at_most_live_limited:        !!wob && (wob.status === 'live_limited' || wob.status === 'preview'),
  not_executable:              !!wob && wob.execution_allowed === false && wob.activation_allowed === false,
  maps_owner_briefing_agent:   !!wob && Array.isArray(wob.included_agents) && wob.included_agents.includes('core.owner_briefing'),
  maps_owner_briefing_workflow: !!wob && Array.isArray(wob.included_workflows) && wob.included_workflows.includes('workflow.owner_briefing_preview'),
};

// ── Gate 11 — Route safety (optional; when present must be GET-only flag-gated) ─
const PB_START = src.server.indexOf('ATLAS PACK REGISTRY');
const PB_END = PB_START > -1 ? src.server.indexOf('END ATLAS PACK REGISTRY', PB_START) : -1;
const packBlock = (PB_START > -1 && PB_END > -1) ? src.server.slice(PB_START, PB_END) : '';
const routePresent = packBlock.length > 0;
const writeVerbPackRoute = /app\.(post|put|patch|delete)\s*\(\s*['"]\/api\/atlas\/packs/i.test(src.server);
const flagIdxP = packBlock.indexOf('atlas_pack_registry_api_enabled');
const buildIdxP = packBlock.indexOf('buildAtlasPackRegistryTruth(');
const g11 = {
  no_post_patch_delete_pack_route: !writeVerbPackRoute,
  route_get_endpoints_present: !routePresent ||
    (/app\.get\(\s*'\/api\/atlas\/packs'/.test(packBlock) && /app\.get\(\s*'\/api\/atlas\/packs\/:id'/.test(packBlock)),
  route_auth_gated: !routePresent ||
    (/app\.get\(\s*'\/api\/atlas\/packs'\s*,\s*authMiddleware/.test(packBlock) &&
     /app\.get\(\s*'\/api\/atlas\/packs\/:id'\s*,\s*authMiddleware/.test(packBlock)),
  route_flag_gated_404: !routePresent || (flagIdxP > -1 && packBlock.includes('status(404)')),
  route_flag_before_build: !routePresent || (flagIdxP > -1 && buildIdxP > -1 && flagIdxP < buildIdxP),
  route_no_db_sync_exec: !routePresent ||
    !/getPool|pool\.query|supabase|\bneon\b|sync_batch|production_sync|external_send|\.execute\(|activate\(/i.test(packBlock),
};

// ── Gate 12 — Feature flag defined default-OFF; no new default-ON flag ────────
let flagDefaultOffRuntime = false;
try { flagDefaultOffRuntime = require(path.join(ROOT, GUARD_FILES.flags)).isEnabled('atlas_pack_registry_api_enabled') === false; } catch (e) {}
const defaultOnCount = (src.flags.match(/!==\s*'false'/g) || []).length;
const g12 = {
  flag_name_present:        /atlas_pack_registry_api_enabled/.test(src.flags) && /FEATURE_ATLAS_PACK_REGISTRY_API_ENABLED/.test(src.flags),
  flag_default_off_source:  /atlas_pack_registry_api_enabled\s*:\s*process\.env\.FEATURE_ATLAS_PACK_REGISTRY_API_ENABLED\s*===\s*'true'/.test(src.flags),
  flag_default_off_runtime: flagDefaultOffRuntime === true,
  only_prompt_guard_default_on: defaultOnCount === 1 &&
    /prompt_guard_enabled\s*:\s*process\.env\.FEATURE_PROMPT_GUARD_ENABLED\s*!==\s*'false'/.test(src.flags),
};

// ── Gate 13 — Prior-phase conservatism unchanged ──────────────────────────────
const PRIOR_ARTIFACTS = [
  'docs/agent-mesh/phase-2c-21-runtime-truth-api.md',
  'lib/config/atlasRuntimeTruth.js',
  'lib/services/runtimeTruth.service.js',
  'scripts/phase-2c-21-runtime-truth-check.js',
  'scripts/phase-2c-22-runtime-truth-live-contract-check.js',
  'docs/agent-mesh/phase-2c-23-owner-briefing-ga-decision-gate.md',
  'scripts/phase-2c-23-owner-briefing-ga-decision-check.js',
  'docs/agent-mesh/phase-2c-24-production-canary-prerequisite-binder.md',
  'scripts/phase-2c-24-production-canary-prerequisite-check.js',
  'docs/agent-mesh/phase-2c-25-owner-approval-canary-scope-intake.md',
  'scripts/phase-2c-25-owner-approval-canary-scope-intake-check.js',
];
const missingArtifacts = PRIOR_ARTIFACTS.filter((p) => !exists(p));
// 2C.21 runtime-truth live_proven, rebuilt from its OWN pure service:
let rtLiveProven = null, rtLoadError = null;
try {
  const rtSvc = require(path.join(ROOT, GUARD_FILES.rt_service));
  const rt = rtSvc.buildRuntimeTruth({ generatedAt: '2026-01-01T00:00:00.000Z' });
  rtLiveProven = rt && rt.summary ? rt.summary.live_proven : null;
} catch (e) { rtLoadError = String(e && e.message ? e.message : e); }
const c23Decision = (src.doc23.match(/^DECISION_STATE:\s*([a-z_]+)\s*$/im) || [])[1] || null;
const c23Ga = (src.doc23.match(/^GA_READY:\s*(yes|no)\s*$/im) || [])[1] || null;
const c23Canary = (src.doc23.match(/^PRODUCTION_CANARY_READY:\s*(yes|no)\s*$/im) || [])[1] || null;
const c24Canary = (src.doc24.match(/^CANARY_READY:\s*(yes|no)\s*$/im) || [])[1] || null;
const c25Owner = (src.doc25.match(/^owner_approval_record_present:\s*(true|false)\s*$/im) || [])[1] || null;
const c25Scope = (src.doc25.match(/^canary_scope_record_present:\s*(true|false)\s*$/im) || [])[1] || null;
const g13 = {
  prior_artifacts_exist:    missingArtifacts.length === 0,
  rt_live_proven_zero:      rtLoadError === null && rtLiveProven === 0,
  c23_staging_proven_only:  c23Decision === 'staging_proven_only',
  c23_ga_ready_no:          c23Ga === 'no',
  c23_canary_ready_no:      c23Canary === 'no',
  c24_canary_ready_no:      c24Canary === 'no',
  c25_owner_record_absent:  c25Owner === 'false',
  c25_scope_record_absent:  c25Scope === 'false',
};

// ── Gate 14 — Overclaim guard (config + service + doc; checker self-excluded) ──
const OVERCLAIM = [
  /216 live agents/i, /300 live agents/i, /500 live agents/i,
  /fully autonomous/i, /bank-grade/i, /military-grade/i,
  /\bproduction-live\b/i, /live external whatsapp/i, /100\+ live/i, /200\+ live/i,
  /generally available/i,
];
const overTargets = { config: src.config, service: src.service, doc: src.doc };
const overclaimHits = [];
for (const [t, text] of Object.entries(overTargets)) {
  for (const re of OVERCLAIM) if (re.test(text)) overclaimHits.push(t + ':' + re.source);
}
const g14 = {
  config_service_doc_free_of_overclaims: overclaimHits.length === 0,
};

// ── Gate 15 — No secrets/PII shapes + code purity (config/service) ────────────
const VALUE_PATTERNS = [
  /postgres(?:ql)?:\/\//i, /eyJ[A-Za-z0-9_-]{10,}/, /\bbearer\s+[A-Za-z0-9._-]{10,}/i,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, /\b\d{10,}\b/, /\+\d[\d -]{8,}\d/,
  /\b(?:sk|rk|pk|rzp)_live_[A-Za-z0-9]{4,}/i, /\bsk-[A-Za-z0-9]{16,}/, /BEGIN [A-Z ]*PRIVATE KEY/,
];
const piiTargets = { config: src.config, service: src.service, doc: src.doc };
const piiHits = [];
for (const [t, text] of Object.entries(piiTargets)) {
  for (const re of VALUE_PATTERNS) if (re.test(text)) piiHits.push(t + ':' + re.source);
}
// Purity scan: config + service must not import DB/network/fs/child_process or read env.
const PURITY_FORBIDDEN = [
  /require\(\s*['"]pg['"]\s*\)/, /postgres/i, /\bPool\b/, /\bClient\b/, /createClient/,
  /supabase/i, /\bfetch\s*\(/, /axios/i, /https?\.request/, /child_process/,
  /\bexec\s*\(/, /\bspawn\s*\(/, /writeFile/, /appendFile/, /\bunlink\b/, /process\.env/,
];
const purityTargets = { config: src.config, service: src.service };
const purityHits = [];
for (const [t, text] of Object.entries(purityTargets)) {
  for (const re of PURITY_FORBIDDEN) if (re.test(text)) purityHits.push(t + ':' + re.source);
}
// The checker is scanned for literal secrets only (its detection patterns can't self-match).
const checkerSrc = read(GUARD_FILES.checker);
const CHECKER_SECRET_LITERALS = [
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
  /postgres(?:ql)?:\/\/[A-Za-z0-9]/,
  /\b(?:sk|rk|pk|rzp)_live_[A-Za-z0-9]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
const checkerSecretHits = CHECKER_SECRET_LITERALS.filter((re) => re.test(checkerSrc)).length;
const g15 = {
  config_service_doc_free_of_pii:   piiHits.length === 0,
  config_service_pure:              purityHits.length === 0,
  checker_present:                  checkerSrc.length > 0,
  checker_free_of_secret_literals:  checkerSecretHits === 0,
};

// ── Gate 16 — DECLARED path scope (static; actual tree verified externally) ───
// HONESTY NOTE: validates the DECLARED phase file list + on-disk existence. It
// spawns no process, so the ACTUAL working-tree scope is verified EXTERNALLY
// (git status / git diff --name-only) in the phase report and review.
const g16 = {
  declared_files_exist:        PHASE_TOUCHED.every((p) => exists(p)),
  no_env_file_declared:        !PHASE_TOUCHED.some((p) => /\.env(\.|$)/.test(p)),
  no_railway_file_declared:    !PHASE_TOUCHED.some((p) => /railway\.toml|nixpacks\.toml|Procfile/i.test(p)),
  no_frontend_file_declared:   !PHASE_TOUCHED.some((p) => /frontend|vercel|next\.config/i.test(p)),
  no_deploy_file_declared:     !PHASE_TOUCHED.some((p) => /\.github\/workflows|deploy/i.test(p)),
  backend_paths_only_declared: PHASE_TOUCHED.every((p) => /^(lib\/|scripts\/|docs\/|server\.js$)/.test(p)),
};

// ── MUTATION GUARD (part 2): re-hash AFTER all checks ─────────────────────────
const HASH_AFTER = {};
for (const [k, rel] of Object.entries(GUARD_FILES)) HASH_AFTER[k] = sha256(rel);
const mutated = Object.keys(GUARD_FILES)
  .filter((k) => HASH_BEFORE[k] === null || HASH_AFTER[k] === null || HASH_BEFORE[k] !== HASH_AFTER[k]);
const g17 = {
  all_hashes_captured:        Object.values(HASH_BEFORE).every((h) => typeof h === 'string'),
  files_unchanged_during_run: mutated.length === 0,
};

// ── roll up ───────────────────────────────────────────────────────────────────
const GATES = {
  '01_assets_exist':               g01,
  '02_status_enum_only':           g02,
  '03_required_families_present':  g03,
  '04_minimum_packs_present':      g04,
  '05_zero_live_execution_activation': g05,
  '06_no_pack_executable':         g06,
  '07_trader_enterprise_custom_visible': g07,
  '08_required_fields_present':    g08,
  '09_safe_cta_only':              g09,
  '10_owner_briefing_pack_honest': g10,
  '11_route_safe':                 g11,
  '12_feature_flag_default_off':   g12,
  '13_prior_phase_conservatism':   g13,
  '14_overclaim_guard':            g14,
  '15_no_secrets_pii_pure':        g15,
  '16_declared_path_scope':        g16,
  '17_mutation_guard':             g17,
};
const gate_results = {};
let gates_passed = 0;
for (const [name, checks] of Object.entries(GATES)) {
  const pass = all(checks);
  if (pass) gates_passed++;
  gate_results[name] = { pass, checks };
}
const gates_total = Object.keys(GATES).length;
const overall_pass = loadError === null && packTruth !== null && gates_passed === gates_total;

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
  pack_registry_version: packTruth ? packTruth.pack_registry_version : null,
  // counts — DERIVED from the pure service, then gated above (not hardcoded)
  registry_summary: summary ? {
    packs_total: summary.packs_total,
    families_total: summary.families_total,
    live_proven_count: summary.live_proven_count,
    execution_allowed_count: summary.execution_allowed_count,
    activation_allowed_count: summary.activation_allowed_count,
    by_status: summary.by_status,
    by_family: summary.by_family,
    by_category: summary.by_category,
  } : null,
  route_present: routePresent,
  prior_markers: {
    rt_live_proven: rtLiveProven,
    c23_decision_state: c23Decision,
    c23_ga_ready: c23Ga,
    c23_production_canary_ready: c23Canary,
    c24_canary_ready: c24Canary,
    c25_owner_approval_record_present: c25Owner,
    c25_canary_scope_record_present: c25Scope,
  },
  load_error: loadError,
  // diagnostics (counts / names only — never values)
  missing_prior_artifacts: missingArtifacts,
  missing_required_fields: missingFields,
  validate_offenders: validateRes.offenders || {},
  overclaim_hits: overclaimHits,
  pii_pattern_hits: piiHits,
  purity_violations: purityHits,
  files_mutated_by_check: mutated,
  guard_file_hashes: hashes,
  // ── informational ONLY — DERIVED from the gates above; NEVER feeds the verdict
  informational_only_not_a_pass_condition: {
    note: 'Display-only, never part of overall_pass. Scope booleans derive from the DECLARED phase file list (gate 16) + secret/purity scans (gate 15) + the mutation guard (gate 17); the ACTUAL working-tree scope is verified externally via git status/diff in the phase report.',
    production_touched: (g16.backend_paths_only_declared && g17.files_unchanged_during_run) ? false : null,
    railway_touched:    g16.no_railway_file_declared ? false : null,
    env_files_changed:  g16.no_env_file_declared ? false : null,
    frontend_touched:   g16.no_frontend_file_declared ? false : null,
    deploy_triggered:   g16.no_deploy_file_declared ? false : null,
    secrets_exposed:    (g15.config_service_doc_free_of_pii && g15.checker_free_of_secret_literals) ? false : null,
    pack_execution_enabled:     g05.service_execution_allowed_zero && g06.no_pack_execution_allowed ? false : null,
    pack_activation_enabled:    g05.service_activation_allowed_zero && g06.no_pack_activation_allowed ? false : null,
  },
  gate_results,
};
if (!overall_pass) {
  result._note = 'FAIL-CLOSED: one or more Pack Registry gates unmet. The pack layer must remain read-only, proof-gated truth — a pack becomes usable ONLY through a future, separately-approved phase that records explicit owner approval and produces real production-access proofs, never an edit to this registry/doc/flag alone.';
}
console.log('PACK_REGISTRY_JSON:' + JSON.stringify(result, null, 1));
process.exit(overall_pass ? 0 : 1);
