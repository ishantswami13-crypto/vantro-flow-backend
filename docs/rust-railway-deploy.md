# Vantro Automation RS -- Railway Deployment (Separate Service)

This document is the playbook for deploying **Vantro Automation RS** as a
**separate Railway service**, per founder Decision 1 (Option B). It is
config + process documentation only. Following it does **not** enable Rust in
production -- `RUST_AUTOMATION_API_ENABLED` stays `false` until every gate in
the CTO charter passes.

## Why a separate service (Option B)

| Property | Separate service (chosen) | Multi-process (Procfile) |
|---|---|---|
| Rust crash isolation | Node service unaffected | Rust crash can restart Node |
| Independent rollback | Yes | No |
| Independent logs/metrics | Yes | Interleaved |
| Independent scaling | Yes | No |
| Build lifecycle coupling | None | Shared |

A Rust panic, OOM, or sqlx pool exhaustion must never page the customer-facing
Node backend. Separate services guarantee that.

## Topology

```
Railway project: vantro-flow
|
+-- service: vantro-flow-backend   (EXISTING, unchanged)
|     root dir   : <repo root>
|     config     : railway.toml            (startCommand = node server.js)
|     nixpacks   : nixpacks.toml            (providers = ["node"])
|     env        : RUST_AUTOMATION_API_ENABLED=false
|                  RUST_AUTOMATION_BASE_URL=http://vantro-automation.railway.internal:3002
|
+-- service: vantro-automation     (NEW, this commit's config)
      root dir   : <repo root>
      config     : vantro-automation-rs/railway.toml
      nixpacks   : vantro-automation-rs/nixpacks.toml   (providers = ["rust"])
      env        : SQLX_OFFLINE=true
                   DATABASE_URL=<non-prod first, then prod>
                   JWT_SECRET=<same value as Node service>
                   RUST_AUTOMATION_PORT=3002
                   NODE_ENV=production
```

Node talks to Rust over Railway's private network
(`*.railway.internal`). The Rust service does **not** need a public domain.

## One-time Railway dashboard setup (Rust service)

1. In the `vantro-flow` project, **New Service -> GitHub Repo ->**
   `ishantswami13-crypto/vantro-flow-backend`.
2. Open the new service **Settings**:
   - **Root Directory**: leave as repo root (`/`). The cargo workspace
     `Cargo.toml`, `Cargo.lock`, and the committed `.sqlx/` cache all live at
     the root and must be in build scope.
   - **Config-as-code / Railway Config File**: set to
     `vantro-automation-rs/railway.toml`. This is what makes Railway use the
     Rust build instead of the repo-root Node config.
   - **Service name**: `vantro-automation` (so the internal hostname becomes
     `vantro-automation.railway.internal`).
3. Set the environment variables (next section).
4. Deploy. The build runs `vantro-automation-rs/nixpacks.toml`.

## Environment variables

Set these on the **Rust service** unless noted otherwise.

| Variable | Value | Required | Notes |
|---|---|---|---|
| `SQLX_OFFLINE` | `true` | **Yes** | Build reads the committed `.sqlx/` cache; no DB at build time. Without it the build fails. |
| `DATABASE_URL` | Postgres URL | **Yes (runtime)** | Used at RUNTIME only. Start with a **non-prod** DB for staging. A read-scoped role is recommended. |
| `JWT_SECRET` | same as Node | **Yes** | Must be byte-identical to the Node service's `JWT_SECRET` so Rust validates the same tokens. |
| `RUST_AUTOMATION_PORT` | `3002` | No | Axum bind port (default 3002). Set to `$PORT` if you want Railway's injected port. |
| `NODE_ENV` | `production` | Recommended | Drives `Config::is_prod()`; disables the `x-user-id` dev auth bypass. **Must be `production` in prod** (see Security note). |
| `REDIS_URL` | Redis URL | Optional | L2 cache. Absent -> L1 (DashMap) only. |
| `NATS_URL` | NATS URL | Optional | Event publishing. Absent -> events log to tracing only. |
| `TEMPORAL_HOST` | host:port | Optional | Workflow scheduling. Absent -> no-op. |

Set these on the **Node service**:

| Variable | Value | Notes |
|---|---|---|
| `RUST_AUTOMATION_API_ENABLED` | `false` | **Stays false** until all gates pass. The Node client short-circuits to JS when false. |
| `RUST_AUTOMATION_BASE_URL` | `http://vantro-automation.railway.internal:3002` | Internal URL Node uses to reach Rust. |

