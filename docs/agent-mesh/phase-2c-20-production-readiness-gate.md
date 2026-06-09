# Phase 2C.20 — Production-Readiness Gate (Neon → Cortex pipeline)

**Status:** 🔒 READINESS GATE — static, read-only. No production, no Railway, no
deploy, no env changes, no DB connection, no data load. Builds directly on Phase
2C.19 (`phase-2c-19-production-neon-to-cortex-pipeline.md`), whose staging LOAD +
Owner Briefing Evidence Gate passed (§16–§17). This document defines the bar the
pipeline must clear **before a production canary is even proposed**, and pairs
with a static auditor that proves the bar is met from the repo itself.

> Contains **no secrets** — no `DATABASE_URL`, Supabase keys/refs, `JWT_SECRET`,
> tokens, passwords, or PII. Connections live only in gitignored env
> (`.env`, `.env.staging`, Railway), referenced by **variable name** only.

---

## 1. Purpose

Phase 2C.19 proved the Neon → Cortex sync end-to-end **in staging**: idempotent
load, partial-unique enforcement, tenant isolation, batch rollback, and a fail-
closed Owner Briefing Evidence Gate (`overall_pass=true`). Phase 2C.20 does **not**
load anything. It freezes the **production-promotion contract**: a fixed set of
invariants that must be present and wired before anyone connects this pipeline to
production data. The gate is enforced statically so it can be re-run on every
change without ever touching production.

**Non-goals (explicitly out of scope here):** connecting to production Neon or
production Cortex, enabling any feature flag, deploying, Railway changes, env
mutation, or any data write. Production enablement remains a separate, owner-
approved decision with its own real-ownership tenant map (never the staging-test
routing of §13/§17).

---

## 2. The 12 readiness gates

Each gate is **fail-closed**: a missing file, missing guard, or unmet invariant
fails the gate. There is no "unknown but pass." The static auditor
(`scripts/phase-2c-20-production-readiness-check.js`) asserts each one against the
repo's own pipeline assets and prints **counts/booleans only**.

| # | Gate | Invariant proven (statically) | Primary evidence in repo |
|---|------|-------------------------------|--------------------------|
| 1 | **Environment separation** | Production Supabase ref (`alepdpyqesevldobjxbo`) and `vantro.in` are hard-blocked in the loader, launcher, and evidence gate; staging seed is marked `environment=staging`; loader binds the **staging** URL var, never a raw production `DATABASE_URL`. | `phase-2c-19-neon-cortex-load.js`, `…-launch-staging-sidecar.js`, `…-owner-briefing-evidence-gate.js`, `…-neon-org-map.staging.json` |
| 2 | **Tenant mapping** | Tenant resolution is an **explicit, human-verified, exact-integer** `neon_org_id → cortex_user_id` seed; every entry carries `verified_by`/`verified_at`/`active`; **no fuzzy matching**; unmapped orgs are **rejected + counted**. | `…-neon-org-map.staging.json`, loader `resolveAndValidate` |
| 3 | **Idempotency** | Partial-unique indexes `WHERE source_id IS NOT NULL` on `(user_id, sync_source, source_type, source_id)` for customers/invoices/followups; loader UPSERTs by that key; re-run proves **0 net-new** and stable counts. | `…-staging-sync-schema.sql`, loader `upsert`/`idempotent` |
| 4 | **Rollback** | A `--mode=rollback --batch=<uuid>` path deletes exactly one batch's rows + ledger by `sync_batch_id`; rollback requires the batch arg (fail-closed). | loader `rollbackBatch` |
| 5 | **Evidence contract** | The Owner Briefing gate imports the **authoritative** `enforceEvidenceContract` from production code (`ownerBriefingAgentClient`), not a copy; fails closed when the sidecar is unreachable. | `ownerBriefingAgentClient.js`, evidence-gate import |
| 6 | **Tenant isolation** | Loader proves **0 foreign-`user_id`** synced rows; evidence gate proves OWNER_B sees **no OWNER_A data** and every OWNER_A evidence id ⊆ OWNER_A's real row universe (subset check required). | loader `isolation`, gate `isolationOk`/`evidenceSubsetOk` |
| 7 | **Sync audit ledger** | `sync_batches` ledger exists with `sync_batch_id, sync_source, user_id, status, started_at, counts`; every load **opens** (`running`) and **closes** (`succeeded` + `finished_at`) a batch → every row is attributable. | `…-staging-sync-schema.sql`, loader batch open/close |
| 8 | **Observability** | All operator scripts emit **structured, counts/booleans-only** output (`RESULT_JSON`/`GATE_JSON`/`SIDECAR_LAUNCH`) and **scrub** secrets (URLs/keys/JWTs/PII never printed). | loader `scrub`, gate redaction, launcher labels-only |
| 9 | **Feature flags** | `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED` defaults **OFF**; the sync is a **manual operator script**, **not wired into the app** and **no feature flag enables it** → it cannot run itself in any environment. | `lib/featureFlags.js`, loader header contract |
| 10 | **Canary rollout safety** | Persistent staging load is **fail-closed** behind `ALLOW_PERSISTENT_STAGING_LOAD=true` **and** `--confirm=PERSIST`; proof mode requires a clean staging; design mandates **staging-first** and "production enablement out of scope." | loader persistent guard, design §8 |
| 11 | **No external sending** | The evidence gate calls only the **read-only `/preview`** path, sets `external_send_used=false`, and references **no send endpoint** — proving the readiness path cannot message a customer. | evidence gate, dry-run |
| 12 | **Production rollback readiness** | Batch rollback is **documented and executable** (`--mode=rollback --batch=…` in §17f) and the Owner Briefing feature flag is itself a rollback switch (set OFF). | design §17f, loader rollback, flags |

