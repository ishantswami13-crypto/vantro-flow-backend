// FILE: lib/services/atlasRelationshipGraph.service.js
// ─────────────────────────────────────────────────────────────────────────────
// Atlas Relationship Graph service (Phase 2C.29).
//
// Builds a READ-ONLY honest snapshot of the Atlas relationship topology from the
// static graph in lib/config/atlasRelationshipGraph.js (which projects the Pack /
// Agent / Workflow registries into nodes + edges).
//
// SAFETY:
//   - No DB. No network. No filesystem. No env reads. No background jobs. No startup
//     side effects. No recursion. No pathfinding. No arbitrary-depth traversal.
//   - Node lookup returns ONLY the node + its FIRST-DEGREE outgoing/incoming edges,
//     derived by a single filter over the static edge array — never nested expansion.
//   - Triggers NO execution, activation, production access, or external send; status /
//     proof / capability are NEVER propagated across edges.
//   - Counts are REGISTRY TOPOLOGY counts, not operational capability counts.
//   - Emits counts / booleans / status / labels only — never secrets, env, or PII.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const {
  GRAPH_VERSION,
  ALLOWED_NODE_TYPES,
  ALLOWED_EDGE_TYPES,
  ALLOWED_SOURCE_REGISTRIES,
  REQUIRED_NODE_FIELDS,
  REQUIRED_EDGE_FIELDS,
  BLOCKED_ACTIONS,
  graphNodeId,
  NODES,
  EDGES,
} = require('../config/atlasRelationshipGraph');

function publicNode(n) {
  return {
    graph_node_id: n.graph_node_id,
    source_id: n.source_id,
    node_type: n.node_type,
    source_registry: n.source_registry,
    name: n.name,
    status: n.status,
    proof_level: n.proof_level === undefined ? null : n.proof_level,
    risk_level: n.risk_level === undefined ? null : n.risk_level,
    execution_allowed: n.execution_allowed === true,
    activation_allowed: n.activation_allowed === true,
    production_allowed: n.production_allowed === true,
  };
}

function publicEdge(e) {
  return {
    edge_id: e.edge_id,
    source_id: e.source_id,
    source_type: e.source_type,
    target_id: e.target_id,
    target_type: e.target_type,
    relationship_type: e.relationship_type,
    required: e.required === true,
    limitations: Array.isArray(e.limitations) ? e.limitations.slice() : [],
    execution_allowed: e.execution_allowed === true,   // never true in this phase
    activation_allowed: e.activation_allowed === true, // never true in this phase
    production_allowed: e.production_allowed === true, // never true in this phase
    blocked_reason: e.blocked_reason || null,
  };
}

/** @returns {{nodes: Array<object>, edges: Array<object>}} the full static graph. */
function listAtlasRelationshipGraph() {
  return {
    nodes: NODES.map(publicNode),
    edges: EDGES.map(publicEdge),
  };
}

/**
 * First-degree node lookup. Returns the node plus its FIRST-DEGREE outgoing and
 * incoming edges only — a single filter over the static edge array, NO recursion and
 * NO nested node expansion.
 * @param {string} id graph_node_id (e.g. "agent:core.owner_briefing")
 * @returns {object|null}
 */
function getAtlasRelationshipGraphNodeById(id) {
  if (typeof id !== 'string' || !id) return null;
  const node = NODES.find((n) => n.graph_node_id === id);
  if (!node) return null;
  const outgoing = EDGES.filter((e) => graphNodeId(e.source_type, e.source_id) === id).map(publicEdge);
  const incoming = EDGES.filter((e) => graphNodeId(e.target_type, e.target_id) === id).map(publicEdge);
  return {
    node: publicNode(node),
    first_degree_only: true,
    outgoing_edges: outgoing,
    incoming_edges: incoming,
    outgoing_edge_count: outgoing.length,
    incoming_edge_count: incoming.length,
  };
}

function countBy(items, key) {
  const counts = {};
  for (const it of items) {
    const v = it[key];
    if (typeof v === 'string' && v) counts[v] = (counts[v] || 0) + 1;
  }
  return counts;
}

