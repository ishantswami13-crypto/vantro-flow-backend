# /invoke-war-room

**Activate all major Vantro Code OS agents for high-risk, multidimensional tasks.**

Use when a task spans multiple domains, carries critical risk, or when you need the full team's perspective before making a decision.

---

## When to Use

- Task touches 3+ domains simultaneously
- Risk level is `critical`
- Launch decision needed (can we ship X by 22 June?)
- Architecture decision with long-term consequences
- Security incident or potential breach
- Rust flag enablement decision
- External message sending enablement decision
- Major migration or schema change
- "What should we build next?" type decisions

---

## Agents Activated (All Major Agents)

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VANTRO CODE OS — WAR ROOM ACTIVE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▶ Chief Architect               ← architecture lead
▶ Security Sentinel             ← security lead
▶ Backend API Engineer
▶ Frontend UX Engineer
▶ Database RLS Guardian
▶ Harness X Verifier            ← proof lead
▶ CashOps Domain Agent
▶ Cost Engine Agent
▶ Launch Readiness Officer      ← 22 June lead
▶ Agent Mesh Architect
▶ Rust Systems Engineer
▶ Observability & Reliability Agent
▶ Compliance Risk Agent
▶ Product Growth Strategist
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## War Room Output Format

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VANTRO CODE OS — WAR ROOM REPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Task:           [what is being decided or built]
Risk level:     CRITICAL / HIGH
Escalation:     YES

ARCHITECTURE PERSPECTIVE (Chief Architect):
  [What is the right system design? What breaks? What's the safe path?]

SECURITY PERSPECTIVE (Security Sentinel):
  [What are the security risks? What must be verified first?]

DOMAIN PERSPECTIVE (CashOps / Relevant Domain):
  [Does this align with MSME owner workflow? Does it serve Rajesh?]

LAUNCH PERSPECTIVE (Launch Readiness Officer):
  [Does this help or hurt 22 June? Is this launch-critical or deferrable?]

PROOF PERSPECTIVE (Harness X Verifier):
  [What scenarios exist? What's missing? What must be run?]

COMPLIANCE PERSPECTIVE (Compliance Risk Agent):
  [Is this legally safe? Does it respect RBI guidelines? Audit trail?]

PRODUCT PERSPECTIVE (Product Growth Strategist):
  [Is this better than HighRadius? Does it serve Rajesh's daily habit?]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CONSOLIDATED PLAN:
  [One clear plan that resolves all perspectives. No contradictions.]

DISSENTING RISKS:
  [What any agent flagged that the plan doesn't fully resolve.]

PROOF GATES REQUIRED:
  - [command] — PASS / FAIL / BLOCKED
  - [command] — PASS / FAIL / BLOCKED

FINAL VERDICT:
  Safe to proceed:   YES / NO / CONDITIONAL
  22 June impact:    HELPS / HURTS / NEUTRAL
  Rollback plan:     [steps]
  Next best action:  [one clear next step]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## War Room Rules

1. Every agent speaks once — no repetition
2. Plan is consolidated at the end — one plan, no contradictions
3. Dissenting risks are logged even if overruled
4. No implementation until war room completes and verdict is YES
5. If verdict is NO or CONDITIONAL — state exact blockers before stopping
6. Proof gates run after war room, not during
