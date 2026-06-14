# Phase 2C.25 — Owner Approval & Canary Scope Record Intake

> **Status:** Intake-contract only. This phase defines and validates the **format**
> of the owner-approval record and the canary-scope record that a future production
> canary will require. It does **not** approve a canary, connect to production,
> deploy, sync, or send. **canary_ready: false.**
> **Branch:** `phase-2c-25-owner-approval-canary-scope-intake`
> **Base:** `e6223c8` (origin/performance-bootstrap-cortex-fix-v1, 2C.24 merged)
> **Scope:** Backend only. No production / Railway / env / frontend / main / DB / deploy / external send.

This document contains **no secrets** — no `DATABASE_URL`, Supabase keys/refs,
`JWT_SECRET`, tokens, passwords, customer PII, emails, phones, invoice details, or
raw row data. Every example is **redacted / demo-only** with placeholder hashes. It
speaks in **field names, counts, booleans, and status** only.

This phase **does not assume any real tenant approval**. No approval record may pass
without explicit owner-recorded approval fields. Approval intake being *ready*
(`approval_intake_ready: true`) means only that the **contract** exists — never that
an approval has been granted.

---

## 0. Machine-readable contract (parsed by the checker)

```
PHASE_2C_25_VERSION: 2C.25
approval_intake_ready: true
owner_approval_record_present: false
canary_scope_record_present: false
canary_ready: false
production_touched: false
production_sync_approved: false
external_send_approved: false
deploy_approved: false
```

These markers are contract surface for
`scripts/phase-2c-25-owner-approval-canary-scope-intake-check.js`. The checker fails
closed if `approval_intake_ready` is not `true`, if any `*_present`/`*_approved`/
`canary_ready`/`production_touched` marker is flipped to `true`, if a required
contract field is dropped, if a blocked action is removed, or if an overclaim phrase
appears. Flipping any decision to `true` requires a NEW phase with NEW recorded proof
AND explicit owner approval — never an edit to this doc alone.

---

## 1. Scope and intent

Phase 2C.24 pinned the seven production-canary blockers and froze the decision at
`canary_ready: false`. Of those blockers, `explicit_owner_approval` and
`canary_scope` cannot be satisfied by code — they require a **recorded human
decision**. Phase 2C.25 specifies the exact, fail-closed **intake format** for those
two records so that, when the owner eventually decides, the decision is captured in a
machine-checkable shape that cannot be forged by branch existence, CI status, or an
agent.

| Artifact | Path |
|----------|------|
| This intake doc | `docs/agent-mesh/phase-2c-25-owner-approval-canary-scope-intake.md` |
| Checker | `scripts/phase-2c-25-owner-approval-canary-scope-intake-check.js` |

### 1.1 What this phase does and does not do

- **Does:** define the owner-approval record contract, the canary-scope record
  contract, redacted example records, the fail-closed rules, and a static checker.
- **Does NOT:** record an approval, connect to production, run a sync, enable
  sending, deploy, or change any flag/env. All seven canary blockers stay open.

---

## 2. OWNER_APPROVAL_RECORD_CONTRACT

A production canary may be proposed ONLY when an owner-approval record exists with
**every** field below present and valid. Today **no such record exists** →
`owner_approval_record_present: false`.

**Required fields (15):**

```
OWNER_APPROVAL_FIELD: approval_record_id
OWNER_APPROVAL_FIELD: approval_status
OWNER_APPROVAL_FIELD: approver_role
OWNER_APPROVAL_FIELD: approver_identity_hash_or_redacted_id
OWNER_APPROVAL_FIELD: approval_timestamp_utc
OWNER_APPROVAL_FIELD: approval_scope
OWNER_APPROVAL_FIELD: approved_actions
OWNER_APPROVAL_FIELD: explicitly_forbidden_actions
OWNER_APPROVAL_FIELD: approval_expiry_utc
OWNER_APPROVAL_FIELD: rollback_required_before_load
OWNER_APPROVAL_FIELD: external_send_allowed
OWNER_APPROVAL_FIELD: production_sync_allowed
OWNER_APPROVAL_FIELD: deploy_allowed
OWNER_APPROVAL_FIELD: raw_pii_allowed_in_record
OWNER_APPROVAL_FIELD: secrets_allowed_in_record
```

**Fixed-value constraints (the record is rejected if these differ):**

