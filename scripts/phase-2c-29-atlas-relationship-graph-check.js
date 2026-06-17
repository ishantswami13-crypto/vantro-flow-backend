#!/usr/bin/env node
'use strict';
/*
 * Phase 2C.29 — Atlas Relationship Graph backend-contract check (FAIL-CLOSED).
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves, statically and fail-closed, that the Atlas Relationship Graph is a static,
 * READ-ONLY topology over the Pack (2C.26) / Agent (2C.28) / Workflow (2C.27)
 * registries that NEVER executes, activates, orchestrates, recurses, or propagates
 * status/proof/capability. The verdict derives ONLY from independent evidence:
 *   (A) the PURE graph config + service loaded with NO DB / network / env reads;
 *   (B) the graph RE-DERIVED independently from the source registries (PACKS/AGENTS/
 *       WORKFLOWS) — 59 nodes (23+18+18) and the pack_contains_agent / agent_supports_
 *       workflow edges from each agent's related_packs / related_workflows — and compared
 *       node-for-node and edge-for-edge against the config's arrays (no trust in self-
 *       reported summaries);
 *   (C) structural invariants over every node/edge (deterministic unique ids, allowed
 *       enums, required fields, endpoints exist, no self-loop, no inverse/cycle, no
 *       Pack->Workflow shortcut, every permission false);
 *   (D) NON-PROPAGATION proven by value equality — each node's status/proof/risk equals
 *       ITS OWN source row's value (never derived from a neighbour);
 *   (E) BEHAVIOURAL first-degree-only lookup (no nested/recursive expansion) + route
 *       safety (auth before flag, generic 404, GET-only, no /paths, no caller-controlled
 *       query/depth, no DB/exec/sync token);
 *   (F) feature flag default-OFF; prior 2C.21–2C.28 conservatism re-derived; overclaim /
 *       CTA / secret / PII scans; DECLARED path scope (backend-only, no DB/migration);
 *       SHA-256 mutation guard.
 *
 * NO self-attestation feeds the verdict; `overall_pass` reads ONLY derived gate results.
 * EVERY `.every()` over a node/edge array is length-guarded so an empty graph cannot pass.
 *
 * SAFETY: read-only. Opens NO database, makes NO network call, writes NO file, spawns NO
 * process. Output is COUNTS / BOOLEANS / STATUS / NAMES only.
 *
 * USAGE: node scripts/phase-2c-29-atlas-relationship-graph-check.js
 *        exit 0 = all gates pass; exit 1 = fail-closed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
delete process.env.FEATURE_ATLAS_RELATIONSHIP_GRAPH_API_ENABLED;

function read(rel) { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return ''; } }
function exists(rel) { try { fs.accessSync(path.join(ROOT, rel)); return true; } catch (e) { return false; } }
function sha256(rel) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex'); }
  catch (e) { return null; }
}
const all = (obj) => Object.values(obj).every((v) => v === true);

const PHASE_TOUCHED = [
  'lib/config/atlasRelationshipGraph.js',
  'lib/services/atlasRelationshipGraph.service.js',
  'docs/agent-mesh/phase-2c-29-atlas-relationship-graph-contract.md',
  'scripts/phase-2c-29-atlas-relationship-graph-check.js',
  'lib/featureFlags.js',
  'server.js',
];

const GUARD_FILES = {
  config:       'lib/config/atlasRelationshipGraph.js',
  service:      'lib/services/atlasRelationshipGraph.service.js',
  doc:          'docs/agent-mesh/phase-2c-29-atlas-relationship-graph-contract.md',
  checker:      'scripts/phase-2c-29-atlas-relationship-graph-check.js',
  flags:        'lib/featureFlags.js',
  server:       'server.js',
  pack_config:  'lib/config/atlasPackRegistry.js',
  pack_service: 'lib/services/atlasPackRegistry.service.js',
  agent_config: 'lib/config/atlasAgentRegistry.js',
  agent_service:'lib/services/atlasAgentRegistry.service.js',
  wf_config:    'lib/config/atlasWorkflowRegistry.js',
  wf_service:   'lib/services/atlasWorkflowRegistry.service.js',
  rt_config:    'lib/config/atlasRuntimeTruth.js',
  rt_service:   'lib/services/runtimeTruth.service.js',
  doc23:        'docs/agent-mesh/phase-2c-23-owner-briefing-ga-decision-gate.md',
  doc24:        'docs/agent-mesh/phase-2c-24-production-canary-prerequisite-binder.md',
  doc25:        'docs/agent-mesh/phase-2c-25-owner-approval-canary-scope-intake.md',
};

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

// ── load PURE graph modules + source registries ───────────────────────────────
let cfg = null, svc = null, truth = null, listed = null, validateRes = { ok: false, offenders: {} }, loadError = null;
let packCfg = null, agentCfg = null, wfCfg = null;
try {
  cfg = require(path.join(ROOT, GUARD_FILES.config));
  svc = require(path.join(ROOT, GUARD_FILES.service));
  packCfg = require(path.join(ROOT, GUARD_FILES.pack_config));
  agentCfg = require(path.join(ROOT, GUARD_FILES.agent_config));
  wfCfg = require(path.join(ROOT, GUARD_FILES.wf_config));
  truth = svc.buildAtlasRelationshipGraphTruth({ generatedAt: '2026-01-01T00:00:00.000Z' });
  listed = svc.listAtlasRelationshipGraph();
  validateRes = svc.validateRelationshipGraph();
} catch (e) { loadError = String(e && e.message ? e.message : e); }

const NODES = cfg && Array.isArray(cfg.NODES) ? cfg.NODES : [];
const EDGES = cfg && Array.isArray(cfg.EDGES) ? cfg.EDGES : [];
const summary = truth ? truth.summary : null;

// ── INDEPENDENT re-derivation from the source registries ──────────────────────
const PACKS = packCfg && Array.isArray(packCfg.PACKS) ? packCfg.PACKS : [];
const AGENTS = agentCfg && Array.isArray(agentCfg.AGENTS) ? agentCfg.AGENTS : [];
const WORKFLOWS = wfCfg && Array.isArray(wfCfg.WORKFLOWS) ? wfCfg.WORKFLOWS : [];
const nid = (t, id) => t + ':' + id;
const expectedNodeIds = new Set([
  ...PACKS.map((p) => nid('pack', p.id)),
  ...AGENTS.map((a) => nid('agent', a.id)),
  ...WORKFLOWS.map((w) => nid('workflow', w.id)),
]);
const srcRow = new Map();
for (const p of PACKS) srcRow.set(nid('pack', p.id), p);
for (const a of AGENTS) srcRow.set(nid('agent', a.id), a);
for (const w of WORKFLOWS) srcRow.set(nid('workflow', w.id), w);
const expectedEdgeKeys = new Set();
for (const a of AGENTS) {
  for (const p of (a.related_packs || [])) {
    if (expectedNodeIds.has(nid('pack', p)) && expectedNodeIds.has(nid('agent', a.id))) {
      expectedEdgeKeys.add('pack_contains_agent|' + nid('pack', p) + '|' + nid('agent', a.id));
    }
  }
  for (const w of (a.related_workflows || [])) {
    if (expectedNodeIds.has(nid('agent', a.id)) && expectedNodeIds.has(nid('workflow', w))) {
      expectedEdgeKeys.add('agent_supports_workflow|' + nid('agent', a.id) + '|' + nid('workflow', w));
    }
  }
}
const actualNodeIds = new Set(NODES.map((n) => n.graph_node_id));
const actualEdgeKeys = new Set(EDGES.map((e) => e.relationship_type + '|' + nid(e.source_type, e.source_id) + '|' + nid(e.target_type, e.target_id)));

const ALLOWED_NODE_TYPES = ['pack', 'agent', 'workflow'];
const ALLOWED_EDGE_TYPES = ['pack_contains_agent', 'agent_supports_workflow'];
const ALLOWED_SOURCE_REGS = ['atlas_pack_registry', 'atlas_agent_registry', 'atlas_workflow_registry'];

const packNodes = NODES.filter((n) => n.node_type === 'pack');
const agentNodes = NODES.filter((n) => n.node_type === 'agent');
const workflowNodes = NODES.filter((n) => n.node_type === 'workflow');

// ── Gate 01 — assets exist + service loads ────────────────────────────────────
const g01 = {
  config_exists:  exists(GUARD_FILES.config),
  service_exists: exists(GUARD_FILES.service),
  doc_exists:     src.doc.length > 0,
  checker_exists: exists(GUARD_FILES.checker),
  service_loads:  truth !== null && listed !== null && loadError === null,
};

// ── Gate 02 — graph non-empty (no vacuous pass) ───────────────────────────────
const g02 = {
  nodes_non_empty: NODES.length > 0,
  edges_non_empty: EDGES.length > 0,
  source_registries_loaded: PACKS.length > 0 && AGENTS.length > 0 && WORKFLOWS.length > 0,
};

// ── Gate 03 — exact node counts (59 = 23 + 18 + 18) ───────────────────────────
const g03 = {
  total_59:    NODES.length === 59 && !!summary && summary.actual_node_count === 59,
  pack_23:     packNodes.length === 23 && PACKS.length === 23,
  agent_18:    agentNodes.length === 18 && AGENTS.length === 18,
  workflow_18: workflowNodes.length === 18 && WORKFLOWS.length === 18,
  by_type_matches: !!summary && summary.node_counts_by_type
    && summary.node_counts_by_type.pack === 23 && summary.node_counts_by_type.agent === 18 && summary.node_counts_by_type.workflow === 18,
};

// ── Gate 04 — every node maps to exactly one canonical source row; no invented ──
const invented = NODES.filter((n) => !srcRow.has(n.graph_node_id)).map((n) => n.graph_node_id);
const sourceCovered = [...expectedNodeIds].every((id) => actualNodeIds.has(id));
const g04 = {
  node_ids_equal_expected: NODES.length > 0 && actualNodeIds.size === expectedNodeIds.size && sourceCovered,
  no_invented_nodes:       NODES.length > 0 && invented.length === 0,
  one_node_per_source_row: NODES.length === expectedNodeIds.size,
  source_id_preserved:     NODES.length > 0 && NODES.every((n) => srcRow.has(n.graph_node_id) && srcRow.get(n.graph_node_id).id === n.source_id),
};

// ── Gate 05 — graph node ids deterministic + unique ───────────────────────────
const g05 = {
  deterministic:  NODES.length > 0 && NODES.every((n) => n.graph_node_id === nid(n.node_type, n.source_id)),
  unique:         actualNodeIds.size === NODES.length && NODES.length > 0,
  prefix_valid:   NODES.length > 0 && NODES.every((n) => ALLOWED_NODE_TYPES.includes(n.node_type)),
};

// ── Gate 06 — source registry valid + correct per type ────────────────────────
const regForType = { pack: 'atlas_pack_registry', agent: 'atlas_agent_registry', workflow: 'atlas_workflow_registry' };
const g06 = {
  source_registry_in_allowlist: NODES.length > 0 && NODES.every((n) => ALLOWED_SOURCE_REGS.includes(n.source_registry)),
  source_registry_matches_type: NODES.length > 0 && NODES.every((n) => n.source_registry === regForType[n.node_type]),
};

// ── Gate 07 — node types valid; no placeholder/foreign node types ─────────────
const distinctNodeTypes = new Set(NODES.map((n) => n.node_type));
const g07 = {
  only_three_node_types: [...distinctNodeTypes].every((t) => ALLOWED_NODE_TYPES.includes(t)),
  no_foreign_node_type:  !NODES.some((n) => /approval|evidence|data_?source|action|runtime|external|connector|policy/i.test(String(n.node_type))),
  exactly_three_types_used: distinctNodeTypes.size === 3,
};

// ── Gate 08 — node required fields present (11) ───────────────────────────────
const REQ_NODE = (cfg && Array.isArray(cfg.REQUIRED_NODE_FIELDS)) ? cfg.REQUIRED_NODE_FIELDS : [];
const nodeMissing = [];
for (const n of NODES) for (const f of REQ_NODE) if (!Object.prototype.hasOwnProperty.call(n, f) || n[f] === undefined) nodeMissing.push(n.graph_node_id + ':' + f);
const g08 = {
  required_fields_count_11: REQ_NODE.length === 11,
  every_node_has_all_fields: NODES.length > 0 && nodeMissing.length === 0,
  proof_risk_null_or_string: NODES.length > 0 && NODES.every((n) =>
    (n.proof_level === null || (typeof n.proof_level === 'string' && n.proof_level !== '0')) &&
    (n.risk_level === null || (typeof n.risk_level === 'string' && n.risk_level !== '0'))),
};

// ── Gate 09 — edges non-empty; declared == actual == re-derived ───────────────
const g09 = {
  edges_non_empty:            EDGES.length > 0,
  declared_equals_actual:     !!summary && summary.declared_edge_count === EDGES.length && summary.actual_edge_count === EDGES.length,
  actual_equals_rederived:    EDGES.length > 0 && actualEdgeKeys.size === EDGES.length && actualEdgeKeys.size === expectedEdgeKeys.size && [...expectedEdgeKeys].every((k) => actualEdgeKeys.has(k)),
  listed_edges_match:         !!listed && Array.isArray(listed.edges) && listed.edges.length === EDGES.length,
};

// ── Gate 10 — edge ids unique ─────────────────────────────────────────────────
const edgeIdSet = new Set(EDGES.map((e) => e.edge_id));
const g10 = { edge_ids_unique: edgeIdSet.size === EDGES.length && EDGES.length > 0 };

// ── Gate 11 — unique source/type/target triples ───────────────────────────────
const g11 = { triples_unique: actualEdgeKeys.size === EDGES.length && EDGES.length > 0 };

// ── Gate 12 — edge allowlist only (2 stored types) ────────────────────────────
const g12 = {
  relationship_types_allowed: EDGES.length > 0 && EDGES.every((e) => ALLOWED_EDGE_TYPES.includes(e.relationship_type)),
  exactly_two_stored_types:   !!summary && Object.keys(summary.edge_counts_by_relationship_type).every((t) => ALLOWED_EDGE_TYPES.includes(t)),
  required_edge_fields_12:    !!cfg && Array.isArray(cfg.REQUIRED_EDGE_FIELDS) && cfg.REQUIRED_EDGE_FIELDS.length === 12,
};

// ── Gate 13 — edge endpoints exist (no missing source/target) ─────────────────
const missingSrc = EDGES.filter((e) => !actualNodeIds.has(nid(e.source_type, e.source_id))).map((e) => e.edge_id);
const missingTgt = EDGES.filter((e) => !actualNodeIds.has(nid(e.target_type, e.target_id))).map((e) => e.edge_id);
const g13 = {
  no_missing_source: EDGES.length > 0 && missingSrc.length === 0,
  no_missing_target: EDGES.length > 0 && missingTgt.length === 0,
};

// ── Gate 14 — no self-loops ───────────────────────────────────────────────────
const selfLoops = EDGES.filter((e) => nid(e.source_type, e.source_id) === nid(e.target_type, e.target_id)).map((e) => e.edge_id);
const g14 = { no_self_loops: EDGES.length > 0 && selfLoops.length === 0 };

// ── Gate 15 — no stored inverse / no two-node cycle ───────────────────────────
const directed = new Set();
const inversePairs = [];
for (const e of EDGES) {
  const s = nid(e.source_type, e.source_id), t = nid(e.target_type, e.target_id);
  if (directed.has(t + '->' + s)) inversePairs.push(s + '<->' + t);
  directed.add(s + '->' + t);
}
const g15 = {
  no_inverse_duplicate: EDGES.length > 0 && inversePairs.length === 0,
  no_two_node_cycle:    inversePairs.length === 0,
};

// ── Gate 16 — no Pack -> Workflow shortcut edge ───────────────────────────────
const shortcuts = EDGES.filter((e) => e.source_type === 'pack' && e.target_type === 'workflow').map((e) => e.edge_id);
const g16 = {
  no_pack_to_workflow_shortcut: EDGES.length > 0 && shortcuts.length === 0,
  only_pack_agent_and_agent_workflow: EDGES.length > 0 && EDGES.every((e) =>
    (e.source_type === 'pack' && e.target_type === 'agent') || (e.source_type === 'agent' && e.target_type === 'workflow')),
};

// ── Gate 17 — NO status / proof / risk propagation (value equality to own row) ─
const statusProp = [], proofProp = [], riskProp = [];
for (const n of NODES) {
  const row = srcRow.get(n.graph_node_id);
  if (!row) continue;
  if (n.status !== row.status) statusProp.push(n.graph_node_id);
  const rp = (typeof row.proof_level === 'string' && row.proof_level.length > 0) ? row.proof_level : null;
  const rr = (typeof row.risk_level === 'string' && row.risk_level.length > 0) ? row.risk_level : null;
  if (n.proof_level !== rp) proofProp.push(n.graph_node_id);
  if (n.risk_level !== rr) riskProp.push(n.graph_node_id);
}
const g17 = {
  status_equals_own_source: NODES.length > 0 && statusProp.length === 0,
  proof_equals_own_source:  NODES.length > 0 && proofProp.length === 0,
  risk_equals_own_source:   NODES.length > 0 && riskProp.length === 0,
};

// ── Gate 18 — every EDGE permission false ─────────────────────────────────────
const g18 = {
  edge_execution_all_false:  EDGES.length > 0 && EDGES.every((e) => e.execution_allowed === false),
  edge_activation_all_false: EDGES.length > 0 && EDGES.every((e) => e.activation_allowed === false),
  edge_production_all_false: EDGES.length > 0 && EDGES.every((e) => e.production_allowed === false),
  summary_edge_perm_zero:    !!summary && summary.execution_allowed_edge_count === 0 && summary.activation_allowed_edge_count === 0 && summary.production_allowed_edge_count === 0,
};

// ── Gate 19 — every NODE permission false (preserved must be false; fail-closed)
const g19 = {
  node_execution_all_false:  NODES.length > 0 && NODES.every((n) => n.execution_allowed === false),
  node_activation_all_false: NODES.length > 0 && NODES.every((n) => n.activation_allowed === false),
  node_production_all_false: NODES.length > 0 && NODES.every((n) => n.production_allowed === false),
  summary_node_perm_zero:    !!summary && summary.execution_allowed_node_count === 0 && summary.activation_allowed_node_count === 0 && summary.production_allowed_node_count === 0,
};

// ── Gate 20 — no hidden agent multiplication ──────────────────────────────────
const agentSourceIds = agentNodes.map((n) => n.source_id);
const g20 = {
  agent_nodes_equal_agents:   agentNodes.length === AGENTS.length && AGENTS.length === 18,
  each_agent_exactly_one_node: new Set(agentSourceIds).size === agentSourceIds.length,
  total_nodes_exactly_59:     NODES.length === 59,
};

// ── Gate 21 — first-degree-only lookup; no recursion / nested expansion ───────
let fd = null, fdErr = null;
try { fd = svc.getAtlasRelationshipGraphNodeById('agent:core.owner_briefing'); } catch (e) { fdErr = String(e); }
const edgeIsFlat = (arr) => Array.isArray(arr) && arr.every((e) => e && typeof e === 'object' &&
  Object.prototype.hasOwnProperty.call(e, 'edge_id') &&
  !Object.prototype.hasOwnProperty.call(e, 'node') &&
  !Object.prototype.hasOwnProperty.call(e, 'outgoing_edges') &&
  !Object.prototype.hasOwnProperty.call(e, 'incoming_edges'));
const g21 = {
  lookup_ok:                fdErr === null && !!fd && !!fd.node,
  flagged_first_degree:     !!fd && fd.first_degree_only === true,
  outgoing_flat_no_nesting: !!fd && edgeIsFlat(fd.outgoing_edges),
  incoming_flat_no_nesting: !!fd && edgeIsFlat(fd.incoming_edges),
  list_edges_flat:          !!listed && edgeIsFlat(listed.edges),
};

// ── Gate 22 — no /paths route; no caller-controlled depth/query ───────────────
const PB_START = src.server.indexOf('BEGIN ATLAS RELATIONSHIP GRAPH (Phase 2C.29)');
const PB_END = PB_START > -1 ? src.server.indexOf('END ATLAS RELATIONSHIP GRAPH (Phase 2C.29)', PB_START) : -1;
const rgBlock = (PB_START > -1 && PB_END > -1) ? src.server.slice(PB_START, PB_END) : '';
const g22 = {
  no_paths_route:            !/['"]\/api\/atlas\/relationship-graph\/paths/i.test(src.server),
  no_caller_query_or_body:   rgBlock.length > 0 && !/req\.(query|body)\b/.test(rgBlock),
  no_caller_depth_param:     rgBlock.length > 0 && !/req\.(query|params|body)[.\[]\s*['"]?depth/i.test(rgBlock) && !/\bdepth\b\s*=/.test(rgBlock),
  only_id_param:             rgBlock.length > 0 && !/req\.params\.(?!id\b)\w+/.test(rgBlock),
};

// ── Gate 23 — route safety (GET-only, auth before flag, generic 404) ──────────
const writeVerb = /app\.(post|put|patch|delete)\s*\(\s*['"]\/api\/atlas\/relationship-graph/i.test(src.server);
const flagIdx = rgBlock.indexOf('atlas_relationship_graph_api_enabled');
const buildIdx = rgBlock.indexOf('buildAtlasRelationshipGraphTruth(');
const g23 = {
  route_present:               rgBlock.length > 0,
  no_write_verb_route:         !writeVerb,
  get_endpoints_present:       rgBlock.length === 0 || (/app\.get\(\s*'\/api\/atlas\/relationship-graph'/.test(rgBlock) && /app\.get\(\s*'\/api\/atlas\/relationship-graph\/nodes\/:id'/.test(rgBlock)),
  auth_before_flag:            rgBlock.length === 0 || (/app\.get\(\s*'\/api\/atlas\/relationship-graph'\s*,\s*authMiddleware/.test(rgBlock) && /nodes\/:id'\s*,\s*authMiddleware/.test(rgBlock)),
  flag_gated_404:              rgBlock.length === 0 || (flagIdx > -1 && rgBlock.includes('status(404)')),
  flag_before_build:           rgBlock.length === 0 || (flagIdx > -1 && buildIdx > -1 && flagIdx < buildIdx),
  no_db_sync_exec_in_block:    rgBlock.length === 0 || !/getPool|pool\.query|supabase|\bneon\b|sync_batch|production_sync|external_send|\.execute\(|activate\(/i.test(rgBlock),
  no_execute_activate_route:   !/app\.\w+\s*\(\s*['"]\/api\/atlas\/relationship-graph[^'"]*\/(execute|activate|run|send|sync|deploy)/i.test(src.server),
};

// ── Gate 24 — feature flag default OFF; only prompt_guard default-ON ──────────
let flagOffRuntime = false;
try { flagOffRuntime = require(path.join(ROOT, GUARD_FILES.flags)).isEnabled('atlas_relationship_graph_api_enabled') === false; } catch (e) {}
const defaultOnCount = (src.flags.match(/!==\s*'false'/g) || []).length;
const g24 = {
  flag_name_present:        /atlas_relationship_graph_api_enabled/.test(src.flags) && /FEATURE_ATLAS_RELATIONSHIP_GRAPH_API_ENABLED/.test(src.flags),
  flag_default_off_source:  /atlas_relationship_graph_api_enabled\s*:\s*process\.env\.FEATURE_ATLAS_RELATIONSHIP_GRAPH_API_ENABLED\s*===\s*'true'/.test(src.flags),
  flag_default_off_runtime: flagOffRuntime === true,
  only_prompt_guard_default_on: defaultOnCount === 1 && /prompt_guard_enabled\s*:\s*process\.env\.FEATURE_PROMPT_GUARD_ENABLED\s*!==\s*'false'/.test(src.flags),
};

// ── Gate 25 — purity: no DB/network/fs/env/startup-side-effect in config+service ─
const PURITY_FORBIDDEN = [
  /require\(\s*['"]pg['"]\s*\)/, /supabase/i, /createClient/, /\bfetch\s*\(/, /axios/i,
  /https?\.request/, /child_process/, /\bexec\s*\(/, /\bspawn\s*\(/, /writeFileSync|writeFile\b|appendFile|\bunlink\b/,
  /process\.env/, /setInterval|setTimeout/, /node-cron|cron\./i, /\.listen\s*\(/,
];
const purityHits = [];
for (const [t, text] of Object.entries({ config: src.config, service: src.service })) {
  for (const re of PURITY_FORBIDDEN) if (re.test(text)) purityHits.push(t + ':' + re.source);
}
const g25 = { config_service_pure: purityHits.length === 0 };

// ── Gate 26 — no node/edge count marketing overclaim ──────────────────────────
const OVERCLAIM = [/\b216\b[^\n]{0,24}\blive\b/i, /\b300\b[^\n]{0,24}\blive\b/i, /\b500\b[^\n]{0,24}\blive\b/i,
  /fully autonomous/i, /generally available/i, /\bproduction-live\b/i, /live capability count/i];
const overTargets = { config: src.config, service: src.service, doc: src.doc };
const overHits = [];
for (const [t, text] of Object.entries(overTargets)) for (const re of OVERCLAIM) if (re.test(text)) overHits.push(t + ':' + re.source);
const claimed = truth && typeof truth.summary.declared_node_count === 'number' ? truth.summary.declared_node_count : null;
const g26 = {
  no_overclaim_phrases:       overHits.length === 0,
  declared_nodes_equal_rows:  claimed === NODES.length,
  counts_labeled_topology:    !!summary && summary.counts_are_registry_topology_not_capability === true,
};

// ── Gate 27 — no unsafe CTA literal in config (graph carries no CTA fields) ────
const g27 = {
  config_no_forbidden_cta_literal: !/'(Run Now|Execute|Launch Agent|Start Automation|Sync Production|Deploy)'/.test(src.config),
  nodes_have_no_cta_field:  NODES.length > 0 && NODES.every((n) => !Object.prototype.hasOwnProperty.call(n, 'safe_cta') && !Object.prototype.hasOwnProperty.call(n, 'cta')),
  edges_have_no_cta_field:  EDGES.length > 0 && EDGES.every((e) => !Object.prototype.hasOwnProperty.call(e, 'safe_cta') && !Object.prototype.hasOwnProperty.call(e, 'cta')),
};

// ── Gate 28 — prior 2C.21–2C.28 conservatism unchanged ────────────────────────
let packSum = null, wfSum = null, agentSum = null, rtLP = null, rtLL = null, priorErr = null;
try {
  packSum = require(path.join(ROOT, GUARD_FILES.pack_service)).summarizeAtlasPackRegistry();
  wfSum = require(path.join(ROOT, GUARD_FILES.wf_service)).summarizeAtlasWorkflowRegistry();
  agentSum = require(path.join(ROOT, GUARD_FILES.agent_service)).summarizeAtlasAgentRegistry();
  const rt = require(path.join(ROOT, GUARD_FILES.rt_service)).buildRuntimeTruth({ generatedAt: '2026-01-01T00:00:00.000Z' });
  rtLP = rt && rt.summary ? rt.summary.live_proven : null;
  rtLL = rt && rt.summary ? rt.summary.live_limited : null;
} catch (e) { priorErr = String(e && e.message ? e.message : e); }
const agentPcProof = AGENTS.filter((a) => a.proof_level === 'production_canary').length;
const agentLpProof = AGENTS.filter((a) => ['live_proven', 'production_live', 'production_proven', 'ga', 'generally_available'].includes(a.proof_level)).length;
const c23Ga = (src.doc23.match(/^GA_READY:\s*(yes|no)\s*$/im) || [])[1] || null;
const c23Canary = (src.doc23.match(/^PRODUCTION_CANARY_READY:\s*(yes|no)\s*$/im) || [])[1] || null;
const c24Canary = (src.doc24.match(/^CANARY_READY:\s*(yes|no)\s*$/im) || [])[1] || null;
const c25Owner = (src.doc25.match(/^owner_approval_record_present:\s*(true|false)\s*$/im) || [])[1] || null;
const c25Scope = (src.doc25.match(/^canary_scope_record_present:\s*(true|false)\s*$/im) || [])[1] || null;
const g28 = {
  pack_conservative:     !!packSum && packSum.live_proven_count === 0 && packSum.execution_allowed_count === 0 && packSum.activation_allowed_count === 0,
  workflow_conservative: !!wfSum && wfSum.live_proven_count === 0 && wfSum.execution_allowed_count === 0 && wfSum.activation_allowed_count === 0,
  agent_conservative:    !!agentSum && agentSum.live_proven_count === 0 && agentSum.live_limited_count === 1 && agentSum.production_allowed_count === 0 && agentSum.external_send_allowed_count === 0,
  agent_no_canary_or_live_proof: agentPcProof === 0 && agentLpProof === 0,
  rt_live_proven_zero:   priorErr === null && rtLP === 0,
  rt_live_limited_two:   priorErr === null && rtLL === 2,
  c23_ga_no: c23Ga === 'no', c23_canary_no: c23Canary === 'no', c24_canary_no: c24Canary === 'no',
  c25_owner_absent: c25Owner === 'false', c25_scope_absent: c25Scope === 'false',
};

// ── Gate 29 — no secrets / PII (config + service + doc); checker clean ────────
const VALUE_PATTERNS = [
  /postgres(?:ql)?:\/\//i, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /\bbearer\s+[A-Za-z0-9._-]{12,}/i,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, /\b\d{10,}\b/, /\+\d[\d -]{8,}\d/,
  /\b(?:sk|rk|pk|rzp)_live_[A-Za-z0-9]{4,}/i, /\bsk-[A-Za-z0-9]{16,}/, /BEGIN [A-Z ]*PRIVATE KEY/,
];
const piiHits = [];
for (const [t, text] of Object.entries({ config: src.config, service: src.service, doc: src.doc })) {
  for (const re of VALUE_PATTERNS) if (re.test(text)) piiHits.push(t + ':' + re.source);
}
const checkerSrc = read(GUARD_FILES.checker);
const checkerSecret = [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, /postgres(?:ql)?:\/\/[A-Za-z0-9]/, /\b(?:sk|rk|pk|rzp)_live_[A-Za-z0-9]{8,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/].filter((re) => re.test(checkerSrc)).length;
const g29 = {
  config_service_doc_free_of_pii: piiHits.length === 0,
  checker_free_of_secret_literals: checkerSecret === 0,
};

// ── Gate 30 — declared path scope; no DB/migration/frontend/env/Railway/deploy ─
const g30 = {
  declared_files_exist:      PHASE_TOUCHED.every((p) => exists(p)),
  no_env_file:               !PHASE_TOUCHED.some((p) => /\.env(\.|$)/.test(p)),
  no_railway_file:           !PHASE_TOUCHED.some((p) => /railway\.toml|nixpacks\.toml|Procfile/i.test(p)),
  no_frontend_file:          !PHASE_TOUCHED.some((p) => /frontend|vercel|next\.config/i.test(p)),
  no_deploy_file:            !PHASE_TOUCHED.some((p) => /\.github\/workflows|deploy/i.test(p)),
  no_migration_or_sql_or_db: !PHASE_TOUCHED.some((p) => /(^|\/)migrations\//i.test(p) || /\.sql$/i.test(p) || /(^|\/)db\//i.test(p)),
  backend_paths_only:        PHASE_TOUCHED.every((p) => /^(lib\/|scripts\/|docs\/|server\.js$)/.test(p)),
};

// ── MUTATION GUARD (part 2) ───────────────────────────────────────────────────
const HASH_AFTER = {};
for (const [k, rel] of Object.entries(GUARD_FILES)) HASH_AFTER[k] = sha256(rel);
const mutated = Object.keys(GUARD_FILES).filter((k) => HASH_BEFORE[k] === null || HASH_AFTER[k] === null || HASH_BEFORE[k] !== HASH_AFTER[k]);
const g31 = {
  all_hashes_captured:        Object.values(HASH_BEFORE).every((h) => typeof h === 'string'),
  files_unchanged_during_run: mutated.length === 0,
};

// ── roll up ───────────────────────────────────────────────────────────────────
const GATES = {
  '01_assets_exist': g01, '02_graph_non_empty': g02, '03_node_counts_59': g03,
  '04_node_canonical_mapping': g04, '05_node_ids_deterministic_unique': g05,
  '06_source_registry_valid': g06, '07_node_types_no_placeholder': g07,
  '08_node_required_fields': g08, '09_edges_declared_equals_rederived': g09,
  '10_edge_ids_unique': g10, '11_edge_triples_unique': g11, '12_edge_allowlist': g12,
  '13_edge_endpoints_exist': g13, '14_no_self_loops': g14, '15_no_inverse_no_cycle': g15,
  '16_no_pack_workflow_shortcut': g16, '17_no_status_proof_risk_propagation': g17,
  '18_edge_permissions_false': g18, '19_node_permissions_false': g19,
  '20_no_hidden_agent_multiplication': g20, '21_first_degree_only_no_recursion': g21,
  '22_no_paths_no_caller_depth': g22, '23_route_safe': g23, '24_feature_flag_default_off': g24,
  '25_purity_no_side_effects': g25, '26_no_count_overclaim': g26, '27_no_unsafe_cta': g27,
  '28_prior_phase_conservatism': g28, '29_no_secrets_pii': g29, '30_declared_path_scope': g30,
  '31_mutation_guard': g31,
};
const gate_results = {};
let gates_passed = 0;
for (const [name, checks] of Object.entries(GATES)) {
  const pass = all(checks);
  if (pass) gates_passed++;
  gate_results[name] = { pass, checks };
}
const gates_total = Object.keys(GATES).length;
const overall_pass = loadError === null && truth !== null && gates_passed === gates_total;

const result = {
  overall_pass, gates_passed, gates_total,
  graph_version: truth ? truth.graph_version : null,
  graph_summary: summary ? {
    declared_node_count: summary.declared_node_count, actual_node_count: summary.actual_node_count,
    declared_edge_count: summary.declared_edge_count, actual_edge_count: summary.actual_edge_count,
    node_counts_by_type: summary.node_counts_by_type, edge_counts_by_relationship_type: summary.edge_counts_by_relationship_type,
    execution_allowed_edge_count: summary.execution_allowed_edge_count,
    activation_allowed_edge_count: summary.activation_allowed_edge_count,
    production_allowed_edge_count: summary.production_allowed_edge_count,
  } : null,
  rederived: { expected_nodes: expectedNodeIds.size, expected_edges: expectedEdgeKeys.size, actual_nodes: actualNodeIds.size, actual_edges: actualEdgeKeys.size },
  route_present: rgBlock.length > 0,
  prior_markers: { rt_live_proven: rtLP, rt_live_limited: rtLL, agent_live_limited: agentSum ? agentSum.live_limited_count : null, agent_pc_proof: agentPcProof, agent_lp_proof: agentLpProof, c23_ga: c23Ga, c23_canary: c23Canary, c24_canary: c24Canary, c25_owner: c25Owner, c25_scope: c25Scope },
  load_error: loadError, prior_error: priorErr,
  // diagnostics
  invented_nodes: invented, node_missing_fields: nodeMissing, missing_edge_sources: missingSrc,
  missing_edge_targets: missingTgt, self_loops: selfLoops, inverse_pairs: inversePairs, pack_workflow_shortcuts: shortcuts,
  status_propagation: statusProp, proof_propagation: proofProp, risk_propagation: riskProp,
  validate_offenders: validateRes.offenders || {}, purity_violations: purityHits, overclaim_hits: overHits, pii_hits: piiHits,
  files_mutated_by_check: mutated,
  informational_only_not_a_pass_condition: {
    note: 'Display-only, never part of overall_pass. Scope booleans derive from the DECLARED phase file list (gate 30) + purity/secret scans (gate 25/29) + mutation guard (gate 31); ACTUAL working-tree scope is verified externally via git status/diff in the phase report.',
    production_touched:   (g30.backend_paths_only && g31.files_unchanged_during_run) ? false : null,
    db_or_migration_changed: g30.no_migration_or_sql_or_db ? false : null,
    frontend_touched:     g30.no_frontend_file ? false : null,
    env_files_changed:    g30.no_env_file ? false : null,
    railway_touched:      g30.no_railway_file ? false : null,
    deploy_triggered:     g30.no_deploy_file ? false : null,
    secrets_exposed:      (g29.config_service_doc_free_of_pii && g29.checker_free_of_secret_literals) ? false : null,
    graph_execution_enabled:   (g18.edge_execution_all_false && g19.node_execution_all_false) ? false : null,
    graph_activation_enabled:  (g18.edge_activation_all_false && g19.node_activation_all_false) ? false : null,
    recursive_traversal_present: (g21.flagged_first_degree && g21.outgoing_flat_no_nesting && g22.no_paths_route) ? false : null,
    status_or_proof_propagation: (g17.status_equals_own_source && g17.proof_equals_own_source) ? false : null,
  },
  gate_results,
};
if (!overall_pass) {
  result._note = 'FAIL-CLOSED: one or more Relationship Graph gates unmet. The graph must remain static, read-only topology projected one-to-one from the canonical registries — it must never execute, activate, recurse, expose /paths, propagate status/proof, or carry a non-false permission. Anything becomes runnable ONLY through a future, separately-approved phase with explicit owner approval and real production-access proofs.';
}
console.log('RELATIONSHIP_GRAPH_JSON:' + JSON.stringify(result, null, 1));
process.exit(overall_pass ? 0 : 1);
