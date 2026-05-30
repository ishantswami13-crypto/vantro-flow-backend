# /fix-with-tests

Fix a bug AND prove it is fixed. Never mark a bug fixed without proof.

## What This Command Does

Fixes a bug in Vantro Flow and creates a Harness X scenario or test that proves the fix is real and will not regress.

## Steps

### 1. Reproduce the Bug
- Identify the exact failure (file:line)
- Identify which feature flag (if any) must be ON to reproduce
- Identify which user_id scoping is involved

### 2. Check Existing Scenarios
```bash
npm run cortex:test     # does any existing scenario catch this?
```
If a scenario is FAILING — that's the bug. Fix the code, not the scenario.
If all scenarios PASS — the bug is in uncovered territory. Add a scenario.

### 3. Fix the Bug
- Fix at the root cause, not the symptom
- Do not add workarounds that mask the bug
- Do not change feature flags to hide the bug
- Do not weaken policy guard or prompt guard to make tests pass

### 4. Write the Harness X Scenario (If Missing)
```json
{
  "id": "bug-fix-scenario-name",
  "description": "Regression test for: [bug description]",
  "category": "[appropriate category]",
  "mode": ["static"],
  "inputs": { ... },
  "expected": { "result": "...", "reason_contains": "..." }
}
```
Place in: `cortex-lab/scenarios/[domain]/`

### 5. Verify Fix
```bash
npm run cortex:test     # must be 100/100
npm run security:cross-user   # if bug was tenant-related
npm run security:smoke        # if bug was auth-related
```

### 6. Check for Regressions
```bash
npm run cortex:test:all       # all modes
node --check server.js        # syntax
```

## Fix Report Format

```
Bug: [description]
Root cause: [file:line — exact cause]
Fix: [what was changed and why]

Harness X scenario: [new/existing scenario name]
npm run cortex:test result: Score X/100 — PASS / FAIL
Regression check: PASS / FAIL

Safe to deploy: YES / NO
Feature flags affected: [list or "none"]
```

**A bug is fixed when:**
1. Root cause identified (not symptom masked)
2. Harness X scenario proves it (new or existing)
3. `npm run cortex:test` still 100/100
4. No regression in other scenarios
5. `/ship-safe` command passes