## The `.cargo/config.toml` cross-compile gotcha (important)

The committed `.cargo/config.toml` pins:

```toml
target = "x86_64-pc-windows-gnu"
```

That is correct for **Windows developer machines** but wrong for Railway's
**Linux** builders -- a naive `cargo build` there would try to cross-compile a
Windows binary and fail (no Windows linker). `vantro-automation-rs/nixpacks.toml`
handles this by overwriting `.cargo/config.toml` inside the ephemeral build
container before building:

```toml
[phases.build]
cmds = [
  "printf '# Overridden by Railway nixpacks -- Linux host target.\\n' > .cargo/config.toml",
  "cargo build --release --features server -p vantro-automation-rs",
]
```

This is the same neutralisation the CI workflows perform. The committed file in
git is never modified; only the build container's copy is replaced. The
resulting binary is at `target/release/vantro-automation`.

## SQLx offline build

`src/db/queries.rs` uses `sqlx::query!` compile-time macros. With
`SQLX_OFFLINE=true` and the committed `.sqlx/` cache (8 `query-*.json` files at
the repo root), the build needs no database connection. If a query changes, the
cache must be regenerated -- see `docs/rust-sqlx-validation.md`. If
`SQLX_OFFLINE` is unset on Railway, the build fails with:

```
error: set DATABASE_URL to use query macros online, or run `cargo sqlx prepare` ...
```

## Health gating

`vantro-automation-rs/railway.toml` sets `healthcheckPath = "/health"`. Railway
will not mark a deploy healthy (or route to it) until `GET /health` returns
2xx. The handler (`src/api/health.rs`) returns
`{"ok": true, "service": "vantro-automation-rs", "version": "..."}` with no DB
dependency, so it is a fast liveness signal.

## Rollout sequence (gated -- do NOT skip ahead)

1. **Deploy Rust to staging** with `DATABASE_URL` = non-prod DB,
   `RUST_AUTOMATION_API_ENABLED=false` on the staging Node service. Confirm
   `/health` green and logs clean.
2. **Run the live harness** (Harness X) against the staging Rust URL. Must pass
   (auth 401s, cross-user isolation, latency budgets).
3. **Staging cutover**: set `RUST_AUTOMATION_API_ENABLED=true` on staging Node
   only. Watch error rate + latency for 24h.
4. **Production deploy Rust service, flag OFF**: deploy the Rust service to prod
   with `RUST_AUTOMATION_API_ENABLED=false` on prod Node. Binary alive, unused.
5. **Production canary**: enable for a single canary user / small allowlist.
   Hold 1h within budget.
6. **Production rollout**: 10% -> 50% -> 100%, watching budgets at each step.

## Rollback (fastest to slowest)

1. **Instant (Node side):** set `RUST_AUTOMATION_API_ENABLED=false`. The Node
   client (`lib/services/rustAutomation/rustAutomationClient.js`) returns `null`
   on every call -> all callers fall through to existing JS. No restart needed
   if hot-read; one restart at worst.
2. **Service kill (Rust side):** stop the `vantro-automation` Railway service.
   Even with the flag on, every Node->Rust fetch fails fast (connection
   refused) -> `null` -> JS fallback. Customer impact: zero.
3. **Code rollback (Node side):** Railway revert the `vantro-flow-backend`
   service to the previous deploy. The Rust service can keep running.

The flag-off path (1) is the primary rollback. The other two are
belt-and-suspenders.

## Security note -- `NODE_ENV` must be `production` in prod

`src/auth.rs` accepts an `x-user-id` header bypass **only** when
`Config::is_dev()` is true (`NODE_ENV` in `{development, test}`). If a
production Rust service is deployed without `NODE_ENV=production`, that bypass
would be live. Always set `NODE_ENV=production` on the prod Rust service. A
startup assertion to enforce this is tracked as a follow-up.

## What this commit does NOT do

- Does NOT deploy anything.
- Does NOT enable `RUST_AUTOMATION_API_ENABLED`.
- Does NOT touch `server.js`, the frontend, or existing Node routes.
- Does NOT change the Node service's build (repo-root `nixpacks.toml` stays
  Node-only).
- Does NOT set any real secret -- all values above are documentation.
