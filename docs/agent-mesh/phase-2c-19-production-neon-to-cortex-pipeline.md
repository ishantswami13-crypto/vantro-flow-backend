# Phase 2C.19 — Production Neon → Cortex Data Pipeline (SCOPING / DESIGN ONLY)

**Status:** 🔍 SCOPING — read-only design. No code, no migration, no deploy, no production
or Railway changes. Builds on Phase 2C.18 (dedicated staging Cortex DB).
**Read-only Neon schema discovery completed 2026-06-04 — see §10. Mapping verification — see §11.**

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

## 10. Read-only schema discovery findings (2026-06-04 · Neon `neondb` · role `atlas_readonly` · PG 17.10)

**Method:** SELECT-only introspection of `information_schema`/catalogs inside a `BEGIN TRANSACTION READ ONLY` via a least-privilege role. **No row values read, no writes, no Neon/Cortex/Railway changes.** Connection referenced by env-var name `NEON_READONLY_URL` only (never printed).

### 10a. Source schema (Neon) — metadata only
Neon `public` has **5 base tables**. There is **no `user_id` column anywhere** — Neon is **organization-scoped**, keyed by `organization_id` → `organizations.id`. **No FK constraints are declared** (referential integrity is application-enforced) and source tables carry **no UNIQUE/natural-key constraints** (only integer PK `id`).

| Neon table | exists | PK | tenant col | timestamp / watermark | source key (idempotency) | → Cortex target |
|---|---|---|---|---|---|---|
| `customers` | ✅ | `id` | `organization_id` | `created_at` | PK `id` (match on `name`,`phone`,`email`) | `customers` |
| `invoices` | ✅ | `id` | `organization_id` | `invoice_date`,`due_date`,`created_at`,`updated_at` | PK `id`; `invoice_number` present but **not unique-constrained** | `invoices` |
| `payment_promises` | ✅ | `id` | `organization_id` | `promised_date`,`created_at` | PK `id` | `promises` |
| `follow_ups` | ✅ | `id` | `organization_id` | `performed_at`,`created_at` | PK `id` | `followups` |
| `organizations` (tenant root) | ✅ | `id` | — (is the tenant) | `created_at`,`onboarding_completed_at` | `email`, `gst_number` (candidate shared keys) | resolve `users.id` |
| `sales` | ❌ missing | — | — | — | — | no source |
| `promises` | ❌ (real name `payment_promises`) | — | — | — | — | — |
| `audit_logs` | ❌ missing | — | — | — | — | Cortex-internal only |
| `business_events` | ❌ missing | — | — | — | — | Cortex-internal only |

Column inventory (names/types only — no values):
- `customers`: id, organization_id, name, phone, whatsapp_number, email, city, status, created_at, total_outstanding, avg_payment_delay_days, preferred_language
- `invoices`: id, organization_id, customer_id, invoice_number, invoice_date, due_date, amount, amount_paid, status, created_at, updated_at, days_overdue, aging_bucket
- `payment_promises`: id, organization_id, customer_id, invoice_id, promised_amount, promised_date, promised_via, notes, status, created_at
- `follow_ups`: id, organization_id, customer_id, invoice_id, activity_type, message_text, performed_at, created_at
- `organizations`: id, name, business_type, city, state, plan, created_at, contact_name, email, company_scale, selected_modules, onboarding_completed, onboarding_completed_at, gst_number

### 10b. Tables found vs missing (vs the planned target set)
- **Found:** `customers`, `invoices` (planned) + `payment_promises` (≙ planned `promises`), `follow_ups` (≙ Cortex `followups`), `organizations` (tenant root).
- **Missing:** `sales`, `audit_logs`, `business_events` — **no Neon source**. Cortex `audit_logs`/`business_events` are populated by the **sync's own batch ledger** (Cortex-side, §5.4), not synced from Neon. `sales` has no source → out of scope unless a source is identified.

