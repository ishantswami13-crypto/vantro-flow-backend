# Phase 2C.31V — PG Startup-Packet Hardening

**Status:** implemented (code-side), pending Codex review + owner commit. NOT committed, NOT
pushed, NOT deployed.

**Base:** `performance-bootstrap-cortex-fix-v1` @ `7e00fabd4fdea9c3293173baa67dae6cc47e3767`
(the deployed 2C.31U commit).

---

## 1. Deployed truth before this phase

Phase 2C.31U shipped a sanitized pg config (explicit fields instead of `connectionString`,
no URL query string forwarded). It deployed to `vantro-node-staging`, but the database still
fails to connect:

| Probe | Result |
|-------|--------|
| `/api/health` | **pass** |
| `/api/health/deep` → node | **ok** |
| `/api/health/deep` → rust | **ok** |
| `/api/health/deep` → db | **fail** |
| `ENETUNREACH` | **absent** (the IPv4 pooler URL fix from 2C.31T held) |
| `ESTARTUPPACKETTOOLARGE` | **present** |
| startup packet size | **1209 bytes** (max **1024**) |
| crash loop | none |
| `NODE_ENV` | logs as `development` (unrelated to the packet; noted only) |

So connectivity reaches PgBouncer (no network error), but the Postgres **startup packet is
1209 bytes**, over the Supabase transaction pooler's hard **1024-byte** limit, and the pooler
rejects it with `ESTARTUPPACKETTOOLARGE`. 2C.31U was necessary but not sufficient.

---

## 2. Why 2C.31U did not shrink the packet — root cause

2C.31U correctly removed the raw `connectionString` and the URL query string. But the packet
size is not driven only by what *we* put in the config. node-postgres derives startup
parameters from the **process environment and library defaults** as well. Verified directly
against the installed driver:

- `node_modules/pg/lib/connection-parameters.js`, `val(key, config, envVar)`:
  it returns `config[key]` **only when that value is truthy**; otherwise it falls through to
  `process.env['PG' + KEY]`, then to `defaults[key]`. Specifically:
  - the application name = `val('application_name', config, 'PGAPPNAME')` → reads **PGAPPNAME**
  - the options param   = `val('options', config)` → reads **PGOPTIONS**
- `node_modules/pg/lib/client.js`, `getStartupConf()`: always sends `user` + `database`, and
  **conditionally** appends the application name, `replication`, the timeouts, and the options
  param **whenever they are truthy**.

Consequence: even though our config object sets neither field, a large **PGAPPNAME** or
**PGOPTIONS** present in the deployed environment is folded into the startup packet. An absent
or empty config value does **not** suppress this — empty is falsy, so pg still reads the env.
This is the most plausible source of the ~1100 extra bytes (`user` + `database` alone are far
under 1024), and it is present on both the old `connectionString` path and the 2C.31U explicit
path, which is why the packet did not shrink.

A secondary risk also addressed here: the native `URL` parser leaves `username` / `password` /
database **percent-encoded**, whereas the old `connectionString` path (`pg-connection-string`)
decoded them. Encoded credentials can be longer than decoded ones and, more importantly, can
authenticate incorrectly.

---

## 3. The fix (smallest safe change)

All changes are confined to `lib/db/pgConfig.js`. `server.js` and `lib/db/pg.js` already route
every real pool/client through `buildSanitizedPgConfig`, so hardening that one helper
propagates to all three real call sites with zero blast radius elsewhere.

1. **Parse with native `URL`** — never `connectionString`, never the URL query string.
2. **Decode credentials safely** — `user`, `password`, and the database name are passed through
   a fail-safe `decodeURIComponent` (falls back to the raw value on malformed input; never
   throws, never logs). This matches the old `pg-connection-string` behavior.