/**
 * Counts/booleans-only summary. All counts are REGISTRY TOPOLOGY counts (how the
 * registries relate) — NOT operational capability counts.
 * @returns {object}
 */
function summarizeAtlasRelationshipGraph() {
  const nodes = NODES.map(publicNode);
  const edges = EDGES.map(publicEdge);
  return {
    counts_are_registry_topology_not_capability: true,
    declared_node_count: nodes.length,
    actual_node_count: NODES.length,
    declared_edge_count: edges.length,
    actual_edge_count: EDGES.length,
    node_counts_by_type: countBy(nodes, 'node_type'),
    node_counts_by_source_registry: countBy(nodes, 'source_registry'),
    edge_counts_by_relationship_type: countBy(edges, 'relationship_type'),
    // safety summary — hard-zero by design
    execution_allowed_edge_count: edges.filter((e) => e.execution_allowed === true).length,
    activation_allowed_edge_count: edges.filter((e) => e.activation_allowed === true).length,
    production_allowed_edge_count: edges.filter((e) => e.production_allowed === true).length,
    execution_allowed_node_count: nodes.filter((n) => n.execution_allowed === true).length,
    activation_allowed_node_count: nodes.filter((n) => n.activation_allowed === true).length,
    production_allowed_node_count: nodes.filter((n) => n.production_allowed === true).length,
    blocked_actions: BLOCKED_ACTIONS.slice(),
  };
}

/**
 * Independent validation used by the checker/tests. Pure — returns offenders, never
 * throws. ok === true means every node/edge honors every invariant.
 * @returns {{ok: boolean, offenders: object}}
 */
function validateRelationshipGraph() {
  const bad_node_type = [];
  const bad_source_registry = [];
  const bad_node_id = [];
  const node_missing_fields = [];
  const node_executable = [];
  const node_activatable = [];
  const node_production = [];
  const duplicate_node_id = [];

  const bad_edge_type = [];
  const edge_missing_fields = [];
  const edge_executable = [];
  const edge_activatable = [];
  const edge_production = [];
  const duplicate_edge_id = [];
  const duplicate_triple = [];
  const self_loop = [];
  const missing_source = [];
  const missing_target = [];
  const inverse_pair = [];
  const pack_to_workflow_shortcut = [];

  const nodeIds = new Set(NODES.map((n) => n.graph_node_id));
  const seenNodeId = new Set();
  for (const n of NODES) {
    if (!ALLOWED_NODE_TYPES.includes(n.node_type)) bad_node_type.push(n.graph_node_id);
    if (!ALLOWED_SOURCE_REGISTRIES.includes(n.source_registry)) bad_source_registry.push(n.graph_node_id);
    if (n.graph_node_id !== graphNodeId(n.node_type, n.source_id)) bad_node_id.push(n.graph_node_id);
    if (seenNodeId.has(n.graph_node_id)) duplicate_node_id.push(n.graph_node_id); else seenNodeId.add(n.graph_node_id);
    for (const f of REQUIRED_NODE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(n, f) || n[f] === undefined) node_missing_fields.push(n.graph_node_id + ':' + f);
    }
    if (n.execution_allowed === true) node_executable.push(n.graph_node_id);
    if (n.activation_allowed === true) node_activatable.push(n.graph_node_id);
    if (n.production_allowed === true) node_production.push(n.graph_node_id);
  }

  const seenEdgeId = new Set();
  const seenTriple = new Set();
  const directed = new Set(); // "sNode->tNode" to detect inverse pairs / cycles
  for (const e of EDGES) {
    if (!ALLOWED_EDGE_TYPES.includes(e.relationship_type)) bad_edge_type.push(e.edge_id);
    for (const f of REQUIRED_EDGE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(e, f) || e[f] === undefined) edge_missing_fields.push(e.edge_id + ':' + f);
    }
    if (e.execution_allowed === true) edge_executable.push(e.edge_id);
    if (e.activation_allowed === true) edge_activatable.push(e.edge_id);
    if (e.production_allowed === true) edge_production.push(e.edge_id);
    if (seenEdgeId.has(e.edge_id)) duplicate_edge_id.push(e.edge_id); else seenEdgeId.add(e.edge_id);

    const sNode = graphNodeId(e.source_type, e.source_id);
    const tNode = graphNodeId(e.target_type, e.target_id);
    const triple = e.relationship_type + '|' + sNode + '|' + tNode;
    if (seenTriple.has(triple)) duplicate_triple.push(triple); else seenTriple.add(triple);
    if (sNode === tNode) self_loop.push(e.edge_id);
    if (!nodeIds.has(sNode)) missing_source.push(e.edge_id);
    if (!nodeIds.has(tNode)) missing_target.push(e.edge_id);
    if (e.source_type === 'pack' && e.target_type === 'workflow') pack_to_workflow_shortcut.push(e.edge_id);
    if (directed.has(tNode + '->' + sNode)) inverse_pair.push(sNode + '<->' + tNode);
    directed.add(sNode + '->' + tNode);
  }

  const offenders = {
    bad_node_type, bad_source_registry, bad_node_id, node_missing_fields,
    node_executable, node_activatable, node_production, duplicate_node_id,
    bad_edge_type, edge_missing_fields, edge_executable, edge_activatable, edge_production,
    duplicate_edge_id, duplicate_triple, self_loop, missing_source, missing_target,
    inverse_pair, pack_to_workflow_shortcut,
  };
  const ok = Object.values(offenders).every((arr) => arr.length === 0);
  return { ok, offenders };
}

