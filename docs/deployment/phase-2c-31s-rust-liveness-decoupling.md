# Phase 2C.31S — Rust Liveness Decoupling (Deployment Contract)

Status: **repository-side liveness fix only.** No Railway change is applied; no deployment
is performed; nothing below is asserted as already-proven on Railway.

## Why 2C.31R was necessary-but-insufficient

Phase 2C.31R fixed the port precedence so the Rust sidecar binds Railway's injected
`$PORT` (`PORT` -> `RUST_AUTOMATION_PORT` -> 3002). With Change Set A verified, the
`8cfd3094` deployment **built** successfully but still failed at the network/health-check
stage after 30 seconds — `/health` was not reached. Proven next root cause: the sidecar's
startup was still coupled to an **eager database connection** (`create_pool` used
`.connect().await` with `min_connections(2)`) that ran **before** the HTTP server bound,
so when the database was missing/slow/unreachable at startup the server never bound and
the liveness endpoint could not answer within the health-check window.

## Liveness vs readiness

- **Liveness (`/health`)** — "is the process up and serving?" Must respond quickly and
  must NOT depend on the database, secrets, or any external dependency. Used by the
  Railway healthcheck. This phase keeps `/health` as a pure, static, DB-independent JSON
  liveness endpoint.
- **Readiness** — "can the process serve DB-backed traffic right now?" This is handled by
  normal endpoint behaviour: DB-dependent business endpoints connect on first use and
  **fail closed** if the database is unavailable. A dedicated `/ready` route is not added
  in this phase (kept minimal); it may be added later behind its own review and must never
  become the Railway liveness path without explicit approval.

## The change (smallest safe)

- `vantro-automation-rs/src/db/pool.rs` — `create_pool` now uses sqlx `connect_lazy`
  (no eager `.connect().await`, no `min_connections`). The pool is created lazily;
  connections are established on first query. The connection-string FORMAT is still
  validated (a malformed `DATABASE_URL` fails fast), and config still REQUIRES
  `DATABASE_URL` to be set — the DB requirement for real operations is not bypassed.
- `vantro-automation-rs/src/main.rs` — drops the `.await` on `create_pool` so startup no
  longer blocks on a database connection before binding the HTTP server and `/health`.

Nothing else changes: no business logic, no auth, no DB-dependent endpoint is allowed to
run without a working database, no DB error is converted to fake success, and no secret or
config value is exposed in health output.

## What this phase does NOT do

- No Railway setting is applied or changed.
- Production Rust is not repaired.
- Node staging is not connected.
- No staging data is loaded.
- No production deployment is performed.
- No `server.js`, database schema, migration, frontend, or Runtime Truth file is changed by
  this phase. The only changed files are `vantro-automation-rs/src/db/pool.rs`,
  `vantro-automation-rs/src/main.rs`, this document, and the phase checker.
- Railway is not proven by this phase: the staging Rust deployment and `/health` result
  must be re-observed only after PR, CI, and merge — the next deployment target is the
  staging Rust service only, and only after merge.

## Runtime proof note

This Windows dev host cannot link the Rust `server` feature locally (`LNK1104` in
dependency build scripts), so the runtime health probe is `BLOCKED_ON_WINDOWS_BUILD`
locally and is NOT faked. The authoritative runtime proof is Linux CI (server-feature
build) plus the eventual staging Rust redeploy + `/health` observation after merge.
