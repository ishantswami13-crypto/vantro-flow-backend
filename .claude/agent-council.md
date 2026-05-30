# Vantro Code OS — Agent Council Protocol

## Purpose

Defines how multiple active agents collaborate, reach decisions, resolve conflicts, and produce one consolidated output — not a committee debate.

A third-party swarm generates agent noise. The Vantro Agent Council generates one clear signal.

---

## Core Rule: One Consolidated Plan

**No matter how many agents are active, there is ONE implementation plan.**

Agents do not argue in the output. They do not produce parallel contradictory instructions. Each agent speaks to its domain, the Chief Architect synthesizes, and one plan is executed.

---

## Authority Hierarchy

When agents disagree, this hierarchy resolves it:

```
1. Security Sentinel      — absolute veto on anything that weakens security
2. Database RLS Guardian  — absolute veto on anything that threatens tenant isolation
3. Harness X Verifier     — veto on anything with no proof path
4. Chief Architect        — final decision on architecture and approach
5. Launch Readiness Officer — final decision on 22 June priority/deferral
6. Domain Lead            — final decision within their specific domain
```

**Security Sentinel veto is absolute**: If the Security Sentinel says "this breaks tenant isolation" or "this weakens auth", implementation STOPS. No override, not even by the Chief Architect.

**Harness X veto is absolute for proof**: If Harness X Verifier says "no scenario can prove this is safe", implementation does not ship.

---

## Council Sequence (How Agents Speak)

In STANDARD and ESCALATED tracks, agents speak in this fixed sequence:

```
Round 1 — ASSESS (each agent states their concern or clearance)
  1. Chief Architect       → "Architecture assessment: [X]"
  2. Security Sentinel     → "Security assessment: [X]"
  3. Domain Lead           → "Domain assessment: [X]"
  4. Harness X Verifier    → "Proof assessment: [X]"
  5. Launch Readiness Officer → "Launch impact: [X]"

Round 2 — SYNTHESIZE (Chief Architect only)
  "Consolidated plan: [one plan that satisfies all agents]"

Round 3 — PEER REVIEW (Security Sentinel only — for ESCALATED tasks)
  "Peer review: APPROVED / REJECTED — [reason]"
  If REJECTED → back to Round 1 with the rejection as new input

Round 4 — EXECUTE (one agent executes the consolidated plan)
```

---

## Peer Review Protocol

For ESCALATED TRACK tasks only, `vantro-security-sentinel` performs a mandatory peer review of the plan before implementation:

**Security Sentinel reviews for:**
- [ ] user_id sourced from JWT in all query paths touched
- [ ] No new cross-tenant data access pattern introduced
- [ ] No weakening of promptGuard or policyGuard
- [ ] No payment/invoice amount mutation without idempotency
- [ ] No external message send path opened without owner approval gate
- [ ] No secrets exposed in code
- [ ] All proof gates are executable and correct

**Output:**
```
PEER REVIEW — Security Sentinel
Status: APPROVED / REJECTED
Reason: [specific approval or rejection reason]
If rejected: [what must change before approval]
```

If REJECTED: Return to planning. Do not implement until APPROVED.

---

## Conflict Resolution Examples

### Example 1: Product vs Security conflict

**Scenario**: Product Growth Strategist wants to enable WhatsApp sending NOW because "it's critical for launch". Security Sentinel says "owner approval gate not wired yet".

**Resolution**: Security Sentinel veto. No external send until approval gate is wired. The Product Growth Strategist's concern is logged as "next priority" in the final report.

**Output**: "WhatsApp send deferred — approval gate must be wired in `/app/ai-actions/page.tsx` first. This is the highest launch priority."

---

### Example 2: Chief Architect vs Rust Systems Engineer

**Scenario**: Chief Architect wants to enable Rust automation sidecar to improve performance. Rust Systems Engineer says "auth_cache_isolation.rs test is failing".

**Resolution**: Harness X Verifier confirms the test failure. Rust Systems Engineer veto. Flag stays OFF. Chief Architect's priority is logged for when tests pass.

**Output**: "RUST_AUTOMATION_API_ENABLED stays OFF — auth_cache_isolation.rs test failing. Fix test first, then re-run /rust-gate."

---

### Example 3: No conflict (most common)

**Scenario**: Backend API Engineer proposes adding a new cashflow route.

**Resolution**: Security Sentinel confirms user_id scoped. Harness X Verifier confirms a cashflow scenario exists. Chief Architect approves the pattern. Launch Readiness Officer confirms it helps Milestone C.

**Output**: One plan, all agents aligned. Execute.

---

## Agent Speaking Rules

1. **Each agent speaks only about their domain** — no agent comments on another agent's domain
2. **Agents do not repeat each other** — no restating what was already said
3. **Agents are concrete, not vague** — "user_id missing from line 47 of server.js" not "security concern"
4. **Chief Architect synthesizes, does not debate** — one plan after all agents speak
5. **Vetoes state the exact fix required** — not just "this is wrong"

---

## When Council is Skipped (Fast Track)

On FAST TRACK: no full council. Only domain lead speaks.

```
Domain Lead: [one-line assessment] → [one-line plan] → execute → verify
```

Council protocol applies to STANDARD and ESCALATED tracks only.

---

## Council Output Format

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AGENT COUNCIL — ROUND 1 (ASSESS)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Chief Architect:        [assessment]
Security Sentinel:      [assessment — CLEAR / FLAG: detail]
[Domain Lead]:          [assessment]
Harness X Verifier:     [proof path: KNOWN / MISSING scenario]
Launch Readiness:       [22 June impact: HELPS / NEUTRAL / HURTS]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ROUND 2 — CONSOLIDATED PLAN (Chief Architect)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[Single implementation plan]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ROUND 3 — PEER REVIEW (Security Sentinel, ESCALATED only)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Status: APPROVED / REJECTED
[reason]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```
