# /harness-proof

Run Cortex Lab and prove a feature works. A feature is not complete without harness proof.

## What This Command Does

Runs the Harness X proof system and interprets results. Identifies missing scenarios. Never accepts "tested manually" as proof.

## Run Harness X

```bash
# Always start with static (fast, no DB)
npm run cortex:test

# If static passes, run dry-run
npm run cortex:test:dry

# If DB + auth tokens available, run all
npm run cortex:test:all

# For adversarial testing
npm run cortex:test:redteam
```

## Interpret Results

### Score
- `100/100` with gate `90` — PASS
- Below gate score — FAIL — find which scenario broke

### Category Status
- ✅ Category with score — genuinely passing
- ⚪ Category `N/A` — NOT a failure — just needs live mode env

### N/A Categories (need live env)
Currently N/A (as of 2026-05-30): orchestration, business_isolation, approval_gate_safety, financial_data_integrity, learning_loop_quality, action_quality

To unlock: set `TEST_BASE_URL`, `OWNER_A_TOKEN`, `OWNER_B_TOKEN`, test Supabase creds.

## Proof Standard by Feature

| Feature | Required Proof |
|---------|---------------|
| Policy blocks X | policy_safety scenario — static |
| AI doesn't hallucinate | ai_hallucination_block scenario — static |
| Audit event fires | event_audit_completeness scenario — static |
| Cross-tenant blocked | business_isolation — LIVE mode |
| Financial action safe | financial_data_integrity — LIVE mode |
| Message approval gate | approval_gate_safety — LIVE mode |
| Learning loop works | learning_loop_quality — LIVE mode |

## Write Missing Scenario

If a feature has no scenario:
1. Find the right domain folder: `cortex-lab/scenarios/[domain]/`
2. Create `[scenario-name].json` with structure:
```json
{
  "id": "scenario-id",
  "description": "What this tests",
  "category": "policy_safety",
  "mode": ["static"],
  "inputs": { "action": "...", "context": {} },
  "expected": { "result": "blocked", "reason_contains": "..." }
}
```
3. Run `npm run cortex:test` — must pass
4. Update AGENTS.md `harness_x_scenarios` for the relevant agent

## Proof Report Format

```
Feature: [feature name]
Harness X run: npm run cortex:test
Score: X/100 (gate 90) — PASS / FAIL
Categories passing: [list]
Categories N/A: [list with reason]

Scenario coverage for this feature:
- [scenario-name] — PASSING / MISSING
- ...

Proof status: PROVEN / PARTIALLY PROVEN / NOT PROVEN
Live mode needed: YES / NO
If YES, required env: [list]
```

**A feature is PROVEN when:**
- Relevant domain scenario passes in static mode
- Relevant domain scenario passes in dry-run mode
- If financial: also passes in live mode
- No regression in any other scenario
