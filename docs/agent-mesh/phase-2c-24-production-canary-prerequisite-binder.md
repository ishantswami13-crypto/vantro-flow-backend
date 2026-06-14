# Phase 2C.24 — Production Canary Prerequisite Binder

> **Status:** Prerequisite binder only. This phase defines what MUST exist before
> any production canary can be approved. It does **not** run a canary, connect to
> production, deploy, sync, or send. **canary_ready: no.**
> **Branch:** `phase-2c-24-production-canary-prerequisite-binder`
> **Base:** `2867cb5` (origin/performance-bootstrap-cortex-fix-v1, 2C.21+2C.22+2C.23 merged)
> **Scope:** Backend only. No production / Railway / env / frontend / main / DB / deploy / external send.

This binder contains **no secrets** — no `DATABASE_URL`, Supabase keys/refs,
`JWT_SECRET`, tokens, passwords, customer PII, emails, phones, invoice details, or
raw row data. It speaks in **field names, counts, booleans, and status** only.

---

## 0. Machine-readable contract (parsed by the checker)

```
BINDER_VERSION: 2C.24
CANARY_READY: no
PRODUCTION_TOUCHED: no
DEPLOY_APPROVED: no
PRODUCTION_SYNC_APPROVED: no
EXTERNAL_SEND_APPROVED: no
ARTIFACT: real_tenant_map_contract
ARTIFACT: owner_approval_record
ARTIFACT: canary_scope_record
ARTIFACT: production_connectivity_proof_plan
ARTIFACT: production_schema_parity_proof_plan
ARTIFACT: rollback_runbook
ARTIFACT: observability_audit_proof_plan
ARTIFACT: kill_switch_feature_flag_plan
BLOCKED_ACTION: production_db_connection
BLOCKED_ACTION: production_sync
BLOCKED_ACTION: persistent_production_load
BLOCKED_ACTION: external_sending
BLOCKED_ACTION: railway_env_change
BLOCKED_ACTION: deploy
BLOCKED_ACTION: ga_claim
BLOCKED_ACTION: public_production_live_claim
NO_CLAIM: canary_ready
NO_CLAIM: ga_ready
NO_CLAIM: production_live
NO_CLAIM: fully_autonomous_agents
NO_CLAIM: inflated_agent_count
NO_CLAIM: defense_grade_security
```

These markers are contract surface for
`scripts/phase-2c-24-production-canary-prerequisite-check.js`. The checker fails
closed if any `*_READY`/`*_APPROVED` marker is flipped to `yes`, a required
`ARTIFACT` is dropped, a `BLOCKED_ACTION` is removed, or an overclaim phrase
appears. Flipping any decision to `yes` requires a NEW phase with NEW proof
artifacts AND explicit owner approval — never an edit to this binder alone.

---

## 1. Scope and intent

Phases 2C.19–2C.23 built and proved the Neon→Cortex pipeline safety machinery in
staging and static contexts, and pinned the honest decision at
`staging_proven_only` (2C.23): **GA_READY: no**, **PRODUCTION_CANARY_READY: no**.
Seven production-canary blockers remain open (2C.20 §4 + 2C.23 §5):

```
real_tenant_map · production_connectivity_proof · production_schema_parity ·
canary_scope · explicit_owner_approval · rollback_procedure ·
observability_audit_proof
```

Phase 2C.24 is the **prerequisite binder**: it specifies, as machine-readable
contracts and checklists, exactly what each blocker requires before a canary may
be *proposed* — plus a fail-closed static checker that proves the build still
refuses to claim canary readiness. **One new doc, one new checker. No source
changes. No flag changes. No data movement.**

| Artifact | Path |
|----------|------|
| This binder | `docs/agent-mesh/phase-2c-24-production-canary-prerequisite-binder.md` |
| Checker | `scripts/phase-2c-24-production-canary-prerequisite-check.js` |

### 1.1 Blocker classification (what can be done now vs. later)

| Blocker | Class | Closable now (statically)? |
|---------|-------|----------------------------|
| `real_tenant_map` | documentation + approval | Contract definable now (§3); the actual mapping is an owner-approved human decision — blocked. |
| `canary_scope` | documentation + approval | Contract definable now (§4); the scope decision is owner-approved — blocked. |
| `explicit_owner_approval` | approval only | Cannot be produced statically; must remain blocked until the owner records it. |
| `rollback_procedure` | static-provable + later execution | Runbook documented now (§5); batch-rollback already executable in staging (2C.19/2C.20). Production execution needs access later. |
| `production_connectivity_proof` | requires production access later | Plan only now (§2.1); proof needs owner-approved read-only access. |
| `production_schema_parity` | requires production access later | Plan only now (§2.1); proof needs production migration tooling + access. |
| `observability_audit_proof` | plan now + later proof | Plan/contract now (§6); the actual production audit-row proof needs a live canary window. |

