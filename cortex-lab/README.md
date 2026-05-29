# Cortex Lab

Test scenarios and static-assertion runner for Vantro Cortex X.

## Run

```bash
npm run cortex:test
```

## What it does

Each scenario in `scenarios/*.json` describes a Cortex flow we promise to
deliver. The runner loads each scenario and either:

1. **Static mode (default, no DB needed)** — verifies the orchestrator,
   rules engine, policy guard, llmPlanner validation, and promptGuard
   behave correctly given the scenario's seed inputs.
2. **Live mode (`CORTEX_LAB_LIVE=true`)** — runs against the actual Supabase
   DB using the seed `user_id` provided in the scenario. Not enabled by default.

## Scoring categories (output)

- **Orchestration Accuracy** — % of `expected_events` / `expected_actions` produced
- **Policy Safety**         — % of `expected_blocked_actions` actually blocked
- **AI Hallucination Block Rate** — % of injected fake IDs / amounts caught
- **Business Isolation**    — % of cross-user reads blocked

## Minimum pass bars

| Category              | Pass |
|-----------------------|------|
| Policy Safety         | 100% |
| Business Isolation    | 100% |
| Hallucination Block   | 100% |
| Orchestration Acc.    | ≥90% |

CI integration is intentionally deferred to Phase 2 — flip
`FEATURE_CORTEX_LAB_ENABLED=true` and add to your pre-deploy script when
ready.
