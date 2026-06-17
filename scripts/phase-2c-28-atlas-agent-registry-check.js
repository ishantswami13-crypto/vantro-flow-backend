#!/usr/bin/env node
'use strict';
/*
 * Phase 2C.28 — Atlas Agent Registry / Agent Universe backend-contract check (FAIL-CLOSED).
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves, statically and fail-closed, that the Atlas "Agent Universe" is defined as
 * READ-ONLY, evidence-gated truth that NEVER executes, activates, production-enables,
 * or external-sends an agent, and never inflates the agent count. Verdict derives ONLY
 * from independent evidence:
 *   (A) the PURE agent-registry service + config loaded with NO DB / NO network / NO env
 *       reads; counts re-tallied independently from the raw AGENTS array
 *       (live_proven == 0, execution/activation/production/external_send == 0);
 *   (B) structural invariants over every agent (allowed status/domain/category/swarm/
 *       proof-level/CTA enums, all 26 required fields, no forbidden CTA, every safety
 *       boolean false, unique ids, non-empty blocked_reason);
 *   (C) EVIDENCE INTEGRITY — is_implemented==true requires an implementation_evidence
 *       PATH that exists on disk; harness_verified==true requires proof_artifact_refs
 *       that ALL exist on disk; live_limited requires implementation AND agent-specific
 *       proof; is_implemented is evidence-backed (not swarm-inferred);
 *   (D) the minimum agents/domains/swarms present + relationship integrity (related_packs
 *       are real Phase 2C.26 pack ids; related_workflows are real Phase 2C.27 workflow
 *       ids; no orphan references);
 *   (E) the optional server route is GET-only, auth-gated, feature-gated default-OFF,
 *       with NO POST/PATCH/PUT/DELETE agent route and no DB / sync / execution token;
 *   (F) NO COUNT INFLATION — claimed_agent_count == concrete rows, summary total == rows,
 *       no 216/300/360/500/"100+/200+ live" overclaim in config/service, swarms are an
 *       8-value enum (organizational), not a multiplier;
 *   (G) NO DB/MIGRATION CHANGE — the declared phase scope contains no migration/.sql/db/
 *       file, and migrations/007_agent_registry.sql is unchanged during this run;
 *   (H) Pack Registry (2C.26) + Workflow Registry (2C.27) still conservative AND prior-
 *       phase conservatism — 2C.21 runtime-truth live_proven==0 and live_limited
 *       UNCHANGED (==2), 2C.23 GA/canary == no, 2C.24 canary_ready == no, 2C.25 owner/
 *       scope records absent (re-derived from the prior services + doc markers);
 *   (I) an overclaim scan of config/service, a secret/PII + purity scan of this phase's
 *       code, a DECLARED-path-scope gate, and a SHA-256 mutation guard over every file
 *       this checker reads.
 *
 * NO self-attestation feeds the verdict. production_touched/etc. live in
 * `informational_only_not_a_pass_condition`, DERIVED from the path-scope/secret/mutation
 * gates; `overall_pass` never reads them. EVERY `.every()` over the agents array is
 * length-guarded so an empty registry can never pass vacuously.
 *
 * SAFETY: read-only. Opens NO database, makes NO network call, writes NO file, spawns NO
 * process. Output is COUNTS / BOOLEANS / STATUS / NAMES only.
 *
 * USAGE: node scripts/phase-2c-28-atlas-agent-registry-check.js
 *        exit 0 = all gates pass; exit 1 = fail-closed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

// DETERMINISM: ensure the agent-registry API flag is unset in-process BEFORE the flag
// module reads env at load. Never written to disk.
delete process.env.FEATURE_ATLAS_AGENT_REGISTRY_API_ENABLED;

function read(rel) { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return ''; } }
function exists(rel) { try { fs.accessSync(path.join(ROOT, rel)); return true; } catch (e) { return false; } }
function sha256(rel) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex'); }
  catch (e) { return null; }
}
const all = (obj) => Object.values(obj).every((v) => v === true);

// ── Phase 2C.28 NEW/CHANGED files (path-scope gate) ───────────────────────────
const PHASE_TOUCHED = [
  'lib/config/atlasAgentRegistry.js',
  'lib/services/atlasAgentRegistry.service.js',
  'docs/agent-mesh/phase-2c-28-atlas-agent-registry-hardening.md',
  'scripts/phase-2c-28-atlas-agent-registry-check.js',
  'lib/featureFlags.js',
  'server.js',
];

// Every file this checker reads — guarded against mutation by this run.
const GUARD_FILES = {
  config:        'lib/config/atlasAgentRegistry.js',
  service:       'lib/services/atlasAgentRegistry.service.js',
  doc:           'docs/agent-mesh/phase-2c-28-atlas-agent-registry-hardening.md',
  checker:       'scripts/phase-2c-28-atlas-agent-registry-check.js',
  flags:         'lib/featureFlags.js',
  server:        'server.js',
  pack_config:   'lib/config/atlasPackRegistry.js',
  pack_service:  'lib/services/atlasPackRegistry.service.js',
  wf_config:     'lib/config/atlasWorkflowRegistry.js',
  wf_service:    'lib/services/atlasWorkflowRegistry.service.js',
  rt_config:     'lib/config/atlasRuntimeTruth.js',
  rt_service:    'lib/services/runtimeTruth.service.js',
  agent_migration: 'migrations/007_agent_registry.sql',
  doc23:         'docs/agent-mesh/phase-2c-23-owner-briefing-ga-decision-gate.md',
  doc24:         'docs/agent-mesh/phase-2c-24-production-canary-prerequisite-binder.md',
  doc25:         'docs/agent-mesh/phase-2c-25-owner-approval-canary-scope-intake.md',
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

// ── load the PURE agent-registry modules ───────────────────────────────────────
let cfg = null, svc = null, agTruth = null, agList = null;
let validateRes = { ok: false, offenders: {} }, loadError = null;
try {
  cfg = require(path.join(ROOT, GUARD_FILES.config));
  svc = require(path.join(ROOT, GUARD_FILES.service));
  agTruth = svc.buildAtlasAgentRegistryTruth({ generatedAt: '2026-01-01T00:00:00.000Z' });
  agList = svc.listAtlasAgents();
  validateRes = svc.validateAgentRegistry();
} catch (e) { loadError = String(e && e.message ? e.message : e); }

const rawAgents = cfg && Array.isArray(cfg.AGENTS) ? cfg.AGENTS : [];
const summary = agTruth ? agTruth.summary : null;
const listed = Array.isArray(agList) ? agList : [];

const EXPECTED_STATUSES = [
  'live_proven', 'live_limited', 'preview', 'connector_required',
  'custom_required', 'partner_required', 'roadmap', 'disabled',
];
const MIN_AGENTS = [
  'core.owner_briefing', 'finance.cashflow_risk', 'collections.priority_review',
  'inventory.pressure_review', 'sales.pipeline_review', 'purchase.supplier_review',
  'customer.risk_review', 'governance.approval_review', 'evidence.evidence_review',
  'data.source_readiness', 'orchestrator.workflow_planner', 'packs.pack_recommendation',
  'enterprise.governance_review', 'custom.operating_model_designer', 'partner.deployment_planner',
];
const MIN_DOMAINS = [
  'command_intelligence', 'finance', 'collections', 'sales', 'purchase', 'inventory',
  'customer', 'supplier', 'governance', 'evidence', 'approvals', 'data_readiness',
  'workflow_orchestration', 'pack_configuration', 'enterprise_custom_deployment',
];
const MIN_SWARMS = [
  'command_intelligence', 'finance_operations', 'revenue_collections', 'supply_inventory',
  'governance_safety', 'evidence_audit', 'data_readiness', 'enterprise_custom_deployment',
];

// ── Gate 01 — Assets exist + pure service loads ───────────────────────────────
const g01 = {
  config_exists:  exists(GUARD_FILES.config),
  service_exists: exists(GUARD_FILES.service),
  doc_exists:     src.doc.length > 0,
  checker_exists: exists(GUARD_FILES.checker),
  service_loads:  agTruth !== null && Array.isArray(agList) && loadError === null,
};

// ── Gate 02 — Allowed status enum only (shared 8-status model) ────────────────
const g02 = {
  allowed_statuses_exactly_eight: !!cfg && Array.isArray(cfg.ALLOWED_AGENT_STATUSES) &&
    cfg.ALLOWED_AGENT_STATUSES.length === 8 && EXPECTED_STATUSES.every((s) => cfg.ALLOWED_AGENT_STATUSES.includes(s)),
  no_nonshared_status_introduced: !!cfg && Array.isArray(cfg.ALLOWED_AGENT_STATUSES) &&
    cfg.ALLOWED_AGENT_STATUSES.every((s) => EXPECTED_STATUSES.includes(s)),
  every_agent_status_allowed: rawAgents.length > 0 && rawAgents.every((a) => EXPECTED_STATUSES.includes(a.status)),
  validate_ok: validateRes.ok === true,
};

// ── Gate 03 — Minimum agents present (unique ids, no empty pass) ──────────────
const ids = rawAgents.map((a) => a.id);
const idSet = new Set(ids);
const g03 = {
  all_minimum_agents_present: rawAgents.length > 0 && MIN_AGENTS.every((id) => idSet.has(id)),
  count_at_least_minimum:     rawAgents.length >= MIN_AGENTS.length,
  ids_unique:                 idSet.size === ids.length && ids.length > 0,
  registry_not_empty:         rawAgents.length > 0 && listed.length === rawAgents.length,
};

// ── Gate 04 — live_proven / execution / activation / production / external == 0 ─
const rawLiveProven = rawAgents.filter((a) => a.status === 'live_proven').length;
const rawExec = rawAgents.filter((a) => a.execution_allowed === true).length;
const rawActiv = rawAgents.filter((a) => a.activation_allowed === true).length;
const rawProd = rawAgents.filter((a) => a.production_allowed === true).length;
const rawExt = rawAgents.filter((a) => a.external_send_allowed === true).length;
const g04 = {
  service_live_proven_zero:         !!summary && summary.live_proven_count === 0,
  service_execution_zero:           !!summary && summary.execution_allowed_count === 0,
  service_activation_zero:          !!summary && summary.activation_allowed_count === 0,
  service_production_zero:          !!summary && summary.production_allowed_count === 0,
  service_external_send_zero:       !!summary && summary.external_send_allowed_count === 0,
  raw_live_proven_zero:  rawAgents.length > 0 && rawLiveProven === 0,
  raw_execution_zero:    rawAgents.length > 0 && rawExec === 0,
  raw_activation_zero:   rawAgents.length > 0 && rawActiv === 0,
  raw_production_zero:   rawAgents.length > 0 && rawProd === 0,
  raw_external_send_zero:rawAgents.length > 0 && rawExt === 0,
};

// ── Gate 05 — No agent executable / activatable / production / external-send ──
const g05 = {
  no_execution_allowed:    rawAgents.length > 0 && rawAgents.every((a) => a.execution_allowed === false),
  no_activation_allowed:   rawAgents.length > 0 && rawAgents.every((a) => a.activation_allowed === false),
  no_production_allowed:   rawAgents.length > 0 && rawAgents.every((a) => a.production_allowed === false),
  no_external_send_allowed:rawAgents.length > 0 && rawAgents.every((a) => a.external_send_allowed === false),
};

// ── Gate 06 — Every agent carries all 26 required fields with valid values ────
const REQUIRED = (cfg && Array.isArray(cfg.REQUIRED_AGENT_FIELDS)) ? cfg.REQUIRED_AGENT_FIELDS : [];
const missingFields = [];
for (const a of rawAgents) {
  for (const f of REQUIRED) {
    if (!Object.prototype.hasOwnProperty.call(a, f) || a[f] === undefined) missingFields.push(a.id + ':' + f);
  }
}
const ARRAY_FIELDS = ['proof_artifact_refs', 'related_packs', 'related_workflows', 'required_data_sources', 'capabilities', 'limitations', 'approval_requirements', 'evidence_requirements', 'audit_requirements'];
const g06 = {
  required_fields_count_26:  REQUIRED.length === 26,
  every_agent_has_all_fields: rawAgents.length > 0 && missingFields.length === 0,
  domain_values_valid:       !!cfg && rawAgents.length > 0 && rawAgents.every((a) => cfg.ALLOWED_AGENT_DOMAINS.includes(a.domain)),
  category_values_valid:     !!cfg && rawAgents.length > 0 && rawAgents.every((a) => cfg.ALLOWED_AGENT_CATEGORIES.includes(a.category)),
  swarm_values_valid:        !!cfg && rawAgents.length > 0 && rawAgents.every((a) => cfg.ALLOWED_AGENT_SWARMS.includes(a.swarm)),
  proof_level_values_valid:  !!cfg && rawAgents.length > 0 && rawAgents.every((a) => cfg.ALLOWED_PROOF_LEVELS.includes(a.proof_level)),
  risk_values_valid:         !!cfg && rawAgents.length > 0 && rawAgents.every((a) => cfg.ALLOWED_RISK_LEVEL.includes(a.risk_level)),
  blocked_reason_nonempty:   rawAgents.length > 0 && rawAgents.every((a) => typeof a.blocked_reason === 'string' && a.blocked_reason.length > 0),
  array_fields_are_arrays:   rawAgents.length > 0 && rawAgents.every((a) => ARRAY_FIELDS.every((k) => Array.isArray(a[k]))),
  bool_fields_are_bool:      rawAgents.length > 0 && rawAgents.every((a) =>
    typeof a.is_implemented === 'boolean' && typeof a.harness_verified === 'boolean' &&
    typeof a.execution_allowed === 'boolean' && typeof a.activation_allowed === 'boolean' &&
    typeof a.production_allowed === 'boolean' && typeof a.external_send_allowed === 'boolean'),
};

// ── Gate 07 — Safe CTA only; no execution-implying CTA ────────────────────────
const allowedCtas = (cfg && Array.isArray(cfg.ALLOWED_SAFE_CTAS)) ? cfg.ALLOWED_SAFE_CTAS : [];
const forbiddenCtas = (cfg && Array.isArray(cfg.FORBIDDEN_CTAS)) ? cfg.FORBIDDEN_CTAS.map((c) => c.toLowerCase()) : [];
const REQUIRED_FORBIDDEN_CTAS = ['run now', 'execute', 'launch agent', 'start automation', 'send', 'sync production', 'deploy'];
const g07 = {
  every_cta_allowed:       rawAgents.length > 0 && rawAgents.every((a) => allowedCtas.includes(a.safe_cta)),
  no_forbidden_cta_used:   rawAgents.length > 0 && rawAgents.every((a) => typeof a.safe_cta === 'string' && !forbiddenCtas.some((c) => a.safe_cta.toLowerCase().includes(c))),
  forbidden_list_complete: REQUIRED_FORBIDDEN_CTAS.every((c) => forbiddenCtas.includes(c)),
};

// ── Gate 08 — Owner-briefing agent honest (sole live_limited; impl + proof) ────
const owb = rawAgents.find((a) => a.id === 'core.owner_briefing') || null;
const liveLimited = rawAgents.filter((a) => a.status === 'live_limited');
const g08 = {
  present:                      !!owb,
  is_live_limited:              !!owb && owb.status === 'live_limited',
  is_implemented_true:          !!owb && owb.is_implemented === true,
  harness_verified_true:        !!owb && owb.harness_verified === true,
  has_impl_evidence_path:       !!owb && typeof owb.implementation_evidence === 'string' && owb.implementation_evidence.length > 0,
  has_proof_refs:               !!owb && Array.isArray(owb.proof_artifact_refs) && owb.proof_artifact_refs.length > 0,
  not_executable:               !!owb && owb.execution_allowed === false && owb.activation_allowed === false && owb.production_allowed === false && owb.external_send_allowed === false,
  sole_live_limited_agent:      liveLimited.length === 1 && !!owb && owb.status === 'live_limited',
};

// ── Gate 09 — EVIDENCE INTEGRITY (impl/proof artifacts exist; no inflation) ───
const implementedWithoutEvidence = [];
const implementedEvidenceMissingOnDisk = [];
const harnessWithoutRefs = [];
const harnessRefMissingOnDisk = [];
const liveLimitedWithoutProof = [];
for (const a of rawAgents) {
  if (a.is_implemented === true) {
    if (!(typeof a.implementation_evidence === 'string' && a.implementation_evidence.length > 0)) {
      implementedWithoutEvidence.push(a.id);
    } else if (!exists(a.implementation_evidence)) {
      implementedEvidenceMissingOnDisk.push(a.id + ':' + a.implementation_evidence);
    }
  }
  if (a.harness_verified === true) {
    if (!(Array.isArray(a.proof_artifact_refs) && a.proof_artifact_refs.length > 0)) {
      harnessWithoutRefs.push(a.id);
    } else {
      for (const ref of a.proof_artifact_refs) if (!exists(ref)) harnessRefMissingOnDisk.push(a.id + ':' + ref);
    }
  }
  if (a.status === 'live_limited') {
    const ok = a.is_implemented === true && a.harness_verified === true &&
      typeof a.implementation_evidence === 'string' && a.implementation_evidence.length > 0 &&
      Array.isArray(a.proof_artifact_refs) && a.proof_artifact_refs.length > 0;
    if (!ok) liveLimitedWithoutProof.push(a.id);
  }
}
// "code existence alone does not imply live_limited": every live_limited MUST carry
// agent-specific proof refs that exist on disk (checked above). "swarm membership does
// not imply implementation": is_implemented must be evidence-backed — the count of
// is_implemented agents must equal the count whose evidence path actually exists.
const implementedCount = rawAgents.filter((a) => a.is_implemented === true).length;
const implementedWithRealEvidence = rawAgents.filter((a) =>
  a.is_implemented === true && typeof a.implementation_evidence === 'string' &&
  a.implementation_evidence.length > 0 && exists(a.implementation_evidence)).length;
const g09 = {
  is_implemented_requires_evidence:      implementedWithoutEvidence.length === 0,
  implementation_evidence_exists_on_disk:implementedEvidenceMissingOnDisk.length === 0,
  harness_verified_requires_refs:        harnessWithoutRefs.length === 0,
  proof_artifact_refs_exist_on_disk:     harnessRefMissingOnDisk.length === 0,
  live_limited_requires_impl_and_proof:  liveLimitedWithoutProof.length === 0,
  is_implemented_is_evidence_backed:     implementedCount === implementedWithRealEvidence,
};

// ── Gate 10 — Relationship integrity (real pack ids + real workflow ids) ──────
let packCfg = null, wfCfg = null, relLoadErr = null;
try { packCfg = require(path.join(ROOT, GUARD_FILES.pack_config)); wfCfg = require(path.join(ROOT, GUARD_FILES.wf_config)); }
catch (e) { relLoadErr = String(e && e.message ? e.message : e); }
const packIds = new Set(packCfg && Array.isArray(packCfg.PACKS) ? packCfg.PACKS.map((p) => p.id) : []);
const wfIds = new Set(wfCfg && Array.isArray(wfCfg.WORKFLOWS) ? wfCfg.WORKFLOWS.map((w) => w.id) : []);
const badPackRefs = [];
const badWfRefs = [];
for (const a of rawAgents) {
  for (const rp of (a.related_packs || [])) if (!packIds.has(rp)) badPackRefs.push(a.id + ':' + rp);
  for (const rw of (a.related_workflows || [])) if (!wfIds.has(rw)) badWfRefs.push(a.id + ':' + rw);
}
const g10 = {
  pack_ids_loaded:              packIds.size > 0,
  workflow_ids_loaded:          wfIds.size > 0,
  related_packs_all_valid:      rawAgents.length > 0 && badPackRefs.length === 0,
  related_workflows_all_valid:  rawAgents.length > 0 && badWfRefs.length === 0,
  no_orphan_references:         badPackRefs.length === 0 && badWfRefs.length === 0,
};

// ── Gate 11 — Route safety (optional; when present, GET-only flag-gated) ──────
const PB_START = src.server.indexOf('BEGIN ATLAS AGENT UNIVERSE (Phase 2C.28)');
const PB_END = PB_START > -1 ? src.server.indexOf('END ATLAS AGENT UNIVERSE (Phase 2C.28)', PB_START) : -1;
const agBlock = (PB_START > -1 && PB_END > -1) ? src.server.slice(PB_START, PB_END) : '';
const routePresent = agBlock.length > 0;
const writeVerbRoute = /app\.(post|put|patch|delete)\s*\(\s*['"]\/api\/atlas\/agents/i.test(src.server);
const flagIdxA = agBlock.indexOf('atlas_agent_registry_api_enabled');
const buildIdxA = agBlock.indexOf('buildAtlasAgentRegistryTruth(');
const g11 = {
  no_post_patch_delete_agent_route: !writeVerbRoute,
  route_get_endpoints_present: !routePresent ||
    (/app\.get\(\s*'\/api\/atlas\/agents'/.test(agBlock) && /app\.get\(\s*'\/api\/atlas\/agents\/:id'/.test(agBlock)),
  route_auth_gated: !routePresent ||
    (/app\.get\(\s*'\/api\/atlas\/agents'\s*,\s*authMiddleware/.test(agBlock) &&
     /app\.get\(\s*'\/api\/atlas\/agents\/:id'\s*,\s*authMiddleware/.test(agBlock)),
  route_flag_gated_404: !routePresent || (flagIdxA > -1 && agBlock.includes('status(404)')),
  route_flag_before_build: !routePresent || (flagIdxA > -1 && buildIdxA > -1 && flagIdxA < buildIdxA),
  route_no_db_sync_exec: !routePresent ||
    !/getPool|pool\.query|supabase|\bneon\b|sync_batch|production_sync|external_send|\.execute\(|activate\(/i.test(agBlock),
  no_execute_activate_run_route: !/app\.\w+\s*\(\s*['"]\/api\/atlas\/agents[^'"]*\/(execute|activate|run|send|sync|deploy)/i.test(src.server),
};

// ── Gate 12 — Feature flag default-OFF; no new default-ON flag ────────────────
let flagDefaultOffRuntime = false;
try { flagDefaultOffRuntime = require(path.join(ROOT, GUARD_FILES.flags)).isEnabled('atlas_agent_registry_api_enabled') === false; } catch (e) {}
const defaultOnCount = (src.flags.match(/!==\s*'false'/g) || []).length;
const g12 = {
  flag_name_present:        /atlas_agent_registry_api_enabled/.test(src.flags) && /FEATURE_ATLAS_AGENT_REGISTRY_API_ENABLED/.test(src.flags),
  flag_default_off_source:  /atlas_agent_registry_api_enabled\s*:\s*process\.env\.FEATURE_ATLAS_AGENT_REGISTRY_API_ENABLED\s*===\s*'true'/.test(src.flags),
  flag_default_off_runtime: flagDefaultOffRuntime === true,
  only_prompt_guard_default_on: defaultOnCount === 1 &&
    /prompt_guard_enabled\s*:\s*process\.env\.FEATURE_PROMPT_GUARD_ENABLED\s*!==\s*'false'/.test(src.flags),
};

// ── Gate 13 — Pack (2C.26) + Workflow (2C.27) registries still conservative ────
let packSummary = null, packSvcErr = null, wfSummary = null, wfSvcErr = null;
try { packSummary = require(path.join(ROOT, GUARD_FILES.pack_service)).summarizeAtlasPackRegistry(); }
catch (e) { packSvcErr = String(e && e.message ? e.message : e); }
try { wfSummary = require(path.join(ROOT, GUARD_FILES.wf_service)).summarizeAtlasWorkflowRegistry(); }
catch (e) { wfSvcErr = String(e && e.message ? e.message : e); }
const g13 = {
  pack_service_loads:    packSvcErr === null && packSummary !== null,
  pack_live_proven_zero: !!packSummary && packSummary.live_proven_count === 0,
  pack_execution_zero:   !!packSummary && packSummary.execution_allowed_count === 0,
  pack_activation_zero:  !!packSummary && packSummary.activation_allowed_count === 0,
  wf_service_loads:      wfSvcErr === null && wfSummary !== null,
  wf_live_proven_zero:   !!wfSummary && wfSummary.live_proven_count === 0,
  wf_execution_zero:     !!wfSummary && wfSummary.execution_allowed_count === 0,
  wf_activation_zero:    !!wfSummary && wfSummary.activation_allowed_count === 0,
};

// ── Gate 14 — Prior-phase conservatism unchanged (2C.21..2C.25); RT live_limited fixed ─
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
  'docs/agent-mesh/phase-2c-27-atlas-workflow-registry-backend-contract.md',
];
const missingArtifacts = PRIOR_ARTIFACTS.filter((p) => !exists(p));
let rtLiveProven = null, rtLiveLimited = null, rtLoadError = null;
try {
  const rtSvc = require(path.join(ROOT, GUARD_FILES.rt_service));
  const rt = rtSvc.buildRuntimeTruth({ generatedAt: '2026-01-01T00:00:00.000Z' });
  rtLiveProven = rt && rt.summary ? rt.summary.live_proven : null;
  rtLiveLimited = rt && rt.summary ? rt.summary.live_limited : null;
} catch (e) { rtLoadError = String(e && e.message ? e.message : e); }
const c23Decision = (src.doc23.match(/^DECISION_STATE:\s*([a-z_]+)\s*$/im) || [])[1] || null;
const c23Ga = (src.doc23.match(/^GA_READY:\s*(yes|no)\s*$/im) || [])[1] || null;
const c23Canary = (src.doc23.match(/^PRODUCTION_CANARY_READY:\s*(yes|no)\s*$/im) || [])[1] || null;
const c24Canary = (src.doc24.match(/^CANARY_READY:\s*(yes|no)\s*$/im) || [])[1] || null;
const c25Owner = (src.doc25.match(/^owner_approval_record_present:\s*(true|false)\s*$/im) || [])[1] || null;
const c25Scope = (src.doc25.match(/^canary_scope_record_present:\s*(true|false)\s*$/im) || [])[1] || null;
const g14 = {
  prior_artifacts_exist:        missingArtifacts.length === 0,
  rt_live_proven_zero:          rtLoadError === null && rtLiveProven === 0,
  rt_live_limited_unchanged:    rtLoadError === null && rtLiveLimited === 2, // 2C.21 baseline; NOT increased
  c23_staging_proven_only:      c23Decision === 'staging_proven_only',
  c23_ga_ready_no:              c23Ga === 'no',
  c23_canary_ready_no:          c23Canary === 'no',
  c24_canary_ready_no:          c24Canary === 'no',
  c25_owner_record_absent:      c25Owner === 'false',
  c25_scope_record_absent:      c25Scope === 'false',
};

// ── Gate 15 — No count inflation / no marketing multiplication ────────────────
// "claim word" = any word that would turn a count into a live/production claim.
const CLAIM_WORD = '(?:live|production|deployed|active|running|autonomous|in[ _-]production|ga\\b)';
const NUMERIC_OVERCLAIM = [
  new RegExp('\\b216\\b[^\\n]{0,24}' + CLAIM_WORD, 'i'),
  new RegExp('\\b300\\b[^\\n]{0,24}' + CLAIM_WORD, 'i'),
  new RegExp('\\b360\\b[^\\n]{0,24}' + CLAIM_WORD, 'i'),
  new RegExp('\\b500\\b[^\\n]{0,24}' + CLAIM_WORD, 'i'),
  new RegExp('\\b100\\+?\\s+' + CLAIM_WORD, 'i'),
  new RegExp('\\b200\\+?\\s+' + CLAIM_WORD, 'i'),
];
const PHRASE_OVERCLAIM = [
  /fully autonomous/i, /bank-grade/i, /military-grade/i,
  /\bproduction-live\b/i, /live external whatsapp/i, /generally available/i,
];
const numericTargets = { config: src.config, service: src.service }; // doc legitimately discusses the numbers to contradict them
const phraseTargets = { config: src.config, service: src.service, doc: src.doc };
const overclaimHits = [];
for (const [t, text] of Object.entries(numericTargets)) {
  for (const re of NUMERIC_OVERCLAIM) if (re.test(text)) overclaimHits.push('num:' + t + ':' + re.source);
}
for (const [t, text] of Object.entries(phraseTargets)) {
  for (const re of PHRASE_OVERCLAIM) if (re.test(text)) overclaimHits.push('phrase:' + t + ':' + re.source);
}
const claimedCount = agTruth && typeof agTruth.claimed_agent_count === 'number' ? agTruth.claimed_agent_count : null;
const swarmsTotal = summary ? summary.swarms_total : null;
const docInflationMarker = (src.doc.match(/^INFLATED_AGENT_COUNT_CLAIM:\s*(yes|no)\s*$/im) || [])[1] || null;
const g15 = {
  config_service_free_of_overclaims: overclaimHits.length === 0,
  claimed_count_equals_rows:         claimedCount !== null && claimedCount === rawAgents.length,
  summary_total_equals_rows:         !!summary && summary.agents_total === rawAgents.length && listed.length === rawAgents.length,
  swarms_are_enum_not_multiplier:    swarmsTotal !== null && swarmsTotal <= 12 && swarmsTotal < rawAgents.length,
  no_claim_exceeds_rows:             claimedCount !== null && claimedCount <= rawAgents.length,
  doc_marks_no_inflated_claim:       docInflationMarker === 'no',
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

// ── Gate 18 — No DB / migration / table change (correction #1) ────────────────
const g18 = {
  no_migration_file_declared:  !PHASE_TOUCHED.some((p) => /(^|\/)migrations\//i.test(p)),
  no_sql_file_declared:        !PHASE_TOUCHED.some((p) => /\.sql$/i.test(p)),
  no_db_dir_declared:          !PHASE_TOUCHED.some((p) => /(^|\/)db\//i.test(p)),
  no_seed_script_declared:     !PHASE_TOUCHED.some((p) => /seed-agent-registry/i.test(p)),
  agent_migration_present:     exists(GUARD_FILES.agent_migration),
  agent_migration_unchanged:   HASH_BEFORE.agent_migration !== null &&
    sha256(GUARD_FILES.agent_migration) === HASH_BEFORE.agent_migration,
};

// ── Gate 19 — Minimum domains & swarms present (taxonomy completeness) ─────────
const domainEnum = (cfg && Array.isArray(cfg.ALLOWED_AGENT_DOMAINS)) ? cfg.ALLOWED_AGENT_DOMAINS : [];
const swarmEnum = (cfg && Array.isArray(cfg.ALLOWED_AGENT_SWARMS)) ? cfg.ALLOWED_AGENT_SWARMS : [];
const swarmsUsed = new Set(rawAgents.map((a) => a.swarm));
const g19 = {
  all_min_domains_in_enum:  MIN_DOMAINS.every((d) => domainEnum.includes(d)),
  all_min_swarms_in_enum:   MIN_SWARMS.every((s) => swarmEnum.includes(s)),
  every_swarm_has_an_agent: rawAgents.length > 0 && MIN_SWARMS.every((s) => swarmsUsed.has(s)),
};

// ── Gate 21 — No production-canary over-claim (CROSS-PHASE semantic gate) ──────
// Codex blocker fix: an agent must NOT claim a production-canary proof level while the
// prior canary gates remain blocked (2C.23 PRODUCTION_CANARY_READY:no, 2C.24 CANARY_READY:no,
// 2C.25 owner/scope records absent). For Phase 2C.28 the production_canary proof count MUST
// be 0; is_implemented / harness_verified / live_limited NEVER imply a production canary.
const prodCanaryProofCount = rawAgents.filter((a) => a.proof_level === 'production_canary').length;
const canaryGatesBlocked = c23Canary === 'no' && c24Canary === 'no' && c25Owner === 'false' && c25Scope === 'false';
const configHasPcValue = /'production_canary'/.test(src.config) || /PRODUCTION_CANARY\s*:/.test(src.config);
const serviceHasPcValue = /'production_canary'/.test(src.service);
// CLAUSE-LOCAL safe context (Codex fix): split into sentence/clause units, THEN a
// "production canary" mention is acceptable ONLY when the SAME clause marks it blocked /
// absent / pending / required / not-done / zero. A safe phrase in one clause NEVER exempts
// an affirmative phrase in another clause. Whitespace (incl. newlines from line-wrapping)
// is collapsed to single spaces — that is NOT a clause boundary; sentence-end ('. '), ';',
// and markdown '|' ARE clause boundaries (so a wrapped sentence stays intact, but distinct
// sentences/cells are evaluated independently). Periods inside tokens like "2C.28" or
// ".js" (no following whitespace) do NOT split.
function _clauses(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .split(/\s*[;|]\s*|(?<=\.)\s+/)
    .map((c) => c.toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((c) => c.length > 0);
}
const PC_SAFE = /\b(?:no|not|never|without|blocked|remains?|absent|pending|requires?|staging|design|disabled|off|false)\b|proof count|\b0\b/i;
function pcViolations(text) {
  const v = [];
  for (const clause of _clauses(text)) {
    if (/production canary/.test(clause) && !PC_SAFE.test(clause)) v.push(clause.slice(0, 80));
  }
  return v;
}
const configPcViol = pcViolations(src.config);
const servicePcViol = pcViolations(src.service);
const docPcViol = pcViolations(src.doc);
const docPcMarker = (src.doc.match(/^PRODUCTION_CANARY_PROOF_COUNT:\s*(\d+)\s*$/im) || [])[1] || null;
const liveLimitedPc = rawAgents.filter((a) => a.status === 'live_limited' && a.proof_level === 'production_canary');
const harnessPc = rawAgents.filter((a) => a.harness_verified === true && a.proof_level === 'production_canary');
const implPc = rawAgents.filter((a) => a.is_implemented === true && a.proof_level === 'production_canary');
const g21 = {
  production_canary_proof_count_zero:     prodCanaryProofCount === 0,
  no_canary_proof_while_gates_blocked:    !(prodCanaryProofCount > 0 && canaryGatesBlocked),
  live_limited_not_production_canary:     liveLimitedPc.length === 0,
  harness_verified_not_production_canary: harnessPc.length === 0,
  is_implemented_not_production_canary:   implPc.length === 0,
  config_service_no_canary_value:         !configHasPcValue && !serviceHasPcValue,
  config_service_no_affirmative_canary:   configPcViol.length === 0 && servicePcViol.length === 0,
  doc_canary_only_in_negation:            docPcViol.length === 0,
  doc_marks_canary_proof_zero:            docPcMarker === '0',
  no_production_proof_while_blocked:      rawAgents.length > 0 && rawAgents.every((a) => a.proof_level !== 'production_canary' || a.production_allowed === true),
  proof_level_enum_excludes_canary:       !!cfg && Array.isArray(cfg.ALLOWED_PROOF_LEVELS) && !cfg.ALLOWED_PROOF_LEVELS.includes('production_canary'),
};

// ── Gate 22 — Dedicated LIVE-PROVEN proof-level count (Codex blocker) ──────────
// Counts agents whose PROOF LEVEL asserts a live / production-proven state. SEPARATE
// from the live_proven STATUS count (g04), the Runtime-Truth live_proven count (g14),
// and generic proof-level enum validation (g06). Phase 2C.28 has NO production-
// observation artifacts, so this count MUST be 0 — fail-closed on its own.
const LIVE_PROOF_VALUES = ['live_proven', 'production_live', 'production_proven', 'ga', 'generally_available'];
const liveProvenProofAgents = rawAgents.filter((a) => LIVE_PROOF_VALUES.includes(a.proof_level)).map((a) => a.id);
const liveProvenProofCount = liveProvenProofAgents.length;
const g22 = {
  live_proven_proof_count_zero: liveProvenProofCount === 0,
  no_live_proven_proof_without_observation_artifacts:
    rawAgents.length > 0 && rawAgents.every((a) => !LIVE_PROOF_VALUES.includes(a.proof_level)),
  proof_level_enum_excludes_live_proven:
    !!cfg && Array.isArray(cfg.ALLOWED_PROOF_LEVELS) && !cfg.ALLOWED_PROOF_LEVELS.includes('live_proven'),
};

// ── Gate 23 — Affirmative production/canary wording detection (Codex blocker) ──
// Fail-closed scan for AFFIRMATIVE production/canary claims in the human-readable
// artifacts (config / service / doc). Normalizes case + hyphen/underscore/whitespace,
// matches whole-phrase, and EXEMPTS ONLY a DIRECT negation/blocked-value — a negation
// elsewhere in the sentence does NOT exempt (e.g. "...not previously production ready
// but now production ready" stays flagged). The checker source is NOT scanned (it
// legitimately contains the phrase list).
const AFFIRMATIVE_PHRASES = [
  'production canary completed', 'canary completed', 'canary tested', 'canary passed',
  'production tested', 'production ready', 'ready for production',
  'deployed to users', 'deployed to production',
  'activated in production', 'production activated',
  'launched to production', 'launched in production',
  'live in production', 'production live',
  'ga ready', 'generally available',
];
function _directlyNegated(pre) {
  const negRe = /\b(?:no|not|never|without|blocked|disabled|pending|false|remains?|stays?|cannot)\b/g;
  const advRe = /\b(?:but|however|now|yet|previously|although|though)\b/g;
  let lastNeg = -1, m;
  while ((m = negRe.exec(pre)) !== null) lastNeg = m.index;
  if (lastNeg === -1) return false;
  advRe.lastIndex = lastNeg;
  let a;
  while ((a = advRe.exec(pre)) !== null) { if (a.index > lastNeg) return false; }
  return true;
}
// CLAUSE-LOCAL (Codex fix): evaluate each clause independently so a negation in a PRIOR
// clause cannot exempt an affirmative claim in a LATER one (e.g. "pending approval.
// Production canary completed." stays flagged). Direct-negation (pre-window within the
// clause, no adversative after it) and immediate negated-value (post) still exempt.
function _affirmativeHits(rawText) {
  const hits = [];
  for (const clause of _clauses(rawText)) {
    for (const p of AFFIRMATIVE_PHRASES) {
      let idx = 0;
      while ((idx = clause.indexOf(p, idx)) !== -1) {
        const before = idx === 0 ? '' : clause[idx - 1];
        const afterPos = idx + p.length;
        const after = afterPos >= clause.length ? '' : clause[afterPos];
        const boundaryOk = (before === '' || !/[a-z0-9]/.test(before)) && (after === '' || !/[a-z0-9]/.test(after));
        if (boundaryOk) {
          const pre = clause.slice(Math.max(0, idx - 24), idx);
          const post = clause.slice(afterPos, afterPos + 12);
          const negatedAfter = /^\s*(?::|=)?\s*(?:no|false|0|disabled|blocked|absent|pending|off)\b/.test(post);
          if (!_directlyNegated(pre) && !negatedAfter) hits.push(p);
        }
        idx = afterPos;
      }
    }
  }
  return hits;
}
const affConfigHits = _affirmativeHits(src.config);
const affServiceHits = _affirmativeHits(src.service);
const affDocHits = _affirmativeHits(src.doc);
const affirmativeProductionClaimCount = affConfigHits.length + affServiceHits.length + affDocHits.length;
const g23 = {
  config_no_affirmative_production_claim:  affConfigHits.length === 0,
  service_no_affirmative_production_claim: affServiceHits.length === 0,
  doc_no_affirmative_production_claim:     affDocHits.length === 0,
  affirmative_production_claim_count_zero: affirmativeProductionClaimCount === 0,
};

// ── MUTATION GUARD (part 2): re-hash AFTER all checks ─────────────────────────
const HASH_AFTER = {};
for (const [k, rel] of Object.entries(GUARD_FILES)) HASH_AFTER[k] = sha256(rel);
const mutated = Object.keys(GUARD_FILES)
  .filter((k) => HASH_BEFORE[k] === null || HASH_AFTER[k] === null || HASH_BEFORE[k] !== HASH_AFTER[k]);
const g20 = {
  all_hashes_captured:        Object.values(HASH_BEFORE).every((h) => typeof h === 'string'),
  files_unchanged_during_run: mutated.length === 0,
};

// ── roll up ───────────────────────────────────────────────────────────────────
const GATES = {
  '01_assets_exist':                       g01,
  '02_status_enum_only':                   g02,
  '03_minimum_agents_present':             g03,
  '04_zero_live_exec_activation_prod_ext': g04,
  '05_no_agent_executable':                g05,
  '06_required_fields_present':            g06,
  '07_safe_cta_only':                      g07,
  '08_owner_briefing_agent_honest':        g08,
  '09_evidence_integrity':                 g09,
  '10_relationship_integrity':             g10,
  '11_route_safe':                         g11,
  '12_feature_flag_default_off':           g12,
  '13_pack_workflow_still_conservative':   g13,
  '14_prior_phase_conservatism':           g14,
  '15_no_count_inflation':                 g15,
  '16_no_secrets_pii_pure':                g16,
  '17_declared_path_scope':                g17,
  '18_no_db_migration_change':             g18,
  '19_minimum_domains_swarms':             g19,
  '20_mutation_guard':                     g20,
  '21_no_production_canary_overclaim':     g21,
  '22_live_proven_proof_count':            g22,
  '23_no_affirmative_production_wording':  g23,
};
const gate_results = {};
let gates_passed = 0;
for (const [name, checks] of Object.entries(GATES)) {
  const pass = all(checks);
  if (pass) gates_passed++;
  gate_results[name] = { pass, checks };
}
const gates_total = Object.keys(GATES).length;
const overall_pass = loadError === null && agTruth !== null && gates_passed === gates_total;

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
  agent_registry_version: agTruth ? agTruth.agent_registry_version : null,
  registry_summary: summary ? {
    agents_total: summary.agents_total,
    domains_total: summary.domains_total,
    swarms_total: summary.swarms_total,
    live_proven_count: summary.live_proven_count,
    live_limited_count: summary.live_limited_count,
    execution_allowed_count: summary.execution_allowed_count,
    activation_allowed_count: summary.activation_allowed_count,
    production_allowed_count: summary.production_allowed_count,
    external_send_allowed_count: summary.external_send_allowed_count,
    is_implemented_count: summary.is_implemented_count,
    harness_verified_count: summary.harness_verified_count,
    by_status: summary.by_status,
    by_swarm: summary.by_swarm,
  } : null,
  route_present: routePresent,
  production_canary_proof_count: prodCanaryProofCount,
  live_proven_proof_count: liveProvenProofCount,
  affirmative_production_claim_count: affirmativeProductionClaimCount,
  canary_gates_blocked: canaryGatesBlocked,
  pack_registry_summary: packSummary ? {
    packs_total: packSummary.packs_total, live_proven_count: packSummary.live_proven_count,
    execution_allowed_count: packSummary.execution_allowed_count, activation_allowed_count: packSummary.activation_allowed_count,
  } : null,
  workflow_registry_summary: wfSummary ? {
    workflows_total: wfSummary.workflows_total, live_proven_count: wfSummary.live_proven_count,
    execution_allowed_count: wfSummary.execution_allowed_count, activation_allowed_count: wfSummary.activation_allowed_count,
  } : null,
  prior_markers: {
    rt_live_proven: rtLiveProven, rt_live_limited: rtLiveLimited,
    c23_decision_state: c23Decision, c23_ga_ready: c23Ga, c23_production_canary_ready: c23Canary,
    c24_canary_ready: c24Canary, c25_owner_approval_record_present: c25Owner, c25_canary_scope_record_present: c25Scope,
  },
  live_limited_agents: liveLimited.map((a) => a.id),
  load_error: loadError,
  rel_load_error: relLoadErr,
  // diagnostics (counts / names only — never values)
  missing_prior_artifacts: missingArtifacts,
  missing_required_fields: missingFields,
  implemented_without_evidence: implementedWithoutEvidence,
  implementation_evidence_missing_on_disk: implementedEvidenceMissingOnDisk,
  harness_without_refs: harnessWithoutRefs,
  harness_ref_missing_on_disk: harnessRefMissingOnDisk,
  live_limited_without_proof: liveLimitedWithoutProof,
  bad_related_pack_refs: badPackRefs,
  bad_related_workflow_refs: badWfRefs,
  config_pc_violations: configPcViol.length,
  service_pc_violations: servicePcViol.length,
  doc_pc_violations: docPcViol.length,
  live_proven_proof_agents: liveProvenProofAgents,
  affirmative_production_claim_hits: affConfigHits.concat(affServiceHits, affDocHits),
  validate_offenders: validateRes.offenders || {},
  overclaim_hits: overclaimHits,
  pii_pattern_hits: piiHits,
  purity_violations: purityHits,
  files_mutated_by_check: mutated,
  guard_file_hashes: hashes,
  informational_only_not_a_pass_condition: {
    note: 'Display-only, never part of overall_pass. Scope booleans derive from the DECLARED phase file list (gate 17/18) + secret/purity scans (gate 16) + the mutation guard (gate 20); the ACTUAL working-tree scope is verified externally via git status/diff in the phase report.',
    production_touched:   (g17.backend_paths_only_declared && g20.files_unchanged_during_run) ? false : null,
    railway_touched:      g17.no_railway_file_declared ? false : null,
    env_files_changed:    g17.no_env_file_declared ? false : null,
    frontend_touched:     g17.no_frontend_file_declared ? false : null,
    deploy_triggered:     g17.no_deploy_file_declared ? false : null,
    db_migration_changed: (g18.no_migration_file_declared && g18.no_sql_file_declared && g18.agent_migration_unchanged) ? false : null,
    secrets_exposed:      (g16.config_service_doc_free_of_pii && g16.checker_free_of_secret_literals) ? false : null,
    agent_execution_enabled:   (g04.service_execution_zero && g05.no_execution_allowed) ? false : null,
    agent_activation_enabled:  (g04.service_activation_zero && g05.no_activation_allowed) ? false : null,
    agent_production_enabled:  (g04.service_production_zero && g05.no_production_allowed) ? false : null,
    external_send_enabled:     (g04.service_external_send_zero && g05.no_external_send_allowed) ? false : null,
    inflated_agent_count_claim:(g15.claimed_count_equals_rows && g15.no_claim_exceeds_rows && g15.config_service_free_of_overclaims) ? false : null,
    production_canary_overclaim:(g21.production_canary_proof_count_zero && g21.no_canary_proof_while_gates_blocked && g21.config_service_no_canary_value && g21.config_service_no_affirmative_canary && g21.doc_canary_only_in_negation) ? false : null,
    live_proven_proof_present: g22.live_proven_proof_count_zero ? false : null,
    affirmative_production_claim_present: g23.affirmative_production_claim_count_zero ? false : null,
  },
  gate_results,
};
if (!overall_pass) {
  result._note = 'FAIL-CLOSED: one or more Agent Registry gates unmet. The Agent Universe must remain read-only, evidence-gated truth — an agent becomes runnable ONLY through a future, separately-approved phase that records explicit owner approval and produces real production-access proofs, never an edit to this registry/doc/flag alone. is_implemented/harness_verified are facts and never grant live/execution/activation/production.';
}
console.log('AGENT_REGISTRY_JSON:' + JSON.stringify(result, null, 1));
process.exit(overall_pass ? 0 : 1);