### 1.2 Required artifacts (8)

| # | Artifact (marker) | Defined where | State |
|---|-------------------|---------------|-------|
| 1 | `real_tenant_map_contract` | §3 | contract defined; mapping pending owner approval |
| 2 | `owner_approval_record` | §2.2 | template defined; record absent (blocked) |
| 3 | `canary_scope_record` | §4 | contract defined; record absent (blocked) |
| 4 | `production_connectivity_proof_plan` | §2.1 | plan defined; proof absent (needs access) |
| 5 | `production_schema_parity_proof_plan` | §2.1 | plan defined; proof absent (needs access) |
| 6 | `rollback_runbook` | §5 | runbook defined; staging-executable |
| 7 | `observability_audit_proof_plan` | §6 | plan defined; proof absent (needs window) |
| 8 | `kill_switch_feature_flag_plan` | §2.3 | plan defined; flags default-OFF in code |

---

## 2. Required-artifact plans (the ones needing later access)

### 2.1 Production connectivity & schema parity proof plans

`production_connectivity_proof_plan` — before any extract:
- Confirm an IPv4-reachable production Cortex path and a least-privilege,
  **read-only** production Neon credential (direct hosts are IPv6-only; pooler
  required — 2C.18/2C.19). Credentials live ONLY in gitignored env, referenced by
  variable name. The proof artifact records **booleans/counts only** (reachable:
  yes/no, read_only: yes/no), never a URL or secret.

`production_schema_parity_proof_plan` — before any load:
- The `sync_batches` ledger + provenance columns + partial-unique indexes
  (`WHERE source_id IS NOT NULL`) must exist in **production** Cortex, applied via
  the same idempotent, production-ref-blocked migration tooling proven in staging.
  Parity proof records present/absent booleans per object, never schema dumps.

Both plans remain **blocked**: they require explicit owner approval and read-only
access. Their output is still only a doc of booleans/counts.

### 2.2 Owner approval record (`owner_approval_record`) template

A canary may be approved ONLY when a logged owner decision exists. The record must
capture (field names only — no values committed here):
`approver_role`, `approval_timestamp`, `decision` (approve/deny), `scope_ref`
(points at the §4 `canary_scope_record`), `tenant_map_ref` (points at §3),
`rollback_runbook_ref` (points at §5). Owner approval is **never implied by a gate
passing** — absence of this record means BLOCKED.

### 2.3 Kill-switch / feature-flag plan (`kill_switch_feature_flag_plan`)

- The Owner Briefing flag (`FEATURE_OWNER_BRIEFING_AGENT_ENABLED`) is the canary
  kill switch: setting it OFF disables the preview path.
- `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED` stays **default-OFF** — external
  sending disabled throughout the canary.
- The Neon→Cortex sync flag stays **default-OFF** and is a manual operator script,
  not wired into the app — it cannot run itself.
- Rollback = flag OFF, documented and instantaneous; no redeploy required to halt.

---

## 3. REAL_TENANT_MAP_CONTRACT

The Neon org `email`/`gst` fields are NULL/incomplete, so the binding is a recorded
human decision — never auto-derived. This contract is binding on any future canary.

- **no fuzzy matching** — no similarity, no best-guess, no nearest-match resolution.
- **no email/gst auto-match** when source data is null/incomplete — a NULL key may
  never resolve a tenant; it is rejected and counted.
- **explicit human-approved mapping required** — every binding is an exact-integer,
  human-verified `neon_org_id → cortex_user_id` decision.
- **one Neon org maps to one Cortex owner user** — strictly 1:1; no fan-out, no
  shared targets, no many-to-one.
- Unmapped or ambiguous orgs are **rejected + counted**, never silently routed.

**Evidence record per mapping (field names only — no raw values committed):**
`approval_timestamp`, `approver_role`, `source_org_id_redacted` (hash/redacted id),
`target_owner_user_id_redacted` (hash/redacted id), `reason`,
`rollback_batch_strategy`.

**no raw PII** and no secrets appear in any committed mapping doc — redacted/hashed
identifiers only. Any real email, phone, GST, or raw id in a committed file is a
fail-closed violation.

---

## 4. CANARY_SCOPE_CONTRACT

A production canary, when eventually approved, is bound to this scope:

- **one consenting tenant** only — a single tenant that has consented.
- **one batch** only — a single `sync_batch`, never a bulk backfill.
- **read-only dry run first** — a no-write dry run must pass before any load.
- **persistent load only after explicit approval** — recorded in the
  `owner_approval_record` (§2.2); never implied.
