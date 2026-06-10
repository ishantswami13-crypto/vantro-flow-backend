# Phase 2C.21 — Runtime Truth API + Pack Backend Foundation

> **Status:** Implemented (backend foundation), flag default OFF, awaiting Codex review + Ishant approval
> **Branch:** `phase-2c-21-runtime-truth-api`
> **Base:** `e09a393` (origin/performance-bootstrap-cortex-fix-v1)
> **Scope:** Backend only. No production / Railway / env / frontend / main touched.

---

## 1. Why

Atlas must never fake live capability. Frontend and agents need a single,
read-only contract that states **exactly** what is real, proven, limited,
planned, or blocked — backed by evidence, not marketing.

Before this phase there was no such contract: agent reality was split between a
live `agent_registry` table and a static honesty policy
(`public-vs-internal-agent-claims.md`), with no machine-readable "what is
actually live right now" surface. That is where overstated claims could leak in.

## 2. What was added (smallest safe path)

| Artifact | Path | Role |
|----------|------|------|
| Static registry | `lib/config/atlasRuntimeTruth.js` | Pure data: status enum + packs/agents/workflows + proof gates + launch claims + warnings. No secrets/PII. |
| Service | `lib/services/runtimeTruth.service.js` | Pure builder. No DB, no network. Derives summary counts + safety toggles from the registry and flag booleans. |
| Endpoint | `server.js` → `GET /api/atlas/runtime-truth` | Read-only, `authMiddleware`, gated by `FEATURE_RUNTIME_TRUTH_API_ENABLED`. 404 when OFF (mirrors every agent-mesh endpoint). |
| Feature flag | `lib/featureFlags.js` → `runtime_truth_api_enabled` | Default **OFF** (`=== 'true'`). |
| Static check | `scripts/phase-2c-21-runtime-truth-check.js` | Fail-closed auditor. 14 gates: static source inspection + runtime-object invariants + SHA-256 mutation guard. No self-attestation. Counts/booleans/hashes only. |

## 3. The contract

`GET /api/atlas/runtime-truth` returns:

```jsonc
{
  "platform": "atlas",
  "environment": "safe_redacted",
  "truth_version": "2C.21",
  "generated_at": "<iso>",
  "execution_enabled": false,
  "external_send_enabled": false,        // from FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED (default OFF)
  "production_sync_enabled": false,      // Neon→Cortex is a manual script; no flag wires it
  "summary": {
    "packs_total": 8, "agents_total": 4, "workflows_total": 3,
    "live_proven": 0, "live_limited": 2, "planned": 11, "blocked": 2
  },
  "packs": [ ... ], "agents": [ ... ], "workflows": [ ... ],
  "proof_gates": [ ... ],
  "launch_claims": { "allowed": [ ... ], "blocked": [ ... ] },
  "warnings": [ ... ]
}
```

### Status enum (the only allowed values)

- **`live_proven`** — implemented **and** tool-wired **and** policy-guarded **and**
  audited **and** cost/status tracked (where applicable) **and** proof-gated in
  production. **Currently 0** — nothing has cleared this bar yet.
- **`live_limited`** — **actually enabled and proven in at least a production
  canary**, usable in a restricted mode with clear, listed limitations.
  Staging-only proof does **not** qualify.
- **`planned`** — **not production-live**; never counted as live. Covers **both**
  roadmap-only items **and** capabilities that are fully implemented and
  staging-proven but whose production flag is OFF/not-set.
- **`blocked`** — needs production canary, legal/compliance, missing evidence,
  tenant map, schema parity, or owner approval. `blocked_reason` carries the nuance.

## 4. Honest initial truth (after the 2C.21 truth-hardening pass)

> Hardened by an adversarial verification workflow (independent evidence + skeptic
> per capability). Result: `live_limited` collapsed from 6 → **2**. The only
> live_limited entries are `core.owner_briefing` and its preview workflow — the one
> capability actually enabled as a production canary with a real evidence gate.

**Packs** — **none live at the pack level.**
- Global Core Pack → `planned` (`not_production_live`). Pack-level automation is
  **not** live; only individual read-only previews exist (one as a canary). Keeping
  it below `live_limited` is deliberate — it must never imply live Global Core
  business automation.
- India / UAE / US / UK-EU / Trader / Enterprise / Custom → `planned` (roadmap only).

**Agents**
- `core.owner_briefing` → **`live_limited`** — the *only* live_limited agent.
  Actually flagged **ON as a production canary** (not GA); backed by Phase 2C.19
  evidence gate + 2C.20 readiness gate; evidence flows from staging Cortex until
  the Neon→Cortex pipeline reaches production. Explicitly **not** full production-live.
- `core.data_quality`, `core.policy_guard`, `core.cost_router` → **`planned`**
  (`not_production_live`). **Backend implemented (Rust sidecar + Node client) and
  genuinely proven end-to-end on STAGING** (auth-gated, zero mutations, real run
  evidence in the Phase 2A/2B/2C proof docs) — but their production flags are
  OFF/dormant, so nothing is live in production. Staging verification ≠ production-live.

**Workflows**
- `workflow.owner_briefing_preview` → `live_limited` (production canary preview, not GA).
- `workflow.neon_to_cortex_sync` → `blocked` (`production_canary`).
- `workflow.external_message_send` → `blocked` (`default_off`).

## 4a. Why we underclaim — by design

**Atlas status labels are proof labels, not marketing labels.**

