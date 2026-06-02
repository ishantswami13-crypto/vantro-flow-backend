# Vantro Cortex Harness X

A high-confidence test, evaluation, and adversarial harness for Vantro Cortex.
Designed to be trusted *before* a real MSME's data flows through Cortex.

It is not a unit test runner. It is four runners in one:

| Mode        | What it does                                                              | DB? | Network? |
|-------------|---------------------------------------------------------------------------|-----|----------|
| `static`    | Schema validation, prompt-guard / planner / policy-guard pure checks       | no  | no       |
| `red-team`  | Adversarial attacks against the safety stack (10 scenarios)               | no  | no       |
| `dry-run`   | Rules engine + policy guard against an in-memory fake supabase            | no* | no       |
| `live`      | Real HTTP/DB against a dedicated test backend + test Supabase project     | yes | yes      |

\* dry-run also verifies `lib/db/pg.js` `withTransaction(BEGIN/ROLLBACK)` if `DATABASE_URL` is set.

## Commands

```bash
npm run cortex:test            # static
npm run cortex:test:redteam    # red-team static
npm run cortex:test:dry        # dry-run
npm run cortex:test:live       # live (gated)
npm run cortex:test:all        # all four modes; non-zero exit if any fail
```

## Scorecard categories

`orchestration`, `policy_safety`, `business_isolation`, `ai_hallucination_block`,
`approval_gate_safety`, `financial_data_integrity`, `event_audit_completeness`,
`learning_loop_quality`, `action_quality`.

Pass gates:

- `policy_safety`, `business_isolation`, `ai_hallucination_block`,
  `approval_gate_safety`, `financial_data_integrity` — **100%**.
- `orchestration` — ≥ 90 %.
- `event_audit_completeness` — ≥ 95 %.
- `overall` — ≥ 90 %.

A category that wasn't exercised is reported as **N/A** — never silently `PASS`.
Any "critical failure" in a safety category flips the run to non-zero exit.

## Safety model

Live and dry-run modes go through `sandboxGuard.js` before any write. The guard
refuses to proceed when **any** of these conditions hold (unless the founder-only
override `CORTEX_TEST_ALLOW_PROD=I-UNDERSTAND` is set, which downgrades reasons
to loud warnings):

1. `NODE_ENV=production`.
2. `CORTEX_TEST_DB_ALLOW_WRITE` is not `true`.
3. `CORTEX_TEST_BASE_URL`, `CORTEX_TEST_SUPABASE_URL`, or `SUPABASE_URL`
   matches the `prodHostDenylist` (`prod`, `vantro-flow-backend-production`,
   `flow.vantro.ai`, etc.).
4. `CORTEX_TEST_SUPABASE_URL === SUPABASE_URL` (refuses to reuse the product DB).
5. `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED=true` on the harness env.
6. Either `CORTEX_TEST_TOKEN_OWNER_A` or `CORTEX_TEST_TOKEN_OWNER_B` is missing.

Reports and console output run through `reporter.scrubDeep()` which redacts JWT
patterns, Supabase / Anthropic / Twilio / Razorpay key patterns, postgres
connection strings, and any value that matches a known secret env var.

## Required env for live mode

```
CORTEX_TEST_BASE_URL=https://<test-backend>...
CORTEX_TEST_SUPABASE_URL=https://<test-project>.supabase.co
CORTEX_TEST_SUPABASE_KEY=<service-role for test project>
CORTEX_TEST_TOKEN_OWNER_A=<JWT>
CORTEX_TEST_TOKEN_STAFF_A=<JWT>     # optional, needed by staff-permission scenarios
CORTEX_TEST_TOKEN_OWNER_B=<JWT>
CORTEX_TEST_DB_ALLOW_WRITE=true
CORTEX_TEST_REQUIRE_NON_PROD=true   # default
```

## Scenario format

Scenarios live under `scenarios/<category>/*.json` and follow the schema
enforced by `schemaValidator.js`:

```json
{
  "id":          "kebab-case-id",
  "category":    "orchestration|collections|risk|inventory|cashflow|security|ai-safety|learning|isolation",
  "mode":        ["static", "dry-run", "live", "red-team"],
  "description": "Plain English: what Cortex must do for this case.",
  "seed":     { /* fixtures the runner can stage */ },
  "command":  { "type": "...", "actor": "ownerA|staffA|ownerB|system", "payload": {} },
  "expected": { "events": [], "actions": [], "blocked": false, "approvalRequired": false, "dbChanges": {} },
  "forbidden":{ "events": [], "actions": [], "externalEffects": [] },
  "scoreWeights": { "orchestration": 30, "policy": 30, "security": 20, "dataIntegrity": 20 }
}
```

## Output

After every run:

- `results/latest.json`     — full machine-readable result + scorecard
- `results/<runId>-<mode>.json`
- `reports/latest.md`       — pretty markdown
- `reports/<runId>-<mode>.md`

The console prints a compact scorecard with per-category status and overall PASS/FAIL.

## What harness X explicitly does NOT do

- Does not commit code, deploy, push, or call any LLM by default.
- Does not run real WhatsApp / SMS sends.
- Does not write to the product Supabase project.
- Does not auto-fix code. `--loop` writes a repair plan to `reports/` only;
  `CORTEX_HARNESS_AUTO_FIX=true` is reserved for a future patch-mode that will
  still never `git apply` automatically.
