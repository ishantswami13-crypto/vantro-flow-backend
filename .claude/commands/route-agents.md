# /route-agents

**Classify task and route to agents. Do not edit files.**

Use this when you want to see which agents would activate for a task before committing to implementation.

---

## Behavior

Read `.claude/agent-router.md` and `.claude/task-classifier.md`. Output the full classification and agent selection. Stop there — do not inspect files, do not plan, do not implement.

---

## Output Format

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VANTRO CODE OS — /route-agents
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Task:              [description of what was asked]

Primary domain:    [domain]
Secondary domains: [domains or "none"]
Risk level:        [low / medium / high / critical]
Escalation:        [YES — reason / NO]

Agents activated:
  ▶ [Agent Name]    ← lead
  ▶ [Agent Name]
  ▶ [Agent Name]
  ▶ [Agent Name]

Files likely involved:
  - [file path] — [reason]
  - [file path] — [reason]

Feature flags to check:
  - [flag name] (current: true/false)
  or "none"

Proof gates this task would require:
  - [command] — [what it checks]
  - [command] — [what it checks]

Escalation agents (if triggered):
  ▶ vantro-security-sentinel (mandatory)
  ▶ vantro-database-rls-guardian
  ▶ vantro-harness-x-verifier
  ▶ vantro-launch-readiness-officer

Routing verdict:
  Ready to proceed?  YES / NEEDS CLARIFICATION
  If needs clarification: [one question only]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Rules

- Do not read any application files during this command
- Do not produce a plan
- Do not implement anything
- Do not edit any files
- Output classification only, then stop
- If task is completely ambiguous: ask ONE clarifying question, then route
