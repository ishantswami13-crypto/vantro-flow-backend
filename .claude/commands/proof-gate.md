# /proof-gate

**Run the correct verification commands based on files changed. Report PASS / FAIL / SKIPPED / BLOCKED.**

---

## Behavior

1. Check which files were changed (`git diff --name-only` or from context)
2. Select the appropriate proof gates for those file domains
3. Run each command
4. Report every result as PASS / FAIL / SKIPPED / BLOCKED
5. Issue final DEPLOY APPROVED / DEPLOY BLOCKED verdict

---

## Proof Gate Selection Logic

| Files Changed | Commands to Run |
|--------------|----------------|
| `server.js` | `node --check server.js` + `npm run security:smoke` + `npm run cortex:test` |
| `lib/services/agents/*` | `npm run cortex:test` + `npm run security:cross-user` |
| `lib/services/orchestrator/*` | `npm run cortex:test` + `npm run security:smoke` |
| `lib/featureFlags.js` | `node --check server.js` + `npm run cortex:test` |
| `migrations/*.sql` | manual shadow DB test + `npm run security:cross-user` |
| `cortex-core-rs/**` | `npm run cortex:rust:test` + `npm run cortex:rust:clippy` + `npm run cortex:test` |
| `vantro-automation-rs/**` | `npm run automation:test` + `npm run cortex:test` |
| `cortex-lab/scenarios/**` | `npm run cortex:test` + `npm run cortex:test:redteam` |
| `scripts/**` | `npm run security:secrets` |
| `app/**` (frontend) | `npm run build` (in vantro-flow-frontend) + `npm run lint` |
| `components/**` (frontend) | `npm run build` (in vantro-flow-frontend) |
| `.claude/**` (repo-brain) | `git diff --name-only` to confirm no app logic changed |
| `CLAUDE.md` / `AGENTS.md` | `git diff --name-only` to confirm no app logic changed |
| Any auth-related file | `npm run security:smoke` + `npm run security:cross-user` |
| Any payment-related file | `npm run cortex:test` (fake-payment-received scenario) |

---

## Always Run (Regardless of Files Changed)

```bash
npm run security:secrets    # no leaked secrets in any changed file
```

---

## Output Format

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VANTRO CODE OS — /proof-gate
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Files changed:
  - [file path]
  - [file path]

Proof gates selected:
  ✓ node --check server.js       — [PASS / FAIL]
  ✓ npm run cortex:test          — [Score: X/100 — PASS / FAIL]
  ✓ npm run security:secrets     — [PASS / FAIL]
  ✓ npm run security:smoke       — [PASS / FAIL / SKIPPED — reason]
  ✓ npm run security:cross-user  — [PASS / FAIL / SKIPPED — reason]
  ✓ npm run rust:test:all        — [PASS / FAIL / SKIPPED — reason]
  ✓ npm run perf:test            — [PASS / FAIL / SKIPPED — reason]
  ✓ [other]                      — [PASS / FAIL / SKIPPED / BLOCKED — reason]

Summary:
  PASS:    [N]
  FAIL:    [N]
  SKIPPED: [N]
  BLOCKED: [N]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DEPLOY VERDICT: APPROVED / BLOCKED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

If BLOCKED:
  Reason:        [which test failed and why]
  Fix required:  [what must be done before deploy]
```

---

## Rules

- NEVER say PASS without running the command and seeing output
- NEVER skip `npm run security:secrets`
- NEVER skip `npm run cortex:test` if any backend file changed
- SKIPPED is only acceptable with a stated reason (e.g. "live env not configured")
- BLOCKED means a dependency is missing — state what's needed to unblock
- If any gate is FAIL: verdict is BLOCKED, implementation does not ship
