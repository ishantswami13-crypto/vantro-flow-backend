# Phase 2C.31T — Node Deep Readiness Probe + DB Startup-Packet Investigation (Contract)

Status: **strictly additive repository change.** No Railway change, no deployment, no
migration, no staging data load, no env edit. Nothing below is claimed proven on Railway —
that requires PR, CI, and a staging deploy + observation. `safe_to_load_data` is always
`false`.

---

## 1. Context — the two Node-staging blockers

- **`ENETUNREACH` (IPv6 direct host) — RESOLVED by an env-only pooler fix.** Auto-migration
  previously failed with `ENETUNREACH` because `DATABASE_URL` pointed at the Supabase
  **direct** (IPv6-only) host that Railway's IPv4 egress cannot reach. This was fixed by
  pointing `DATABASE_URL` at the Supabase IPv4 **pooler** URL (owner-approved env change, no
  code). `vantro-node-staging` is now ACTIVE and `/api/health` returns 200.
- **`ESTARTUPPACKETTOOLARGE` — STILL the DB-readiness blocker, until proven resolved.** After
  the pooler fix, auto-migration logs a NON-FATAL `ESTARTUPPACKETTOOLARGE` (PgBouncer
  startup packet ~1145 bytes > the 1024-byte transaction-pooler limit). Until this is proven
  resolved on a deployed staging instance, **DB readiness is NOT proven** and schema
  certainty is NOT established.

This phase does not assume the DB is reachable. It adds a probe that **honestly reports**
DB readiness (it will report `db:fail` while `ESTARTUPPACKETTOOLARGE` persists) and documents
the safe path to a real, pool-wide fix.

---

## 2. What this adds — `GET /api/health/deep`

A new read-only endpoint that reports three independent, fail-closed checks so Node staging
readiness can be proven without touching data:

- **Node liveness** — `node: ok` (the process is serving requests).
- **DB connectivity** — a single `SELECT 1` with a short (2s) timeout, run over the **same
  shared application `pgPool`** that migrations and business queries use. Status:
  `ok` | `fail` | `skipped` (skipped when `DATABASE_URL` is not configured). No table is
  read, no schema is mutated, no row data is returned.
- **Node→Rust connectivity** — reuses the existing fail-closed
  `rustAutomationClient.checkRustHealth()` (a `GET` to the Rust sidecar `/health` only).
  Status: `ok` | `fail` | `disabled` | `missing_url`.

Response shape (safe booleans/status only):

```
{ "success": boolean,
  "checks": { "node": "ok", "db": "ok|fail|skipped", "rust": "ok|fail|disabled|missing_url" },
  "safe_to_load_data": false,
  "timestamp": "...",
  "request_id": "..." }
```

`success` is true only when `node=ok` AND `db=ok` AND `rust` is `ok` or `disabled`
(a configured-but-unreachable Rust sidecar — `fail`/`missing_url` — yields `success=false`).
The endpoint always responds **HTTP 200** while the process is alive; the `success` body
field conveys readiness.

## Route boundaries (unchanged contracts)

- **`/api/health` is liveness only** — `{ status: 'alive', uptime, ... }`. **NOT changed.**
  It remains the Railway liveness gate, so the deep probe cannot accidentally fail liveness.
- **`/api/live` is liveness only** — `{ status: 'live' }`. **NOT changed.**
- **`/api/ready` is env-presence only** — reports `ok`/`missing` for `DATABASE_URL`,
  `JWT_SECRET`, `SUPABASE_URL`, `METRICS_TOKEN` (no values). **NOT changed.**
- **`/api/health/deep` is readiness proof only** — the only new route; additive.

## Safety — what it does NOT do

- Returns no secrets and no environment-variable values.
- Reads no customer or tenant data; queries no business table (only `SELECT 1`).
- Performs no schema mutation, no write, and runs no migration.
- Triggers no agent, no workflow, and no external send.
- Bypasses no auth for business endpoints; changes no business behaviour.
- `safe_to_load_data` is always `false` — this probe never authorizes a data load.

