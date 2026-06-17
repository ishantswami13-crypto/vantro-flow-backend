# Phase 2C.28 — Atlas Agent Registry Hardening / Agent Universe Contract

> Agents are the actor layer that relates to the Atlas Pack Civilization Layer
> (Phase 2C.26) and the Workflow business-process layer (Phase 2C.27). This phase
> defines the **Agent Universe** as **read-only, proof-gated, non-executable backend
> truth** — a truth model, not marketing. It does **not** execute agents, does **not**
> activate agents, does **not** claim hundreds of agents are live, and does **not**
> touch production.

<!-- ── MACHINE-READABLE MARKERS (verified by scripts/phase-2c-28-atlas-agent-registry-check.js) ── -->

PHASE_2C_28_VERSION: 2C.28
AGENT_REGISTRY_READ_ONLY: yes
AGENT_REGISTRY_EXECUTES_AGENTS: no
LIVE_PROVEN_AGENTS: 0
EXECUTION_ALLOWED_AGENTS: 0
ACTIVATION_ALLOWED_AGENTS: 0
PRODUCTION_ALLOWED_AGENTS: 0
EXTERNAL_SEND_ALLOWED_AGENTS: 0
LIVE_LIMITED_AGENTS: 1
PRODUCTION_CANARY_PROOF_COUNT: 0
DATABASE_MIGRATION_CHANGED: no
PACK_REGISTRY_CONSERVATIVE: yes
WORKFLOW_REGISTRY_CONSERVATIVE: yes
RUNTIME_TRUTH_CONSERVATIVE: yes
RUNTIME_TRUTH_LIVE_LIMITED_CHANGED: no
INFLATED_AGENT_COUNT_CLAIM: no
PRODUCTION_TOUCHED: no

> The counts above are also DERIVED independently from
> `lib/services/atlasAgentRegistry.service.js` by the checker, and pack/workflow/runtime
> conservatism is re-derived from the 2C.26 / 2C.27 / 2C.21 services and the
> 2C.23/2C.24/2C.25 doc markers. The verdict relies on those derived values; no
> self-attestation feeds the pass/fail decision.

---

## 1. What this phase is

| Artifact | Path | Role |
|----------|------|------|
| Agent registry config | `lib/config/atlasAgentRegistry.js` | Static, frozen Agent Universe truth (18 agents) |
| Agent registry service | `lib/services/atlasAgentRegistry.service.js` | Pure read-only builder + validator |
| Proof doc | `docs/agent-mesh/phase-2c-28-atlas-agent-registry-hardening.md` | This file |
| Fail-closed checker | `scripts/phase-2c-28-atlas-agent-registry-check.js` | Static, fail-closed proof |
| Read-only API route | `server.js` + `lib/featureFlags.js` | `GET /api/atlas/agents[/:id]`, default OFF |

**No database schema, migration, or table is changed.** `migrations/007_agent_registry.sql`
and its seed (`scripts/seed-agent-registry.js`) are intentionally **untouched**. This phase
is a static read-only contract aligned with the merged Pack (2C.26) and Workflow (2C.27)
registries. DB-backed agent-graph persistence belongs to a later, separately-approved phase.

## 2. Core guarantees

- **Agent Registry is read-only.** It returns metadata only; it never mutates anything.
- **Agent Registry does not execute agents.** There is no execution path, no activation
  path, no production-enable path, no external-send path, no production-sync path, no DB
  write, and no background-job trigger anywhere in the config, the service, or the route.
- **`live_proven` agents = 0.**
- **`execution_allowed` agents = 0** (forced false by `defineAgent()`).
- **`activation_allowed` agents = 0** (forced false; activation requires `live_proven`, none exist).
- **`production_allowed` agents = 0** (forced false by `defineAgent()`).
- **`external_send_allowed` agents = 0** (forced false by `defineAgent()`).

## 3. Honest status & evidence model