```
approval_status: pending | approved | rejected | expired
rollback_required_before_load: true
external_send_allowed: false
production_sync_allowed: false
deploy_allowed: false
raw_pii_allowed_in_record: false
secrets_allowed_in_record: false
```

**Rules (fail-closed):**

- **no default approval** — absence of a record means BLOCKED, never approved.
- **no implied approval** — approval is never inferred from any other state.
- **no approval from branch existence** — a branch/PR/worktree existing is not consent.
- **no approval from CI green** — green checks prove code, never owner intent.
- **no approval from Claude/Codex** — no agent or reviewer can grant owner approval.
- **no approval from stale docs** — a prior doc is not a live approval.
- **approval must be explicit and owner-recorded** — by the owner, with identity.
- **expired approval fails closed** — `approval_expiry_utc` in the past ⇒ rejected.
- **missing approver identity fails closed** — null/empty identity ⇒ rejected.
- **missing timestamp fails closed** — null/empty `approval_timestamp_utc` ⇒ rejected.
- **approved_actions must be an allowlist, not a broad wildcard** — explicit actions
  only; a wildcard (`*` / "all") is rejected.
- **explicitly_forbidden_actions must include** external sending, deploy,
  Railway/env change, public production live claim, and GA claim unless separately
  approved.

---

## 3. CANARY_SCOPE_RECORD_CONTRACT

A canary, when approved, is bound to a scope record with **every** field below.
Today **no such record exists** → `canary_scope_record_present: false`.

**Required fields (17):**

```
CANARY_SCOPE_FIELD: canary_scope_id
CANARY_SCOPE_FIELD: tenant_count
CANARY_SCOPE_FIELD: tenant_consent_record_present
CANARY_SCOPE_FIELD: tenant_identifier_hash_or_redacted_id
CANARY_SCOPE_FIELD: source_org_identifier_hash_or_redacted_id
CANARY_SCOPE_FIELD: target_owner_user_hash_or_redacted_id
CANARY_SCOPE_FIELD: batch_limit
CANARY_SCOPE_FIELD: dry_run_required_first
CANARY_SCOPE_FIELD: persistent_load_allowed
CANARY_SCOPE_FIELD: rollback_batch_strategy_present
CANARY_SCOPE_FIELD: observation_window_required
CANARY_SCOPE_FIELD: external_send_allowed
CANARY_SCOPE_FIELD: scheduled_sync_allowed
CANARY_SCOPE_FIELD: automatic_sync_allowed
CANARY_SCOPE_FIELD: production_sync_flag_default_off
CANARY_SCOPE_FIELD: raw_pii_allowed_in_record
CANARY_SCOPE_FIELD: secrets_allowed_in_record
```

**Fixed-value constraints (the record is rejected if these differ):**

```
tenant_count: 1
tenant_consent_record_present: true
batch_limit: 1
dry_run_required_first: true
persistent_load_allowed: false
rollback_batch_strategy_present: true
observation_window_required: true
external_send_allowed: false
scheduled_sync_allowed: false
automatic_sync_allowed: false
production_sync_flag_default_off: true
raw_pii_allowed_in_record: false
secrets_allowed_in_record: false
```

**Rules (fail-closed):**

- **one consenting tenant only** — `tenant_count` strictly 1, consent recorded.
- **one batch only** — `batch_limit` strictly 1; no bulk backfill.
- **no fuzzy matching** — no similarity / best-guess / nearest-match resolution.
- **no null/incomplete identifier matching** — a NULL/partial id never resolves a tenant.
- **no email/GST auto-match** — identifiers are explicit redacted ids, never derived
  from email or GST.
- **dry-run proof must exist before persistent load** — `persistent_load_allowed`
  stays false until a recorded dry-run result exists.
- **rollback command must be ready before load** — `rollback_batch_strategy_present`
  must be true before any persistent write.
- **observation artifacts required before any GA claim** — a clean window with no
  committed artifact is UNKNOWN, and UNKNOWN never rounds up to a GA claim.

---

## 4. RECORD_EXAMPLES (redacted / demo-only)

These are **format illustrations only** — placeholder hashes, no real PII, no real
emails, no real phone numbers, no real DB URLs, no real customer names, no real
invoice values. They are NOT a recorded approval (`approval_status: pending`).