---

## 3. How to run the static gate

```bash
cd I:/Vantro/vantro-flow-backend
node scripts/phase-2c-20-production-readiness-check.js
```

- **Static & read-only.** No DB connection (Neon, staging, or production), no
  Railway, no deploy, no env mutation, no writes. It only `readFileSync`s the
  pipeline assets and asserts structure.
- **Output:** `READINESS_JSON:` with `overall_pass`, `gates_passed/gates_total`,
  per-gate booleans, asset presence, and a safety self-attestation
  (`production_touched=false`, `db_connection_opened=false`, …). Counts/booleans
  only — never a secret, URL, or row value.
- **Fail-closed:** any missing asset or unmet invariant ⇒ that gate `false` ⇒
  `overall_pass=false` ⇒ exit 1.

---

## 4. Remaining blockers before a production canary (NOT cleared here)

The static gate proves the pipeline's **safety machinery** is in place. It does
**not** authorize production. The following are **out of scope for 2C.20** and
must each be satisfied, with owner approval, before any production canary:

1. **Real-ownership production tenant map.** §13/§17 used a deliberate staging-test
   routing (`org 1 → OWNER_A`). Production requires a **real, human-verified**
   `neon_org_id → production cortex_user_id` map. The Neon org's `email`/`gst`
   are NULL (§11), so the binding is a recorded human decision — never auto-derived.
2. **Production connectivity proof (read-only first).** Confirm an IPv4-reachable
   production Cortex path and a least-privilege read-only **production** Neon
   credential before any extract. (Phase 2C.18/2C.19 showed direct hosts are
   IPv6-only; pooler required.)
3. **Production schema parity.** The `sync_batches` ledger + provenance columns +
   partial-unique indexes (§14/§15) must exist in **production** Cortex, applied
   via the same idempotent, prod-ref-blocked migration tooling.
4. **Canary scope decision.** One consenting tenant, single `sync_batch`, batch-
   rollback staged, behind the relevant `FEATURE_*` flag (OFF by default), with
   the Owner Briefing flag as the kill switch.
5. **Owner approval + separate deploy decision.** Production enablement is an
   explicit, logged owner decision — not implied by this gate passing.

---

## 5. Safety attestation (this phase)

Production touched: **no.** Railway touched: **no.** Deploy: **no.** Neon writes:
**none.** Cortex writes: **none.** Env files changed: **no.** Secrets exposed:
**no.** Frontend touched: **no.** This phase adds a design doc and a static,
read-only auditor only — no data movement, no flag changes, no production contact.