Each agent carries independent factual fields — `is_implemented`,
`implementation_evidence` (an in-repo artifact path), `harness_verified`, and
`proof_artifact_refs` (committed artifact paths). **These facts never grant
`live_limited`, execution, activation, or production readiness.** They are decoupled by
design: an agent may be `is_implemented: true` and still be `preview`.

Evidence-derived classification (audited against committed artifacts):

| Agent | Status | is_implemented | harness_verified | Why |
|-------|--------|----------------|------------------|-----|
| `core.owner_briefing` | **live_limited** | true | true | Rust impl `vantro-automation-rs/src/agents/owner_briefing/core_owner_briefing.rs`; agent-specific proof `scripts/phase-2c-19-owner-briefing-evidence-gate.js` + `cortex-lab/scenarios/owner-briefing`. **proof_level: `staging_proven`** — staging-safe, tenant-isolated, evidence-gated, read-only; NO external send, NO production canary, NO GA/production readiness. Matches Phase 2C.21 Runtime Truth (the sole audited `live_limited` agent). |
| `core.data_quality` | preview | true | true | Impl `…/agents/data_quality/mod.rs`; staging proof `phase-2a-data-quality-staging-proof.md` + scenarios. Runtime Truth marks it planned (not the audited `live_limited` surface) → **preview**. |
| `core.policy_guard` | preview | true | true | Impl `…/agents/policy_guard/mod.rs`; staging proof `phase-2b-policy-guard-staging-proof.md` + committed Rust test `policy_guard_fir_regression.rs`. Runtime Truth marks it planned → **preview**. |
| `core.cost_router` | preview | true | true | Impl `…/agents/cost_router/mod.rs`; staging proof `phase-2c-cost-router-staging-proof.md`; default-OFF. Runtime Truth marks it planned → **preview**. |
| 14 domain agents (`finance.cashflow_risk`, `collections.priority_review`, `inventory.pressure_review`, `sales.pipeline_review`, `purchase.supplier_review`, `customer.risk_review`, `governance.approval_review`, `evidence.evidence_review`, `data.source_readiness`, `orchestrator.workflow_planner`, `packs.pack_recommendation`, `enterprise.governance_review`, `custom.operating_model_designer`, `partner.deployment_planner`) | roadmap / connector_required / custom_required / partner_required | false | No implementation exists under these contract ids (whole-tree audit found zero matches). Honest not-yet-built contracts; `proof_artifact_refs: []`. |

**Only `core.owner_briefing` is `live_limited`** — it is the audited, evidence-gated,
tenant-isolated, read-only surface that Phase 2C.21 Runtime Truth recognizes as
`live_limited`, on **staging proof only** (the 2C.19 evidence gate). It claims **no
production canary, no GA, and no production readiness** (`proof_level: staging_proven`).
Antigravity's proposed `live_limited` expansion (cashflow / inventory-cash / data-quality)
is **rejected**: none is the Runtime-Truth-recognized `live_limited` surface, and none has
agent-specific committed proof under its contract id beyond preview level. Code existence
alone does not promote an agent — production canary, GA, and production enablement all
remain **blocked** (2C.23 `PRODUCTION_CANARY_READY: no`, 2C.24 `CANARY_READY: no`, 2C.25
owner/scope records absent), so the production-canary proof count is **0**.

## 4. Allowed statuses & safe CTAs

Allowed statuses (shared Atlas model — identical across packs, workflows, agents):
`live_proven`, `live_limited`, `preview`, `connector_required`, `custom_required`,
`partner_required`, `roadmap`, `disabled`.

Safe CTAs (allowlist): `Preview`, `Request Activation`, `Connect Data Source`,
`Configure Agent`, `Requires Approval`, `View Evidence`, `View Requirements`.

Forbidden CTAs (on no agent): `Run Now`, `Execute`, `Launch Agent`,
`Start Automation`, `Send`, `Sync Production`, `Deploy`.