A capability can be fully written, fully tested, and proven on staging and *still*
be labelled `planned` here — because `planned` in this contract means "not
production-live," not "no code exists." We deliberately choose the conservative
label whenever a capability is not actually enabled and proven in production:

- **Overclaiming is a defect.** If the contract said `live_limited` for a
  staging-only, production-OFF agent, a consumer (frontend/agent/marketing) could
  present it as a live production capability. That is the exact failure mode this
  phase exists to prevent.
- **Underclaiming is safe and reversible.** The implementation reality is not
  erased — each `planned` entry's `limitations` and `proof_refs` record that the
  backend exists and is staging-proven, plus the precise gate still missing
  (production flag enablement, owner UI review flow, clean canary). When a
  capability is genuinely enabled and proven in production, it graduates to
  `live_limited` (and only then `live_proven`).
- **One promotion bar, applied uniformly.** `core.owner_briefing` clears it
  (production canary + evidence gate + readiness gate); the other three do not
  (dormant flags). Same rule, honest outcome.

## 5. Safety invariants (enforced by the check script)

> **How the checker proves safety — and why it is not weak / self-attesting.**
> The verdict (`overall_pass`) is computed **only** from independent evidence of
> two kinds: **(A) static source inspection** of the runtime/response-building
> files (`lib/config/atlasRuntimeTruth.js`, `lib/services/runtimeTruth.service.js`)
> and the extracted `/api/atlas/runtime-truth` endpoint block in `server.js`, and
> **(B) runtime-object invariants** built from the pure service and independently
> re-tallied from the raw registry arrays + deep-scanned for PII. It trusts **no
> self-attestation field** — there is no `production_touched: false` literal feeding
> the result. The `informational_only_not_a_pass_condition` block is *derived from*
> those gates for display and is never read by `overall_pass`. A **SHA-256 mutation
> guard** hashes every Phase 2C.21 file before and after the run and fails if the
> checker changed anything on disk. The gates are proven to have **teeth** by an
> adversarial negative-test battery (clean baseline passes; 7 tampered variants —
> overclaim-in-allowed, forbidden `pg` import, injected PII value, removed endpoint
> gate, default-ON flag, overclaimed agent, bogus enum — each correctly rejected).

14 gates, fail-closed, exit 1 on any miss:

1. **Assets exist** — config + service + doc exist; pure service loads; endpoint block extracted.
2. **Strict enum** — every built **and** raw-registry status ∈ {live_proven, live_limited, planned, blocked}; enum is exactly those 4.
3. **Counts independent** — totals + per-status counts recomputed from the **raw registry arrays** match `summary`; `live_proven == 0`; only live-status items counted as live.
4. **Unsafe toggles disabled** — `execution_enabled`, `production_sync_enabled`, `external_send_enabled` false; `environment === "safe_redacted"`; external-send flag default-OFF in source.
5. **Owner Briefing proof-gated** — `live_limited` and references the real 2C.19/2C.20 proofs.
6. **Neon→Cortex** — `blocked` for `production_canary`.
7. **Overclaim regression** — none of `216 live agents` / `fully autonomous finance operations` / `production-live neon` / `live external whatsapp` / `bank-grade` / `military-grade` / `100+ live` / `200+ live` appears in the allowed claims; prohibited claims present in the blocked list.
8. **No forbidden source patterns** — config + service + endpoint contain none of `pg`/`postgres`/`Pool`/`Client`/`createClient`/`supabase`/`fetch(`/`axios`/`http(s).request`/`child_process`/`exec(`/`spawn(`/`writeFile`/`appendFile`/`unlink`/`rm(`/`process.env`/DB-URL/JWT/secret-env patterns.
9. **No PII in runtime object** — deep walk of every key + value: no key like `DATABASE_URL`/`JWT_SECRET`/`SUPABASE`/`RAILWAY`/`PASSWORD`/`SECRET`/`TOKEN`; no value shaped like a DB URL, bearer/JWT, email, phone, Stripe/Razorpay live key, or private key.
10. **Endpoint source** — path `/api/atlas/runtime-truth` with `authMiddleware`; flag gate **and** 404 occur **before** `buildRuntimeTruth`; calls the runtime-truth service; no DB/sync in the handler.
11. **Feature flag source** — `runtime_truth_api_enabled` / `FEATURE_RUNTIME_TRUTH_API_ENABLED` exists; default OFF (`=== 'true'`) in source **and** at runtime; external-send default-OFF; exactly one default-ON flag (the documented `prompt_guard`), so this phase turned on no external-send / production-sync flag.
12. **Conservative labeling** — exactly two `live_limited` items, and they are exactly `core.owner_briefing` + `workflow.owner_briefing_preview`; `data_quality`/`policy_guard`/`cost_router` are `planned`; no pack is `live_limited`.
13. **Path scope** — touched set has no env / Railway / frontend file; backend paths only.
14. **Mutation guard** — SHA-256 of every Phase 2C.21 file is unchanged across the run (checker mutates nothing).

```bash
node scripts/phase-2c-21-runtime-truth-check.js   # exit 0 = pass; 14/14 gates
```

## 6. Remaining blockers (unchanged by this phase)

Production canary remains blocked until: real tenant map, production connectivity
proof, schema parity, canary scope, and explicit owner approval. This phase adds
**no** production capability — it only makes the current honest state legible.

## 7. Rollback

The endpoint is dark by default (`FEATURE_RUNTIME_TRUTH_API_ENABLED` unset → 404).
Rollback = leave the flag unset, or revert the branch. No data, no migrations.
