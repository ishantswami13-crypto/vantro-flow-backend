// FILE: scripts/phase-2c-31-pilot-contract-check.js
// ─────────────────────────────────────────────────────────────────────────────
// Phase 2C.31 — Founding Pilot Launch-Profile & Evidence-Contract checker.
//
// INDEPENDENT PROOF. This checker derives truth from the canonical committed source
// registries (Phase 2C.26 Packs, 2C.27 Workflows, 2C.28 Agents, 2C.30 Action
// Approval) and from the raw file TEXT of the profile + doc. It does NOT trust the
// profile's own booleans or the documentation's declarations. The final PASS is only
// reachable after every one of the 42 independent gates passes.
//
// READ-ONLY. This checker reads files and registries; it opens no DB/network/process
// and writes no file. The mutation matrix runs against TEMPORARY copies via the
// test-only --profile / --doc overrides (default = the canonical committed files).
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── paths (test-only overrides; default = canonical committed files) ────────────
function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const PROFILE_PATH = path.resolve(argVal('--profile') || path.join(__dirname, '..', 'lib', 'config', 'atlasLaunchProfiles.js'));
const DOC_PATH = path.resolve(argVal('--doc') || path.join(__dirname, '..', 'docs', 'agent-mesh', 'phase-2c-31-founding-pilot-contract.md'));
const CHECKER_PATH = __filename;

// canonical registries are ALWAYS the committed worktree ones (never overridable)
const PACK_REG = path.join(__dirname, '..', 'lib', 'config', 'atlasPackRegistry.js');
const AGENT_REG = path.join(__dirname, '..', 'lib', 'config', 'atlasAgentRegistry.js');
const WF_REG = path.join(__dirname, '..', 'lib', 'config', 'atlasWorkflowRegistry.js');
const AA_REG = path.join(__dirname, '..', 'lib', 'config', 'atlasActionApprovalRegistry.js');

const EXPECTED_GATE_COUNT = 42;

// ── expected truth (mission contract) ───────────────────────────────────────────
const EXPECTED_PROFILE_ID = 'swami_founding_pilot_v1';
const EXPECTED_PACKS = [
  'global_core', 'trader_pack', 'business_type_distributor', 'business_size_smb',
  'industry_wholesale_distribution', 'region_india', 'role_owner',
];
const EXPECTED_HOOK_IDS = ['daily_owner_briefing', 'collections_copilot', 'smart_reorder'];
const REQ_SCHEMA_KEYS = [
  'finding', 'business_impact', 'priority', 'evidence_ids', 'provenance_source_ids',
  'source_freshness', 'confidence', 'prepared_next_action', 'approval_requirement', 'safe_to_show_decision',
];

// status / proof comparison ranks (unknown → high so comparisons fail closed)
const STATUS_RANK = {
  not_implemented: 0, none: 0, roadmap: 0, disabled: 0,
  connector_required: 1, custom_required: 1, partner_required: 1,
  preview: 2, live_limited: 3, live_proven: 4,
};
const PROOF_RANK = { none: 0, design_contract: 1, staging_proven: 2, production_canary: 3, live_proven: 4 };
const rank = (s) => (Object.prototype.hasOwnProperty.call(STATUS_RANK, s) ? STATUS_RANK[s] : 99);
const prank = (s) => (Object.prototype.hasOwnProperty.call(PROOF_RANK, s) ? PROOF_RANK[s] : 99);

// ── overclaim phrases (scanned in profile+doc TEXT only; negation-aware) ────────
const OVERCLAIM_PHRASES = [
  'connects real business data', 'connect real business data',
  'forces the evaluator', 'force the evaluator', 'evaluator is enforced',
  'execution layer', 'foundational read-only execution layer',
  'operational copilot', 'data is connected',
  'backend supports all three hooks', 'all three hooks are live',
  'pilot ready', 'pilot-ready', 'pilot_ready',
  'production ready', 'production-ready', 'production_ready',
  'live ready', 'live-ready', 'acceptance ready', 'acceptance-ready',
  'ready for staging seed', 'ready for staging load', 'ready for seed', 'staging seed',
];
const NEGATIONS = [
  'no ', 'not ', 'never', "n't", 'without', 'zero ', 'false', 'blocked', 'disabled',
  'no_', 'cannot', 'does not', 'is not', 'are not', 'shape is not',
];

