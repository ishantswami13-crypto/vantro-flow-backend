# Phase 2C.29 — Atlas Relationship Graph Contract

> A static, truthful, **read-only relationship graph** connecting the merged Pack
> (2C.26), Agent (2C.28), and Workflow (2C.27) registries into one topology. It is a
> truth model of how those registries relate — it does **not** execute, does **not**
> activate, does **not** orchestrate, does **not** imply production readiness, and does
> **not** touch production.

<!-- ── MACHINE-READABLE MARKERS (verified by scripts/phase-2c-29-atlas-relationship-graph-check.js) ── -->

PHASE_2C_29_VERSION: 2C.29
RELATIONSHIP_GRAPH_READ_ONLY: yes
RELATIONSHIP_GRAPH_EXECUTES: no
GRAPH_NODE_COUNT: 59
PACK_NODE_COUNT: 23
AGENT_NODE_COUNT: 18
WORKFLOW_NODE_COUNT: 18
STORED_EDGE_TYPE_COUNT: 2
EXECUTION_ALLOWED_EDGES: 0
ACTIVATION_ALLOWED_EDGES: 0
PRODUCTION_ALLOWED_EDGES: 0
RECURSIVE_TRAVERSAL: no
PATHS_ROUTE: no
CALLER_CONTROLLED_DEPTH: no
DB_BACKED_GRAPH: no
STATUS_PROPAGATION: no
PROOF_PROPAGATION: no
HIDDEN_AGENT_MULTIPLICATION: no
PACK_REGISTRY_CONSERVATIVE: yes
WORKFLOW_REGISTRY_CONSERVATIVE: yes
AGENT_REGISTRY_CONSERVATIVE: yes
RUNTIME_TRUTH_CONSERVATIVE: yes
PRODUCTION_TOUCHED: no

> The counts above are also DERIVED independently from
> `lib/services/atlasRelationshipGraph.service.js` and re-derived from the source
> registries by the checker; pack/agent/workflow/runtime conservatism is re-derived from
> their own services and the 2C.23/2C.24/2C.25 doc markers. The verdict relies on those
> derived values; no self-attestation feeds the pass/fail decision.

---

## 1. What this phase is

| Artifact | Path | Role |
|----------|------|------|
| Graph config | `lib/config/atlasRelationshipGraph.js` | Static graph: projects the 3 registries into 59 frozen nodes + derived edges |
| Graph service | `lib/services/atlasRelationshipGraph.service.js` | Pure read-only builder + first-degree lookup + validator |
| Proof doc | `docs/agent-mesh/phase-2c-29-atlas-relationship-graph-contract.md` | This file |
| Fail-closed checker | `scripts/phase-2c-29-atlas-relationship-graph-check.js` | Static, fail-closed proof (re-derives from source registries) |
| Read-only API route | `server.js` + `lib/featureFlags.js` | `GET /api/atlas/relationship-graph[/nodes/:id]`, default OFF |

**No DB-backed graph storage is added.** The graph is materialized purely from the
already-merged static registries at module load; nothing is persisted.

## 2. Core guarantees

- **The graph is static and read-only.** It returns topology metadata only; it never
  mutates anything.
- **The graph does not execute orchestration.** No execution, activation, production-
  access, external-send, production-sync, DB-write, background-job, or recursive path.
- **The graph does not activate anything** and **does not imply production readiness**.
- **Exactly 59 canonical source nodes** = 23 Pack + 18 Agent + 18 Workflow (one node per
  source row; shared agents remain a single node even when linked to several packs).
- **Only two edge types are stored:** `pack_contains_agent` (Pack→Agent) and
  `agent_supports_workflow` (Agent→Workflow), derived strictly from `agent.related_packs`
  and `agent.related_workflows`.
- **Reverse adjacency is derived, not stored.** Incoming edges are computed by filtering
  the same static edge array; there is no inverse edge, no two-node cycle.
- **No recursive traversal, no `/paths`, no caller-controlled depth, no DB-backed graph.**
- **No hidden agent multiplication** — the agent node count equals the 18 canonical agents.
- **Node/edge counts are registry topology counts, not live-capability metrics.**

## 3. Node model

Each node projects exactly one canonical source row. Fields: `graph_node_id`,
`source_id`, `node_type`, `source_registry`, `name`, `status`, `proof_level`,
`risk_level`, `execution_allowed`, `activation_allowed`, `production_allowed`.

