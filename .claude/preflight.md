# Vantro Code OS — Pre-Flight Checklist

## Purpose

A mandatory 10-point check that runs before every meaningful task. Like a pilot's pre-flight — fast, non-negotiable, prevents disasters.

This takes under 60 seconds to run mentally. It prevents the most common failure modes before any code is touched.

---

## Pre-Flight Protocol

Before every task, answer all 10 questions. Routing and track selection depend on the answers.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VANTRO CODE OS — PRE-FLIGHT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[1] SCOPE — What exactly is being changed?
    File(s): [list]
    Domain:  [from signal-map.md]
    Scope:   REPO-BRAIN / APP LOGIC / BOTH

[2] FINANCIAL RISK — Does this touch money?
    Invoices / amounts / payments / balances:  YES → ESCALATED / NO

[3] AUTH RISK — Does this touch identity?
    JWT / cookies / middleware / permissions:   YES → ESCALATED / NO

[4] TENANT RISK — Does this touch user isolation?
    user_id scoping / cross-user queries:      YES → ESCALATED / NO

[5] AI SAFETY — Does this touch AI behaviour?
    policyGuard / promptGuard / agents:        YES → high min risk / NO

[6] EXTERNAL SEND RISK — Does this touch messaging?
    Twilio / WhatsApp / FEATURE_EXTERNAL_*:    YES → ESCALATED / NO

[7] RUST RISK — Does this touch Rust services?
    cortex-core-rs / vantro-automation-rs:     YES → high min risk / NO

[8] DB RISK — Does this touch database?
    Migrations / schema / RLS / indexes:       YES → ESCALATED / NO

[9] SECRETS RISK — Does this touch secrets?
    .env / env vars / keys / tokens in code:   YES → ESCALATED / NO

[10] 22 JUNE IMPACT — How does this affect launch?
     HELPS (builds toward launch) / NEUTRAL / HURTS (adds risk or debt)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TRACK:  FAST / STANDARD / ESCALATED
SCORE:  [from risk-matrix.md]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Pre-Flight Failure Modes (What to Do When)

### [1] Scope is unclear
→ Ask ONE clarifying question: "Which file(s) is this change in?"
→ Do not guess. Do not assume. Do not start until scope is clear.

### [2] Financial risk = YES
→ Immediately: ESCALATED TRACK
→ Mandatory: `vantro-security-sentinel` + `vantro-harness-x-verifier`
→ Run: Harness X `fake-payment-received` scenario must still pass after change

### [3] Auth risk = YES
→ Immediately: ESCALATED TRACK
→ Mandatory: Confirm `verifyJWT()` still on all protected routes after change
→ Run: `npm run security:smoke` + `npm run security:cross-user`

### [4] Tenant risk = YES
→ Immediately: ESCALATED TRACK
→ Mandatory: Read every query in affected file and confirm `user_id = req.user.id`
→ Run: `npm run security:cross-user`

### [5] AI safety = YES
→ Minimum: STANDARD TRACK
→ Mandatory: Confirm `promptGuard` still active on all LLM input paths
→ Run: `npm run cortex:test` (ai-safety scenarios must all pass)

### [6] External send = YES
→ Immediately: ESCALATED TRACK
→ Mandatory: Confirm `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED` still false in Railway
→ Do NOT enable without owner approval gate wired in UI

### [7] Rust risk = YES
→ Minimum: STANDARD TRACK
→ Mandatory: Run `npm run rust:check:all` after any Rust file change
→ If flag enablement: `/rust-gate` command first

### [8] DB risk = YES
→ Immediately: ESCALATED TRACK
→ Mandatory: Confirm migration is additive + has rollback SQL + tested on shadow DB
→ Migration 006 (RLS): NEVER apply without Supabase Auth bridge confirmed

### [9] Secrets risk = YES
→ Immediately: ESCALATED TRACK
→ Mandatory: `npm run security:secrets` BEFORE and AFTER change
→ If secret found in code: STOP — do not commit, remove secret, rotate the key

### [10] 22 June impact = HURTS
→ Flag it in the final report
→ Ask: "Is this the highest-leverage use of time today?"
→ If not: suggest deferring and focus on Milestone C

---

## Pre-Flight for Repo-Brain Only Tasks

If scope is REPO-BRAIN only (CLAUDE.md, AGENTS.md, .claude/*):

```
Pre-flight result: REPO-BRAIN ONLY
Track:             FAST TRACK
App logic:         NOT TOUCHED
Proof gate:        git diff --name-only (confirm no app files staged)
```

No Harness X required. No security checks required. Confirm `git diff --name-only` shows only `.claude/`, `CLAUDE.md`, `AGENTS.md` files before committing.

---

## Pre-Flight Frequency

- **Every meaningful task**: Run pre-flight
- **Trivial fixes** (typo, comment): Fast mental pass of questions 1-4 only
- **War room / invoke-war-room**: Pre-flight is embedded in war room protocol
- **Continuing a stopped task**: Re-run pre-flight to re-establish context