Owner-approval record (demo):

```json
{
  "approval_record_id": "appr_demo_only_0001",
  "approval_status": "pending",
  "approver_role": "owner",
  "approver_identity_hash_or_redacted_id": "owner_hash_demo_only",
  "approval_timestamp_utc": "demo_only_utc_not_set",
  "approval_scope": "single_tenant_canary_demo_only",
  "approved_actions": ["dry_run_read_only"],
  "explicitly_forbidden_actions": [
    "external_sending", "deploy", "railway_env_change",
    "production_sync", "public_production_live_claim", "ga_claim"
  ],
  "approval_expiry_utc": "demo_only_utc_not_set",
  "rollback_required_before_load": true,
  "external_send_allowed": false,
  "production_sync_allowed": false,
  "deploy_allowed": false,
  "raw_pii_allowed_in_record": false,
  "secrets_allowed_in_record": false
}
```

Canary-scope record (demo):

```json
{
  "canary_scope_id": "scope_demo_only_0001",
  "tenant_count": 1,
  "tenant_consent_record_present": true,
  "tenant_identifier_hash_or_redacted_id": "tenant_hash_demo_only",
  "source_org_identifier_hash_or_redacted_id": "source_org_hash_demo_only",
  "target_owner_user_hash_or_redacted_id": "target_owner_user_hash_demo_only",
  "batch_limit": 1,
  "dry_run_required_first": true,
  "persistent_load_allowed": false,
  "rollback_batch_strategy_present": true,
  "observation_window_required": true,
  "external_send_allowed": false,
  "scheduled_sync_allowed": false,
  "automatic_sync_allowed": false,
  "production_sync_flag_default_off": true,
  "raw_pii_allowed_in_record": false,
  "secrets_allowed_in_record": false
}
```

---

## 5. BLOCKED_AFTER_2C_25

The intake contract existing does **not** unblock anything. Every action below
remains BLOCKED until a future phase records explicit owner approval AND produces the
required production-access proofs. A passing checker does not unblock any of them.

```
BLOCKED_AFTER_2C25: production_db_connection
BLOCKED_AFTER_2C25: production_schema_parity_proof
BLOCKED_AFTER_2C25: production_connectivity_proof
BLOCKED_AFTER_2C25: persistent_production_load
BLOCKED_AFTER_2C25: production_sync
BLOCKED_AFTER_2C25: external_sending
BLOCKED_AFTER_2C25: railway_env_change
BLOCKED_AFTER_2C25: deploy
BLOCKED_AFTER_2C25: ga_claim
BLOCKED_AFTER_2C25: public_production_live_claim
```

| Blocked action | Why still blocked after 2C.25 |
|----------------|-------------------------------|
| production_db_connection | No production connection without owner-approved read-only access. |
| production_schema_parity_proof | Needs production migration tooling + access (later phase). |
| production_connectivity_proof | Needs owner-approved read-only production credential (later phase). |
| persistent_production_load | Only after dry-run pass + explicit approval + staged rollback. |
| production_sync | Neon→Cortex stays a manual script; no flag wires it; not approved. |
| external_sending | `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED` default-OFF; drafts only. |
| railway_env_change | No Railway/env mutation in this or the canary phase. |
| deploy | Production enablement is a separate, logged owner decision. |
| ga_claim | GA requires recorded clean-canary close proof, which does not exist. |
| public_production_live_claim | No public production live claim without production proof. |

---

## 6. Overclaim discipline

This intake doc asserts none of the blocked launch claims. It does not claim canary
readiness, GA, production live status, autonomous operation, inflated agent counts,
or defense-grade security. Atlas status labels remain **proof labels, not marketing
labels**: absence of a recorded owner approval means BLOCKED, and BLOCKED never
rounds up to approved.

---

## 7. How to run

```bash
node scripts/phase-2c-25-owner-approval-canary-scope-intake-check.js   # exit 0 = pass
```

Fail-closed: a missing prior artifact, a flipped decision marker, a dropped required
contract field, a removed blocked action, an upgraded 2C.24 binder, a non-zero
`live_proven`, an unblocked production sync or external send, an overclaim, or any
secret/PII shape in this phase's files fails the run (exit 1). A SHA-256 mutation
guard proves the checker changed nothing on disk. No self-attestation feeds the
verdict — derived scope booleans are display-only.
