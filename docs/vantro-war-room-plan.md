# Vantro War-Room Plan -- Production-Ready by 22 June

Authored: 30 May. Target: 22 June (23 days). Owner: founder + CTO loop.

This is the single execution map for shipping Vantro as an **AI Business
Automation Service** without breaking the working product or shipping unproven
systems into production unflagged.

---

## 0. Operating principles (non-negotiable)

Every system follows the pipeline. No step skipped, no fake "done".

```
Build -> Test -> Harness X -> CI green -> Feature flag -> Staging -> Canary -> Production
```

- The **Node backend is the live production path today** and stays the default.
  Nothing on the Rust/AI track may become the production path until it has
  passed CI + Harness X + staging + canary.
- **No production data in tests.** Non-prod Postgres / Supabase only.
- **Node fallback is never removed.** Every Rust/AI call returns `null` on
  failure and the JS path serves the request.
- **Risky systems ship behind flags** (default OFF) until proven. Ambition is
  not reduced; exposure is gated.
- **Proof or it didn't happen.** A system is "done" only with green CI +
  Harness evidence, not an assertion.

Priority legend:
- **P0** = must ship by 22 June (launch-blocking).
- **P1** = should ship behind a flag (built + tested, enabled post-proof).
- **P2** = designed/foundation only, not blocking launch.

---

## 1. Current verified state (as of 30 May)

| Item | Status | Proof |
|---|---|---|
| Rust workspace baseline committed | DONE | commit a11e2b3 |
| FIR policy bug fixed + regression test | DONE / verified | Linux CI green |
| Linux CI gate (fmt/check/test) | DONE / green | rust-automation-ci |
| SQLx validation workflow (ephemeral PG) | DONE / green | rust-sqlx-validation |
| `.sqlx/` offline cache committed (8 queries) | DONE | commit dcdcede |
| Server-feature offline build gate (SQLX_OFFLINE=true) | DONE / green | rust-automation-ci |
| Separate Railway Rust service config | DONE | commit ef35653 |
| Auth + cache cross-user isolation tests | IN VERIFICATION | commit 9d46d18 (CI running) |
| `RUST_AUTOMATION_API_ENABLED` | **false** | featureFlags.js |
| Rust service deployed | NO | by design |
| Node backend default | YES | unchanged |

---

## 2. Readiness matrix by domain

### Backend readiness
- **P0** Node backend stable, existing routes unchanged, `/api/v1` bootstrap
  endpoints fast. (Already live.)
- **P0** Rust `/api/v2` endpoints compile offline + pass auth/cache gates.
  (Auth/cache: in verification. Live test: Commit 6.)
- **P1** Rust service running in staging behind `RUST_AUTOMATION_API_ENABLED`.
- **P2** NATS/Temporal event + workflow infra (interfaces only today).

### Frontend readiness (React Control Room)
- **P0** Action-first dashboard + bootstrap endpoints + skeleton loading.
- **P0** Collections War Room, Customer Intelligence Profile, Owner Approval
  Queue (these are the revenue-driving surfaces).
- **P1** Credit Risk Simulator, Cashflow Command Center, Inventory-Cash panel,
  Payables Priority panel, Agent Command Center (read-only).
- **P2** Harness X Status panel, Cortex Cost Engine internal dashboard.
- Rules enforced: React Query, no AI calls from React, no secrets in frontend,
  no agent execution in React, lazy-load heavy widgets.

### Security readiness
- **P0** Cross-user isolation (cache + query scoping) proven. (Commit 5.)
- **P0** Policy Guard blocks the unsafe-action set (FIR fix done; full matrix
  in Harness red-team).
- **P0** No secrets in frontend; JWT verified server-side; `NODE_ENV=production`
  disables the `x-user-id` dev bypass on any prod Rust service.
- **P1** Startup assertion that refuses to boot a prod Rust service when the dev
  bypass would be live.

### Auth readiness
- **P0** JWT missing/malformed/invalid-signature/expired -> 401; valid ->
  correct user_id; token never logged. (Commit 5, in verification.)
- **P0** Rust JWT secret identical to Node's; same tokens validate on both.

### Cache readiness
- **P0** Every user-data cache key scoped by user_id; no global user-data key;
  cross-user reads impossible. (Commit 5.)
- **P1** Redis L2 behind `REDIS_URL` (L1 DashMap is the default).
- **P1** Event-driven cache invalidation (invalidate by business event).

### Rust readiness (Automation RS + Cortex Core RS)
- **P0** Offline build proven; pure engines unit-tested (cashops, cortex).
- **P0** Live `/api/v2` endpoints tested against non-prod DB. (Commit 6.)
- **P1** Rust enabled in staging, then canary, behind the flag.
- **P2** Full Rust takeover of `/api/v1` equivalents (not a launch goal).

