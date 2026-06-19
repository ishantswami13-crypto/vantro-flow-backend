# Phase 2C.31R — Railway Runtime Recovery (Deployment Contract)

Status: **diagnosis + minimal repository fix only.** No Railway change has been applied
by this phase. No deployment has been performed. No setting below is asserted as
already-applied; the "Railway change manifest" is a proposal requiring explicit owner
approval and a browser/CLI operator.

This document defines the *intended* Railway service topology and the exact
build/start/health contract per service, plus the proven root causes of the repeated
deployment failures and the smallest correct repository-side fix.

---

## 1. Verified topology (Railway project `handsome-stillness`)

Services observed (read-only): `Postgres`, `vantro-flow-backend`, `vantro-node-staging`,
`vantro-automation-staging`, `vantro-automation-prod`. GitHub deployment objects label
several of these under the shared environment string `handsome-stillness / production`;
that shared label is **not** proof that a given deployment is customer-facing production.

| Service | Component | Intended branch | Component root | Builder | Start | Health |
| --- | --- | --- | --- | --- | --- | --- |
| `vantro-flow-backend` | Production Node | `main` (temporary; future manual-release gate) | repo root | NIXPACKS (node) | `node server.js` | n/a here (do not change) |
| `vantro-automation-prod` | Production Rust sidecar | `main` (temporary; or dedicated release branch later) | repo root, config `vantro-automation-rs/railway.toml` | NIXPACKS (rust) | `/app/bin/cortex-core` | `GET /health` |
| `vantro-node-staging` | Staging Node | `performance-bootstrap-cortex-fix-v1` | repo root | NIXPACKS (node) | `node server.js` | per Node service |
| `vantro-automation-staging` | Staging Rust sidecar | `performance-bootstrap-cortex-fix-v1` | repo root, config `vantro-automation-rs/railway.toml` | NIXPACKS (rust) | `/app/bin/cortex-core` | `GET /health` |

Component-root note: the Rust services use **repo root** as the Railway "Root Directory"
(the workspace `Cargo.toml`, `Cargo.lock`, and committed `.sqlx/` cache live at root) and
point Railway's "Config Path" at `vantro-automation-rs/railway.toml`.

---

## 2. Build / start / health contract — Rust sidecar (`vantro-automation-rs`)

- Workspace member: `vantro-automation-rs`; library `vantro_automation_lib`.
- Server binary: `[[bin]] name = "vantro-automation"`, `path = src/main.rs`,
  `required-features = ["server"]`. Built with `--features server` on Linux (the slim
  runtime is musl/static; Windows dev cannot link the server feature).
- Nixpacks build copies the real artifact to the path the auto-generated runtime stage
  expects: `cp target/x86_64-unknown-linux-musl/release/vantro-automation bin/cortex-core`.
  The file named `cortex-core` here **is** the `vantro-automation` Axum server — only the
  path name collides with the first workspace member (`cortex-core-rs`). This is expected,
  not a stale/wrong binary.
- Start command (must match across both config files): `/app/bin/cortex-core`.
- Bind host: `0.0.0.0` (required by Railway; never `127.0.0.1`).
- **Port (the documented health-timeout cause):** the server must bind the platform port.
  After the 2C.31R fix, `config.rs` resolves the port as `PORT` → `RUST_AUTOMATION_PORT`
  → `3002`, so it honours Railway's injected `$PORT` even if `RUST_AUTOMATION_PORT=$PORT`
  was not set in the service env. (Setting `RUST_AUTOMATION_PORT=$PORT` in the env is an
  equivalent Railway-side option.)
- Health route: `GET /health`, mounted unconditionally and auth-free, returning a static
  `{"ok": true, "service": ..., "version": ...}` JSON. It performs **no** DB query and
  references **no** secret — a correct liveness endpoint.
- Health gate: `healthcheckPath = /health`, `healthcheckTimeout = 30`.

### Readiness vs liveness (known coupling — recommended follow-up)
`main.rs` creates the Postgres pool with an **eager** `connect()` (`min_connections(2)`)
*before* binding the HTTP server, so liveness is currently coupled to DB reachability at
startup: if the DB is not reachable when the process starts, the server never binds and
`/health` cannot answer. The static `/health` handler itself is DB-independent. A
recommended (not-yet-implemented) hardening is to make the pool lazy (`connect_lazy`) so
the HTTP server and `/health` come up independent of DB readiness, with DB-backed
endpoints still requiring a working DB on first query. This phase does **not** change pool
semantics; it implements only the proven port fix.