### 10c. Tenant mapping options (Neon organization → Cortex `users.id`)
Cortex is **user-scoped** (`user_id UUID REFERENCES users(id)`); Neon is **organization-scoped** (`organization_id INT`). The key spaces differ, so a deterministic bridge is required. Candidate shared keys on `organizations`:
1. **`organizations.email` → Cortex `users.email`** — most likely join, but not unique-constrained in Neon and Cortex side not yet inspected.
2. **`organizations.gst_number`** — stable legal business id; useful only if Cortex stores it.
3. **explicit curated map** `neon_org_id → cortex_user_id`, human-verified once (safest).

### 10d. Blockers / open questions (updated)
- **B1 — Cortex `users` schema not inspected.** This task authorized read-only **Neon** only; no read-only Cortex credential was provided and `DATABASE_URL`/service-role were deliberately not used. Cannot yet confirm `users.email`/`users.phone` exist or are unique. → read-only Cortex check (or confirm from `supabase-schema.sql`).
- **B2 — org→user cardinality undefined.** One Neon `organization` may map to one or many Cortex users; a 1-org→1-user assumption must be confirmed by product/owner.
- **B3 — `organizations.email` not unique / coverage unknown.** Verify uniqueness + null-coverage (aggregate counts, still read-only) before using as a join key.
- **B4 — no DB-level FKs in Neon.** `organization_id`/`customer_id`/`invoice_id` integrity is app-enforced; transform must validate parents and reject orphans.
- **B5 — `sales` has no Neon source**; `audit_logs`/`business_events` are Cortex-internal, not synced.
- ✅ **Resolved from §9:** Neon schema + tenant identifier (`organization_id`) confirmed; read-only access (`NEON_READONLY_URL`, role `atlas_readonly`, SELECT-only) confirmed working.

### 10e. Proposed mapping contract (CONDITIONAL — pending B1–B3, do not implement yet)
An explicit, audited bridge table in **Cortex/staging** (never in Neon):
```
neon_org_map(
  neon_organization_id INT PRIMARY KEY,
  cortex_user_id       UUID NOT NULL REFERENCES users(id),
  match_key            TEXT,            -- e.g. normalized email / gst_number
  match_method         TEXT,            -- 'email' | 'gst' | 'manual'
  verified_by          TEXT,
  verified_at          TIMESTAMPTZ
)
```
- Seed by matching `lower(trim(organizations.email))` → `users.email`; fall back to `gst_number`; **never auto-create on ambiguity or miss** — leave unmapped and log.
- Sync resolves `user_id` via this table **only**; rows for unmapped orgs are **skipped + recorded** (fail-closed → no cross-tenant risk).
- Carry `source_id=<neon pk>`, `sync_source='neon'`, `sync_batch_id` for idempotent UPSERT + batch rollback (§5).

### 10f. Recommended next step (still no sync code, gated)
1. Read-only inspect Cortex `users` (+ `customers/invoices/promises/followups`) to confirm join key + natural keys → resolves **B1**.
2. Read-only **aggregate** check on Neon `organizations.email`/`gst_number` (count, distinct, null) → resolves **B3**. Aggregates only; no row values.
3. Product decision on org→user cardinality → resolves **B2**.
4. Then design the `neon_org_map` seed + a **staging-only dry-run** extract→transform (no load) against OWNER_A/OWNER_B fixtures.

---

## 11. Mapping verification (2026-06-04) — Cortex `users` + Neon aggregates + verdict

Read-only. Cortex side confirmed from **repo files only** (no DB connection). Neon side = **aggregate counts only** via `NEON_READONLY_URL` (no row values). No writes anywhere.