---

## 3. STEP 4 — DB startup-packet (`ESTARTUPPACKETTOOLARGE`) mitigation investigation

**Root cause (confirmed by code read).** Neither pool sets any startup parameter: both the
shared `pgPool` (`server.js`) and the transaction pool (`lib/db/pg.js`) pass only
`connectionString` + `ssl` (+ `max`/timeouts). No code sets `application_name`, `options`,
GUCs, `search_path`, `statement_timeout`, or `client_encoding`. Therefore the oversized
startup packet is produced by the **`DATABASE_URL` query string** — `pg` /
`pg-connection-string` parse those query params and forward them as PostgreSQL startup
parameters. PgBouncer (transaction mode) caps the startup packet at 1024 bytes. This is a
**pool-wide** condition: it affects auto-migration **and** every runtime business query, not
just one path.

**Why a readiness-only "sanitized" client is NOT implemented here (false-green risk).** A
tempting shortcut is to give `/api/health/deep` its own connection that strips the query
params so the probe connects. That is **rejected**: the probe would then report `db:ok`
while the real shared pool (used by migrations and all business queries) still fails the
packet limit — a false green that masks the actual blocker. This violates the "never create
fake green status" rule. The probe therefore deliberately uses the **same shared `pgPool`**
and will report `db:fail` until a genuine, pool-wide fix lands.

**The genuine fix is pool-wide (a separate, report-first change — NOT done in this phase):**

- **Option A — env-only (smallest):** normalize `DATABASE_URL` to drop the nonessential
  query params (retain `sslmode` only if Supabase requires it), via a PRECISE single-variable
  Railway edit with before/after key-presence validation. **Never** the Raw Editor (it
  corrupted variables in a prior incident). Fixes both migration and runtime; no code change.
- **Option B — code-side sanitized config (durable hardening):** parse `DATABASE_URL` and
  build the `pg` config from only host / port / database / user / password + `ssl`
  (preserving `ssl: { rejectUnauthorized: false }`), dropping forwarded query params and
  setting at most a minimal/empty `application_name`, with a short connection timeout. To
  actually fix the blocker this must be applied to **both** pools (`server.js` shared pool and
  `lib/db/pg.js`). Because that changes how every connection (including business queries) is
  established, it requires separate justification and Codex/owner review — it is **reported,
  not silently applied** here.
- **Option C — migration-only sanitized client:** INSUFFICIENT — the packet limit is
  pool-wide, so fixing only the migration path leaves runtime queries broken.
- **Option D — disable auto-migrations on staging:** NOT preferred — auto-migration is
  already non-fatal; disabling it would hide schema uncertainty rather than resolve it. Do
  not mask migration failure.

**Recommendation:** Option A as the smallest safe fix (if the env can be edited precisely),
with Option B as durable hardening; given the prior Raw-Editor incident, the code-side
Option B may be the safer of the two. Either is a **separate change** that this phase does
not implement. Auto-migration behaviour is **unchanged** by this phase; its failure is not
hidden and remains visible in logs.

---

## 4. Scope boundary

The only changes in this phase are: `lib/health/deepReadiness.js` (new), a minimal additive
route in `server.js`, this document, and the phase checker
`scripts/phase-2c-31t-node-deep-readiness-check.js`. **No** frontend, **no** Runtime Truth,
**no** DB schema, **no** migration, **no** production setting, and **no** existing
`/api/health` / `/api/live` / `/api/ready` contract is changed.

## 5. Not proven / not claimed (gates remain closed)

- This phase does **not** prove the staging Node deployment on Railway; that requires PR, CI,
  and a staging deploy + observation of `/api/health/deep`.
- **No production claim.** Nothing here is live in production and nothing is production-ready.
- **Phase 2C.32 remains blocked** — it must not merge until a deployed `/api/health/deep`
  passes and DB readiness is proven.
- **Staging data load remains blocked** — it must not happen until separate schema, tenant,
  dry-run, and rollback approvals are granted. `safe_to_load_data` is always `false`.