- `graph_node_id` = `<node_type>:<source_id>` with `source_id` preserved **verbatim**.
  Examples: `pack:global_core`, `agent:core.owner_briefing`,
  `workflow:workflow_owner_briefing_preview` (workflow source ids keep their `workflow_`
  prefix — the namespaced node id is `workflow:` + the unchanged source id).
- `status`, `proof_level`, and `risk_level` are copied from the node's **own** source row;
  `proof_level`/`risk_level` become `null` (never `0`) when the source registry has no
  such field. They are **never** derived from connected nodes.
- `execution_allowed` / `activation_allowed` / `production_allowed` are **preserved** from
  the source (not silently normalized). They are already false in every source registry;
  the checker fails closed if any node ever carries a non-false permission.

## 4. Edge model

Fields: `edge_id`, `source_id`, `source_type`, `target_id`, `target_type`,
`relationship_type`, `required`, `limitations`, `execution_allowed`,
`activation_allowed`, `production_allowed`, `blocked_reason`.

- `edge_id` = `<relationship_type>:<source_node_id>-><target_node_id>` (deterministic,
  collision-safe).
- Stored types: **only** `pack_contains_agent` and `agent_supports_workflow`. No
  `workflow_requires_agent`, no reverse/inverse edge, no Pack→Workflow shortcut, no
  self-loop, no duplicate source/type/target triple.
- Every edge has `required: false` and `execution_allowed`/`activation_allowed`/
  `production_allowed` all **false**, with `blocked_reason: read_only_topology_link`.

## 5. Non-propagation invariants

The graph **never** infers capability, readiness, activation, execution, production
permission, proof level, or status across an edge. Explicitly:

- a `live_limited` Agent does **not** upgrade a Pack or Workflow;
- a `staging_proven` Agent does **not** upgrade a Workflow's proof;
- a `roadmap` Pack does **not** up/down-grade an Agent;
- containment does **not** imply execution; support does **not** imply execution;
  visibility does **not** imply activation; a path does **not** imply orchestration;
- graph-level status is **not** derived from the strongest node;
- edge permissions remain false regardless of node metadata.

## 6. Read-only API & route safety

`GET /api/atlas/relationship-graph` and `GET /api/atlas/relationship-graph/nodes/:id` are
added behind `authMiddleware` and the feature flag
`FEATURE_ATLAS_RELATIONSHIP_GRAPH_API_ENABLED` (**default OFF**). Order: authentication →
feature gate → generic `404` when disabled → read-only handler. The node endpoint returns
only the node plus its **first-degree** outgoing and incoming edges (a single filter over
the static edge array — no nested recursive expansion).

There are **no** `POST`/`PUT`/`PATCH`/`DELETE` routes, no `/paths` route, no caller-
controlled depth parameter, and no execute/activate/run/send/sync/deploy endpoint.

## 7. Conservatism is unchanged

- **Pack Registry** (2C.26): 23 packs, `live_proven=0`, `execution=0`, `activation=0`.
- **Workflow Registry** (2C.27): 18 workflows, `live_proven=0`, `execution=0`, `activation=0`.
- **Agent Registry** (2C.28): 18 agents, `live_proven=0`, `live_limited=1`
  (`core.owner_briefing`/`staging_proven`), `production_canary_proof_count=0`,
  `live_proven_proof_count=0`, all exec/activation/production/external-send 0.
- **Runtime Truth** (2C.21): `live_proven=0`, unchanged (`atlasRuntimeTruth.js` not edited);
  2C.23 `GA_READY: no` / `PRODUCTION_CANARY_READY: no`; 2C.24 `CANARY_READY: no`; 2C.25
  owner/scope records absent.
- **Approval requirements remain metadata for Phase 2C.30; evidence requirements remain
  metadata for Phase 2C.31.** Production and canary remain **blocked**.
- **Production untouched.** No production DB, no migration, no Railway, no env file, no
  frontend, no deploy. Backend paths only.

## 8. Why an edge here can never make anything live

The graph is pure projection: editing it cannot run, activate, or production-enable any
pack/agent/workflow because there is no execution code to reach, every edge permission is
forced false, and orchestration/pathfinding/recursion do not exist. A pack, agent, or
workflow becomes runnable only through a **future, separately-approved phase** that records
explicit owner approval and the canary-scope record defined in Phase 2C.25 and produces
real production-access proofs.