### Harness X readiness
- **P0** static + red-team modes green (auth, cache, cross-user, unsafe
  message, AI hallucination, policy).
- **P0** dry-run mode for collections / promise-broken / credit-risk flows.
- **P1** live mode against non-prod `/api/v2` endpoints. (Commit 6.)
- Rule: no agent enabled without a passing Harness scenario.

### Agent Mesh readiness (Vantro ASI)
- **P1** Agent registry + schema + tests (IDs, success metric, approval rules,
  policy rules, harness scenarios). Registry only -- **no runtime execution**.
  (Commit 7.)
- **P2** Agent runtime execution behind per-agent flags, gated by Harness +
  Policy Guard.

### ASI pipeline readiness
- **P2** Orchestrator -> agent mesh -> tool registry -> policy -> simulation ->
  learning loop. Interfaces and registry exist; runtime stays flagged off.

### UX / UI readiness
- **P0** Perceived load < 2s on dashboard + collections; action-first layout;
  approval queue usable by a non-technical owner.
- **P1** Customer intelligence + simulators polished.

### Performance readiness
- **P0** Bootstrap < 1s (Node); pages never block on Cortex; tables paginated;
  charts lazy. Measured, not projected. (Commit 8 -- perf lab.)
- **P1** Rust bootstrap latency measured and within budget before canary.

### Launch readiness
- **P0** Node product polished + secure + measured; Rust/AI proven in staging
  behind flags; rollback (flag-off) verified.
- **P1** Canary enablement of Rust path for a small allowlist.

---

## 3. Milestone sequence to 22 June

Each is a discrete, reviewable commit with its own CI + Harness proof.
Dates are targets; gates, not calendar, decide promotion.

| # | Commit / milestone | Track | By |
|---|---|---|---|
| 1-5 | Baseline, CI, SQLx, Railway cfg, auth/cache isolation | Rust infra | DONE / in-verify |
| 6 | Rust live harness for `/api/v2` (non-prod env only) | Rust + Harness | ~02 Jun |
| 7 | Agent Mesh registry foundation (no runtime) | ASI | ~04 Jun |
| 8 | Performance lab: Node vs Rust measured numbers | Perf | ~06 Jun |
| 9 | Node fallback matrix verification (down/timeout/bad-resp) | Reliability | ~07 Jun |
| 10 | Vantro Collect algorithm completeness + explainability | CashOps | ~10 Jun |
| 11 | Harness X full red-team + policy matrix | Security | ~12 Jun |
| 12 | React Control Room P0 surfaces (action-first) | Frontend | ~15 Jun |
| 13 | Staging deploy: Rust service up, flag OFF | Deploy | ~17 Jun |
| 14 | Staging cutover: flag ON in staging, 24h soak | Deploy | ~19 Jun |
| 15 | Production deploy Rust service, flag OFF | Deploy | ~20 Jun |
| 16 | Production canary: flag ON for allowlist | Launch | ~21 Jun |
| 17 | Launch review + rollback drill | Launch | 22 Jun |

If a gate fails, the dependent milestones slip -- the flag stays OFF and the
Node path carries production. We do not ship unproven paths to hit a date.

---

## 4. Gate definitions ("done" means)

- **A Rust endpoint is done** when: offline build green, auth 401 matrix green,
  cross-user isolation green, live harness green on non-prod, latency measured
  within budget, Node fallback verified.
- **An agent is done** when: registered with schema + success metric + approval
  + policy rules + >=1 harness scenario, AND its runtime stays flagged off until
  the harness scenario passes live.
- **The product is launch-ready** when: Node path polished/secure/measured; Rust
  path proven in staging behind a flag; canary green; flag-off rollback drilled.

---

## 5. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Rust path enabled before proof | Low | Flag default OFF; gate checklist; this doc |
| Cross-user leak | Low | Commit 5 gates; Harness cross-user scenario |
| Build breaks Node deploy | Low | Separate Railway service (Option B) |
| Unsafe AI action reaches customer | Med | Policy Guard + approval queue + red-team |
| Perf regression / 1-min pages | Med | Perf lab measured numbers; lazy widgets |
| Schedule slip on frontend P0 | Med | P0 surfaces only; P1/P2 deferred behind flags |
| Windows dev box cannot build Rust | Known | Linux CI is the verifier (already the loop) |

---

## 6. The non-negotiables (restated)

1. No compromise on ambition -- build the advanced systems now.
2. No compromise on proof -- CI + Harness evidence or it is not done.
3. No compromise on safety -- flags OFF until proven; Node fallback intact;
   no production data in tests; cross-user isolation enforced.