### 11a. Cortex `users` schema (from `supabase-schema.sql` + `scripts/supabase/phase-2c-18-users-schema-align.sql`)
Columns: `id` (UUID PK), **`email` (TEXT UNIQUE NOT NULL)**, `phone` (TEXT, nullable), `business_name`, `password_hash`, `plan`, **`gstin` (TEXT, nullable)**, `address`, `logo_url`, `whatsapp_phone`, `whatsapp_token`, `industry`, `language`, `contact_time`, `created_at`, `updated_at` (+ staging-only: `owner_name`, `city`, `business_size`, `gst_registered`, `has_workers`, `onboarding_done`).
- **email exists: yes · unique: YES (UNIQUE NOT NULL) · fully populated: yes (NOT NULL)**
- **phone exists: yes · unique: NO** (plain TEXT)
- **gstin exists: yes · unique: NO**
- The **only** UNIQUE constraint on `users` is `email` → Cortex offers exactly one deterministic join target: **`users.email`**.

### 11b. Neon `organizations` aggregates (counts only, no values)
| metric | value |
|---|---|
| total_organizations | **1** |
| email_populated | 0 |
| email_null | 1 |
| email_empty_string | 0 |
| email_distinct_norm (nonempty) | 0 |
| **email fully populated** | **false (0% coverage)** |
| gst_number column exists | yes |
| gst_populated | 0 |
| gst_null | 1 |
| gst_empty_string | 0 |
| gst_distinct_norm (nonempty) | 0 |
| **gst_number fully populated** | **false (0% coverage)** |

> "unique among populated" came back vacuously true (0 populated rows) — **not** evidence of a usable key. The decisive fact is **zero coverage**: the single org has NULL `email` and NULL `gst_number`.
> ⚠️ Only **1 organization** exists, with no email/gstin → this Neon DB looks **near-empty / seed-stage**, not a populated production tenant set. Confirm it is the real production app DB before relying on it (blocker **B6**).

### 11c. Candidate join safety
- `organizations.email` fully populated? **No (0/1).** Unique? Vacuous → **not usable as an automatic key now.**
- `organizations.gst_number` fully populated? **No (0/1).** Unique? Vacuous → not usable now.
- Cortex compatible unique field? **Yes — `users.email` (UNIQUE NOT NULL)** — but the Neon side currently has no email value to match against.

### 11d. Cardinality (CONFIRMED 2026-06-04 by owner)
**1 Neon organization → 1 Cortex `users.id` owner workspace (1:1).** `neon_org_map` is therefore a clean 1:1 PK bridge (`neon_org_id` PK → exactly one `cortex_user_id`).

### 11e. MAPPING VERDICT: **B — SAFE WITH MANUAL MAP**
Automatic email→email mapping (verdict A) is **not possible**: `organizations.email` and `gst_number` are both NULL (0% coverage), so there is no deterministic value to join on — even though both sides have the right *columns* and `users.email` is unique. Not verdict C either: a safe bridge is achievable via an **explicit, human-verified `neon_org_map`** seed (one row, since one org). The mapping must be **manual**; no automatic fuzzy matching; unresolved orgs rejected + logged.

### 11f. `neon_org_map` contract (design only — do not implement)
```
neon_org_map(
  neon_org_id            INT          PRIMARY KEY,        -- Neon organizations.id
  verified_external_key  TEXT,                            -- owner email / gstin used to confirm (nullable; manual allowed)
  cortex_user_id         UUID NOT NULL,                   -- REFERENCES users(id)
  mapping_source         TEXT NOT NULL,                   -- 'manual' | 'email' | 'gstin'
  verified_by            TEXT NOT NULL,
  verified_at            TIMESTAMPTZ NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes                  TEXT,
  active                 BOOLEAN NOT NULL DEFAULT true
)
```
Resolution rules (future sync):
- Every Neon row resolves its tenant **only** via `neon_org_map` (active = true).
- Unresolved `organization_id` → row **rejected + logged** (fail-closed); never defaulted, never guessed.
- **No automatic fuzzy matching**; every binding is human-verified.
- Loaded Cortex rows stamped with resolved `user_id`, `source_id = <neon pk>`, `sync_source = 'neon'`, `sync_batch_id`.

