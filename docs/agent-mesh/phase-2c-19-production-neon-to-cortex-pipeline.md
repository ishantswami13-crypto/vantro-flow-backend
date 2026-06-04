# Phase 2C.19 — Production Neon → Cortex Data Pipeline (SCOPING / DESIGN ONLY)

**Status:** 🔍 SCOPING — read-only design. No code, no migration, no deploy, no production
or Railway changes. Builds on Phase 2C.18 (dedicated staging Cortex DB).

> This document contains **no secrets** — no `DATABASE_URL`, Supabase keys, `JWT_SECRET`,
> tokens, or passwords. Source/target connection strings live only in gitignored env
> (`.env.staging`, Railway), referenced here by **variable name** only.

---

## 1. Problem statement (carried forward from Phase 2C.18 §11)

Owner Briefing and the Agent Mesh read **tenant-scoped evidence** from the **Cortex DB**
(Supabase Postgres: `migrations/001–007` + `supabase-schema.sql`). The real production
application data lives in a separate **Neon** app database. **Today there is no pipeline**
from Neon → Cortex, so production Owner Briefing has no real records to ground claims in
(the RAG Evidence Contract correctly returns `safe_to_show=false` when evidence is empty).

**Goal:** safely flow real production app data (customers, invoices, sales, promises, etc.)
from Neon into the Cortex DB as **`user_id`-scoped, idempotent, audited** records — so Owner
Briefing reflects real data **without ever crossing tenants**.

## 2. Current topology (as built)

```
PRODUCTION (today)                          NEXT (this phase designs)
┌───────────────────┐                       ┌───────────────────┐
│ Neon app DB        │  (real customer/      │ Neon app DB        │  source of truth
│ customers,invoices │   invoice data —      │ (READ-ONLY access) │
│ sales, ... )       │   source of truth)    └─────────┬──────────┘
└───────────────────┘                                  │  extract (watermark/CDC)
                                                        ▼
┌───────────────────┐                       ┌───────────────────┐
│ Cortex DB (Supabase)│ user_id-scoped       │ Sync service       │ transform → resolve user_id
│ owner briefing reads│ evidence read-model  │ (idempotent UPSERT)│ load → audit per batch
└───────────────────┘                       └─────────┬──────────┘
        ▲ (no live data today)                         ▼
                                              ┌───────────────────┐
                                              │ Cortex DB (Supabase)│ user_id-scoped evidence
                                              └───────────────────┘
```

## 3. Data source mapping

### 3a. Target — Cortex DB (confirmed from this repo, read-only)
All Cortex tables are **strictly tenant-scoped**: `user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE`.

| Table | Source file | Tenant key | Natural key (idempotency candidate) |
|-------|-------------|------------|-------------------------------------|
| `customers` | `migrations/001` | `user_id` | `uq_customers_user_name_phone (user_id, lower(name), coalesce(lower(phone),''))` |
| `invoices` | `supabase-schema.sql` / base | `user_id` | needs a stable `source_id` (Neon invoice PK) within `user_id` |
| `public.sales` | `scripts/supabase/phase-2c-10c-script-a` | `user_id` | needs `source_id` within `user_id` |
| `promises` | `migrations/001` | `user_id` | within `user_id` |
| `followups` | `migrations/001` | `user_id` | within `user_id` |
| `business_events` | `migrations/001` | `user_id` | `(user_id, entity_type, entity_id)` indexed |
| `audit_logs` | `migrations/001` | `user_id` | `(user_id, entity_type, entity_id)` indexed |
| `customer_scores`, `cashflow_events` | `migrations/001` | `user_id` | derived, recomputable |

