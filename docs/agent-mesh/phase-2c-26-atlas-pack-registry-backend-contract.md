# Phase 2C.26 — Atlas Pack Registry Backend Contract

> Atlas is AI Business Civilization Infrastructure / BusinessOS. **Packs** are the
> multidimensional operating-model layer for businesses. This phase defines that
> layer as **read-only, proof-gated backend truth** — a TRUTH MODEL, not marketing,
> and **not** anything executable.

<!-- ── MACHINE-READABLE MARKERS (verified by scripts/phase-2c-26-atlas-pack-registry-check.js) ── -->

PHASE_2C_26_VERSION: 2C.26
PACK_REGISTRY_READ_ONLY: yes
PACK_REGISTRY_EXECUTES_PACKS: no
LIVE_PROVEN_PACKS: 0
EXECUTION_ALLOWED_PACKS: 0
ACTIVATION_ALLOWED_PACKS: 0
TRADER_PACK_VISIBLE: yes
ENTERPRISE_PACK_VISIBLE: yes
CUSTOM_PACK_VISIBLE: yes
PRODUCTION_TOUCHED: no
RUNTIME_TRUTH_CONSERVATIVE: yes

> The counts above are also DERIVED independently from
> `lib/services/atlasPackRegistry.service.js` by the checker; the verdict relies on
> the derived values, and the markers must match them. No self-attestation feeds the
> pass/fail decision.

---

## 1. What this phase is

This phase adds three mandatory backend artifacts and one optional read-only route:

| Artifact | Path | Role |
|----------|------|------|
| Pack registry config | `lib/config/atlasPackRegistry.js` | Static, frozen pack truth (23 packs, 12 families) |
| Pack registry service | `lib/services/atlasPackRegistry.service.js` | Pure read-only builder + validator |
| Proof doc | `docs/agent-mesh/phase-2c-26-atlas-pack-registry-backend-contract.md` | This file |
| Fail-closed checker | `scripts/phase-2c-26-atlas-pack-registry-check.js` | Static, fail-closed proof |
| Read-only API route (optional) | `server.js` + `lib/featureFlags.js` | `GET /api/atlas/packs[/:id]`, default OFF |

## 2. Core guarantees

- **Pack Registry is read-only.** It returns metadata only; it never mutates anything.
- **Pack Registry does not execute packs.** There is no execution path, no activation
  path, no production-sync path, and no external-send path anywhere in the config,
  the service, or the route.
- **`live_proven` packs = 0.** Nothing is proven live at the pack level.
- **`execution_allowed` packs = 0.** Every pack is constructed with
  `execution_allowed: false`, forced by `definePack()` regardless of input.
- **`activation_allowed` packs = 0.** Activation requires `live_proven`, of which
  there are none, so every pack is `activation_allowed: false`.
- **The Atlas Pack Civilization Layer is a TRUTH MODEL, not marketing.** Statuses are
  proof labels; preview/custom/roadmap/connector/partner packs are described honestly
  as not-yet-usable, never dressed up as live.

## 3. Pack families and visibility

All twelve required families are present in the backend registry:

`global_core`, `trader`, `enterprise`, `custom`, `business_type`, `business_size`,
`industry`, `region`, `role`, `workflow`, `agent_swarm`, `partner_custom_deployment`.

Specifically requested commercial packs are present and visible in the backend
registry as read-only metadata:

- **Trader Pack visible in backend registry: yes** (`trader_pack`, status `preview`).
- **Enterprise Pack visible in backend registry: yes** (`enterprise_pack`, status
  `custom_required`).
- **Custom Pack visible in backend registry: yes** (`custom_pack`, status
  `custom_required`).

Visible ≠ runnable: each carries `execution_allowed: false`, `activation_allowed:
false`, and a safe call-to-action only.

## 4. Allowed pack statuses (the only values permitted)

`live_proven`, `live_limited`, `preview`, `connector_required`, `custom_required`,
`partner_required`, `roadmap`, `disabled`.

- `live_proven` count is **0** by hard invariant.
- The single `live_limited` pack is `workflow_owner_briefing`, which honestly maps to
  the existing Owner Briefing read-only production-canary preview (Phase 2C.6/2C.19).
  It is still **not executable** from this registry.
- Everything else is `preview`, `connector_required`, `custom_required`,
  `partner_required`, or `roadmap`.

## 5. Safe call-to-action contract

Every pack surfaces exactly one CTA from this allowlist:

`Preview`, `Request Activation`, `Connect Data Source`, `Configure Custom Pack`,
`Requires Approval`, `View Evidence`, `View Requirements`.

The following execution-implying CTAs are forbidden and appear on no pack:
`Run Now`, `Execute`, `Launch Agent`, `Start Automation`, `Send`, `Sync Production`.

## 6. Preview / custom / roadmap packs blocked from execution

`preview`, `connector_required`, `custom_required`, `partner_required`, `roadmap`,
and `disabled` packs are all **blocked from execution and activation**. Each records a
`blocked_reason` (`pack_execution_not_enabled`, `connector_not_connected`,
`custom_configuration_required`, `partner_deployment_required`, `roadmap_not_built`,
or `disabled_by_default`). The registry exposes no way to clear these blocks.

## 7. Blocked actions (what this registry refuses to do or claim)

`pack_execution`, `pack_activation`, `production_sync`, `external_sending`, `deploy`,
`production_db_connection`, `ga_claim`, `canary_ready_claim`,
`public_production_live_claim`.

## 8. Optional read-only API route

`GET /api/atlas/packs` and `GET /api/atlas/packs/:id` are added behind
`authMiddleware` and the feature flag `FEATURE_ATLAS_PACK_REGISTRY_API_ENABLED`
(**default OFF**). When the flag is off the route returns a generic `404` after the
auth pattern — identical to the Phase 2C.21 runtime-truth route. There are **no**
`POST`/`PATCH`/`DELETE` pack routes, no execution endpoint, no activation endpoint, no
production-sync endpoint, and no external-send endpoint.

## 9. Conservatism is unchanged

This phase changes none of the prior posture:

- Phase 2C.21 Runtime Truth still reports `live_proven = 0`.
- Phase 2C.23 still reports `DECISION_STATE: staging_proven_only`, `GA_READY: no`,
  `PRODUCTION_CANARY_READY: no`.
- Phase 2C.24 still reports `CANARY_READY: no`.
- Phase 2C.25 still reports `owner_approval_record_present: false` and
  `canary_scope_record_present: false`.
- **Runtime Truth remains conservative.** No GA claim is made. No canary-readiness
  claim is made. Atlas makes no claim that any pack is live in production. No inflated
  live-agent counts are claimed.
- **Production untouched.** No production database, no Railway, no env file, no
  frontend, and no deploy are touched by this phase. Backend paths only.

## 10. Why an edit here can never make a pack live

A pack becomes usable only through a **future, separately-approved phase** that
records explicit owner approval and the canary-scope record defined in Phase 2C.25,
and that produces real production-access proofs. Editing this registry, this doc, or
flipping the read-only API flag does **not** and **cannot** activate or execute a
pack — there is no execution code to reach.