// ── PII / secret patterns (scanned in profile+doc TEXT only) ────────────────────
const PII_PATTERNS = [
  { name: 'email', re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i },
  { name: 'long_digit_run', re: /\d{10,}/ },
  { name: 'phone_like', re: /(?:\+?\d[\s-]?){10,}/ },
  { name: 'currency_amount', re: /(?:₹|\binr\b|\brs\.?\b|\$)\s?[\d,]{3,}/i },
];

// ── forbidden runtime tokens (built by concatenation so this file never contains ─
//    the contiguous token itself → scanning the checker never self-matches) ──────
const FORBIDDEN_RUNTIME = [
  'child' + '_process', 'spa' + 'wn(', 'exe' + 'cSync', 'exe' + 'c(',
  'write' + 'FileSync', 'append' + 'FileSync', 'write' + 'File(', 'create' + 'WriteStream',
  "require('h" + "ttp')", "require('h" + "ttps')", "require('n" + "et')", "require('d" + "gram')",
  "require('p" + "g')", "require('m" + "ysql')", 'supa' + 'base', 'DATA' + 'BASE_URL',
  'fet' + 'ch(', '.que' + 'ry(', '.conn' + 'ect(', 'process.' + 'env', '.writeF' + 'ileSync',
];
const FORBIDDEN_SELF_KEYS = new Set([
  'checker_pass', 'self_certified', 'is_safe', 'verified_safe', 'pilot_ready',
  'approved', 'auto_approve', 'overall_pass', 'passed', 'certified', 'safe_certified',
]);

