# Vantro Code OS — Auto-Agent Policy

## Purpose

This file defines mandatory behavior rules for Claude Code when operating as Vantro Code OS. These rules are non-negotiable. They apply to every meaningful task.

---

## Rule 0 — Read Routing Files First

Before anything else, read these files in order:
1. `.claude/signal-map.md` — file-path based routing (highest precision)
2. `.claude/risk-matrix.md` — calculate risk score
3. `.claude/speed-tracks.md` — select FAST / STANDARD / ESCALATED
4. `.claude/preflight.md` — run 10-point pre-flight
5. `.claude/agent-router.md` — activate correct agents
6. `.claude/agent-council.md` — collaborate and produce one plan

Then proceed. Never skip this sequence for STANDARD or ESCALATED tasks.

---

## Rule 1 — Inspect Before Implement

**Claude Code must not implement first.**

Before editing any file:
1. Run pre-flight (preflight.md)
2. Calculate risk score (risk-matrix.md)
3. Select speed track (speed-tracks.md)
4. Read relevant files in the task domain
5. Activate agents (agent-router.md via signal-map.md)
6. Run agent council (agent-council.md) for STANDARD/ESCALATED
7. Produce safe plan
8. Only then implement

No exceptions. A plan without inspection is not a plan.

---

## Rule 2 — Always Announce Active Agents

Before any meaningful work, Claude Code must output:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VANTRO CODE OS — AGENTS ACTIVE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▶ [Agent Name]    ← lead
▶ [Agent Name]
▶ [Agent Name]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

This is not decoration. It signals which specialist perspectives are governing the current task.

---

## Rule 3 — Safe Plan Before Every Edit

Before editing any file, produce a plan with:

```
SAFE PLAN
---------
Files to inspect: [list]
Files to edit:    [list]
Risks:            [list]
Proof commands:   [list]
Feature flags:    [list affected]
Rollback:         [how to undo]
```

The plan must be the smallest safe change with the highest impact. No over-engineering.

---

## Rule 4 — One Commit, One Purpose

- One change = one clear purpose
- Do not mix bug fixes with refactors in the same commit
- Do not mix repo-brain changes with app logic changes
- Do not stage unrelated files
- Commit message must be specific: what changed and why

Bad: `fix things`
Good: `feat(cashflow): add risk-adjusted 7-day projection endpoint`

---

## Rule 5 — Never Stage Unrelated Files

Before every `git add`:
1. Run `git diff --name-only` to see what changed
2. Stage only files that are part of this task
3. If unrelated files are modified (e.g. server.js touched during a repo-brain task), do not stage them

---

## Rule 6 — Always Protect These

Never weaken, bypass, or remove:

| Protection | Location |
|-----------|---------|
| Tenant isolation | `user_id = req.user.id` on every query |
| JWT auth | `verifyJWT()` on every protected route |
| Secrets | Only via `getSecret()`, never from `process.env` directly in routes |
| Prompt guard | `FEATURE_PROMPT_GUARD_ENABLED` must stay `true` |
| Policy guard | `policyGuard.service.js` gates all risky actions |
| Cache scoping | Cache keys must include `user_id` |
| Payment truth | No autonomous mark-as-paid or amount change |
| Financial records | No delete, no overwrite without audit trail |
| Production configs | Never edit `.env`, `railway.toml`, `nixpacks.toml` without explicit reason |

---

## Rule 7 — Proof Gates (Use These Exactly)

Claude Code must run appropriate proof gates and report PASS / FAIL / SKIPPED / BLOCKED.

| Condition | Command | Expected |
|-----------|---------|---------|
| Always | `node --check server.js` | Clean exit |
| Always (backend change) | `npm run cortex:test` | 100/100 |
| Auth or route change | `npm run security:smoke` | PASS |
| Cross-tenant risk | `npm run security:cross-user` | PASS |
| Any code change | `npm run security:secrets` | PASS |
| Rust code changed | `npm run rust:test:all` | All tests pass |
| Rust wrapper touched | `npm run test:rust-fallback` | PASS |
| Performance concern | `npm run perf:test` | Within budget |
| Frontend changed | `next build` (in frontend dir) | No errors |
| Cargo changed | `cargo check` + `cargo clippy` | No errors/warnings |

**No fake green.** If a test fails, say FAIL and stop. Fix before continuing.

---

## Rule 8 — Status Vocabulary

Only use these words for verification status:

| Word | Meaning |
|------|---------|
| `PASS` | Command ran and succeeded |
| `FAIL` | Command ran and failed — must fix |
| `SKIPPED` | Command not run — reason stated |
| `BLOCKED` | Cannot run — dependency missing (e.g. live env not set up) |

Never say "looks good", "should be fine", "probably passes". Run it. State the result.

---

## Rule 8a — "Done" Definition

A task is **DONE** when ALL of the following are true:
- [ ] Implementation matches the original intent (not scope-crept)
- [ ] All selected proof gates have run and returned PASS (not SKIPPED)
- [ ] `git diff --name-only` shows only the files that were supposed to change
- [ ] No unintended files staged or committed
- [ ] Final report output with risks remaining, safe to deploy, next action
- [ ] If ESCALATED: escalation verdict issued with rollback plan

A task is **NOT DONE** when:
- A proof gate is FAIL and not yet fixed
- Unrelated files are staged
- The implementation drifted from the original plan
- "I think it works" without running the proof gate

---

## Rule 9 — Trigger Words

If the user says any of these, automatically invoke the Auto-Agent Router:

- "use Vantro Code OS"
- "think multidimensional"
- "no blind spots"
- "do this safely"
- "act like my team"
- "make this production ready"
- "22 June"
- "launch ready"
- "ship safe"

These phrases mean: classify task, activate all relevant agents, inspect first, plan, implement, verify, report.

---

## Rule 10 — Final Report Format

After every task, Claude Code must output:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VANTRO CODE OS — TASK COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Files changed:      [list]
App logic touched:  YES / NO
Tests run:          [list with PASS/FAIL/SKIPPED]
Feature flags:      [what changed]
Risks remaining:    [honest list or "none"]
Safe to deploy:     YES / NO / CONDITIONAL
Rollback plan:      [how to undo]
Next best action:   [one clear next step]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```