---

## 3. Proven root causes

- **Staging Rust health-check timeout:** (a) port mismatch — the server bound
  `RUST_AUTOMATION_PORT`/`3002` while Railway health-checks and routes the injected
  `$PORT`; and (b) liveness coupled to eager DB connect at startup. Cause (a) is the
  primary, directly-proven cause and is what the repository fix addresses.
- **Production Rust config/snapshot failure:** consistent with the Railway service "Root
  Directory" / "Config Path" not resolving `vantro-automation-rs/railway.toml`
  (Railway reports missing `railway.toml` when the root/config path is wrong). This is a
  **Railway-side service-settings** issue, not a repository file problem — the repo files
  exist and are correct. Do not add a root-level Rust `railway.toml` (it would break the
  Node service in this monorepo).
- **Missing Node staging deploy gate:** `vantro-node-staging` has **no branch connected**,
  so Node changes on the integration branch have no staging deployment proof before
  production. This is a Railway-side connection that must be added (Change Set B).

---

## 4. Repository-side fix in this phase (minimal, proven)

- `vantro-automation-rs/src/config.rs`: port precedence now `PORT` → `RUST_AUTOMATION_PORT`
  → `3002`. This is the only runtime code change. No business logic, no auth, no DB
  requirement is changed. Compile verification of the `server` feature is deferred to CI
  (Linux musl); this Windows dev host cannot link the server feature.

Everything else in this phase is documentation, a machine-checkable gate, and a local
health-probe scaffold.

---

## 5. Deployment success / rollback criteria

- Success (per Rust service, after an approved deploy): build completes; `/app/bin/cortex-core`
  starts; `/health` returns HTTP 200 on the platform `$PORT` within 30 seconds; no secret in
  logs; restart policy not tripped.
- Rollback: Railway retains the previous successful deployment on failure (no auto-activation
  of a failed deploy). Roll back by redeploying the last known-good commit / deactivating the
  failed deployment. No DB migration is part of sidecar startup, so rollback is stateless.
- Owner-approval boundary: production services (`vantro-flow-backend`, `vantro-automation-prod`)
  must not auto-deploy from development/integration branches; production promotion requires
  explicit owner approval. Railway-native deploy status must be queried after every approved
  deploy (GitHub deployment metadata alone is insufficient — it registers asynchronously).

---

## 6. Railway change manifest — NOT YET APPLIED (requires owner approval + operator)

The following are **proposals**, not applied settings. Do not combine into one deployment.

### Change Set A — Staging Rust recovery (`vantro-automation-staging`)
- Verify Root Directory = repo root; Config Path = `vantro-automation-rs/railway.toml`.
- Ensure the platform port is honoured: rely on the 2C.31R `PORT` precedence fix, and/or set
  `RUST_AUTOMATION_PORT=$PORT` in the service env. Do not change build/start/health values
  (they are already correct in config-as-code).
- Source branch = `performance-bootstrap-cortex-fix-v1`.
- Expected side effect: a new staging Rust deployment. Risk: staging only. Rollback: previous
  deployment retained. Saving may trigger a deploy.

### Change Set B — Staging Node gate (`vantro-node-staging`)
- Connect source branch `performance-bootstrap-cortex-fix-v1`; verify Root Directory = repo
  root (Node). Deploy staging only. Side effect: staging Node deployment. Risk: staging only.

### Change Set C — Production Rust repair (`vantro-automation-prod`) — only AFTER Staging Rust passes
- Verify Root Directory / Config Path resolve `vantro-automation-rs/railway.toml`. Use manual
  deploy or an owner-approved release. Require `/health` proof + rollback plan. Risk: production.

### Change Set D — Production deployment hardening (future)
- Replace silent `main` auto-deploy with manual promotion or a dedicated release branch +
  explicit owner approval + a deploy gate.

---

## 7. Boundaries honoured by this phase

No Railway mutation, no deploy, no retry/restart/rollback, no DB/migration, no env read or
change, no secret exposure, no frontend change, no Node production behaviour change, no commit
or push. No Railway change above has been performed; none is claimed complete.
