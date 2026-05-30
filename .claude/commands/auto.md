# /auto

**Full automatic Vantro Code OS task execution.**

Classify → Route agents → Inspect → Plan → Implement → Verify → Report.

---

## Behavior

When `/auto` is invoked (or user says "do this safely", "act like my team", "no blind spots", "make this production ready"), Claude Code must:

### Step 1 — Read router files
```
.claude/agent-router.md
.claude/task-classifier.md
.claude/auto-agent-policy.md
.claude/escalation-rules.md
```

### Step 2 — Output Task Classification

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VANTRO CODE OS — /auto
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Task:              [what was asked]
Primary domain:    [domain]
Secondary domains: [domains or "none"]
Risk level:        [low / medium / high / critical]
Escalation:        [YES / NO]
```

### Step 3 — Announce Active Agents

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VANTRO CODE OS — AGENTS ACTIVE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▶ [Agent]    ← lead
▶ [Agent]
▶ [Agent]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Step 4 — Inspect Relevant Files

Read all files relevant to the task domain. Do NOT edit anything yet.

Output:
```
INSPECTION
----------
Read: [file] — [key finding]
Read: [file] — [key finding]
```

### Step 5 — Produce Safe Plan

```
SAFE PLAN
---------
Files to edit:    [list]
Approach:         [2-3 sentences]
Risks:            [list]
Feature flags:    [what changes]
Proof gates:      [commands to run]
Rollback:         [how to undo]
```

### Step 6 — Implement

Only after inspection and plan. Smallest safe change. No scope creep.

### Step 7 — Verify

Run proof gates from the plan. Report each as PASS / FAIL / SKIPPED / BLOCKED.

```
PROOF GATES
-----------
node --check server.js       — PASS / FAIL
npm run cortex:test          — X/100 — PASS / FAIL
npm run security:smoke       — PASS / FAIL / SKIPPED
npm run security:cross-user  — PASS / FAIL / SKIPPED
[other commands]             — PASS / FAIL / SKIPPED
```

### Step 8 — Final Report

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VANTRO CODE OS — TASK COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Files changed:      [list]
App logic touched:  YES / NO
Tests run:          [with results]
Feature flags:      [what changed]
Risks remaining:    [honest list or "none"]
Safe to deploy:     YES / NO / CONDITIONAL
Rollback plan:      [steps]
Next best action:   [one clear next step]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Rules

- Never skip Step 4 (inspect) or Step 5 (plan)
- Never implement without announcing active agents
- Never say PASS without running the command
- Never say COMPLETE without proof
- If escalation triggered → follow escalation-rules.md fully before Step 6
