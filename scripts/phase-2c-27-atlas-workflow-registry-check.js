#!/usr/bin/env node
'use strict';
/*
 * Phase 2C.27 — Atlas Workflow Registry backend-contract check (FAIL-CLOSED).
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves, statically and fail-closed, that the Atlas business-process (workflow)
 * layer is defined as READ-ONLY, proof-gated truth that NEVER executes or activates
 * a workflow. Verdict derives ONLY from independent evidence:
 *   (A) the PURE workflow-registry service + config loaded with NO DB / NO network /
 *       NO env reads, counts re-tallied independently from the raw WORKFLOWS array
 *       (live_proven == 0, execution_allowed == 0, activation_allowed == 0);
 *   (B) structural invariants over every workflow (allowed status/domain/category/
 *       proof-level/CTA enums, all required fields, no forbidden CTA, no executable
 *       preview/custom/roadmap/connector/partner workflow, output_contract with no
 *       side effects / mutations / external sends / production sync);
 *   (C) the 18 minimum workflows present + relationship integrity (related_packs are
 *       real Phase 2C.26 pack ids; required_agents are real runtime-truth agent ids);
 *   (D) the optional server route, when present, is GET-only, auth-gated, feature-
 *       gated default-OFF, with NO POST/PATCH/DELETE workflow route and no DB / sync /
 *       execution token in its block;
 *   (E) the feature flag default-OFF with no new default-ON flag introduced;
 *   (F) Pack Registry still conservative (2C.26 service: live_proven/execution/
 *       activation all 0) AND prior-phase conservatism — 2C.21 runtime-truth
 *       live_proven == 0 (rebuilt from its pure service), 2C.23 GA/canary == no,
 *       2C.24 canary_ready == no, 2C.25 owner/scope records absent (re-derived from
 *       the prior docs' own markers);
 *   (G) an overclaim scan of config/service/doc, a secret/PII + purity scan of this
 *       phase's code, a DECLARED-path-scope gate, and a SHA-256 mutation guard over
 *       every file this checker reads.
 *
 * NO self-attestation feeds the verdict. production_touched/etc. live in
 * `informational_only_not_a_pass_condition`, DERIVED from the path-scope/secret/
 * mutation gates; `overall_pass` never reads them. EVERY `.every()` over the workflow
 * array is length-guarded so an empty registry can never pass vacuously.
 *
 * SAFETY: read-only. Opens NO database, makes NO network call, writes NO file, spawns
 * NO process. Output is COUNTS / BOOLEANS / STATUS / NAMES only.
 *
 * USAGE: node scripts/phase-2c-27-atlas-workflow-registry-check.js
 *        exit 0 = all gates pass; exit 1 = fail-closed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

// DETERMINISM: ensure the workflow-registry API flag is unset in-process BEFORE the
// flag module reads env at load. Never written to disk.
delete process.env.FEATURE_ATLAS_WORKFLOW_REGISTRY_API_ENABLED;

function read(rel) { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return ''; } }
function exists(rel) { try { fs.accessSync(path.join(ROOT, rel)); return true; } catch (e) { return false; } }
function sha256(rel) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex'); }
  catch (e) { return null; }
}
const all = (obj) => Object.values(obj).every((v) => v === true);

// ── Phase 2C.27 NEW/CHANGED files (path-scope gate) ───────────────────────────
const PHASE_TOUCHED = [
  'lib/config/atlasWorkflowRegistry.js',
  'lib/services/atlasWorkflowRegistry.service.js',
  'docs/agent-mesh/phase-2c-27-atlas-workflow-registry-backend-contract.md',
  'scripts/phase-2c-27-atlas-workflow-registry-check.js',
  'lib/featureFlags.js',
  'server.js',
];

// Every file this checker reads — guarded against mutation by this run.
const GUARD_FILES = {
  config:       'lib/config/atlasWorkflowRegistry.js',
  service:      'lib/services/atlasWorkflowRegistry.service.js',
  doc:          'docs/agent-mesh/phase-2c-27-atlas-workflow-registry-backend-contract.md',
  checker:      'scripts/phase-2c-27-atlas-workflow-registry-check.js',
  flags:        'lib/featureFlags.js',
  server:       'server.js',
  pack_config:  'lib/config/atlasPackRegistry.js',
  pack_service: 'lib/services/atlasPackRegistry.service.js',
  rt_config:    'lib/config/atlasRuntimeTruth.js',
  rt_service:   'lib/services/runtimeTruth.service.js',
  doc23:        'docs/agent-mesh/phase-2c-23-owner-briefing-ga-decision-gate.md',
  doc24:        'docs/agent-mesh/phase-2c-24-production-canary-prerequisite-binder.md',
  doc25:        'docs/agent-mesh/phase-2c-25-owner-approval-canary-scope-intake.md',
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

// ── load the PURE workflow-registry modules ────────────────────────────────────
let cfg = null, svc = null, wfTruth = null, wfList = null;
let validateRes = { ok: false, offenders: {} }, loadError = null;
try {
  cfg = require(path.join(ROOT, GUARD_FILES.config));
  svc = require(path.join(ROOT, GUARD_FILES.service));
  wfTruth = svc.buildAtlasWorkflowRegistryTruth({ generatedAt: '2026-01-01T00:00:00.000Z' });
  wfList = svc.listAtlasWorkflows();
  validateRes = svc.validateWorkflowRegistry();
} catch (e) { loadError = String(e && e.message ? e.message : e); }

const rawWorkflows = cfg && Array.isArray(cfg.WORKFLOWS) ? cfg.WORKFLOWS : [];
const summary = wfTruth ? wfTruth.summary : null;
const listed = Array.isArray(wfList) ? wfList : [];

const EXPECTED_STATUSES = [
  'live_proven', 'live_limited', 'preview', 'connector_required',
  'custom_required', 'partner_required', 'roadmap', 'disabled',
];
const MIN_WORKFLOWS = [
  'workflow_owner_briefing_preview', 'workflow_daily_command_briefing',
  'workflow_collections_review', 'workflow_cashflow_risk_review',
  'workflow_inventory_pressure_review', 'workflow_sales_pipeline_review',
  'workflow_purchase_supplier_review', 'workflow_customer_risk_review',
  'workflow_actions_approval_review', 'workflow_evidence_review',
  'workflow_data_source_readiness', 'workflow_neon_to_cortex_dry_run',
  'workflow_canary_scope_review', 'workflow_pack_activation_request',
  'workflow_enterprise_governance_review', 'workflow_custom_pack_design',
  'workflow_agent_swarm_planning', 'workflow_partner_deployment_review',
];
const NON_EXECUTABLE_STATUSES = ['preview', 'connector_required', 'custom_required', 'partner_required', 'roadmap', 'disabled'];

// ── Gate 01 — Assets exist + pure service loads ───────────────────────────────
const g01 = {
  config_exists:  exists(GUARD_FILES.config),
  service_exists: exists(GUARD_FILES.service),
  doc_exists:     src.doc.length > 0,
  checker_exists: exists(GUARD_FILES.checker),
  service_loads:  wfTruth !== null && Array.isArray(wfList) && loadError === null,
};

// ── Gate 02 — Allowed status enum only ────────────────────────────────────────
const g02 = {
  allowed_statuses_exactly_eight: !!cfg && Array.isArray(cfg.ALLOWED_WORKFLOW_STATUSES) &&
    cfg.ALLOWED_WORKFLOW_STATUSES.length === 8 && EXPECTED_STATUSES.every((s) => cfg.ALLOWED_WORKFLOW_STATUSES.includes(s)),
  every_workflow_status_allowed: rawWorkflows.length > 0 && rawWorkflows.every((w) => EXPECTED_STATUSES.includes(w.status)),
  validate_ok: validateRes.ok === true,
};

// ── Gate 03 — Minimum workflows present (all 18, unique ids) ──────────────────
const ids = rawWorkflows.map((w) => w.id);
const idSet = new Set(ids);
const g03 = {
  all_minimum_workflows_present: rawWorkflows.length > 0 && MIN_WORKFLOWS.every((id) => idSet.has(id)),
  count_at_least_minimum: rawWorkflows.length >= MIN_WORKFLOWS.length,
  ids_unique: idSet.size === ids.length && ids.length > 0,
};

// ── Gate 04 — live_proven / execution / activation counts == 0 ────────────────
const rawLiveProven = rawWorkflows.filter((w) => w.status === 'live_proven').length;
const rawExec = rawWorkflows.filter((w) => w.execution_allowed === true).length;
const rawActiv = rawWorkflows.filter((w) => w.activation_allowed === true).length;
const g04 = {
  service_live_proven_zero:        !!summary && summary.live_proven_count === 0,
  service_execution_allowed_zero:  !!summary && summary.execution_allowed_count === 0,
  service_activation_allowed_zero: !!summary && summary.activation_allowed_count === 0,
  raw_live_proven_zero:  rawWorkflows.length > 0 && rawLiveProven === 0,
  raw_execution_zero:    rawWorkflows.length > 0 && rawExec === 0,
  raw_activation_zero:   rawWorkflows.length > 0 && rawActiv === 0,
};

// ── Gate 05 — No workflow is executable or activatable ────────────────────────
const g05 = {
  no_workflow_execution_allowed:  rawWorkflows.length > 0 && rawWorkflows.every((w) => w.execution_allowed === false),
  no_workflow_activation_allowed: rawWorkflows.length > 0 && rawWorkflows.every((w) => w.activation_allowed === false),
  non_live_not_activatable:       rawWorkflows.length > 0 && rawWorkflows.every((w) => w.status === 'live_proven' || w.activation_allowed === false),
  preview_family_not_executable:  rawWorkflows.length > 0 && rawWorkflows
    .filter((w) => NON_EXECUTABLE_STATUSES.includes(w.status))
    .every((w) => w.execution_allowed === false && w.activation_allowed === false),
};

// ── Gate 06 — output_contract is non-executable for every workflow ────────────
const g06 = {
  output_contract_present:  rawWorkflows.length > 0 && rawWorkflows.every((w) => w.output_contract && typeof w.output_contract === 'object'),
  no_side_effects:          rawWorkflows.length > 0 && rawWorkflows.every((w) => w.output_contract && w.output_contract.side_effects === 'none'),
  no_mutations:             rawWorkflows.length > 0 && rawWorkflows.every((w) => w.output_contract && w.output_contract.mutations === false),
  no_external_sends:        rawWorkflows.length > 0 && rawWorkflows.every((w) => w.output_contract && w.output_contract.external_sends === false),
  no_production_sync:       rawWorkflows.length > 0 && rawWorkflows.every((w) => w.output_contract && w.output_contract.production_sync === false),
};

// ── Gate 07 — Every workflow carries all required fields with valid values ────
const REQUIRED = (cfg && Array.isArray(cfg.REQUIRED_WORKFLOW_FIELDS)) ? cfg.REQUIRED_WORKFLOW_FIELDS : [];
const missingFields = [];
for (const w of rawWorkflows) {
  for (const f of REQUIRED) {
    if (!Object.prototype.hasOwnProperty.call(w, f) || w[f] === undefined) missingFields.push(w.id + ':' + f);
  }
}
const ARRAY_FIELDS = ['related_packs', 'required_agents', 'required_data_sources', 'input_requirements', 'approval_requirements', 'evidence_requirements', 'audit_requirements'];
const g07 = {
  required_fields_count_22:  REQUIRED.length === 22,
  every_workflow_has_all_fields: rawWorkflows.length > 0 && missingFields.length === 0,
  domain_values_valid:       !!cfg && rawWorkflows.length > 0 && rawWorkflows.every((w) => cfg.ALLOWED_WORKFLOW_DOMAINS.includes(w.domain)),
  category_values_valid:     !!cfg && rawWorkflows.length > 0 && rawWorkflows.every((w) => cfg.ALLOWED_WORKFLOW_CATEGORIES.includes(w.category)),
  proof_level_values_valid:  !!cfg && rawWorkflows.length > 0 && rawWorkflows.every((w) => cfg.ALLOWED_PROOF_LEVELS.includes(w.proof_level)),
  setup_values_valid:        !!cfg && rawWorkflows.length > 0 && rawWorkflows.every((w) => cfg.ALLOWED_SETUP_COMPLEXITY.includes(w.setup_complexity)),
  automation_values_valid:   !!cfg && rawWorkflows.length > 0 && rawWorkflows.every((w) => cfg.ALLOWED_AUTOMATION_DEPTH.includes(w.automation_depth)),
  risk_values_valid:         !!cfg && rawWorkflows.length > 0 && rawWorkflows.every((w) => cfg.ALLOWED_RISK_LEVEL.includes(w.risk_level)),
  blocked_reason_nonempty:   rawWorkflows.length > 0 && rawWorkflows.every((w) => typeof w.blocked_reason === 'string' && w.blocked_reason.length > 0),
  array_fields_are_arrays:   rawWorkflows.length > 0 && rawWorkflows.every((w) => ARRAY_FIELDS.every((k) => Array.isArray(w[k]))),
};

// ── Gate 08 — Safe CTA only; no execution-implying CTA ────────────────────────
const allowedCtas = (cfg && Array.isArray(cfg.ALLOWED_SAFE_CTAS)) ? cfg.ALLOWED_SAFE_CTAS : [];
const forbiddenCtas = (cfg && Array.isArray(cfg.FORBIDDEN_CTAS)) ? cfg.FORBIDDEN_CTAS.map((c) => c.toLowerCase()) : [];
const REQUIRED_FORBIDDEN_CTAS = ['run now', 'execute', 'launch workflow', 'start automation', 'send', 'sync production', 'deploy'];
const g08 = {
  every_cta_allowed:       rawWorkflows.length > 0 && rawWorkflows.every((w) => allowedCtas.includes(w.safe_cta)),
  no_forbidden_cta_used:   rawWorkflows.length > 0 && rawWorkflows.every((w) => typeof w.safe_cta === 'string' && !forbiddenCtas.some((c) => w.safe_cta.toLowerCase().includes(c))),
  forbidden_list_complete: REQUIRED_FORBIDDEN_CTAS.every((c) => forbiddenCtas.includes(c)),
};

// ── Gate 09 — owner-briefing workflow honest (not live_proven; not executable) ─
const wob = rawWorkflows.find((w) => w.id === 'workflow_owner_briefing_preview') || null;
const g09 = {
  present:                     !!wob,
  not_live_proven:             !!wob && wob.status !== 'live_proven',
  at_most_live_limited:        !!wob && (wob.status === 'live_limited' || wob.status === 'preview'),
  not_executable:              !!wob && wob.execution_allowed === false && wob.activation_allowed === false,
  maps_owner_briefing_agent:   !!wob && Array.isArray(wob.required_agents) && wob.required_agents.includes('core.owner_briefing'),
};

// ── Gate 10 — Relationship integrity (real pack ids + real agent ids) ─────────
let packCfg = null, rtCfg = null, relLoadErr = null;
try { packCfg = require(path.join(ROOT, GUARD_FILES.pack_config)); rtCfg = require(path.join(ROOT, GUARD_FILES.rt_config)); }
catch (e) { relLoadErr = String(e && e.message ? e.message : e); }
const packIds = new Set(packCfg && Array.isArray(packCfg.PACKS) ? packCfg.PACKS.map((p) => p.id) : []);
const rtAgentIds = new Set(rtCfg && Array.isArray(rtCfg.AGENTS) ? rtCfg.AGENTS.map((a) => a.id) : []);
const badPackRefs = [];
const badAgentRefs = [];
for (const w of rawWorkflows) {
  for (const rp of (w.related_packs || [])) if (!packIds.has(rp)) badPackRefs.push(w.id + ':' + rp);
  for (const ra of (w.required_agents || [])) if (!rtAgentIds.has(ra)) badAgentRefs.push(w.id + ':' + ra);
}
const g10 = {
  pack_ids_loaded:           packIds.size > 0,
  agent_ids_loaded:          rtAgentIds.size > 0,
  related_packs_all_valid:   rawWorkflows.length > 0 && badPackRefs.length === 0,
  required_agents_all_valid: rawWorkflows.length > 0 && badAgentRefs.length === 0,
};

// ── Gate 11 — Route safety (optional; when present, GET-only flag-gated) ──────
const PB_START = src.server.indexOf('ATLAS WORKFLOW REGISTRY');
const PB_END = PB_START > -1 ? src.server.indexOf('END ATLAS WORKFLOW REGISTRY', PB_START) : -1;
const wfBlock = (PB_START > -1 && PB_END > -1) ? src.server.slice(PB_START, PB_END) : '';
const routePresent = wfBlock.length > 0;
const writeVerbRoute = /app\.(post|put|patch|delete)\s*\(\s*['"]\/api\/atlas\/workflows/i.test(src.server);
const flagIdxP = wfBlock.indexOf('atlas_workflow_registry_api_enabled');
const buildIdxP = wfBlock.indexOf('buildAtlasWorkflowRegistryTruth(');
const g11 = {
  no_post_patch_delete_workflow_route: !writeVerbRoute,
  route_get_endpoints_present: !routePresent ||
    (/app\.get\(\s*'\/api\/atlas\/workflows'/.test(wfBlock) && /app\.get\(\s*'\/api\/atlas\/workflows\/:id'/.test(wfBlock)),
  route_auth_gated: !routePresent ||
    (/app\.get\(\s*'\/api\/atlas\/workflows'\s*,\s*authMiddleware/.test(wfBlock) &&
     /app\.get\(\s*'\/api\/atlas\/workflows\/:id'\s*,\s*authMiddleware/.test(wfBlock)),
  route_flag_gated_404: !routePresent || (flagIdxP > -1 && wfBlock.includes('status(404)')),
  route_flag_before_build: !routePresent || (flagIdxP > -1 && buildIdxP > -1 && flagIdxP < buildIdxP),
  route_no_db_sync_exec: !routePresent ||
    !/getPool|pool\.query|supabase|\bneon\b|sync_batch|production_sync|external_send|\.execute\(|activate\(/i.test(wfBlock),
};

// ── Gate 12 — Feature flag default-OFF; no new default-ON flag ────────────────
let flagDefaultOffRuntime = false;
try { flagDefaultOffRuntime = require(path.join(ROOT, GUARD_FILES.flags)).isEnabled('atlas_workflow_registry_api_enabled') === false; } catch (e) {}
const defaultOnCount = (src.flags.match(/!==\s*'false'/g) || []).length;
const g12 = {
  flag_name_present:        /atlas_workflow_registry_api_enabled/.test(src.flags) && /FEATURE_ATLAS_WORKFLOW_REGISTRY_API_ENABLED/.test(src.flags),
  flag_default_off_source:  /atlas_workflow_registry_api_enabled\s*:\s*process\.env\.FEATURE_ATLAS_WORKFLOW_REGISTRY_API_ENABLED\s*===\s*'true'/.test(src.flags),
  flag_default_off_runtime: flagDefaultOffRuntime === true,
  only_prompt_guard_default_on: defaultOnCount === 1 &&
    /prompt_guard_enabled\s*:\s*process\.env\.FEATURE_PROMPT_GUARD_ENABLED\s*!==\s*'false'/.test(src.flags),
};

// ── Gate 13 — Pack Registry (2C.26) still conservative ────────────────────────
let packSummary = null, packSvcErr = null;
try { packSummary = require(path.join(ROOT, GUARD_FILES.pack_service)).summarizeAtlasPackRegistry(); }
catch (e) { packSvcErr = String(e && e.message ? e.message : e); }
const g13 = {
  pack_config_exists:    exists(GUARD_FILES.pack_config),
  pack_checker_exists:   exists('scripts/phase-2c-26-atlas-pack-registry-check.js'),
  pack_service_loads:    packSvcErr === null && packSummary !== null,
  pack_live_proven_zero: !!packSummary && packSummary.live_proven_count === 0,
  pack_execution_zero:   !!packSummary && packSummary.execution_allowed_count === 0,
  pack_activation_zero:  !!packSummary && packSummary.activation_allowed_count === 0,
};

// ── Gate 14 — Prior-phase conservatism unchanged (2C.21..2C.25) ───────────────
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
  'docs/agent-mesh/phase-2c-26-atlas-pack-registry-backend-contract.md',
];
const missingArtifacts = PRIOR_ARTIFACTS.filter((p) => !exists(p));
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
const g14 = {
  prior_artifacts_exist:    missingArtifacts.length === 0,
  rt_live_proven_zero:      rtLoadError === null && rtLiveProven === 0,
  c23_staging_proven_only:  c23Decision === 'staging_proven_only',
  c23_ga_ready_no:          c23Ga === 'no',
  c23_canary_ready_no:      c23Canary === 'no',
  c24_canary_ready_no:      c24Canary === 'no',
  c25_owner_record_absent:  c25Owner === 'false',
  c25_scope_record_absent:  c25Scope === 'false',
};

// ── Gate 15 — Overclaim guard (config + service + doc; checker self-excluded) ──
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
const g15 = {
  config_service_doc_free_of_overclaims: overclaimHits.length === 0,
};

// ── Gate 16 — No secrets/PII + code purity (config/service) ───────────────────
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
const checkerSrc = read(GUARD_FILES.checker);
const CHECKER_SECRET_LITERALS = [
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
  /postgres(?:ql)?:\/\/[A-Za-z0-9]/,
  /\b(?:sk|rk|pk|rzp)_live_[A-Za-z0-9]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
const checkerSecretHits = CHECKER_SECRET_LITERALS.filter((re) => re.test(checkerSrc)).length;
const g16 = {
  config_service_doc_free_of_pii:  piiHits.length === 0,
  config_service_pure:             purityHits.length === 0,
  checker_present:                 checkerSrc.length > 0,
  checker_free_of_secret_literals: checkerSecretHits === 0,
};

// ── Gate 17 — DECLARED path scope (static; actual tree verified externally) ───
const g17 = {
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
const g18 = {
  all_hashes_captured:        Object.values(HASH_BEFORE).every((h) => typeof h === 'string'),
  files_unchanged_during_run: mutated.length === 0,
};

// ── roll up ───────────────────────────────────────────────────────────────────
const GATES = {
  '01_assets_exist':                 g01,
  '02_status_enum_only':             g02,
  '03_minimum_workflows_present':    g03,
  '04_zero_live_execution_activation': g04,
  '05_no_workflow_executable':       g05,
  '06_output_contract_non_executable': g06,
  '07_required_fields_present':      g07,
  '08_safe_cta_only':                g08,
  '09_owner_briefing_workflow_honest': g09,
  '10_relationship_integrity':       g10,
  '11_route_safe':                   g11,
  '12_feature_flag_default_off':     g12,
  '13_pack_registry_still_conservative': g13,
  '14_prior_phase_conservatism':     g14,
  '15_overclaim_guard':              g15,
  '16_no_secrets_pii_pure':          g16,
  '17_declared_path_scope':          g17,
  '18_mutation_guard':               g18,
};
const gate_results = {};
let gates_passed = 0;
for (const [name, checks] of Object.entries(GATES)) {
  const pass = all(checks);
  if (pass) gates_passed++;
  gate_results[name] = { pass, checks };
}
const gates_total = Object.keys(GATES).length;
const overall_pass = loadError === null && wfTruth !== null && gates_passed === gates_total;

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
  workflow_registry_version: wfTruth ? wfTruth.workflow_registry_version : null,
  registry_summary: summary ? {
    workflows_total: summary.workflows_total,
    domains_total: summary.domains_total,
    live_proven_count: summary.live_proven_count,
    execution_allowed_count: summary.execution_allowed_count,
    activation_allowed_count: summary.activation_allowed_count,
    by_status: summary.by_status,
    by_domain: summary.by_domain,
    by_category: summary.by_category,
  } : null,
  route_present: routePresent,
  pack_registry_summary: packSummary ? {
    packs_total: packSummary.packs_total,
    live_proven_count: packSummary.live_proven_count,
    execution_allowed_count: packSummary.execution_allowed_count,
    activation_allowed_count: packSummary.activation_allowed_count,
  } : null,
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
  rel_load_error: relLoadErr,
  // diagnostics (counts / names only — never values)
  missing_prior_artifacts: missingArtifacts,
  missing_required_fields: missingFields,
  bad_related_pack_refs: badPackRefs,
  bad_required_agent_refs: badAgentRefs,
  validate_offenders: validateRes.offenders || {},
  overclaim_hits: overclaimHits,
  pii_pattern_hits: piiHits,
  purity_violations: purityHits,
  files_mutated_by_check: mutated,
  guard_file_hashes: hashes,
  informational_only_not_a_pass_condition: {
    note: 'Display-only, never part of overall_pass. Scope booleans derive from the DECLARED phase file list (gate 17) + secret/purity scans (gate 16) + the mutation guard (gate 18); the ACTUAL working-tree scope is verified externally via git status/diff in the phase report.',
    production_touched: (g17.backend_paths_only_declared && g18.files_unchanged_during_run) ? false : null,
    railway_touched:    g17.no_railway_file_declared ? false : null,
    env_files_changed:  g17.no_env_file_declared ? false : null,
    frontend_touched:   g17.no_frontend_file_declared ? false : null,
    deploy_triggered:   g17.no_deploy_file_declared ? false : null,
    secrets_exposed:    (g16.config_service_doc_free_of_pii && g16.checker_free_of_secret_literals) ? false : null,
    workflow_execution_enabled:  (g04.service_execution_allowed_zero && g05.no_workflow_execution_allowed) ? false : null,
    workflow_activation_enabled: (g04.service_activation_allowed_zero && g05.no_workflow_activation_allowed) ? false : null,
  },
  gate_results,
};
if (!overall_pass) {
  result._note = 'FAIL-CLOSED: one or more Workflow Registry gates unmet. The workflow layer must remain read-only, proof-gated truth — a workflow becomes runnable ONLY through a future, separately-approved phase that records explicit owner approval and produces real production-access proofs, never an edit to this registry/doc/flag alone.';
}
console.log('WORKFLOW_REGISTRY_JSON:' + JSON.stringify(result, null, 1));
process.exit(overall_pass ? 0 : 1);