## 5. Swarms are organizational, not a count claim

The Agent Universe groups agents into 8 launch-truth swarms — Command & Intelligence,
Finance Operations, Revenue & Collections, Supply & Inventory, Governance & Safety,
Evidence & Audit, Data Readiness, Enterprise & Custom Deployment. **A swarm is an
organizational grouping only.** It implies no hidden agents, no executable behavior, and
no multiplied count. Every agent is an explicit row; the registry's claimed agent count
equals the number of concrete rows (18). **No claim is made that 216, 300, 360, or 500
agents are live.** The internal "Atlas Agent Mesh 216" design (`docs/agent-mesh/atlas-agent-mesh-216.md`)
is a proof-gated *design* taxonomy, not a live-agent count, and is explicitly contradicted
here for live-status purposes.

## 6. Relationship integrity (validated statically, never persisted)

Each agent lists `related_packs` (referencing Phase 2C.26 pack ids) and
`related_workflows` (referencing Phase 2C.27 workflow ids). These are informational
cross-links only — an agent **never** requires or triggers pack/workflow execution. The
checker validates every reference against the real `PACKS` / `WORKFLOWS` arrays and
**rejects orphan references**. No relationship is written to any database.

## 7. Read-only API route & route reconciliation

`GET /api/atlas/agents` and `GET /api/atlas/agents/:id` are added behind `authMiddleware`
and the feature flag `FEATURE_ATLAS_AGENT_REGISTRY_API_ENABLED` (**default OFF**).
Authentication runs **before** the feature-flag response; when the flag is off the route
returns a generic `404` — identical to the 2C.21 runtime-truth, 2C.26 pack-registry, and
2C.27 workflow-registry routes. There are **no** `POST`/`PUT`/`PATCH`/`DELETE` agent
routes, no execute/activate/run/send/sync/deploy endpoint.

**Canonical route:** `/api/atlas/agents` is the canonical Atlas-truth agents route — a
sibling of `/api/atlas/packs` and `/api/atlas/workflows`. It is **distinct from** the
pre-existing DB-backed operational route `GET /api/agents/registry` (and
`/api/agents/registry/:agentId`), which this phase neither modifies, duplicates, nor
replaces. The existing per-agent preview/evaluate routes
(`/api/agents/core.*/preview|evaluate`) are likewise untouched and are not re-exposed
through the Atlas namespace.

## 8. Conservatism is unchanged

- **Pack Registry remains conservative** (2C.26: 23 packs, `live_proven=0`,
  `execution_allowed=0`, `activation_allowed=0`).
- **Workflow Registry remains conservative** (2C.27: 18 workflows, `live_proven=0`,
  `execution_allowed=0`, `activation_allowed=0`).
- **Runtime Truth remains conservative and unchanged** (2C.21 `live_proven=0`; its
  `live_limited` count is **not** increased by this phase — `atlasRuntimeTruth.js` is not
  edited; 2C.23 `DECISION_STATE: staging_proven_only`, `GA_READY: no`,
  `PRODUCTION_CANARY_READY: no`; 2C.24 `CANARY_READY: no`; 2C.25
  `owner_approval_record_present: false`, `canary_scope_record_present: false`).
- No GA claim is made. No canary-readiness claim is made. Atlas asserts that no agent
  operates in production. No inflated live-agent counts are claimed.
- **Production untouched.** No production database, no migration, no Railway, no env file,
  no frontend, and no deploy are touched by this phase. Backend paths only.

## 9. Why an edit here can never make an agent live

An agent becomes runnable only through a **future, separately-approved phase** that
records explicit owner approval and the canary-scope record defined in Phase 2C.25, and
that produces real production-access proofs. Editing this registry, this doc, flipping the
read-only API flag, or setting `is_implemented`/`harness_verified` to `true` does **not**
and **cannot** activate, execute, or production-enable an agent — there is no execution
code to reach, and the safety booleans are forced false by `defineAgent()`.
