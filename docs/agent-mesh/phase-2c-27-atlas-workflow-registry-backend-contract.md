# Phase 2C.27 — Atlas Workflow Registry Backend Contract

> Workflows are the business-PROCESS layer that sits UNDER the Atlas Pack
> Civilization Layer (Phase 2C.26). This phase defines that layer as **read-only,
> proof-gated, non-executable backend truth** — a truth model, not marketing, and
> not anything runnable in this phase.

<!-- ── MACHINE-READABLE MARKERS (verified by scripts/phase-2c-27-atlas-workflow-registry-check.js) ── -->

PHASE_2C_27_VERSION: 2C.27
WORKFLOW_REGISTRY_READ_ONLY: yes
WORKFLOW_REGISTRY_EXECUTES_WORKFLOWS: no
LIVE_PROVEN_WORKFLOWS: 0
EXECUTION_ALLOWED_WORKFLOWS: 0
ACTIVATION_ALLOWED_WORKFLOWS: 0
PACK_REGISTRY_CONSERVATIVE: yes
RUNTIME_TRUTH_CONSERVATIVE: yes
PRODUCTION_TOUCHED: no

> The counts above are also DERIVED independently from
> `lib/services/atlasWorkflowRegistry.service.js` by the checker, and pack/runtime
> conservatism is re-derived from the 2C.26 / 2C.21 services and the 2C.23/2C.24/2C.25
> doc markers. The verdict relies on those derived values; no self-attestation feeds
> the pass/fail decision.

---

## 1. What this phase is

| Artifact | Path | Role |
|----------|------|------|
| Workflow registry config | `lib/config/atlasWorkflowRegistry.js` | Static, frozen workflow truth (18 workflows) |
| Workflow registry service | `lib/services/atlasWorkflowRegistry.service.js` | Pure read-only builder + validator |
| Proof doc | `docs/agent-mesh/phase-2c-27-atlas-workflow-registry-backend-contract.md` | This file |
| Fail-closed checker | `scripts/phase-2c-27-atlas-workflow-registry-check.js` | Static, fail-closed proof |
| Read-only API route (optional) | `server.js` + `lib/featureFlags.js` | `GET /api/atlas/workflows[/:id]`, default OFF |

## 2. Core guarantees

- **Workflow Registry is read-only.** It returns metadata only; it never mutates anything.
- **Workflow Registry does not execute workflows.** There is no execution path, no
  activation path, no production-sync path, no external-send path, no DB write, and no
  background-job trigger anywhere in the config, the service, or the route.
- **`live_proven` workflows = 0.**
- **`execution_allowed` workflows = 0** (forced false by `defineWorkflow()`).
- **`activation_allowed` workflows = 0** (activation requires `live_proven`, of which there are none).
- Every workflow's `output_contract` declares `side_effects: 'none'`, `mutations: false`,
  `external_sends: false`, `production_sync: false` — all forced by `defineWorkflow()`.

## 3. Owner Briefing workflow is honestly bounded

`workflow_owner_briefing_preview` is the only `live_limited` workflow. It maps honestly
to the already-proven, staging-safe Owner Briefing read-only production-canary preview
(Phase 2C.6 / 2C.19). **It is a proof-limited read-side workflow only and is NOT
executable from this registry** (`execution_allowed: false`, `activation_allowed: false`,
`safe_cta: 'Preview'`).

## 4. Allowed statuses & safe CTAs

Allowed statuses: `live_proven`, `live_limited`, `preview`, `connector_required`,
`custom_required`, `partner_required`, `roadmap`, `disabled`.

Safe CTAs (allowlist): `Preview`, `Request Activation`, `Connect Data Source`,
`Configure Custom Workflow`, `Requires Approval`, `View Evidence`, `View Requirements`.

Forbidden CTAs (on no workflow): `Run Now`, `Execute`, `Launch Workflow`,
`Start Automation`, `Send`, `Sync Production`, `Deploy`.

## 5. Preview / custom / roadmap workflows blocked from execution

`preview`, `connector_required`, `custom_required`, `partner_required`, `roadmap`, and
`disabled` workflows are all **blocked from execution and activation**, each recording a
`blocked_reason`. The registry exposes no way to clear these blocks.

## 6. Relationship to the Pack layer

Each workflow lists `related_packs` referencing Phase 2C.26 pack ids (e.g.
`workflow_owner_briefing`, `global_core`, `trader_pack`). These are informational
cross-links only — a workflow **never** requires or triggers pack execution, and the
Pack Registry remains read-only and conservative.

## 7. Optional read-only API route

`GET /api/atlas/workflows` and `GET /api/atlas/workflows/:id` are added behind
`authMiddleware` and the feature flag `FEATURE_ATLAS_WORKFLOW_REGISTRY_API_ENABLED`
(**default OFF**). When the flag is off the route returns a generic `404` after the auth
pattern — identical to the 2C.21 runtime-truth and 2C.26 pack-registry routes. There are
**no** `POST`/`PATCH`/`DELETE` workflow routes, no execution endpoint, no activation
endpoint, no production-sync endpoint, and no external-send endpoint.

## 8. Conservatism is unchanged

- **Pack Registry remains conservative** (2C.26: 23 packs, `live_proven=0`,
  `execution_allowed=0`, `activation_allowed=0`).
- **Runtime Truth remains conservative** (2C.21 `live_proven=0`; 2C.23
  `DECISION_STATE: staging_proven_only`, `GA_READY: no`, `PRODUCTION_CANARY_READY: no`;
  2C.24 `CANARY_READY: no`; 2C.25 `owner_approval_record_present: false`,
  `canary_scope_record_present: false`).
- No GA claim is made. No canary-readiness claim is made. Atlas makes no claim that any
  workflow is live in production. No inflated live-agent counts are claimed.
- **Production untouched.** No production database, no Railway, no env file, no frontend,
  and no deploy are touched by this phase. Backend paths only.

## 9. Why an edit here can never make a workflow live

A workflow becomes runnable only through a **future, separately-approved phase** that
records explicit owner approval and the canary-scope record defined in Phase 2C.25, and
that produces real production-access proofs. Editing this registry, this doc, or flipping
the read-only API flag does **not** and **cannot** activate or execute a workflow — there
is no execution code to reach.