Owner Briefing (`vantro-automation-rs/.../core_owner_briefing.rs`) queries `invoices`,
`customers`, `promises` **`WHERE user_id = $1`**, and emits evidence by `source_type:source_id`
(no raw customer_id — enforced by Phase 2C.18 follow-up / PR #3). So the pipeline must
populate these tables per `user_id` with stable `source_id`s.

### 3b. Source — Neon app DB (NOT in this repo — confirm read-only at implementation)
Relevant tables: `customers, invoices, sales, promises, audit_logs, business_events`.
**Known gap (from brief):** Neon `customers`/`invoices` **lack `user_id`** (no tenant column),
or use a different account/tenant key. The exact Neon schema, PKs, and tenant identifier
**must be confirmed read-only** before implementation (see §9). **Do not assume columns.**

## 4. Schema gaps (the central problem: tenant resolution)

1. **No `user_id` on Neon rows.** Cortex requires `user_id NOT NULL`. Every synced row must
   be assigned the **correct** Cortex `users.id`. This is the highest-risk transform: a wrong
   mapping = cross-tenant leak.
2. **No tenant map yet.** We need an explicit, verifiable mapping `Neon account/owner → Cortex users.id`
   (e.g., a `tenant_map` derived from a shared key such as owner email/phone/account id that
   exists in both systems). Rows whose tenant cannot be resolved **must be rejected**, never guessed.
3. **No stable cross-system `source_id`.** Cortex evidence references `source_type:source_id`.
   We must carry the Neon PK as the Cortex `source_id` (and a `sync_source` discriminator) so
   loads are idempotent and traceable.
4. **Shape/type differences** (amounts, dates, status enums, phone normalization) to reconcile
   in transform — must match Cortex `customers` natural-key normalization (`lower(name)`, phone).

## 5. Proposed pipeline architecture (Extract → Transform → Load → Audit)

**Read-only on Neon; idempotent + audited writes to Cortex only. Staging-first.**

1. **Extract (Neon, read-only):** connect to a Neon **read replica/endpoint** with a
   least-privilege read-only credential (new env var, e.g. `NEON_READONLY_URL` — not the app's
   write URL). Pull incrementally by an `updated_at`/`id` **watermark** (or logical CDC), bounded
   page sizes. Never write to Neon.
2. **Transform (tenant resolution):**
   - Resolve `user_id` for each row via the explicit **tenant map**; **drop + log** any row that
     can't be resolved (fail-closed → no cross-tenant risk).
   - Normalize to Cortex shapes; compute the natural key (e.g. customers `(user_id, name, phone)`).
   - Stamp each record with `sync_source='neon'`, `source_id=<neon pk>`, `sync_batch_id=<uuid>`.
3. **Load (idempotent UPSERT into Cortex):**
   - `INSERT … ON CONFLICT (<natural or source key within user_id>) DO UPDATE` — re-running a
     batch produces zero duplicates and converges to the latest source state.
   - All writes scoped to a single `user_id`; **no cross-tenant bulk writes**.
   - Use the **Supabase service role** (bypasses RLS) exactly as today; never widen anon access.
4. **Audit (every sync):**
   - A `sync_batches` ledger (batch id, started/finished, source watermark, counts:
     inserted/updated/skipped/rejected, status) + per-row mapping in `audit_logs`/`business_events`
     (`entity_type`, `entity_id`, `sync_batch_id`). Every record is attributable to a batch.
5. **Idempotency + replay:** deterministic keys + watermark + batch ledger → safe re-run, resume,
   and **rollback by `sync_batch_id`** (delete/revert just that batch's rows).

## 6. Proof gates (must all pass before any prod enablement)

| Gate | How it is proven |
|------|------------------|
| **No duplicate records** | Re-run the same batch twice → row counts unchanged; UNIQUE/natural-key constraints hold; 0 conflicts produce dupes. |
| **Tenant scoping verified** | For a 2-tenant fixture (OWNER_A/OWNER_B, per Harness X), assert every synced row's `user_id` matches its source tenant; cross-tenant query returns 0 foreign rows; unresolved rows are rejected (not defaulted). |
| **Evidence only from synced records** | Owner Briefing evidence `source_id`s ⊆ synced `source_id`s for that `user_id`; no synthetic/hallucinated evidence (existing RAG contract). |
| **Owner Briefing reflects real prod data** | After a staging sync of a known fixture, `/api/.../owner_briefing` (or live Harness X) shows the expected real records; `safe_to_show=true` only with evidence. |
| **Rollback/delete a sync batch** | `DELETE … WHERE sync_batch_id=$1` (or revert) removes exactly that batch; Owner Briefing returns to prior state; non-destructive to other batches. |
| **No raw PII/customer_id leak** | Serialized evidence carries `source_type:source_id` only (regression-guarded by `core_owner_briefing.rs` tests from PR #3). |
| **Harness X live** | New `cortex-lab` scenarios for the pipeline (sync-idempotency, tenant-isolation, rollback) pass 100/100; `launch_blocker=false`. |

## 7. Risks (ranked)

1. **Cross-tenant mis-mapping (CRITICAL).** Wrong `user_id` resolution leaks one business's data
   into another's briefing. Mitigation: explicit verified tenant map, fail-closed on unresolved,
   tenant-isolation proof gate, staging-first with 2-tenant fixtures.
2. **Neon → Cortex connectivity.** Phase 2C.18 showed Railway↔Supabase **IPv6/direct-`pg`
   unreachable**; the pipeline host must use IPv4-reachable endpoints (pooler) and read-only Neon.
   Validate connectivity read-only before any load.
3. **Partial / interrupted sync.** Mitigation: watermark + batch ledger + idempotent UPSERT → safe resume.
4. **Schema drift (Neon).** Source schema unknown/unstable. Mitigation: confirm read-only (§9),
   pin a contract, reject unexpected shapes.
5. **PII handling.** Customer names/phones flow into Cortex; keep evidence ID-only (already enforced),
   service-role writes only, no new anon exposure.
6. **Backfill volume / Neon read load.** Large initial backfill. Mitigation: paged, throttled,
   off-peak, read replica.
7. **Duplicate/ambiguous natural keys** (same name+phone across real customers). Mitigation: prefer
   stable `source_id` over fuzzy natural key; log ambiguities.

## 8. Rollout plan (proposed, gated)

1. **Staging first** — staging Cortex is already isolated (Phase 2C.18). Build + prove all gates there
   against OWNER_A/OWNER_B fixtures.
2. **Production canary** — one consenting tenant, read-only Neon, single `sync_batch`, verify briefing,
   keep batch-rollback ready. `FEATURE_*` flag gated, OFF by default.
3. **Gradual per-tenant rollout** — never a blind cross-tenant bulk sync.
> Production enablement is out of scope here and requires explicit approval + a separate deploy decision.

## 9. Open questions — confirm READ-ONLY before implementation
- Neon source schema for `customers/invoices/sales/promises/audit_logs/business_events`: exact columns, PKs, and the **tenant/account identifier** present.
- The shared key to build `Neon account → Cortex users.id` (owner email? phone? account id?). Is there an existing mapping?
- Neon read access method: read-replica/endpoint + least-privilege read-only credential (new env var; **not** the app write URL).
- Expected data volume (backfill size, daily delta) → batch sizing/throttling.
- Sync cadence: one-time backfill + incremental (cron) vs event-driven.

---

## Appendix — what is already in place (reusable)
- Cortex target schema is fully `user_id`-scoped with natural keys (this repo) — ready for idempotent UPSERT.
- Staging Cortex DB is isolated (Phase 2C.18); `scripts/apply-sql-file.js` + `staging-migrate.js` patterns exist for safe, idempotent DDL.
- Owner Briefing reads Cortex by `user_id` and emits ID-only evidence (RAG Evidence Contract; PR #3 privacy guard).
- Harness X (`cortex-lab`) live mode + OWNER_A/OWNER_B fixtures can host the pipeline proof scenarios.