3. **Clear PGOPTIONS / PGAPPNAME / PGREPLICATION from the process env** before pg builds its
   connection parameters. This is the reliable block: no config value can mean "send nothing"
   for the options param, so the env itself must be cleared. These three are the **only**
   env-sourced fields `getStartupConf()` can fold into the packet (`PGAPPNAME` → application
   name, `PGOPTIONS` → options, `PGREPLICATION` → replication). The `*_timeout` fields use pg's
   `envVar=false` path and read no env; `client_encoding` is read from `PGCLIENT_ENCODING` but
   is **not** written to the startup packet by `getStartupConf()`, so it cannot inflate it and
   is intentionally left untouched. We set **neither an application name, nor an options param,
   nor replication** in the config. With the env cleared and the pg defaults being `undefined`,
   the startup packet carries **only `user` + `database`** — comfortably under 1024 bytes
   (estimated ≈ 60–120 bytes depending on the user/database lengths, versus 1209 before).
   `PGREPLICATION` is cleared defensively (rare in app deployments, and its value is tiny) so
   the packet is provably free of *all* env-sourced inflation without needing to inspect the
   deployed environment.
   - The env clear is an **in-process runtime** change only. It does **not** read or modify any
     Railway variable or any `.env` file.
4. **Preserve SSL and pool settings exactly** — `ssl: { rejectUnauthorized: false }`,
   `max: 10`, `idleTimeoutMillis: 30000`, `connectionTimeoutMillis: 5000` are unchanged from
   2C.31U.

No application name or arbitrary options are introduced. No long values are added.

---

## 4. Real shared DB path preserved

- `server.js` `pgPool` is still `new Pool(buildSanitizedPgConfig(process.env.DATABASE_URL))`.
- `lib/db/pg.js` `getPool()` is still `new Pool(buildSanitizedPgConfig(process.env.DATABASE_URL))`.
- The manual-migration endpoint still uses `new Client(buildSanitizedPgConfig(dbUrl))`.
- Auto-migration (`runAutoMigrations()`) still runs over the **shared** `pgPool` via
  `pgPool.connect()`; its failure path is unchanged and still **visible** (logged, non-fatal).
- `/api/health/deep` still calls `deepReadiness(pgPool, …)` — the same shared pool. The probe
  does **not** open a side connection, so it reflects the real pool's health honestly.

No new pool or client is introduced. No readiness-only "sanitized" side client exists — that
would be a false green (it could report `db:ok` while the real pool still failed).

---

## 5. Safety — what this change does NOT do

- **No false DB readiness.** `deepReadiness` keeps `safe_to_load_data: false` always; the DB
  check is a single `SELECT 1` over the shared pool. If the real pool fails, the probe reports
  `db:fail`.
- **No secrets / no PII.** No `DATABASE_URL`, credential, or env value is ever logged. The doc
  and checker print only key names and lengths, never values.
- **No customer/business queries, no writes, no schema changes, no migrations run.**
- **No external sends, agents, or workflows triggered.**
- **No Railway / deploy / production / main / integration / commit / PR** performed by this
  phase. `.env.staging` is not read or touched.

---

## 6. Verification

- New offline checker: `scripts/phase-2c-31v-pg-startup-packet-hardening-check.js` — 21
  fail-closed gates, including a **behavioral** test that builds a config from a synthetic URL
  (no real credentials, no connection) and asserts: credentials are decoded, the application
  name and options param are absent, SSL + pool settings are preserved, query-string keys are
  not forwarded, and `PGOPTIONS` / `PGAPPNAME` are removed from the process env.
- The 2C.31U checker (`scripts/phase-2c-31u-pg-startup-fix-check.js`) still passes (run as a
  subprocess by the 2C.31V checker, and again in the full chain).
- Full proof chain 2C.21 → 2C.31V runs green.

---

## 7. Gates that remain blocked

- **Phase 2C.32 remains blocked.** This change does not authorize or enable 2C.32; 2C.32 still
  awaits the owner and its own Pilot Data Intake Contract + Dry-Run Gate.
- **Staging data load remains blocked.** No staging data is loaded, and nothing here makes it
  safe to load staging data.
- Whether the deployed packet actually drops below 1024 must be confirmed by the deployed
  `/api/health/deep` returning `db: ok` **after** an owner-approved deploy — not asserted here.
