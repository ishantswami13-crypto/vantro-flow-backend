# Phase 2C.31W — Runtime PG Startup-Packet Proof + Final Hardening

**Status:** implemented (code-side), pending Codex review + owner commit. NOT committed, NOT
pushed, NOT deployed. (This revision, 2C.31W-R, repairs the Codex-blocked first cut.)

**Base:** `performance-bootstrap-cortex-fix-v1` @ `c9f83939ea0a496eb858d5b820800866b68a990b`
(the deployed 2C.31V commit).

---

## 1. Deployed truth before this phase

Phase 2C.31V deployed correctly and reduced the startup packet, but the live DB still fails:

| Probe | Result |
|-------|--------|
| `/api/health` | **pass** |
| `/api/health/deep` → node | **ok** |
| `/api/health/deep` → rust | **ok** |
| `/api/health/deep` → db | **fail** |
| `ENETUNREACH` | **absent** |
| `ESTARTUPPACKETTOOLARGE` | **present** |
| startup packet size | **1145 bytes** (was 1209 at 2C.31U; max **1024**) |
| `safe_to_load_data` | **false** |
| crash loop | none |

2C.31V's env-fallback clearing reduced the packet by only **64 bytes** (1209 → 1145). It is
still **121 bytes over** the limit.

---

## 2. The exact byte model (corrected) — `client_encoding=UTF8` is always counted

This phase proves the startup fields **by byte length only**, using the byte model from the
**lockfile-pinned** driver (`pg@8.21.0` + `pg-protocol@1.14.0`, pinned in `package-lock.json`).
We do **not** assume `node_modules` is present (it is absent in a fresh worktree/CI). The
authoritative `pg-protocol@1.14.0` `startup` serializer is:

```
writer.addInt16(3).addInt16(0)                          // 4-byte protocol version 3.0
for (key of opts) writer.addCString(key).addCString(opts[key])
writer.addCString('client_encoding').addCString('UTF8') // ALWAYS appended by the serializer
bodyBuffer = writer.addCString('').flush()              // 1-byte final NUL terminator
length = bodyBuffer.length + 4                           // 4-byte Int32 length prefix
```

So the packet is:

```
total = 4 (length) + 4 (protocol) + Σ_present(byteLen(key)+1 + byteLen(value)+1)
        + 21 (client_encoding=UTF8 pair) + 1 (final NUL)
```

`opts` come from `pg` `getStartupConf()`: always `user` + `database`; and `application_name`
(= `application_name` || `fallback_application_name`), `replication`, the three `*_timeout`
fields, and `options` **only when truthy**. `password`/`host`/`port` are **not** in the
startup packet.

**Minimal proof:** `user = database = 'postgres'` → `9 (framing) + 14 (user) + 18 (database) +
21 (client_encoding=UTF8) = 62 bytes`. (The first cut wrongly omitted `client_encoding` and
reported 41 — fixed.)

**Live diagnosis:** with our config (env-fallbacks cleared, no app/options/timeouts), the only
present `opts` are `user` + `database`, so `total = 46 + len(user) + len(database)`. The live
**1145** ⇒ `len(user) + len(database) ≈ 1099 bytes`. Normal pooler credentials are tiny
(~58 bytes total). A ~1099-byte `user`/`database` means the **`DATABASE_URL`'s username or
database segment is malformed or oversized** — an **environment/credential** problem, not a
code defect. (It cannot be a leftover env-fallback param: those are already cleared, and
`client_encoding=UTF8` is a fixed 21 bytes.)

---

## 3. What 2C.31W adds — the proof, by length only

`lib/db/pgStartupEstimate.js` `estimateStartupPacket(config)` (re-exported from
`lib/db/pgConfig.js`) mirrors the pinned serializer + `getStartupConf()` exactly, **including
the always-appended `client_encoding=UTF8`**, and returns **only** per-field
`{name, present, keyBytes, valueBytes, pairBytes}` plus `totalBytes`, `limit`, and
`belowLimit`. It never returns/logs any value, makes no DB/network call, and does not alter
connection behavior. `fallback_application_name` is **not** modeled as its own wire field
(the serializer never sends it separately — it only feeds `application_name`); it is noted here
as a config/default risk only.

