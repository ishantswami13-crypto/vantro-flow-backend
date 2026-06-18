#!/usr/bin/env node
'use strict';
/*
 * Phase 2C.30 — Atlas Action Approval Contract check (FAIL-CLOSED).
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves, statically and fail-closed, that the Action Approval registry is a static,
 * READ-ONLY approval-REQUIREMENT truth model that requests/grants/records/executes
 * NOTHING. Verdict derives ONLY from independent evidence:
 *   (A) the PURE config + service loaded with NO DB / network / env reads;
 *   (B) structural invariants over every contract (allowed enums, 27 required fields,
 *       unique ids, approval/approver/role/SoD/evidence/audit consistency, every safety
 *       boolean false, automatic_approval zero);
 *   (C) reference integrity — related packs/agents/workflows are real 2C.26/2C.28/2C.27
 *       ids, no orphans;
 *   (D) class-specific rules — external communication / financial commitment / customer
 *       data export / business record mutation REQUIRE approval; production sync and
 *       deployment change BLOCKED; policy override cannot auto-approve;
 *   (E) route safety (auth before flag, generic 404, GET-only, no approve/reject/request/
 *       decide/execute route); feature flag default-OFF;
 *   (F) no operational-claim — truth booleans false + doc markers 'no' + a CLAUSE-LOCAL
 *       affirmative-claim scan (a negation in another clause never exempts an affirmative
 *       claim) so "approval granted / queue operational / executes after approval" cannot
 *       slip in;
 *   (G) prior 2C.21–2C.29 conservatism re-derived; secret/PII scan; DECLARED path scope
 *       (backend-only, no DB/migration); SHA-256 mutation guard.
 *
 * NO self-attestation feeds the verdict. EVERY `.every()` is length-guarded.
 * SAFETY: read-only. No DB, no network, no file writes, no process spawn.
 * USAGE: node scripts/phase-2c-30-atlas-action-approval-check.js  (exit 0 = pass)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
delete process.env.FEATURE_ATLAS_ACTION_APPROVAL_API_ENABLED;

function read(rel) { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return ''; } }
function exists(rel) { try { fs.accessSync(path.join(ROOT, rel)); return true; } catch (e) { return false; } }
function sha256(rel) { try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex'); } catch (e) { return null; } }
const all = (obj) => Object.values(obj).every((v) => v === true);

const PHASE_TOUCHED = [
  'lib/config/atlasActionApprovalRegistry.js',
  'lib/services/atlasActionApprovalRegistry.service.js',
  'docs/agent-mesh/phase-2c-30-atlas-action-approval-contract.md',
  'scripts/phase-2c-30-atlas-action-approval-check.js',
  'lib/featureFlags.js',
  'server.js',
];

const GUARD_FILES = {
  config:       'lib/config/atlasActionApprovalRegistry.js',
  service:      'lib/services/atlasActionApprovalRegistry.service.js',
  doc:          'docs/agent-mesh/phase-2c-30-atlas-action-approval-contract.md',
  checker:      'scripts/phase-2c-30-atlas-action-approval-check.js',
  flags:        'lib/featureFlags.js',
  server:       'server.js',
  pack_config:  'lib/config/atlasPackRegistry.js',
  pack_service: 'lib/services/atlasPackRegistry.service.js',
  agent_config: 'lib/config/atlasAgentRegistry.js',
  agent_service:'lib/services/atlasAgentRegistry.service.js',
  wf_config:    'lib/config/atlasWorkflowRegistry.js',
  wf_service:   'lib/services/atlasWorkflowRegistry.service.js',
  graph_service:'lib/services/atlasRelationshipGraph.service.js',
  rt_service:   'lib/services/runtimeTruth.service.js',
  doc23:        'docs/agent-mesh/phase-2c-23-owner-briefing-ga-decision-gate.md',
  doc24:        'docs/agent-mesh/phase-2c-24-production-canary-prerequisite-binder.md',
  doc25:        'docs/agent-mesh/phase-2c-25-owner-approval-canary-scope-intake.md',
};

const HASH_BEFORE = {};
for (const [k, rel] of Object.entries(GUARD_FILES)) HASH_BEFORE[k] = sha256(rel);

const src = {
  config:  read(GUARD_FILES.config), service: read(GUARD_FILES.service), doc: read(GUARD_FILES.doc),
  flags:   read(GUARD_FILES.flags), server: read(GUARD_FILES.server),
  doc23:   read(GUARD_FILES.doc23), doc24: read(GUARD_FILES.doc24), doc25: read(GUARD_FILES.doc25),
};

let cfg = null, svc = null, truth = null, listed = null, validateRes = { ok: false, offenders: {} }, loadError = null;
let packCfg = null, agentCfg = null, wfCfg = null;
try {
  cfg = require(path.join(ROOT, GUARD_FILES.config));
  svc = require(path.join(ROOT, GUARD_FILES.service));
  packCfg = require(path.join(ROOT, GUARD_FILES.pack_config));
  agentCfg = require(path.join(ROOT, GUARD_FILES.agent_config));
  wfCfg = require(path.join(ROOT, GUARD_FILES.wf_config));
  truth = svc.buildAtlasActionApprovalTruth({ generatedAt: '2026-01-01T00:00:00.000Z' });
  listed = svc.listAtlasActionApprovalContracts();
  validateRes = svc.validateActionApprovalRegistry();
} catch (e) { loadError = String(e && e.message ? e.message : e); }

const CONTRACTS = cfg && Array.isArray(cfg.CONTRACTS) ? cfg.CONTRACTS : [];
const summary = truth ? truth.summary : null;
const byClass = {};
for (const c of CONTRACTS) byClass[c.action_class] = c;

const packIds = new Set(packCfg && Array.isArray(packCfg.PACKS) ? packCfg.PACKS.map((p) => p.id) : []);
const agentIds = new Set(agentCfg && Array.isArray(agentCfg.AGENTS) ? agentCfg.AGENTS.map((a) => a.id) : []);
const wfIds = new Set(wfCfg && Array.isArray(wfCfg.WORKFLOWS) ? wfCfg.WORKFLOWS.map((w) => w.id) : []);

const EXPECTED_CLASSES = [
  'read_only_analysis', 'business_record_mutation', 'financial_commitment', 'external_communication',
  'customer_data_export', 'workflow_activation', 'agent_activation', 'production_sync',
  'configuration_change', 'policy_override', 'deployment_change', 'partner_custom_automation',
];

// ── Gate 01 — assets exist + service loads ────────────────────────────────────
const g01 = {
  config_exists: exists(GUARD_FILES.config), service_exists: exists(GUARD_FILES.service),
  doc_exists: src.doc.length > 0, checker_exists: exists(GUARD_FILES.checker),
  service_loads: truth !== null && Array.isArray(listed) && loadError === null,
};

// ── Gate 02 — registry non-empty (no vacuous pass) ────────────────────────────
const g02 = {
  contracts_non_empty: CONTRACTS.length > 0,
  twelve_contracts: CONTRACTS.length === 12,
  registries_loaded: packIds.size > 0 && agentIds.size > 0 && wfIds.size > 0,
};

// ── Gate 03 — unique contract ids ─────────────────────────────────────────────
const ids = CONTRACTS.map((c) => c.id);
const g03 = { ids_unique: new Set(ids).size === ids.length && ids.length > 0 };

// ── Gate 04 — required fields (27) ────────────────────────────────────────────
const REQ = (cfg && Array.isArray(cfg.REQUIRED_CONTRACT_FIELDS)) ? cfg.REQUIRED_CONTRACT_FIELDS : [];
const missingFields = [];
for (const c of CONTRACTS) for (const f of REQ) if (!Object.prototype.hasOwnProperty.call(c, f) || c[f] === undefined) missingFields.push(c.id + ':' + f);
const g04 = {
  required_fields_count_27: REQ.length === 27,
  every_contract_has_all_fields: CONTRACTS.length > 0 && missingFields.length === 0,
};

// ── Gate 05 — valid enums + all 12 action classes present ─────────────────────
const present = new Set(CONTRACTS.map((c) => c.action_class));
const g05 = {
  action_classes_valid: !!cfg && CONTRACTS.length > 0 && CONTRACTS.every((c) => cfg.ALLOWED_ACTION_CLASSES.includes(c.action_class)),
  all_12_classes_present: EXPECTED_CLASSES.every((cl) => present.has(cl)) && present.size === 12,
  risk_levels_valid: !!cfg && CONTRACTS.length > 0 && CONTRACTS.every((c) => cfg.ALLOWED_RISK_LEVELS.includes(c.risk_level)),
  status_valid: !!cfg && CONTRACTS.length > 0 && CONTRACTS.every((c) => cfg.ALLOWED_STATUSES.includes(c.status)),
  proof_valid: !!cfg && CONTRACTS.length > 0 && CONTRACTS.every((c) => cfg.ALLOWED_PROOF_LEVELS.includes(c.proof_level)),
  approval_modes_valid: !!cfg && CONTRACTS.length > 0 && CONTRACTS.every((c) => cfg.ALLOWED_APPROVAL_MODES.includes(c.approval_mode)),
  effect_types_valid: !!cfg && CONTRACTS.length > 0 && CONTRACTS.every((c) => cfg.ALLOWED_EXTERNAL_EFFECT_TYPES.includes(c.external_effect_type)),
  validate_ok: validateRes.ok === true,
};

// ── Gate 06 — approval-required consistency ───────────────────────────────────
const g06 = {
  read_only_not_required: !!byClass.read_only_analysis && byClass.read_only_analysis.approval_required === false && byClass.read_only_analysis.approval_mode === 'none',
  all_others_required: CONTRACTS.length > 0 && CONTRACTS.filter((c) => c.action_class !== 'read_only_analysis').every((c) => c.approval_required === true),
  required_has_real_mode: CONTRACTS.length > 0 && CONTRACTS.every((c) => c.approval_required === false || c.approval_mode !== 'none'),
};

// ── Gate 07 — minimum-approver consistency ────────────────────────────────────
const g07 = {
  required_min_ge_1: CONTRACTS.length > 0 && CONTRACTS.every((c) => c.approval_required === false || c.minimum_approvers >= 1),
  not_required_zero: CONTRACTS.length > 0 && CONTRACTS.every((c) => c.approval_required === true || c.minimum_approvers === 0),
  dual_min_ge_2: CONTRACTS.length > 0 && CONTRACTS.every((c) => c.approval_mode !== 'dual_human' || c.minimum_approvers >= 2),
};

// ── Gate 08 — allowed-role consistency ────────────────────────────────────────
const g08 = {
  roles_in_enum: !!cfg && CONTRACTS.length > 0 && CONTRACTS.every((c) => Array.isArray(c.allowed_approver_roles) && c.allowed_approver_roles.every((r) => cfg.ALLOWED_APPROVER_ROLES.includes(r))),
  required_has_roles: CONTRACTS.length > 0 && CONTRACTS.every((c) => c.approval_required === false || c.allowed_approver_roles.length >= 1),
  not_required_no_roles: CONTRACTS.length > 0 && CONTRACTS.every((c) => c.approval_required === true || c.allowed_approver_roles.length === 0),
};

// ── Gate 09 — separation-of-duties consistency ────────────────────────────────
const g09 = {
  sod_requires_two: CONTRACTS.length > 0 && CONTRACTS.every((c) => c.separation_of_duties_required === false || c.minimum_approvers >= 2),
};

// ── Gate 10 — evidence-required consistency ───────────────────────────────────
const g10 = {
  read_only_no_evidence: !!byClass.read_only_analysis && byClass.read_only_analysis.evidence_required === false,
  all_others_evidence: CONTRACTS.length > 0 && CONTRACTS.filter((c) => c.action_class !== 'read_only_analysis').every((c) => c.evidence_required === true),
};

// ── Gate 11 — audit-required consistency (all true) ───────────────────────────
const g11 = { all_audit_required: CONTRACTS.length > 0 && CONTRACTS.every((c) => c.audit_required === true) };

// ── Gate 12 — reference integrity (packs/agents/workflows) + no orphans ───────
const badPack = [], badAgent = [], badWf = [];
for (const c of CONTRACTS) {
  for (const p of (c.related_packs || [])) if (!packIds.has(p)) badPack.push(c.id + ':' + p);
  for (const a of (c.related_agents || [])) if (!agentIds.has(a)) badAgent.push(c.id + ':' + a);
  for (const w of (c.related_workflows || [])) if (!wfIds.has(w)) badWf.push(c.id + ':' + w);
}
const g12 = {
  packs_valid: CONTRACTS.length > 0 && badPack.length === 0,
  agents_valid: CONTRACTS.length > 0 && badAgent.length === 0,
  workflows_valid: CONTRACTS.length > 0 && badWf.length === 0,
  no_orphans: badPack.length === 0 && badAgent.length === 0 && badWf.length === 0,
};

// ── Gates 13–17 — all safety counts zero (raw + summary) ──────────────────────
const rawExec = CONTRACTS.filter((c) => c.execution_allowed === true).length;
const rawActiv = CONTRACTS.filter((c) => c.activation_allowed === true).length;
const rawProd = CONTRACTS.filter((c) => c.production_allowed === true).length;
const rawExt = CONTRACTS.filter((c) => c.external_send_allowed === true).length;
const rawAuto = CONTRACTS.filter((c) => c.automatic_approval_allowed === true).length;
const g13 = { exec_zero_raw: CONTRACTS.length > 0 && rawExec === 0, exec_zero_summary: !!summary && summary.execution_allowed_count === 0 };
const g14 = { activation_zero_raw: CONTRACTS.length > 0 && rawActiv === 0, activation_zero_summary: !!summary && summary.activation_allowed_count === 0 };
const g15 = { production_zero_raw: CONTRACTS.length > 0 && rawProd === 0, production_zero_summary: !!summary && summary.production_allowed_count === 0 };
const g16 = { external_send_zero_raw: CONTRACTS.length > 0 && rawExt === 0, external_send_zero_summary: !!summary && summary.external_send_allowed_count === 0 };
const g17 = { auto_approval_zero_raw: CONTRACTS.length > 0 && rawAuto === 0, auto_approval_zero_summary: !!summary && summary.automatic_approval_allowed_count === 0 };

// ── Gate 18/19 — production sync + deployment change BLOCKED ───────────────────
const ps = byClass.production_sync || null;
const dc = byClass.deployment_change || null;
const g18 = { present: !!ps, blocked_mode: !!ps && ps.approval_mode === 'blocked', disabled_status: !!ps && ps.status === 'disabled', not_executable: !!ps && ps.execution_allowed === false && ps.production_allowed === false };
const g19 = { present: !!dc, blocked_mode: !!dc && dc.approval_mode === 'blocked', disabled_status: !!dc && dc.status === 'disabled', not_executable: !!dc && dc.execution_allowed === false };

// ── Gate 20 — policy override cannot auto-approve (human + SoD) ────────────────
const po = byClass.policy_override || null;
const g20 = {
  present: !!po,
  no_auto_approval: !!po && po.automatic_approval_allowed === false,
  requires_human: !!po && po.approval_required === true && po.approval_mode === 'dual_human',
  separation_of_duties: !!po && po.separation_of_duties_required === true && po.minimum_approvers >= 2,
};

// ── Gate 21 — high-risk classes require approval ──────────────────────────────
const g21 = {
  external_communication_requires: !!byClass.external_communication && byClass.external_communication.approval_required === true,
  financial_commitment_requires: !!byClass.financial_commitment && byClass.financial_commitment.approval_required === true,
  customer_data_export_requires: !!byClass.customer_data_export && byClass.customer_data_export.approval_required === true,
  business_record_mutation_requires: !!byClass.business_record_mutation && byClass.business_record_mutation.approval_required === true,
};

// ── Gate 22 — route safety ────────────────────────────────────────────────────
const PB_START = src.server.indexOf('BEGIN ATLAS ACTION APPROVAL (Phase 2C.30)');
const PB_END = PB_START > -1 ? src.server.indexOf('END ATLAS ACTION APPROVAL (Phase 2C.30)', PB_START) : -1;
const aaBlock = (PB_START > -1 && PB_END > -1) ? src.server.slice(PB_START, PB_END) : '';
const writeVerb = /app\.(post|put|patch|delete)\s*\(\s*['"]\/api\/atlas\/action-approvals/i.test(src.server);
const decideRoute = /app\.\w+\s*\(\s*['"]\/api\/atlas\/action-approvals[^'"]*\/(approve|reject|request|decide|execute|activate|send|sync|deploy)/i.test(src.server);
const flagIdx = aaBlock.indexOf('atlas_action_approval_api_enabled');
const buildIdx = aaBlock.indexOf('buildAtlasActionApprovalTruth(');
const g22 = {
  route_present: aaBlock.length > 0,
  no_write_verb_route: !writeVerb,
  no_decide_route: !decideRoute,
  get_endpoints_present: aaBlock.length === 0 || (/app\.get\(\s*'\/api\/atlas\/action-approvals'/.test(aaBlock) && /app\.get\(\s*'\/api\/atlas\/action-approvals\/:id'/.test(aaBlock)),
  auth_before_flag: aaBlock.length === 0 || (/app\.get\(\s*'\/api\/atlas\/action-approvals'\s*,\s*authMiddleware/.test(aaBlock) && /action-approvals\/:id'\s*,\s*authMiddleware/.test(aaBlock)),
  flag_gated_404: aaBlock.length === 0 || (flagIdx > -1 && aaBlock.includes('status(404)')),
  flag_before_build: aaBlock.length === 0 || (flagIdx > -1 && buildIdx > -1 && flagIdx < buildIdx),
  no_db_exec_in_block: aaBlock.length === 0 || !/getPool|pool\.query|supabase|\bneon\b|production_sync|external_send|\.execute\(|activate\(/i.test(aaBlock),
};

// ── Gate 23 — feature flag default OFF ────────────────────────────────────────
let flagOff = false;
try { flagOff = require(path.join(ROOT, GUARD_FILES.flags)).isEnabled('atlas_action_approval_api_enabled') === false; } catch (e) {}
const defaultOnCount = (src.flags.match(/!==\s*'false'/g) || []).length;
const g23 = {
  flag_name_present: /atlas_action_approval_api_enabled/.test(src.flags) && /FEATURE_ATLAS_ACTION_APPROVAL_API_ENABLED/.test(src.flags),
  flag_default_off_source: /atlas_action_approval_api_enabled\s*:\s*process\.env\.FEATURE_ATLAS_ACTION_APPROVAL_API_ENABLED\s*===\s*'true'/.test(src.flags),
  flag_default_off_runtime: flagOff === true,
  only_prompt_guard_default_on: defaultOnCount === 1 && /prompt_guard_enabled\s*:\s*process\.env\.FEATURE_PROMPT_GUARD_ENABLED\s*!==\s*'false'/.test(src.flags),
};

// ── Gate 24 — purity (config + service) ───────────────────────────────────────
const PURITY = [
  /require\(\s*['"]pg['"]\s*\)/, /supabase/i, /createClient/, /\bfetch\s*\(/, /axios/i, /https?\.request/,
  /child_process/, /\bexec\s*\(/, /\bspawn\s*\(/, /writeFileSync|writeFile\b|appendFile|\bunlink\b/,
  /process\.env/, /setInterval|setTimeout/, /node-cron|cron\./i, /\.listen\s*\(/,
];
const purityHits = [];
for (const [t, text] of Object.entries({ config: src.config, service: src.service })) for (const re of PURITY) if (re.test(text)) purityHits.push(t + ':' + re.source);
const g24 = { config_service_pure: purityHits.length === 0 };

// ── Gate 25 — no operational/granted/execution-after-approval claim ───────────
// Structural truth booleans + doc markers + CLAUSE-LOCAL affirmative-claim scan.
// TRUE clause-local boundaries (Codex blocker): comma, semicolon, colon, '!', '?',
// pipe, em-dash, double-hyphen, NEWLINE, and a SENTENCE-ending period (period followed
// by whitespace — so version tokens like "2C.30"/".js" are NOT split). Newlines are NOT
// pre-collapsed into one window; scope from a previous/following clause cannot bleed.
function clauses(text) {
  return String(text)
    .split(/\s*[,;:!?|]\s*|\s*—\s*|\s*--\s*|\r?\n|(?<=\.)\s+/)
    .map((c) => c.toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((c) => c.length > 0);
}
// Coarser clause split for the AFFIRMATIVE scan ONLY: collapse whitespace, split on
// sentence-period / semicolon / pipe (NOT comma/colon). This keeps array/field tokens
// (e.g. BLOCKED_ACTIONS items, "*_by_this_phase: false" fields) together with their
// negation/scope context. The strict comma/colon/em-dash/newline boundaries are used
// ONLY by the negative-overclaim gate (gate 30) via clauses().
function clausesCoarse(text) {
  return String(text).replace(/\s+/g, ' ').split(/\s*[;|]\s*|(?<=\.)\s+/)
    .map((c) => c.toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim()).filter((c) => c.length > 0);
}
const CLAIM_PHRASES = [
  'approval granted', 'approval has been granted', 'approvals granted', 'human approval granted',
  'approval queue is live', 'approval queue is operational', 'approval queue operational',
  'ready to execute', 'action ready to execute', 'executes after approval', 'execute after approval',
  'human in the loop is live', 'human in the loop enforcement is live',
];
const CLAIM_SAFE = /\b(no|not|never|without|false|blocked|absent|zero|disabled|does not|cannot)\b|: no\b|no_/i;
const claimHits = [];
for (const [t, text] of Object.entries({ config: src.config, service: src.service, doc: src.doc })) {
  for (const cl of clausesCoarse(text)) {
    for (const p of CLAIM_PHRASES) {
      if (cl.indexOf(p) !== -1 && !CLAIM_SAFE.test(cl)) claimHits.push(t + ':' + p);
    }
  }
}
const docMarker = (re) => { const m = src.doc.match(re); return m ? m[1] : null; };
const pscope = truth && truth.phase_scope ? truth.phase_scope : null;
const g25 = {
  truth_phase_scope_present: !!pscope && pscope.phase === '2C.30' && pscope.contract_registry_only === true,
  truth_no_records_this_phase: !!pscope && pscope.approval_records_created_by_this_phase === false,
  truth_no_queue_this_phase: !!pscope && pscope.approval_queue_operated_by_this_phase === false,
  truth_no_human_approval_this_phase: !!pscope && pscope.human_approval_granted_by_this_phase === false,
  truth_no_exec_after_approval_this_phase: !!pscope && pscope.execution_after_approval_enabled_by_this_phase === false,
  // the ambiguous platform-wide field names must NOT exist on the truth object
  truth_no_ambiguous_global_fields: !!truth && !('approval_records_exist' in truth) && !('approval_queue_operational' in truth) && !('human_approval_granted' in truth) && !('execution_occurs_after_approval' in truth),
  doc_marks_records_scoped_no: docMarker(/^APPROVAL_RECORDS_CREATED_BY_PHASE_2C_30:\s*(yes|no)\s*$/im) === 'no',
  doc_marks_queue_scoped_no: docMarker(/^APPROVAL_QUEUE_OPERATED_BY_PHASE_2C_30:\s*(yes|no)\s*$/im) === 'no',
  doc_marks_granted_scoped_no: docMarker(/^HUMAN_APPROVAL_GRANTED_BY_PHASE_2C_30:\s*(yes|no)\s*$/im) === 'no',
  doc_marks_exec_after_scoped_no: docMarker(/^EXECUTION_AFTER_APPROVAL_ENABLED_BY_PHASE_2C_30:\s*(yes|no)\s*$/im) === 'no',
  no_affirmative_claim: claimHits.length === 0,
};

// ── Gate 26 — prior 2C.21–2C.29 conservatism ─────────────────────────────────
let packSum = null, wfSum = null, agentSum = null, graphSum = null, rtLP = null, rtLL = null, priorErr = null;
try {
  packSum = require(path.join(ROOT, GUARD_FILES.pack_service)).summarizeAtlasPackRegistry();
  wfSum = require(path.join(ROOT, GUARD_FILES.wf_service)).summarizeAtlasWorkflowRegistry();
  agentSum = require(path.join(ROOT, GUARD_FILES.agent_service)).summarizeAtlasAgentRegistry();
  graphSum = require(path.join(ROOT, GUARD_FILES.graph_service)).summarizeAtlasRelationshipGraph();
  const rt = require(path.join(ROOT, GUARD_FILES.rt_service)).buildRuntimeTruth({ generatedAt: '2026-01-01T00:00:00.000Z' });
  rtLP = rt && rt.summary ? rt.summary.live_proven : null;
  rtLL = rt && rt.summary ? rt.summary.live_limited : null;
} catch (e) { priorErr = String(e && e.message ? e.message : e); }
const c23Ga = (src.doc23.match(/^GA_READY:\s*(yes|no)\s*$/im) || [])[1] || null;
const c23Canary = (src.doc23.match(/^PRODUCTION_CANARY_READY:\s*(yes|no)\s*$/im) || [])[1] || null;
const c24Canary = (src.doc24.match(/^CANARY_READY:\s*(yes|no)\s*$/im) || [])[1] || null;
const c25Owner = (src.doc25.match(/^owner_approval_record_present:\s*(true|false)\s*$/im) || [])[1] || null;
const c25Scope = (src.doc25.match(/^canary_scope_record_present:\s*(true|false)\s*$/im) || [])[1] || null;
const g26 = {
  pack_conservative: !!packSum && packSum.live_proven_count === 0 && packSum.execution_allowed_count === 0 && packSum.activation_allowed_count === 0,
  workflow_conservative: !!wfSum && wfSum.live_proven_count === 0 && wfSum.execution_allowed_count === 0,
  agent_conservative: !!agentSum && agentSum.live_proven_count === 0 && agentSum.live_limited_count === 1 && agentSum.production_allowed_count === 0,
  graph_conservative: !!graphSum && graphSum.actual_node_count === 59 && graphSum.execution_allowed_edge_count === 0 && graphSum.production_allowed_edge_count === 0,
  rt_live_proven_zero: priorErr === null && rtLP === 0,
  rt_live_limited_two: priorErr === null && rtLL === 2,
  c23_ga_no: c23Ga === 'no', c23_canary_no: c23Canary === 'no', c24_canary_no: c24Canary === 'no',
  c25_owner_absent: c25Owner === 'false', c25_scope_absent: c25Scope === 'false',
};

// ── Gate 27 — no secrets / PII ────────────────────────────────────────────────
const VALUE_PATTERNS = [
  /postgres(?:ql)?:\/\//i, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /\bbearer\s+[A-Za-z0-9._-]{12,}/i,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, /\b\d{10,}\b/, /\+\d[\d -]{8,}\d/,
  /\b(?:sk|rk|pk|rzp)_live_[A-Za-z0-9]{4,}/i, /\bsk-[A-Za-z0-9]{16,}/, /BEGIN [A-Z ]*PRIVATE KEY/,
];
const piiHits = [];
for (const [t, text] of Object.entries({ config: src.config, service: src.service, doc: src.doc })) for (const re of VALUE_PATTERNS) if (re.test(text)) piiHits.push(t + ':' + re.source);
const checkerSrc = read(GUARD_FILES.checker);
const checkerSecret = [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, /postgres(?:ql)?:\/\/[A-Za-z0-9]/, /\b(?:sk|rk|pk|rzp)_live_[A-Za-z0-9]{8,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/].filter((re) => re.test(checkerSrc)).length;
const g27 = { config_service_doc_free_of_pii: piiHits.length === 0, checker_free_of_secret_literals: checkerSecret === 0 };

// ── Gate 28 — declared path scope (backend-only, no DB/migration) ─────────────
const g28 = {
  declared_files_exist: PHASE_TOUCHED.every((p) => exists(p)),
  no_env_file: !PHASE_TOUCHED.some((p) => /\.env(\.|$)/.test(p)),
  no_railway_file: !PHASE_TOUCHED.some((p) => /railway\.toml|nixpacks\.toml|Procfile/i.test(p)),
  no_frontend_file: !PHASE_TOUCHED.some((p) => /frontend|vercel|next\.config/i.test(p)),
  no_deploy_file: !PHASE_TOUCHED.some((p) => /\.github\/workflows|deploy/i.test(p)),
  no_migration_sql_db: !PHASE_TOUCHED.some((p) => /(^|\/)migrations\//i.test(p) || /\.sql$/i.test(p) || /(^|\/)db\//i.test(p)),
  backend_paths_only: PHASE_TOUCHED.every((p) => /^(lib\/|scripts\/|docs\/|server\.js$)/.test(p)),
};

// ── Gate 30 — NO UNSCOPED NEGATIVE OPERATIONAL OVERCLAIM (Codex blocker) ───────
// A NEGATIVE claim about approval/action records, approval queues, human approvals,
// approval enforcement, or execution-after-approval is SAFE only when the SAME clause
// explicitly scopes it to Phase 2C.30 (this phase/registry/contract). A scope phrase in
// another clause never sanitizes a global statement. Scans the changed truth-carrying
// files (service + doc); the checker source itself is NOT scanned (it holds the patterns).
const NEG_SUBJECT = /\bapproval records?\b|\baction records?\b|\bapproval queue\b|\bhuman approvals?\b|\bapproval enforcement\b|\bexecution[ ]after[ ]approval\b/i;
const NEG_NEGATOR = /(?:^|[^a-z])(?:no|not|never|none|cannot|without|zero|nonexistent|non existent|absent|false|neither|nor)(?:[^a-z]|$)|\bdoes not\b|\bdo not\b|\bhas no\b|\bhave no\b|\bthere (?:is|are) no\b|no_/i;
const SCOPE_TOKEN = /phase 2c.?30|this phase|this registry|this contract|read only contract|introduced by this phase|created by this phase|operated by this phase|by this (?:phase|registry|contract)|by phase 2c.?30/i;
function negativeOverclaims(text) {
  const v = [];
  for (const cl of clauses(text)) {
    if (NEG_SUBJECT.test(cl) && NEG_NEGATOR.test(cl) && !SCOPE_TOKEN.test(cl)) v.push(cl.slice(0, 90));
  }
  return v;
}
const negService = negativeOverclaims(src.service);
const negDoc = negativeOverclaims(src.doc);
const g30 = {
  service_no_unscoped_negative: negService.length === 0,
  doc_no_unscoped_negative: negDoc.length === 0,
  // belt-and-braces: the ambiguous platform-wide field NAMES must not appear in service source
  service_no_ambiguous_field_names: !/approval_records_exist\b|approval_queue_operational\b|human_approval_granted\b(?!_)|execution_occurs_after_approval\b/.test(src.service),
};

// ── Gate 31 — LEGACY COMPATIBILITY acknowledged + INDEPENDENTLY confirmed ─────
// The doc must acknowledge the pre-existing AI Action Center + ai_actions remain separate
// and unchanged; AND the checker independently confirms those legacy artifacts truly exist
// (route in server.js, ai_actions in a migration) — not documentation self-attestation.
const legacyRouteExists = /app\.(?:get|post|patch|put|delete)\s*\(\s*['"]\/api\/ai-actions/i.test(src.server);
const migrationFiles = ['migrations/001_cortex_foundation.sql', 'migrations/003_evaluation.sql', 'migrations/005_cortex_x_extensions.sql', 'migrations/002_cortex_extension.sql'];
const legacyTableExists = migrationFiles.some((p) => /ai_actions/i.test(read(p)));
const docAck = src.doc.toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ');
const ackHasCenter = /ai action center/.test(docAck);
const ackHasTable = /ai actions/.test(docAck);
const ackHasSeparate = /remain separate and unchanged by phase 2c.?30/.test(docAck);
const g31 = {
  legacy_route_exists_in_repo: legacyRouteExists,
  legacy_table_exists_in_repo: legacyTableExists,
  doc_acknowledges_center: ackHasCenter,
  doc_acknowledges_table: ackHasTable,
  doc_acknowledges_separate_unchanged: ackHasSeparate,
};

// ── Gate 32 — SEPARATION-OF-DUTIES role diversity (Codex blocker) ─────────────
// For every contract with separation_of_duties_required === true, the launch-minimum
// invariant is: approval_required, minimum_approvers >= 2, a non-empty role list, and at
// least TWO DISTINCT eligible HUMAN approver-role classes (duplicates collapse to one;
// non-human/system/agent/model/ai/policy_guard/automation/service identifiers do NOT
// count). This is contract metadata only — it does not prove live identity enforcement.
const NON_HUMAN_ROLE = /^(?:system|agent|model|ai|policy_guard|automation|service|bot|llm|machine)$/i;
const sodMissingApproval = [];
const sodInsufficientApprovers = [];
const sodInsufficientHumanRoles = [];
for (const c of CONTRACTS) {
  if (c.separation_of_duties_required !== true) continue;
  const roles = Array.isArray(c.allowed_approver_roles) ? c.allowed_approver_roles : [];
  const humanRoles = new Set(roles.map((r) => String(r).trim().toLowerCase()).filter((r) => r.length > 0 && !NON_HUMAN_ROLE.test(r)));
  if (!(c.approval_required === true)) sodMissingApproval.push(c.id);
  if (!(typeof c.minimum_approvers === 'number' && c.minimum_approvers >= 2)) sodInsufficientApprovers.push(c.id);
  if (!(roles.length > 0 && humanRoles.size >= 2)) sodInsufficientHumanRoles.push(c.id);
}
const sodContracts = CONTRACTS.filter((c) => c.separation_of_duties_required === true);
const g32 = {
  sod_contracts_present: sodContracts.length > 0,
  sod_requires_approval: sodMissingApproval.length === 0,
  sod_requires_two_approvers: sodInsufficientApprovers.length === 0,
  sod_requires_two_distinct_human_roles: sodInsufficientHumanRoles.length === 0,
};

// ── MUTATION GUARD ────────────────────────────────────────────────────────────
const HASH_AFTER = {};
for (const [k, rel] of Object.entries(GUARD_FILES)) HASH_AFTER[k] = sha256(rel);
const mutated = Object.keys(GUARD_FILES).filter((k) => HASH_BEFORE[k] === null || HASH_AFTER[k] === null || HASH_BEFORE[k] !== HASH_AFTER[k]);
const g29 = { all_hashes_captured: Object.values(HASH_BEFORE).every((h) => typeof h === 'string'), files_unchanged_during_run: mutated.length === 0 };

const GATES = {
  '01_assets_exist': g01, '02_registry_non_empty': g02, '03_unique_ids': g03, '04_required_fields': g04,
  '05_valid_enums_all_classes': g05, '06_approval_required_consistency': g06, '07_minimum_approver_consistency': g07,
  '08_allowed_role_consistency': g08, '09_separation_of_duties_consistency': g09, '10_evidence_required_consistency': g10,
  '11_audit_required_consistency': g11, '12_reference_integrity': g12, '13_execution_allowed_zero': g13,
  '14_activation_allowed_zero': g14, '15_production_allowed_zero': g15, '16_external_send_allowed_zero': g16,
  '17_automatic_approval_zero': g17, '18_production_sync_blocked': g18, '19_deployment_change_blocked': g19,
  '20_policy_override_no_auto_approve': g20, '21_high_risk_requires_approval': g21, '22_route_safe': g22,
  '23_feature_flag_default_off': g23, '24_purity_no_side_effects': g24, '25_no_operational_or_granted_claim': g25,
  '26_prior_phase_conservatism': g26, '27_no_secrets_pii': g27, '28_declared_path_scope': g28,
  '29_mutation_guard': g29,
  '30_no_unscoped_negative_overclaim': g30, '31_legacy_compatibility_acknowledged': g31,
  '32_separation_of_duties_role_diversity': g32,
};
const gate_results = {};
let gates_passed = 0;
for (const [name, checks] of Object.entries(GATES)) { const pass = all(checks); if (pass) gates_passed++; gate_results[name] = { pass, checks }; }
const gates_total = Object.keys(GATES).length;
const overall_pass = loadError === null && truth !== null && gates_passed === gates_total;

const result = {
  overall_pass, gates_passed, gates_total,
  action_approval_version: truth ? truth.action_approval_version : null,
  summary: summary ? {
    contracts_total: summary.contracts_total, approval_required_count: summary.approval_required_count,
    no_approval_required_count: summary.no_approval_required_count, blocked_count: summary.blocked_count,
    separation_of_duties_count: summary.separation_of_duties_count,
    execution_allowed_count: summary.execution_allowed_count, activation_allowed_count: summary.activation_allowed_count,
    production_allowed_count: summary.production_allowed_count, external_send_allowed_count: summary.external_send_allowed_count,
    automatic_approval_allowed_count: summary.automatic_approval_allowed_count,
    by_action_class: summary.by_action_class, by_risk_level: summary.by_risk_level, by_approval_mode: summary.by_approval_mode,
  } : null,
  route_present: aaBlock.length > 0,
  prior_markers: { rt_live_proven: rtLP, rt_live_limited: rtLL, c23_ga: c23Ga, c23_canary: c23Canary, c24_canary: c24Canary, c25_owner: c25Owner, c25_scope: c25Scope },
  load_error: loadError, prior_error: priorErr,
  missing_required_fields: missingFields, bad_pack_refs: badPack, bad_agent_refs: badAgent, bad_workflow_refs: badWf,
  validate_offenders: validateRes.offenders || {}, purity_violations: purityHits, pii_hits: piiHits, affirmative_claim_hits: claimHits,
  unscoped_negative_overclaims_service: negService, unscoped_negative_overclaims_doc: negDoc,
  sod_role_diversity_violations: sodInsufficientHumanRoles, sod_approver_count_violations: sodInsufficientApprovers,
  files_mutated_by_check: mutated,
  informational_only_not_a_pass_condition: {
    note: 'Display-only, never part of overall_pass. Derived from declared scope (g28) + purity/secret scans (g24/g27) + mutation guard (g29); ACTUAL working-tree scope verified externally via git status/diff.',
    production_touched: (g28.backend_paths_only && g29.files_unchanged_during_run) ? false : null,
    db_or_migration_changed: g28.no_migration_sql_db ? false : null,
    frontend_touched: g28.no_frontend_file ? false : null,
    env_files_changed: g28.no_env_file ? false : null,
    railway_touched: g28.no_railway_file ? false : null,
    deploy_triggered: g28.no_deploy_file ? false : null,
    secrets_exposed: (g27.config_service_doc_free_of_pii && g27.checker_free_of_secret_literals) ? false : null,
    execution_enabled: (g13.exec_zero_raw && g13.exec_zero_summary) ? false : null,
    automatic_approval_enabled: (g17.auto_approval_zero_raw && g17.auto_approval_zero_summary) ? false : null,
    operational_approval_queue_or_granted_claim_by_this_phase: (g25.truth_no_queue_this_phase && g25.truth_no_human_approval_this_phase && g25.no_affirmative_claim) ? false : null,
    unscoped_global_negative_overclaim: (g30.service_no_unscoped_negative && g30.doc_no_unscoped_negative) ? false : null,
    legacy_ai_action_center_acknowledged_separate: (g31.doc_acknowledges_center && g31.doc_acknowledges_separate_unchanged) ? true : null,
  },
  gate_results,
};
if (!overall_pass) {
  result._note = 'FAIL-CLOSED: one or more Action Approval gates unmet. This registry must remain a static, read-only approval-REQUIREMENT model — it must never grant/record/queue approvals, never execute, never auto-approve, and never claim a live approval queue or granted approval. Actions become approvable/runnable ONLY through a future, separately-approved phase with explicit owner approval and real production-access proofs.';
}
console.log('ACTION_APPROVAL_JSON:' + JSON.stringify(result, null, 1));
process.exit(overall_pass ? 0 : 1);
