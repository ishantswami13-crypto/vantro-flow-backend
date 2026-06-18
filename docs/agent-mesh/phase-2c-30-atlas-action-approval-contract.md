# Phase 2C.30 — Atlas Action Approval Contract

> A static, truthful, **read-only Action Approval Contract** registry. **This Phase 2C.30
> registry** describes, per action class, what approval would be required before an action
> could ever run. This Phase 2C.30 registry creates no approval records and operates no
> approval queue. This Phase 2C.30 registry grants no human approval and introduces no
> execution-after-approval capability. The pre-existing AI Action Center
> (`/api/ai-actions/*`) and the `ai_actions` table are separate, pre-existing systems that
> Phase 2C.30 neither modifies nor relies on.

<!-- ── MACHINE-READABLE MARKERS (verified by scripts/phase-2c-30-atlas-action-approval-check.js) ── -->
<!-- All absence markers below are EXPLICITLY scoped to Phase 2C.30; they are NOT platform-wide claims. -->

PHASE_2C_30_VERSION: 2C.30
ACTION_APPROVAL_READ_ONLY: yes
APPROVAL_RECORDS_CREATED_BY_PHASE_2C_30: no
APPROVAL_QUEUE_OPERATED_BY_PHASE_2C_30: no
HUMAN_APPROVAL_GRANTED_BY_PHASE_2C_30: no
EXECUTION_AFTER_APPROVAL_ENABLED_BY_PHASE_2C_30: no
POLICY_GUARD_TREATED_AS_HUMAN_APPROVAL_BY_PHASE_2C_30: no
LEGACY_AI_ACTION_CENTER_SEPARATE_AND_UNCHANGED: yes
LEGACY_AI_ACTIONS_TABLE_SEPARATE_AND_UNCHANGED: yes
CONTRACT_COUNT: 12
APPROVAL_REQUIRED_COUNT: 11
NO_APPROVAL_REQUIRED_COUNT: 1
BLOCKED_CONTRACT_COUNT: 2
AUTOMATIC_APPROVAL_ALLOWED_COUNT: 0
EXECUTION_ALLOWED_COUNT: 0
ACTIVATION_ALLOWED_COUNT: 0
PRODUCTION_ALLOWED_COUNT: 0
EXTERNAL_SEND_ALLOWED_COUNT: 0
PRODUCTION_SYNC_BLOCKED: yes
DEPLOYMENT_CHANGE_BLOCKED: yes
PRODUCTION_TOUCHED: no

> The counts above are also DERIVED independently from
> `lib/services/atlasActionApprovalRegistry.service.js` by the checker, which inspects
> real registry content (not these markers). Prior-phase conservatism (incl. 2C.25 owner
> approval / canary-scope absence) is re-derived from the 2C.21–2C.29 services and the
> 2C.23/2C.24/2C.25 doc markers. No self-attestation feeds the verdict.

---

## 1. What this phase is

| Artifact | Path | Role |
|----------|------|------|
| Approval registry config | `lib/config/atlasActionApprovalRegistry.js` | Static, frozen approval-requirement contracts (12 action classes) |
| Approval registry service | `lib/services/atlasActionApprovalRegistry.service.js` | Pure read-only builder + validator (fresh copies per call) |
| Proof doc | `docs/agent-mesh/phase-2c-30-atlas-action-approval-contract.md` | This file |
| Fail-closed checker | `scripts/phase-2c-30-atlas-action-approval-check.js` | Static, fail-closed proof (inspects real registry content) |
| Read-only API route | `server.js` + `lib/featureFlags.js` | `GET /api/atlas/action-approvals[/:id]`, default OFF |

**No migration or DB-backed approval storage is added by Phase 2C.30.** This registry is a
static truth model.

## 2. Core guarantees (scoped to Phase 2C.30)

- **Requirement registry only.** Phase 2C.30 creates no approval records and operates no
  approval queue; this read-only contract grants no human approval.
- **No execution by this phase.** For Phase 2C.30 every contract has `execution_allowed=false`,
  `activation_allowed=false`, `production_allowed=false`, `external_send_allowed=false`,
  `automatic_approval_allowed=false`; this phase introduces no execution-after-approval path.
- **policy guard ≠ human approval.** `policyGuard.service.js` is automated policy
  enforcement; this phase does not treat it as human approval.
- **Approval requirement ≠ execution availability** for this phase.

## 2.1 Legacy compatibility (separate, pre-existing, unchanged)

