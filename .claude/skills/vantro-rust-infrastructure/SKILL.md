# Vantro Rust Infrastructure Skill

## Overview

Use this skill when building, testing, or debugging Rust services (cortex-core-rs or vantro-automation-rs), reviewing the Node↔Rust bridge, or deciding when to enable Rust feature flags.

Trigger: "Rust", "cargo", "cortex-core", "vantro-automation", "Rust flag", "RUST_CORTEX_CORE_ENABLED", "RUST_AUTOMATION_API_ENABLED", "Axum", "SQLx", "Node fallback".

## What This Skill Does

1. Checks Rust build/test status
2. Evaluates whether Rust feature flags are safe to enable
3. Reviews Node↔Rust bridge correctness
4. Identifies Rust-specific security issues (auth, cache isolation)
5. Gives ENABLE / DO NOT ENABLE verdict

## Current Rust Reality

Both flags OFF: `RUST_CORTEX_CORE_ENABLED=false`, `RUST_AUTOMATION_API_ENABLED=false`

**cortex-core-rs** (CLI, `bin/cortex-core.exe`):
- Node wrapper: `lib/services/cortexCore/rustCore.service.js`
- Tests: `npm run cortex:rust:test`
- Gate: cargo test + parity + harness

**vantro-automation-rs** (Axum, port 3002):
- Node wrapper: `lib/services/rustAutomation/rustAutomationClient.js`
- Tests: `npm run automation:test` (includes auth_cache_isolation.rs, policy_guard_fir_regression.rs)
- Gate: cargo test + bootstrap <500ms + harness

## Rust Commands

```bash
# Check
npm run rust:check:all         # cargo check entire workspace
npm run cortex:rust:check      # cortex-core only
npm run automation:check       # vantro-automation only

# Test
npm run rust:test:all          # all workspace tests
npm run cortex:rust:test       # cortex-core tests
npm run automation:test        # vantro-automation tests

# Quality
npm run cortex:rust:clippy     # cargo clippy -D warnings
npm run cortex:rust:fmt        # cargo fmt --check

# Build
npm run rust:build:all         # cargo build --release
npm run cortex:rust:build      # cortex-core + copy binary
npm run automation:build       # vantro-automation + copy binary
```

## Rust Flag Enable Gate

**RUST_CORTEX_CORE_ENABLED** — ALL required:
1. `npm run cortex:rust:test` — PASS
2. `npm run cortex:rust:clippy` — zero warnings
3. Node parity test: Rust output matches Node for 50 test cases
4. `npm run cortex:test` — still 100% pass
5. `npm run security:cross-user` — still passes

**RUST_AUTOMATION_API_ENABLED** — ALL required:
1. `npm run automation:test` — PASS (including auth_cache_isolation.rs)
2. Bootstrap <500ms: `curl -w "%{time_total}" http://localhost:3002/api/bootstrap`
3. Health: `curl http://localhost:3002/api/health` → 200
4. Port 3002 NOT accessible from public internet
5. `npm run cortex:test` — still 100% pass
6. Node fallback still works when port 3002 is DOWN

## Rust Security Requirements

- `vantro-automation-rs/src/auth.rs` must use same JWT secret as Node
- `vantro-automation-rs/src/cache/keys.rs` must include user_id in ALL cache keys
- `tests/auth_cache_isolation.rs` must pass before flag enabled
- Axum sidecar port 3002: localhost only, never public-facing

## Node Fallback Pattern

Every Rust feature must have Node fallback:
```javascript
// In rustCore.service.js
if (!isEnabled('rust_cortex_core_enabled')) {
  return nodeJsFallback(input); // Never break when Rust is OFF
}
return rustCLI(input);
```

## Output Format

1. Cargo check/test result
2. Clippy warnings (list them)
3. Node parity status
4. auth_cache_isolation.rs status
5. Node fallback verified: YES / NO
6. Verdict: SAFE TO ENABLE FLAG / DO NOT ENABLE (blockers list)