### 11g. Blockers / next gate
- **B6 — RESOLVED (owner-confirmed 2026-06-04):** This **is** the real production app DB, just **early-stage** — ~1 org and sparse data today, so **current backfill volume ≈ 0**. Sync design may proceed; expect effectively nothing to sync until real tenants/data arrive.
- **B2 — RESOLVED (owner-confirmed):** **1 org → 1 Cortex owner user (1:1).**
- **B1 — RESOLVED:** Cortex `users.email` is UNIQUE NOT NULL (repo-confirmed); deterministic join target exists.
- **B3 — RESOLVED (by data):** email/gst coverage is 0% → automatic key not viable → **manual map required**.
- **No open blockers.** **Next gate:** author the `neon_org_map` seed (1 verified row: the single Neon `organization_id` → its verified `cortex_user_id`) in **staging Cortex**, then a **staging-only dry-run** extract→transform (no load) on OWNER_A/OWNER_B fixtures. No production and no sync code until that dry-run passes the §6 proof gates.

---

## 12. Dry-run proof (2026-06-04) — staging-only, NO LOAD

**Scope:** read-only Neon (`atlas_readonly`, `BEGIN TRANSACTION READ ONLY`) → resolve `organization_id` via the explicit `neon_org_map` seed → **manual parent validation** (Neon has no DB-level FKs) → normalize to Cortex shapes **in memory** → **NO load** (no Cortex/Supabase connection, no insert/upsert, no deploy, no migrations, no Railway). Script: `scripts/phase-2c-19-neon-cortex-dry-run.js`; seed: `scripts/phase-2c-19-neon-org-map.staging.json` (staging-only, OWNER_A fixture). Counts/shapes only — **no Neon row values printed**.

### 12a. Extracted counts (read-only)
`customers=5 · invoices=8 · payment_promises=0 · follow_ups=5` → total **18**.

### 12b. Fail-closed proof (empty seed)
With **no** seed entry, every row is rejected: **resolved=0, rejected_unresolved_org=18, normalized=0** — nothing passes without an explicit mapping.

### 12c. Seeded proof (org 1 → OWNER_A, manual/verified)
**resolved_valid=18, rejected_unresolved_org=0, rejected_orphan=0.** All 8 `invoices.customer_id` resolve to the 5 customers; all 5 `follow_ups` parents present → **0 orphans**. **Repeatable:** two consecutive runs produced identical counts.

### 12d. Normalized shape summary (field names only)
- **customer:** `user_id, source_type, source_id, name, phone, email, status, natural_key, sync_source`
- **invoice:** `user_id, source_type, source_id, customer_source_id, invoice_number, amount, amount_paid, status, due_date, sync_source`
- **followup:** `user_id, source_type, source_id, customer_source_id, invoice_source_id, activity_type, performed_at, sync_source`
- **promise:** none produced (0 source rows)

### 12e. Evidence-eligible
**13** (8 invoices + 5 customers + 0 promises), shape **`{user_id, source_type, source_id}` only** — no raw `customer_id`/PII.

### 12f. Proof gates — ALL PASS (`loaded=false`)
no Neon writes · no Cortex/production writes · row accounting balances · no unresolved rows pass · mapping explicit/manual · no fuzzy matching · output user_id-scoped · evidence ⊆ resolved · no raw customer_id leak in evidence. → **No Neon writes · No Cortex writes · No production touched.**

### 12g. B6 correction (IMPORTANT)
§11g recorded "backfill ≈ 0". **That was wrong.** Neon org 1 has NULL `email`/`gst_number` (no automatic shared key) **but does contain 18 real child rows** (5 customers, 8 invoices, 5 follow-ups). **Real data exists** and is worth syncing — but because email/gst are NULL, an **explicit, human-verified** mapping is **mandatory before any load** (no automatic match is possible).

### 12h. Pre-load gate (MUST pass before any staging load)
The dry-run binding `org 1 → OWNER_A` is a **placeholder for proof only — not production truth.** Before any staging *load*, an operator must verify: (1) the target `cortex_user_id` (OWNER_A or the correct owner) **exists in staging Cortex `users`**, and (2) Neon org 1 **genuinely belongs to that owner.** Since Neon org email/gst are NULL, this is a human decision recorded in `neon_org_map` (`verified_by`/`verified_at`), never auto-derived.