- **rollback command ready before load** — the §5 batch-rollback command is staged
  and dry-run-verified BEFORE any persistent write.
- **external sending disabled** — no Twilio/WhatsApp send during the canary.
- **production sync flag default OFF** — enabled only for the single scoped batch,
  then returned OFF.
- **no scheduled or automatic sync** — every run is a manual, owner-authorized,
  single-batch operator action; no cron, no self-trigger.

The `canary_scope_record` (marker) capturing the consenting tenant, the single
batch id (redacted), and the dry-run result is **absent** today → BLOCKED.

---

## 5. ROLLBACK_RUNBOOK

Batch-scoped, fail-closed. Already executable in staging (2C.19 loader
`rollbackBatch`, 2C.20 gate 4); never yet run in production.

- **rollback by sync_batch_id** — `--mode=rollback --batch=<uuid>`; the batch arg
  is required (fail-closed; no batch arg ⇒ no action).
- **dry-run rollback before destructive** — list-only dry run first; destructive
  rollback runs only after the dry run is reviewed.
- **delete/revert order:** `followups → invoices → customers → ledger` — children
  before parents, ledger row closed last.
- **never touch other batches** — the rollback is scoped strictly to the one
  `sync_batch_id`; rows from any other batch are out of bounds.
- **proof after rollback: counts/booleans only** — rows_deleted per table and
  net-zero booleans; no PII, no raw rows.
- **no PII logs** — rollback output is scrubbed; identifiers redacted.

---

## 6. OBSERVABILITY_AUDIT_PLAN

The canary observation window must produce **committed artifacts before GA**; time
elapsed is not proof (2C.23 §3). Required machinery and rules:

- **sync_batches ledger required** — every load opens (`running`) and closes
  (`succeeded` + `finished_at`) a batch; every row is attributable to a batch.
- **counts: inserted / updated / rejected / orphan** — recorded per batch.
- **failure reason categories** — every rejection carries a categorized reason;
  no uncategorized failures.
- **audit user id must be resolved** — every audit row resolves to a real
  JWT-sourced `user_id`.
- **unknown user_id must be rejected** and must never pass — a row whose user_id is
  unknown is rejected, never written with a placeholder.
- **no raw PII logs** — observability emits counts/booleans/status only.
- The canary observation window **must produce committed artifacts before GA** — a
  "clean window" with no committed artifact is UNKNOWN, and UNKNOWN never rounds up
  to PASS.

---

## 7. BLOCKED_UNTIL_EXPLICIT_APPROVAL

Every action below remains BLOCKED until the owner records explicit approval in the
`owner_approval_record` (§2.2). A passing checker does **not** unblock any of them.

| # | Blocked action (marker) | Why blocked |
|---|-------------------------|-------------|
| 1 | `production_db_connection` | No production Neon/Cortex connection without owner-approved read-only access. |
| 2 | `production_sync` | Neon→Cortex sync stays a manual script; no flag wires it; not approved. |
| 3 | `persistent_production_load` | Only after dry-run pass + explicit approval + staged rollback. |
| 4 | `external_sending` | `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED` default-OFF; drafts only. |
| 5 | `railway_env_change` | No Railway/env mutation in this or the canary phase. |
| 6 | `deploy` | Production enablement is a separate, logged owner decision. |
| 7 | `ga_claim` | GA requires recorded clean-canary close proof, which does not exist. |
| 8 | `public_production_live_claim` | No public claim of production live status without production proof. |

---

## 8. Overclaim discipline

This binder asserts none of the `LAUNCH_CLAIMS.blocked` items enumerated in
`lib/config/atlasRuntimeTruth.js`. Specifically it does not assert canary
readiness, GA, production live status, autonomous operation, inflated agent counts,
or defense-grade security. The `NO_CLAIM:` markers in §0 pin these prohibitions;
the checker fails closed if any banned phrase appears. Atlas status labels remain
**proof labels, not marketing labels** (2C.21 doctrine): absence of recorded proof
means UNKNOWN, and UNKNOWN never rounds up to PASS.

---

## 9. How to run

```bash
node scripts/phase-2c-24-production-canary-prerequisite-check.js   # exit 0 = pass
```

Fail-closed: a missing prior artifact, a flipped decision marker, a dropped
required artifact or blocked action, an upgraded 2C.23 decision, a non-zero
`live_proven`, an unblocked Neon→Cortex sync or external send, an overclaim, or any
secret/PII shape in this phase's files fails the run (exit 1). A SHA-256 mutation
guard proves the checker changed nothing on disk. No self-attestation feeds the
verdict — derived scope booleans are display-only.
