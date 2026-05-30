# /rust-gate

Gate check before enabling a Rust feature flag. Must pass ALL items before flipping any Rust flag ON.

## What This Command Does

Verifies that a Rust service (cortex-core-rs or vantro-automation-rs) is safe to enable in production. Prevents premature Rust flag enablement.

## Current Rust Status

Both flags: OFF (correct — do not change until all gate checks pass)
- `RUST_CORTEX_CORE_ENABLED=false`
- `RUST_AUTOMATION_API_ENABLED=false`

## Gate for RUST_CORTEX_CORE_ENABLED

Run ALL of these:
```bash
npm run cortex:rust:check       # cargo check -p cortex-core — must exit 0
npm run cortex:rust:test        # cargo test — must all pass
npm run cortex:rust:clippy      # cargo clippy -D warnings — must be zero warnings
npm run cortex:rust:fmt         # cargo fmt --check — must be clean
```

Then:
- [ ] Node parity test: score output from `bin/cortex-core.exe` matches Node JS scoring for 50 diverse test cases (write this test if it doesn't exist: `scripts/rust-live-harness.js`)
- [ ] `npm run cortex:test` — still 100/100 after enabling flag in dev
- [ ] `npm run security:cross-user` — still passes (no cross-tenant data via CLI stdin/stdout)
- [ ] Node fallback verified: when `RUST_CORTEX_CORE_ENABLED=false`, Node JS scoring still returns correct results

## Gate for RUST_AUTOMATION_API_ENABLED

Run ALL of these:
```bash
npm run automation:check        # cargo check — must exit 0
npm run automation:test         # cargo test — must all pass (including auth_cache_isolation.rs)
```

Then:
- [ ] Start Rust sidecar: `npm run automation:start`
- [ ] Bootstrap <500ms: `curl -w "%{time_total}\n" http://localhost:3002/api/bootstrap` — must be <0.5
- [ ] Health: `curl http://localhost:3002/api/health` — must return `{"status":"ok"}`
- [ ] Port 3002 NOT accessible from public internet (sidecar is localhost only)
- [ ] `vantro-automation-rs/tests/auth_cache_isolation.rs` — PASS
- [ ] `vantro-automation-rs/tests/policy_guard_fir_regression.rs` — PASS
- [ ] `npm run cortex:test` — still 100/100 after enabling flag in dev
- [ ] Node fallback verified: when Rust sidecar is DOWN, `rustAutomationClient.js` falls back to Node JS gracefully

## Rust Gate Report

```
RUST_CORTEX_CORE_ENABLED gate:
cargo check         — PASS / FAIL
cargo test          — PASS / FAIL
cargo clippy        — PASS / FAIL (N warnings)
cargo fmt           — PASS / FAIL
Node parity (50 cases) — PASS / FAIL
Harness X post-enable — 100/100 / FAIL
Node fallback works — PASS / FAIL
Cross-user after — PASS / FAIL

RUST_CORTEX_CORE_ENABLED: SAFE TO ENABLE / DO NOT ENABLE

RUST_AUTOMATION_API_ENABLED gate:
cargo check             — PASS / FAIL
cargo test              — PASS / FAIL
auth_cache_isolation    — PASS / FAIL
policy_guard_regression — PASS / FAIL
Bootstrap <500ms        — X ms — PASS / FAIL
Port 3002 internal only — YES / NO
Harness X post-enable   — 100/100 / FAIL
Node fallback works     — PASS / FAIL

RUST_AUTOMATION_API_ENABLED: SAFE TO ENABLE / DO NOT ENABLE
```

BOTH flags must pass their full gate independently. Partial gate = DO NOT ENABLE.