---

## 13. Pre-load gate clearance (2026-06-04) — staging-test routing, NO LOAD

§12h pre-load checks cleared for a **staging-test load proof only** (NOT production truth):
- **B7 (staging connectivity) — CLEARED via Supabase REST.** The direct `STAGING_DATABASE_URL` host is unreachable from local (IPv4/IPv6 direct-connection limit, per §7.2). OWNER_A existence was instead confirmed through the **staging Supabase REST API** (service role, staging project ref): **`owner_a_exists=true`, `matching_user_count=1`** (booleans/counts only; no PII, no keys/URLs printed).
- **B8 (ownership) — CLEARED for STAGING-TEST routing only.** Operator **Ishant** confirmed deliberate routing of Neon org 1 → OWNER_A for the isolated staging load proof. **Not production truth, not real-world ownership** (Neon org 1 email/gst are NULL → no automatic match possible).
- **Neon org 1** re-confirmed read-only: exists; child counts `customers=5 invoices=8 payment_promises=0 follow_ups=5`.
- **Seed promoted** → `scripts/phase-2c-19-neon-org-map.staging.json` is now a **verified staging-load seed**: `mapping_source=manual_staging_test_routing`, `verified_by=Ishant`, `verified_at=2026-06-04T12:35:34.574Z`, `active=true`, `seed_status=staging_load_verified`.
- **No load performed** — no Cortex/Neon writes, no upsert, no deploy, no Railway changes.

**Gate state:** ready for the **staging LOAD** step (idempotent UPSERT into staging Cortex + `sync_batches` ledger + §6 live proofs). Production remains out of scope and would require its own **real-ownership** mapping — never this staging-test routing.

---

## 14. Staging LOAD attempt (2026-06-04) — BLOCKED: target schema not ready (NO LOAD, NO WRITES)

Preflight via staging Supabase REST (service role, read-only, `limit=0`, counts/booleans only). **Load was NOT attempted** — staging Cortex lacks the required sync schema. **No Cortex writes, no Neon writes, no migrations, no deploy.**

**Preflight results:**
- Staging REST reachable; **OWNER_A count=1, OWNER_B count=1** (both exist → tenant-isolation test is possible once schema is ready).
- Neon read-only extraction/transform re-confirmed: `extracted=18, resolved=18, rejected=0, orphan=0, evidence-eligible=13` (no load).
- Content tables present: `users, customers, invoices, followups, promises, business_events, audit_logs`.
- **`sync_batches` ledger table: MISSING.**
- **Sync provenance columns MISSING:**
  - `customers`: `source_type, source_id, sync_source, sync_batch_id` (all missing; `user_id` present)
  - `invoices`: `sync_source, sync_batch_id` (missing; `source_type, source_id, user_id` already present)
  - `followups`: `source_type, source_id, sync_source, sync_batch_id` (all missing; `user_id` present)
- `required_target_schema_ready = false`.