The repository already contains a separate, pre-existing **AI Action Center** —
`GET /api/ai-actions`, `PATCH /api/ai-actions/:id`, `GET /api/ai-actions/counts`,
`POST /api/ai-actions/:id/send-whatsapp` — backed by the `ai_actions` table (which has
approval-related columns). The AI Action Center and `ai_actions` storage
**remain separate and unchanged by Phase 2C.30** — this phase neither modifies nor relies on them.
Their existence is not evidence that this Phase 2C.30 registry provides human-approval
enforcement, and this phase exposes no decision route over them.

## 3. Approval-requirement model (12 action classes)

| Action class | approval_required | mode | min approvers | SoD | status | blocked? |
|---|---|---|---|---|---|---|
| `read_only_analysis` | **false** | none | 0 | no | preview | no |
| `business_record_mutation` | true | single_human | 1 | no | preview | no |
| `financial_commitment` | true | dual_human | 2 | yes | preview | no |
| `external_communication` | true | single_human | 1 | no | preview | no (external send blocked; drafts only) |
| `customer_data_export` | true | dual_human | 2 | yes | preview | no |
| `workflow_activation` | true | single_human | 1 | no | preview | no (activation blocked) |
| `agent_activation` | true | single_human | 1 | no | preview | no (activation blocked) |
| `production_sync` | true | **blocked** | 2 | yes | disabled | **yes** |
| `configuration_change` | true | single_human | 1 | no | custom_required | no |
| `policy_override` | true | **dual_human** | 2 | **yes** | preview | no |
| `deployment_change` | true | **blocked** | 2 | yes | disabled | **yes** |
| `partner_custom_automation` | true | dual_human | 2 | yes | partner_required | no |

- External communication, financial commitment, customer-data export, business-record
  mutation, workflow activation, and agent activation each require explicit human approval.
- Policy override requires explicit human approval AND separation of duties.
- Production sync and deployment change remain blocked; automatic approval is blocked in
  every contract (`automatic_approval_allowed=0`).
- `read_only_analysis` is the only `approval_required:false` class, and it is still
  non-executable.
- For contracts requiring separation of duties, Phase 2C.30 requires at least two distinct
  eligible human approver-role classes and at least two approvers; this is contract
  metadata only and does not prove live identity enforcement.

## 4. Reference integrity

Each contract's `related_packs` / `related_agents` / `related_workflows` reference only
canonical ids from the merged Pack (2C.26, 23), Agent (2C.28, 18), and Workflow (2C.27,
18) registries. The checker validates every reference; there are no orphan references and
no duplicate Pack/Agent/Workflow truth is created.

## 5. Read-only API & route safety

`GET /api/atlas/action-approvals` and `GET /api/atlas/action-approvals/:id` are added
behind `authMiddleware` and the feature flag `FEATURE_ATLAS_ACTION_APPROVAL_API_ENABLED`
(**default OFF**). Order: authentication → feature gate → generic `404` when disabled →
read-only handler. There are **no** `POST`/`PUT`/`PATCH`/`DELETE` routes and no
approve / reject / request / decide / execute / activate / send / sync / deploy endpoint.
No approver identities, customer ids, tokens, or PII are exposed. This route is distinct
from the operational AI Action Center (`/api/ai-actions/*`), which is unchanged.

## 6. Conservatism is unchanged

- Pack (2C.26), Workflow (2C.27), Agent (2C.28), Relationship Graph (2C.29), and Runtime
  Truth (2C.21) all remain conservative and untouched (`live_proven=0`, no execution /
  activation / production).
- 2C.23 `GA_READY: no` / `PRODUCTION_CANARY_READY: no`; 2C.24 `CANARY_READY: no`; 2C.25
  owner approval and canary scope remain absent.
- **Production untouched.** No production DB, no migration, no Railway, no env file, no
  frontend, no deploy. Backend paths only.
- **Phase 2C.31 will add evidence-contract truth; Phase 2C.32 will consolidate launch truth.**

## 7. Why this Phase 2C.30 registry can never approve or run anything

This Phase 2C.30 registry is pure projection of approval *requirements*. This phase adds no
decision code, no record writer, no queue, and no execution path; every safety boolean is
forced false by `defineContract()`. An action becomes approvable/runnable only through a
**future, separately-approved phase** that records explicit owner approval and the
canary-scope record defined in Phase 2C.25 and produces real production-access proofs.
