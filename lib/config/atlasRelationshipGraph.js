// FILE: lib/config/atlasRelationshipGraph.js
// ─────────────────────────────────────────────────────────────────────────────
// Atlas Relationship Graph — static, honest, READ-ONLY topology truth (Phase 2C.29).
//
// PURPOSE
//   A read-only relationship graph that connects the already-merged canonical
//   registries — Packs (2C.26), Agents (2C.28), Workflows (2C.27) — into a single
//   static topology. Every node is a PROJECTION of exactly one canonical source-
//   registry row; every edge is DERIVED strictly from `agent.related_packs` and
//   `agent.related_workflows`. The graph is a TRUTH MODEL of how these registries
//   relate — never that anything is live, runnable, activatable, or orchestrated.
//
// HARD INVARIANTS (enforced by scripts/phase-2c-29-atlas-relationship-graph-check.js):
//   - exactly 59 nodes = 23 pack + 18 agent + 18 workflow (one node per source row).
//   - exactly two STORED edge types: `pack_contains_agent`, `agent_supports_workflow`.
//   - reverse adjacency is DERIVED by filtering, never stored (no inverse edge).
//   - no Pack→Workflow shortcut, no self-loop, no two-node cycle, no recursion.
//   - status / proof_level / risk_level / capability NEVER propagate across edges:
//     each node carries only its OWN source row's values.
//   - execution_allowed / activation_allowed / production_allowed are PRESERVED from
//     the source (not normalized): they must already be false in every source
//     registry, and the checker fails closed if any is true.
//
// THIS FILE IS PURE STATIC DATA derived deterministically from frozen registries at
// load. NO DB, network, env, filesystem, secrets, PII, tokens, or raw row data —
// only ids, names, statuses, labels, counts, and booleans.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { PACKS } = require('./atlasPackRegistry');
const { AGENTS } = require('./atlasAgentRegistry');
const { WORKFLOWS } = require('./atlasWorkflowRegistry');

const GRAPH_VERSION = '2C.29';

// ── NODE TYPE ENUM — the ONLY allowed node types (one per source registry) ─────
const NODE_TYPE = Object.freeze({
  PACK: 'pack',
  AGENT: 'agent',
  WORKFLOW: 'workflow',
});
const ALLOWED_NODE_TYPES = Object.freeze(Object.values(NODE_TYPE));

// ── SOURCE REGISTRY ENUM — provenance of each node ─────────────────────────────
const SOURCE_REGISTRY = Object.freeze({
  PACK: 'atlas_pack_registry',
  AGENT: 'atlas_agent_registry',
  WORKFLOW: 'atlas_workflow_registry',
});
const ALLOWED_SOURCE_REGISTRIES = Object.freeze(Object.values(SOURCE_REGISTRY));

// ── EDGE TYPE ENUM — the ONLY STORED relationship types ────────────────────────
const EDGE_TYPE = Object.freeze({
  PACK_CONTAINS_AGENT: 'pack_contains_agent',       // Pack → Agent  (from agent.related_packs)
  AGENT_SUPPORTS_WORKFLOW: 'agent_supports_workflow', // Agent → Workflow (from agent.related_workflows)
});
const ALLOWED_EDGE_TYPES = Object.freeze(Object.values(EDGE_TYPE));

// ── EDGE BLOCKED REASON (documentation only) ───────────────────────────────────
const EDGE_BLOCKED_REASON = Object.freeze({
  READ_ONLY_TOPOLOGY_LINK: 'read_only_topology_link',
});

const REQUIRED_NODE_FIELDS = Object.freeze([
  'graph_node_id', 'source_id', 'node_type', 'source_registry', 'name',
  'status', 'proof_level', 'risk_level',
  'execution_allowed', 'activation_allowed', 'production_allowed',
]);

const REQUIRED_EDGE_FIELDS = Object.freeze([
  'edge_id', 'source_id', 'source_type', 'target_id', 'target_type',
  'relationship_type', 'required', 'limitations',
  'execution_allowed', 'activation_allowed', 'production_allowed', 'blocked_reason',
]);

// ── BLOCKED ACTIONS — what this graph refuses to do / claim ────────────────────
const BLOCKED_ACTIONS = Object.freeze([
  'graph_execution',
  'graph_activation',
  'recursive_traversal',
  'pathfinding',
  'arbitrary_depth_expansion',
  'db_backed_graph_storage',
  'status_propagation',
  'proof_propagation',
  'capability_inference',
  'production_sync',
  'external_sending',
  'production_access',
]);

// graph_node_id is DETERMINISTICALLY derived as "<node_type>:<source_id>" with the
// source_id preserved VERBATIM (so workflow node ids retain their `workflow_` prefix,
// e.g. "workflow:workflow_owner_briefing_preview"). One source row → exactly one node.
function graphNodeId(nodeType, sourceId) {
  return nodeType + ':' + sourceId;
}