**Exact STAGING schema required before load (review + approve; apply via staging-only tooling — NOT run here):**
1. **`sync_batches`** ledger: `sync_batch_id uuid pk`, `sync_source text not null`, `user_id uuid null references users(id)`, `status text not null`, `started_at timestamptz not null default now()`, `finished_at timestamptz`, `source_watermark text`, `counts jsonb`.
2. **ADD COLUMN IF NOT EXISTS** — `customers` & `followups`: `source_type text, source_id text, sync_source text, sync_batch_id uuid`; `invoices`: `sync_source text, sync_batch_id uuid`. (Match `invoices`' existing `source_type`/`source_id` types for consistency.)
3. **UNIQUE constraint for idempotency** on each content table, e.g. `UNIQUE (user_id, sync_source, source_type, source_id)` — without it, re-running the load would create duplicates (idempotency gate would fail). `customers` retains its existing `uq_customers_user_name_phone` natural key as well.

**Decision:** STOP per the pre-load rules (missing `sync_batches`/columns/conflict-constraints → report, do not migrate). **Not a launch blocker** — the Neon→Cortex sync is feature-flag OFF and Owner Briefing correctly returns `safe_to_show=false` with no evidence. **Next gate:** review + approve the staging schema above → apply via staging-only migration tooling (`apply-sql-file.js`/`staging-migrate.js`, which block the production ref) → re-run the staging LOAD + §6 live proofs.

---

## 15. Staging schema enablement (2026-06-04) — APPLIED via Supabase SQL Editor + REST-verified (NO LOAD)

Reviewable idempotent staging-only migration: **`scripts/supabase/phase-2c-19-staging-sync-schema.sql`**. **Applied manually via the staging Supabase SQL Editor** (project `vantro-cortex-staging-db`) — the local env can't reach the direct PG host (IPv6-only) and REST can't run DDL, so the operator ran it in the SQL Editor (`sync_batches` created with RLS enabled). **No production, no Neon writes, no Railway, no deploy, no data load.**

**Migration contents (idempotent; `CREATE`/`ADD COLUMN`/`CREATE INDEX … IF NOT EXISTS`; no `DROP`):**
- `sync_batches(sync_batch_id uuid pk, sync_source text not null, user_id uuid null references users(id), status text not null, started_at timestamptz default now(), finished_at timestamptz, source_watermark text, counts jsonb default '{}', notes text)`.
- ADD COLUMN — customers `(source_type, source_id, sync_source, sync_batch_id)`; invoices `(sync_source, sync_batch_id)` (source_type/source_id already present); followups `(source_type, source_id, sync_source, sync_batch_id)`.
- **PARTIAL UNIQUE INDEX** `WHERE source_id IS NOT NULL` on customers/invoices/followups `(user_id, sync_source, source_type, source_id)` — idempotency anchor for **synced rows only** (native rows unconstrained; cannot fail on existing data since 0 synced rows).
- Helper indexes: `sync_batches(sync_source, user_id, started_at desc)`, and `(sync_batch_id)` on customers/invoices/followups.

**Verified via staging REST (read-only, 2026-06-04):**
- `sync_batches` **exists** — columns `sync_batch_id, sync_source, user_id, status, started_at, counts` all present.
- `customers` / `invoices` / `followups` — **all four** provenance columns (`source_type, source_id, sync_source, sync_batch_id`) present on each.
- **No-data-load confirmed:** `sync_batches` row count = 0; rows with `sync_source='neon'` = 0 and rows with `sync_batch_id` = 0 across all three tables.
- **Indexes** (`uq_customers_sync_src`, `uq_invoices_sync_src`, `uq_followups_sync_src`, `ix_sync_batches_src_user_started`, `ix_{customers,invoices,followups}_sync_batch`): **not introspectable via PostgREST** (pg_catalog not exposed) → operator-reported as created; **functional proof deferred to the LOAD idempotency gate** (a re-run UPSERT producing 0 duplicates proves the partial unique index is enforcing).

**Schema blocker CLEARED.** **Next gate:** staging LOAD proof — idempotent UPSERT (REST `Prefer: resolution=merge-duplicates` on `(user_id, sync_source, source_type, source_id)`) + `sync_batches` ledger + §6 live proofs (0-dupe re-run, OWNER_A/OWNER_B isolation, rollback-by-batch, Owner Briefing evidence). No production; no data load until that gate runs.

---

## Appendix — what is already in place (reusable)
- Cortex target schema is fully `user_id`-scoped with natural keys (this repo) — ready for idempotent UPSERT.
- Staging Cortex DB is isolated (Phase 2C.18); `scripts/apply-sql-file.js` + `staging-migrate.js` patterns exist for safe, idempotent DDL.
- Owner Briefing reads Cortex by `user_id` and emits ID-only evidence (RAG Evidence Contract; PR #3 privacy guard).
- Harness X (`cortex-lab`) live mode + OWNER_A/OWNER_B fixtures can host the pipeline proof scenarios.