// ── helpers ──────────────────────────────────────────────────────────────────────
function readText(p) { return fs.readFileSync(p, 'utf8'); }
function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
function allTrue(arr, pred, minLen) {
  const m = typeof minLen === 'number' ? minLen : 1;
  return Array.isArray(arr) && arr.length >= m && arr.every(pred);
}
function clauses(text) {
  return String(text).toLowerCase().split(/[\n.,;:!?|#]|—|--/).map((s) => s.trim()).filter(Boolean);
}
function hasNeg(clause) { return NEGATIONS.some((n) => clause.includes(n)); }
function collectKeys(o, acc) {
  if (o && typeof o === 'object') {
    if (Array.isArray(o)) o.forEach((x) => collectKeys(x, acc));
    else Object.keys(o).forEach((k) => { acc.add(String(k).toLowerCase()); collectKeys(o[k], acc); });
  }
  return acc;
}
function actionByRole(h, role) { return ((h && h.actions) || []).find((a) => a.role === role); }

// ── load ──────────────────────────────────────────────────────────────────────
const results = [];
const add = (id, name, pass, detail) => results.push({ id, name, pass: pass === true, detail: detail || {} });

let loadError = null;
let pack, agent, wf, aa, profileMod, profile, profileText, docText, checkerText;
let packIds, packById, agentById, wfById, contractByClass, actionClasses;
let hooks, hookById, daily, collections, reorder;

try {
  pack = require(PACK_REG);
  agent = require(AGENT_REG);
  wf = require(WF_REG);
  aa = require(AA_REG);
  profileMod = require(PROFILE_PATH);
  profile = (profileMod.PROFILES && profileMod.PROFILES[0]) || profileMod.swami_founding_pilot_v1;
  profileText = readText(PROFILE_PATH);
  docText = readText(DOC_PATH);
  checkerText = readText(CHECKER_PATH);

  packById = Object.fromEntries(pack.PACKS.map((p) => [p.id, p]));
  packIds = new Set(Object.keys(packById));
  agentById = Object.fromEntries(agent.AGENTS.map((a) => [a.id, a]));
  wfById = Object.fromEntries(wf.WORKFLOWS.map((w) => [w.id, w]));
  contractByClass = Object.fromEntries(aa.CONTRACTS.map((c) => [c.action_class, c]));
  actionClasses = new Set(Object.keys(contractByClass));

  hooks = (profile && profile.hooks) || [];
  hookById = Object.fromEntries(hooks.map((h) => [h.id, h]));
  daily = hookById['daily_owner_briefing'];
  collections = hookById['collections_copilot'];
  reorder = hookById['smart_reorder'];
} catch (e) {
  loadError = String(e && e.message ? e.message : e);
}

// capability-claim helpers (registry-derived)
function claimsCapability(h) {
  return !!h && (h.implementation_status === 'implemented' || (h.capability_status && h.capability_status !== 'not_implemented'));
}
function capabilityProven(h) {
  if (!h || !h.canonical_agent_ref) return false;
  const a = agentById[h.canonical_agent_ref];
  if (!a || a.is_implemented !== true) return false;
  if (h.capability_status === 'live_proven') return false;
  if (rank(h.capability_status) > rank(a.status)) return false;
  if (prank(h.proof_level) > prank(a.proof_level)) return false;
  return true;
}
function notImplementedHookOk(h) {
  return !!h && h.canonical_agent_ref === null && h.capability_status === 'not_implemented' &&
    h.implementation_status === 'not_implemented' && h.proof_level === 'none';
}

const beforeHashes = { profile: null, doc: null, checker: null };

if (loadError) {
  // a load failure fails the whole run — push 42 failing gates so counts are explicit
  for (let i = 1; i <= EXPECTED_GATE_COUNT; i += 1) add('G' + String(i).padStart(2, '0'), 'load_error', false, { loadError });
} else {
  beforeHashes.profile = sha256(PROFILE_PATH);
  beforeHashes.doc = sha256(DOC_PATH);
  beforeHashes.checker = sha256(CHECKER_PATH);

  // G01 — exact Phase 2C.31 file scope assumptions
  add('G01', 'file_scope', fs.existsSync(PROFILE_PATH) && fs.existsSync(DOC_PATH) && fs.existsSync(CHECKER_PATH), {
    profile: fs.existsSync(PROFILE_PATH), doc: fs.existsSync(DOC_PATH), checker: fs.existsSync(CHECKER_PATH),
  });

  // G02 — exactly one launch profile
  add('G02', 'exactly_one_profile', Array.isArray(profileMod.PROFILES) && profileMod.PROFILES.length === 1 && !!profile,
    { count: Array.isArray(profileMod.PROFILES) ? profileMod.PROFILES.length : null });

  // G03 — exact profile id
  add('G03', 'exact_profile_id', !!profile && profile.id === EXPECTED_PROFILE_ID, { id: profile && profile.id });

  const reqPacks = (profile && profile.required_packs) || [];
  // G04 — exact required pack count = 7
  add('G04', 'pack_count_7', Array.isArray(reqPacks) && reqPacks.length === 7, { count: reqPacks.length });

  // G05 — exact required pack set (every expected present, all strings)
  const reqSet = new Set(reqPacks);
  add('G05', 'exact_pack_set', allTrue(reqPacks, (p) => typeof p === 'string', 7) &&
    EXPECTED_PACKS.every((p) => reqSet.has(p)) && reqSet.size === EXPECTED_PACKS.length, {});

  // G06 — no duplicate pack ids
  add('G06', 'no_duplicate_packs', Array.isArray(reqPacks) && reqPacks.length === new Set(reqPacks).size, {});

  // G07 — no additional pack ids (no id outside the expected set)
  add('G07', 'no_extra_packs', allTrue(reqPacks, (p) => EXPECTED_PACKS.includes(p), 7), {});

  // G08 — every required pack exists in canonical 2C.26 registry
  add('G08', 'packs_canonical', allTrue(reqPacks, (p) => packIds.has(p), 7), {});

  // G09 — source pack status not upgraded (string-only refs; no live_proven source)
  add('G09', 'pack_status_not_upgraded', allTrue(reqPacks, (p) => typeof p === 'string' && packById[p] && packById[p].status !== 'live_proven', 7), {});

  // G10 — source pack permissions not expanded (canonical exec/activation false)
  add('G10', 'pack_perms_not_expanded', allTrue(reqPacks, (p) => packById[p] && packById[p].execution_allowed === false && packById[p].activation_allowed === false, 7), {});

  // G11 — exactly three hook contracts
  add('G11', 'exactly_three_hooks', Array.isArray(hooks) && hooks.length === 3, { count: hooks.length });

  // G12 — exact hook ids
  const hookIds = hooks.map((h) => h && h.id);
  add('G12', 'exact_hook_ids', EXPECTED_HOOK_IDS.every((id) => hookIds.includes(id)) && hookIds.length === 3, { hookIds });

  // G13 — unique hook ids
  add('G13', 'unique_hook_ids', hookIds.length === new Set(hookIds).size && !hookIds.includes(undefined), {});

  // G14 — Daily Briefing canonical agent reference (== core.owner_briefing, implemented)
  add('G14', 'daily_agent_ref', !!daily && daily.canonical_agent_ref === 'core.owner_briefing' &&
    !!agentById['core.owner_briefing'] && agentById['core.owner_briefing'].is_implemented === true, {});

  // G15 — every non-null agent ref exists in 2C.28
  add('G15', 'agent_refs_canonical', allTrue(hooks, (h) => h.canonical_agent_ref === null || !!agentById[h.canonical_agent_ref], 3), {});

  // G16 — every non-null workflow ref exists in 2C.27 AND is agent-backed by the hook's agent
  add('G16', 'workflow_refs_canonical', allTrue(hooks, (h) => {
    if (h.canonical_workflow_ref === null) return true;
    const w = wfById[h.canonical_workflow_ref];
    return !!w && !!h.canonical_agent_ref && w.required_agents.includes(h.canonical_agent_ref);
  }, 3), {});

  // G17 — hook status does not exceed source agent/workflow truth
  add('G17', 'status_not_exceeding_source', allTrue(hooks, (h) => {
    if (h.canonical_agent_ref) return capabilityProven(h);
    return notImplementedHookOk(h);
  }, 3), {});

  // G18 — Collections capability not represented implemented when not proven
  add('G18', 'collections_not_overstated', !!collections && (claimsCapability(collections) ? capabilityProven(collections) : notImplementedHookOk(collections)), {
    claims: claimsCapability(collections), proven: capabilityProven(collections),
  });

  // G19 — Smart Reorder capability not represented implemented when not proven
  add('G19', 'reorder_not_overstated', !!reorder && (claimsCapability(reorder) ? capabilityProven(reorder) : notImplementedHookOk(reorder)), {
    claims: claimsCapability(reorder), proven: capabilityProven(reorder),
  });

  // G20 — every action class exists in 2C.30
  const allActions = hooks.flatMap((h) => (h.actions || []));
  add('G20', 'action_classes_canonical', allTrue(allActions, (a) => actionClasses.has(a.action_class), 1), {});

  // G21 — Daily Briefing analysis maps to read_only_analysis
  const dAnalysis = actionByRole(daily, 'analysis');
  add('G21', 'daily_read_only_analysis', !!dAnalysis && dAnalysis.action_class === 'read_only_analysis', {});

  // G22 — Collections communication maps to external_communication (+ canonical effect)
  const cMsg = actionByRole(collections, 'message_preparation');
  add('G22', 'collections_external_communication', !!cMsg && cMsg.action_class === 'external_communication' &&
    !!contractByClass['external_communication'] && contractByClass['external_communication'].external_effect_type === 'external_message', {});

  // G23 — Collections communication requires approval (hook + canonical contract)
  add('G23', 'collections_requires_approval', !!cMsg && cMsg.approval_required === true &&
    !!contractByClass['external_communication'] && contractByClass['external_communication'].approval_required === true, {});

  // G24 — Reorder/purchase draft maps to verified consequential class (financial_commitment, effect=financial)
  const rDraft = actionByRole(reorder, 'purchase_draft');
  add('G24', 'reorder_financial_commitment', !!rDraft && rDraft.action_class === 'financial_commitment' &&
    !!contractByClass['financial_commitment'] && contractByClass['financial_commitment'].external_effect_type === 'financial', {});

  // G25 — Reorder/purchase draft requires approval (hook + canonical contract)
  add('G25', 'reorder_requires_approval', !!rDraft && rDraft.approval_required === true &&
    !!contractByClass['financial_commitment'] && contractByClass['financial_commitment'].approval_required === true, {});

  // G26 — consequential actions are not executable (hook + canonical contract)
  add('G26', 'consequential_not_executable', allTrue(allActions, (a) => {
    if (a.action_class === 'read_only_analysis') return a.executable === false;
    const c = contractByClass[a.action_class];
    return a.executable === false && !!c && c.execution_allowed === false;
  }, 1), {});

  const si = (profile && profile.safety_invariants) || {};
  // G27 — execution_allowed=false
  add('G27', 'execution_false', si.execution_allowed === false, { v: si.execution_allowed });
  // G28 — external_sending_allowed=false
  add('G28', 'external_sending_false', si.external_sending_allowed === false, { v: si.external_sending_allowed });
  // G29 — production_mutation_allowed=false
  add('G29', 'production_mutation_false', si.production_mutation_allowed === false, { v: si.production_mutation_allowed });
  // G30 — automatic approval not enabled
  add('G30', 'automatic_approval_false', si.automatic_approval_allowed === false, { v: si.automatic_approval_allowed });

  // G31 — evidence contract shape present for every hook
  add('G31', 'evidence_shape_present', allTrue(hooks, (h) => {
    const ec = h.evidence_contract; const os = ec && ec.output_schema;
    return !!os && REQ_SCHEMA_KEYS.every((k) => Object.prototype.hasOwnProperty.call(os, k));
  }, 3), {});

  // G32 — workspace/owner isolation required
  add('G32', 'isolation_required', allTrue(hooks, (h) => h.evidence_contract &&
    h.evidence_contract.workspace_isolation_required === true && h.evidence_contract.owner_isolation_required === true, 3), {});

  // G33 — evidence ids required for material findings
  add('G33', 'evidence_ids_required', allTrue(hooks, (h) => {
    const ec = h.evidence_contract;
    return !!ec && ec.evidence_ids_required_for_material_findings === true && ec.output_schema && Object.prototype.hasOwnProperty.call(ec.output_schema, 'evidence_ids');
  }, 3), {});

  // G34 — provenance / source ids required
  add('G34', 'provenance_required', allTrue(hooks, (h) => {
    const ec = h.evidence_contract;
    return !!ec && ec.provenance_source_ids_required === true && ec.output_schema && Object.prototype.hasOwnProperty.call(ec.output_schema, 'provenance_source_ids');
  }, 3), {});

  // G35 — freshness required
  add('G35', 'freshness_required', allTrue(hooks, (h) => {
    const ec = h.evidence_contract;
    return !!ec && ec.freshness_required === true && ec.output_schema && Object.prototype.hasOwnProperty.call(ec.output_schema, 'source_freshness');
  }, 3), {});

  // G36 — missing-data and limitation behaviour is fail-closed
  add('G36', 'fail_closed_missing_data', allTrue(hooks, (h) => {
    const ec = h.evidence_contract;
    return !!ec && ec.missing_data_behavior === 'fail_closed' && ec.stale_data_behavior === 'fail_closed_with_limitation' && allTrue(ec.limitations, (x) => typeof x === 'string', 1);
  }, 3), {});

  // G37 — no live/production/pilot-ready overclaim (profile + doc, negation-aware)
  const scanText = [profileText, docText].join('\n');
  const overclaimHits = [];
  clauses(scanText).forEach((cl) => {
    OVERCLAIM_PHRASES.forEach((ph) => { if (cl.includes(ph) && !hasNeg(cl)) overclaimHits.push(ph); });
  });
  add('G37', 'no_overclaim', overclaimHits.length === 0, { hits: overclaimHits.slice(0, 8) });

  // G38 — no PII / secrets embedded (profile + doc)
  const piiHits = PII_PATTERNS.filter((p) => p.re.test(scanText)).map((p) => p.name);
  add('G38', 'no_pii_secrets', piiHits.length === 0, { hits: piiHits });

  // G39 — no DB/network/process/write behaviour in config/checker (+ config has no require)
  const configClean = !profileText.includes('require(') && !FORBIDDEN_RUNTIME.some((t) => profileText.includes(t));
  const checkerClean = !FORBIDDEN_RUNTIME.some((t) => checkerText.includes(t));
  add('G39', 'no_runtime_side_effects', configClean && checkerClean, { configClean, checkerClean });

  // G40 — no vacuous .every() / empty-array pass (exact non-empty structure)
  add('G40', 'no_vacuous_pass', reqPacks.length === 7 && hooks.length === 3 &&
    hooks.every((h) => Array.isArray(h.actions) && h.actions.length >= 1) &&
    hooks.every((h) => h.evidence_contract && Object.keys(h.evidence_contract.output_schema || {}).length >= REQ_SCHEMA_KEYS.length), {});

  // G41 — no self-attestation-only pass (registries loaded + no self-cert keys + derived approval truth)
  const regsLoaded = pack.PACKS.length > 0 && agent.AGENTS.length > 0 && wf.WORKFLOWS.length > 0 && aa.CONTRACTS.length > 0;
  const profileKeys = collectKeys(profile, new Set());
  const noSelfCertKey = ![...profileKeys].some((k) => FORBIDDEN_SELF_KEYS.has(k));
  const derivedApprovalTruth = contractByClass['read_only_analysis'] && contractByClass['read_only_analysis'].approval_required === false &&
    contractByClass['external_communication'] && contractByClass['external_communication'].approval_required === true &&
    contractByClass['financial_commitment'] && contractByClass['financial_commitment'].approval_required === true;
  add('G41', 'no_self_attestation', regsLoaded && noSelfCertKey && !!derivedApprovalTruth, { regsLoaded, noSelfCertKey });

  // G42 — files unchanged during checker execution (re-hash)
  const afterHashes = { profile: sha256(PROFILE_PATH), doc: sha256(DOC_PATH), checker: sha256(CHECKER_PATH) };
  const filesMutated = ['profile', 'doc', 'checker'].filter((k) => beforeHashes[k] !== afterHashes[k]);
  add('G42', 'files_unchanged', filesMutated.length === 0, { filesMutated });
}

// ── aggregate ───────────────────────────────────────────────────────────────────
const gatesPassed = results.filter((r) => r.pass).length;
const overallPass = !loadError && results.length === EXPECTED_GATE_COUNT && gatesPassed === EXPECTED_GATE_COUNT;

// ── safe summary (no env values, no business data) ──────────────────────────────
const si2 = (profile && profile.safety_invariants) || {};
const capabilityStatuses = (hooks || []).reduce((acc, h) => { if (h) acc[h.id] = h.capability_status; return acc; }, {});
const allActions2 = (hooks || []).flatMap((h) => (h.actions || []));
const consequential = allActions2.filter((a) => a.action_class !== 'read_only_analysis');

const summary = {
  phase: '2C.31',
  overall_pass: overallPass,
  gates_passed: gatesPassed,
  gates_total: results.length,
  expected_gate_count: EXPECTED_GATE_COUNT,
  load_error: loadError,
  profile_count: (profileMod && Array.isArray(profileMod.PROFILES)) ? profileMod.PROFILES.length : null,
  profile_id: profile && profile.id,
  pack_count: (profile && profile.required_packs) ? profile.required_packs.length : null,
  hook_count: (hooks || []).length,
  hook_ids: (hooks || []).map((h) => h && h.id),
  valid_pack_refs: !loadError && allTrue((profile && profile.required_packs) || [], (p) => packIds.has(p), 7),
  valid_agent_refs: !loadError && allTrue(hooks || [], (h) => h.canonical_agent_ref === null || !!agentById[h.canonical_agent_ref], 3),
  valid_workflow_refs: !loadError && allTrue(hooks || [], (h) => h.canonical_workflow_ref === null || !!wfById[h.canonical_workflow_ref], 3),
  valid_action_class_refs: !loadError && allTrue(allActions2, (a) => actionClasses.has(a.action_class), 1),
  capability_statuses: capabilityStatuses,
  daily_agent_ref: daily && daily.canonical_agent_ref,
  daily_workflow_ref: daily && daily.canonical_workflow_ref,
  collections_implementation_status: collections && collections.implementation_status,
  reorder_implementation_status: reorder && reorder.implementation_status,
  consequential_actions_approval_gated: consequential.length > 0 && consequential.every((a) => a.approval_required === true),
  execution_enabled_count: si2.execution_allowed === true ? 1 : 0,
  external_sending_enabled_count: si2.external_sending_allowed === true ? 1 : 0,
  production_mutation_enabled_count: si2.production_mutation_allowed === true ? 1 : 0,
  automatic_approval_enabled_count: si2.automatic_approval_allowed === true ? 1 : 0,
  no_pii_or_secrets: !loadError && (results.find((r) => r.id === 'G38') || {}).pass === true,
  no_overclaim: !loadError && (results.find((r) => r.id === 'G37') || {}).pass === true,
  files_mutated_by_check: (results.find((r) => r.id === 'G42') || { detail: {} }).detail.filesMutated || [],
  failed_gates: results.filter((r) => !r.pass).map((r) => ({ id: r.id, name: r.name, detail: r.detail })),
};

console.log('PILOT_CONTRACT_JSON:' + JSON.stringify(summary, null, 1));

if (overallPass) {
  console.log('✅ PILOT_CONTRACT_PASS: all ' + EXPECTED_GATE_COUNT + ' independent gates passed; static profile is conservative and truthful.');
  process.exit(0);
} else {
  console.error('❌ PILOT_CONTRACT_FAIL: ' + (loadError ? ('load_error: ' + loadError) : (gatesPassed + '/' + results.length + ' gates passed')) + '.');
  process.exit(1);
}
