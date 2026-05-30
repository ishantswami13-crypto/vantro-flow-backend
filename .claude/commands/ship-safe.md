# /ship-safe

Run this before shipping any change to Vantro Flow. No shortcuts.

## What This Command Does

Verifies a change is safe to deploy: Harness X passes, no security regressions, feature flags correct, Rust flags still OFF unless explicitly enabled, migration safety checked.

## Steps (Run in Order)

### 1. Syntax Check
```bash
node --check server.js
```
Expected: clean exit (no output). If fails: fix before continuing.

### 2. Harness X (Proof System)
```bash
npm run cortex:test
```
Expected: Score 100/100, gate 90. If fails: STOP — find which scenario broke and fix it.

### 3. Security Checks
```bash
npm run security:secrets        # no leaked secrets in code
npm run security:smoke          # auth + route smoke test
npm run security:cross-user     # tenant isolation test
```
All must pass. If any fail: STOP.

### 4. Feature Flag Verification
Check `lib/featureFlags.js` and Railway env:
- `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED` — must be `false` unless owner approval gate is wired in UI
- `FEATURE_PROMPT_GUARD_ENABLED` — must be `true` (default ON)
- `RUST_CORTEX_CORE_ENABLED` — must be `false` unless full Rust gate passed
- `RUST_AUTOMATION_API_ENABLED` — must be `false` unless full Rust gate passed

### 5. Migration Safety
If this change includes a migration:
- [ ] Migration is additive (no column drops, no full-table rewrites)
- [ ] Migration has corresponding rollback SQL
- [ ] Migration tested on shadow Supabase project
- [ ] `006_cortex_rls.sql` — NOT applied unless auth bridge is ready

### 6. Rust Status (If Rust Code Changed)
```bash
npm run rust:check:all          # cargo check
npm run rust:test:all           # cargo test
npm run cortex:rust:clippy      # no warnings
```
All must pass. Rust flag must stay OFF until parity test passes.

### 7. Performance Check (If Route Changed)
```bash
npm run perf:test
```
Note response times. If any route >500ms: investigate before shipping.

## Ship Safe Verdict

```
[ ] node --check server.js — PASS / FAIL
[ ] npm run cortex:test — Score: X/100 — PASS / FAIL
[ ] npm run security:secrets — PASS / FAIL
[ ] npm run security:smoke — PASS / FAIL
[ ] npm run security:cross-user — PASS / FAIL
[ ] Feature flags verified — PASS / FAIL
[ ] Migration safety — N/A / PASS / FAIL
[ ] Rust checks — N/A / PASS / FAIL

SAFE TO DEPLOY: YES / NO
```

If any item is FAIL: do not deploy. Fix it first.
