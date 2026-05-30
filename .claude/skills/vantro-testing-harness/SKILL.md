# Vantro Testing Harness (Cortex Lab) Skill

## Overview

Use this skill when writing new Harness X scenarios, interpreting cortex-lab results, verifying agent behavior, or establishing proof before marking a feature complete.

**Hard rule: A feature is not done until a Harness X scenario proves it.**

Trigger: "test", "harness", "cortex:test", "scenario", "prove it works", "is this verified", "Harness X", "cortex-lab".

## What This Skill Does

1. Runs `npm run cortex:test` and interprets results
2. Identifies which categories are N/A vs truly passing
3. Writes new scenarios for uncovered features
4. Blocks false "complete" claims
5. Diagnoses scenario failures
6. Identifies what's needed to unlock live mode

## Cortex Lab Reality

**Location**: `I:/Vantro/vantro-flow-backend/cortex-lab/`
**Scenarios**: 37 JSON files across 8 domains
**Last run**: 100% static pass (2026-05-30)
**N/A categories** (need live env): orchestration, business_isolation, approval_gate_safety, financial_data_integrity, learning_loop_quality, action_quality

## Running Harness X

```bash
npm run cortex:test            # static — ALWAYS run first (fast, no DB)
npm run cortex:test:dry        # dry-run — no DB writes
npm run cortex:test:live       # live — needs TEST_BASE_URL + Supabase creds
npm run cortex:test:redteam    # adversarial
npm run cortex:test:all        # all modes
npm run cortex:harness:loop    # continuous
```

## Live Mode Env Vars (to unlock 5 N/A categories)

```bash
TEST_BASE_URL=https://vantro-flow-backend-production.up.railway.app
TEST_SUPABASE_URL=...
OWNER_A_TOKEN=...
OWNER_B_TOKEN=...    # second owner for cross-tenant tests
```

## Scenario Writing Pattern

```json
{
  "id": "feature-scenario-name",
  "description": "What this tests in plain English",
  "category": "policy_safety",
  "mode": ["static", "dry-run"],
  "inputs": {
    "action": "proposed_action_name",
    "context": { "user_id": "...", "amount": 50000 }
  },
  "expected": {
    "result": "blocked",
    "reason_contains": "requires owner approval",
    "audit_event": "action_blocked"
  }
}
```

Place in: `cortex-lab/scenarios/[domain]/[scenario-name].json`

## Proof Standard

| Claim | What proves it |
|-------|---------------|
| "Policy guard blocks X" | policy_safety scenario, static mode |
| "AI doesn't hallucinate Y" | ai_hallucination_block scenario |
| "Audit event fires for Z" | event_audit_completeness scenario |
| "Cross-tenant leak prevented" | business_isolation scenario, LIVE mode |
| "Payment can't be faked" | financial_data_integrity scenario, LIVE mode |
| "Learning loop improves scores" | learning_loop_quality scenario, LIVE mode |

## Output Format

1. Run result: `npm run cortex:test` output
2. Score: X/100, gate: Y, PASS/FAIL
3. N/A categories explanation (not failures — just need live env)
4. Scenarios missing for this feature (if any)
5. New scenario file content (if needed)
6. Verdict: PROVEN / NOT PROVEN / PARTIALLY PROVEN (specify which modes)