`server.js` emits this estimate once at pool creation via the existing structured logger as
**sanitized metadata** (`{ totalBytes, limit, belowLimit, fields:[{name,present,keyBytes,
valueBytes,pairBytes}] }`). On the next owner-approved deploy, the deployed logs will show
exactly which field (`user` vs `database`) holds the ~1099 bytes — the runtime proof — without
exposing any secret. The estimator also resolves `user`/`database` through pg's
`PGUSER`/`PGDATABASE` fallback, so the log reveals (by byte length) if an env fallback rather
than the URL is supplying an oversized value.

---

## 4. `/api/ready` made honest (no DB-connectivity false-green)

`/api/ready` previously reported `database: 'ok'` from `DATABASE_URL` *presence* alone, which
reads as DB connectivity. It now reports:

- `database_configured: true|false` (config presence only)
- `database_connectivity: "not_checked"`
- `db_readiness_endpoint: "/api/health/deep"`
- `ready_for_data_load: false`

It runs **no** DB query and never fakes DB readiness. **`/api/health/deep` remains the real
DB-connectivity proof** (single `SELECT 1` over the shared pool) and is unchanged.

---

## 5. No fake readiness; real shared DB path preserved

- `/api/health/deep` still calls `deepReadiness(pgPool, …)` over the **shared** pool; it keeps
  `safe_to_load_data: false` and reports **`db: fail`** while the real pool cannot connect.
- `server.js` `pgPool` and `lib/db/pg.js` still use `buildSanitizedPgConfig`. Auto-migration
  still runs over the shared `pgPool` via `pgPool.connect()`; its failure stays visible.
- No readiness-only side pool/client. No migration added/run. The estimator never throws into
  startup (guarded), so there is no crash loop.

---

## 6. Remaining DB blocker comes first

The remaining over-limit bytes are in `user`/`database` (or a `PGUSER`/`PGDATABASE` fallback).
The **owner remediation** is to correct the Railway `DATABASE_URL` credential (exact Supabase
transaction-pooler URI; precise single-variable edit — never the Raw Editor, which corrupted
vars in a prior incident). This DB blocker **must be cleared before** any schema/tenant
diagnostics, and certainly before any data load. No env edit is performed here.

---

## 7. Safety / boundaries

- No secret/PII/value exposure — only field names + byte lengths + booleans.
- No fake DB readiness; `/api/health/deep` still fails while the pool cannot connect.
- No raw `connectionString`, no raw `DATABASE_URL` to a Pool/Client, no URL query-string
  forwarding (unchanged from 2C.31U/2C.31V).
- No DB query, migration, staging-data load, business/customer endpoint, external send, agent,
  or workflow. No Railway / deploy / production / main / integration-push / `.env.staging` read.
- The runtime DB path (`server.js` pgPool, `lib/db/pg.js`, the migration client) is the only
  surface hardened/gated here. Operational one-off scripts (e.g. `scripts/staging-seed.js`,
  `scripts/staging-migrate.js`) intentionally use `connectionString` and are **out of the
  runtime path** — not modified or gated.

---

## 8. Gates that remain blocked

- **Phase 2C.32 remains blocked.** This change does not authorize or enable 2C.32.
- **Staging data load remains blocked.** Nothing here makes it safe to load staging data.
- Whether the packet drops below 1024 will be proven only after the owner fixes the
  `DATABASE_URL` credential and the deployed `/api/health/deep` returns `db: ok` — not asserted
  here.

---

## 9. Verification

- New offline checker `scripts/phase-2c-31w-pg-startup-runtime-proof-check.js` — 32 fail-closed
  gates, including a behavioral test that runs the estimator on synthetic configs (the
  `postgres/postgres = 62` byte assertion; `client_encoding=UTF8` always present; UTF-8
  multi-byte length via `Buffer.byteLength`; all-optional-fields-present + total consistency;
  oversized-field detection; `PGUSER` **and** `PGDATABASE` fallback inspection;
  `fallback_application_name` is **not** a wire field) and a subprocess run of the 2C.31V
  checker.
- **Mutation matrix** (run during phase verification; each case must be REJECTED): remove
  `client_encoding`; minimal packet ≠ 62; string length instead of byte length; omit final
  NUL; estimator returns raw values; estimator logs; raw `connectionString`; raw `DATABASE_URL`
  → Pool/Client; forward search params; allow PGAPPNAME/PGOPTIONS; hide PGDATABASE fallback;
  `/api/ready` false DB ok; readiness-only side pool; `safe_to_load_data: true`; 2C.32
  overclaim; hardcoded PASS. The actual rejected-case run is recorded in the phase report.
- Full proof chain 2C.21 → 2C.31W runs green.