// projectNode() copies ONLY this row's own truth. proof_level / risk_level become null
// when the source registry has no such field (never 0). The three permission booleans
// are PRESERVED from the source (coerced to a strict boolean but NOT forced false) so a
// non-false source permission survives to be caught fail-closed by the checker.
function projectNode(row, nodeType, sourceRegistry) {
  return Object.freeze({
    graph_node_id: graphNodeId(nodeType, row.id),
    source_id: row.id,
    node_type: nodeType,
    source_registry: sourceRegistry,
    name: typeof row.name === 'string' ? row.name : null,
    status: row.status,
    proof_level: (typeof row.proof_level === 'string' && row.proof_level.length > 0) ? row.proof_level : null,
    risk_level: (typeof row.risk_level === 'string' && row.risk_level.length > 0) ? row.risk_level : null,
    execution_allowed: row.execution_allowed === true,
    activation_allowed: row.activation_allowed === true,
    production_allowed: row.production_allowed === true,
  });
}

// ── THE NODES — one projection per canonical source row (23 + 18 + 18 = 59) ────
const NODES = Object.freeze([
  ...PACKS.map((p) => projectNode(p, NODE_TYPE.PACK, SOURCE_REGISTRY.PACK)),
  ...AGENTS.map((a) => projectNode(a, NODE_TYPE.AGENT, SOURCE_REGISTRY.AGENT)),
  ...WORKFLOWS.map((w) => projectNode(w, NODE_TYPE.WORKFLOW, SOURCE_REGISTRY.WORKFLOW)),
]);

const NODE_ID_SET = Object.freeze(new Set(NODES.map((n) => n.graph_node_id)));

// defineEdge() FORCES the three permission booleans false — an edge is a read-only
// topology link and can never carry execution / activation / production permission.
function defineEdge(sourceType, sourceId, targetType, targetId, relationshipType) {
  return Object.freeze({
    edge_id: relationshipType + ':' + sourceType + ':' + sourceId + '->' + targetType + ':' + targetId,
    source_id: sourceId,
    source_type: sourceType,
    target_id: targetId,
    target_type: targetType,
    relationship_type: relationshipType,
    required: false,                 // topology link only — asserts no requirement
    limitations: Object.freeze(['read_only_topology', 'no_execution', 'no_propagation']),
    execution_allowed: false,        // HARD INVARIANT
    activation_allowed: false,       // HARD INVARIANT
    production_allowed: false,        // HARD INVARIANT
    blocked_reason: EDGE_BLOCKED_REASON.READ_ONLY_TOPOLOGY_LINK,
  });
}

// ── THE EDGES — derived STRICTLY from each agent's related_packs/related_workflows ──
// pack_contains_agent : Pack → Agent     (one per (agent, pack) in agent.related_packs)
// agent_supports_workflow : Agent → Workflow (one per (agent, workflow) in agent.related_workflows)
// Endpoints are validated against NODE_ID_SET; duplicate triples are skipped. No reverse
// edge, no Pack→Workflow shortcut, no self-loop is ever produced by this derivation.
function deriveEdges() {
  const edges = [];
  const seenTriple = new Set();
  const pushEdge = (sType, sId, tType, tId, rel) => {
    const sNode = graphNodeId(sType, sId);
    const tNode = graphNodeId(tType, tId);
    if (!NODE_ID_SET.has(sNode) || !NODE_ID_SET.has(tNode)) return; // skip dangling endpoints
    if (sNode === tNode) return;                                    // never a self-loop
    const triple = rel + '|' + sNode + '|' + tNode;
    if (seenTriple.has(triple)) return;                            // no duplicate triple
    seenTriple.add(triple);
    edges.push(defineEdge(sType, sId, tType, tId, rel));
  };
  for (const a of AGENTS) {
    for (const packId of (a.related_packs || [])) {
      pushEdge(NODE_TYPE.PACK, packId, NODE_TYPE.AGENT, a.id, EDGE_TYPE.PACK_CONTAINS_AGENT);
    }
    for (const wfId of (a.related_workflows || [])) {
      pushEdge(NODE_TYPE.AGENT, a.id, NODE_TYPE.WORKFLOW, wfId, EDGE_TYPE.AGENT_SUPPORTS_WORKFLOW);
    }
  }
  return edges;
}

const EDGES = Object.freeze(deriveEdges());

module.exports = {
  GRAPH_VERSION,
  NODE_TYPE,
  ALLOWED_NODE_TYPES,
  SOURCE_REGISTRY,
  ALLOWED_SOURCE_REGISTRIES,
  EDGE_TYPE,
  ALLOWED_EDGE_TYPES,
  EDGE_BLOCKED_REASON,
  REQUIRED_NODE_FIELDS,
  REQUIRED_EDGE_FIELDS,
  BLOCKED_ACTIONS,
  graphNodeId,
  NODES,
  EDGES,
};