/**
 * Build the full read-only Relationship Graph truth object.
 * @param {object} [opts]
 * @param {string} [opts.generatedAt] caller-supplied ISO timestamp (for testability)
 * @returns {object}
 */
function buildAtlasRelationshipGraphTruth(opts = {}) {
  const generatedAt =
    typeof opts.generatedAt === 'string' && opts.generatedAt
      ? opts.generatedAt
      : new Date().toISOString();

  const { nodes, edges } = listAtlasRelationshipGraph();
  const summary = summarizeAtlasRelationshipGraph();

  return {
    platform: 'atlas',
    layer: 'atlas_relationship_graph_layer',
    contract: 'read_only_relationship_graph_truth',
    environment: 'safe_redacted',
    graph_version: GRAPH_VERSION,
    generated_at: generatedAt,

    // Safety posture — hard-false by design in this phase.
    read_only: true,
    execution_enabled: false,
    activation_enabled: false,
    production_enabled: false,
    external_send_enabled: false,
    recursive_traversal_enabled: false,
    pathfinding_enabled: false,
    db_backed_graph_storage: false,

    summary,
    nodes,
    edges,
    blocked_actions: BLOCKED_ACTIONS.slice(),

    notes: [
      'The relationship graph is static, read-only topology over the Pack / Agent / Workflow registries.',
      'Each node is a projection of exactly one canonical source row (59 nodes = 23 pack + 18 agent + 18 workflow).',
      'Only two edge types are stored: pack_contains_agent and agent_supports_workflow.',
      'Reverse adjacency is derived by filtering, never stored; there are no inverse edges.',
      'The graph never executes, activates, orchestrates, or production-enables anything.',
      'Status, proof_level, and capability never propagate across edges — each node carries only its own truth.',
      'Node/edge counts are registry topology counts, NOT live-capability metrics.',
      'No recursive traversal, no /paths, no caller-controlled depth, no DB-backed graph storage.',
      'Pack Registry, Workflow Registry, Agent Registry, and Runtime Truth remain conservative and untouched.',
    ],
  };
}

module.exports = {
  buildAtlasRelationshipGraphTruth,
  listAtlasRelationshipGraph,
  getAtlasRelationshipGraphNodeById,
  summarizeAtlasRelationshipGraph,
  validateRelationshipGraph,
  REQUIRED_NODE_FIELDS,
  REQUIRED_EDGE_FIELDS,
};
