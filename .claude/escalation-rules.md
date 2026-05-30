# Vantro Code OS — Escalation Rules

## Purpose

Defines critical-risk triggers that require mandatory escalation to senior agents, additional proof gates, and explicit safety verdicts before any action is taken.

**Escalation means**: more agents activated, harder proof required, explicit YES/NO deployment verdict, rollback plan mandatory.

---

## Critical-Risk Triggers

Any task that touches any of the following is automatically `critical` risk and triggers full escalation:

| Trigger | Why Critical |
|---------|-------------|
| Authentication (JWT, cookies, sessions) | Breaks login for all users if wrong |
| Payment state (Razorpay, mark-paid) | Financial data integrity |
| Invoice amount change | Can create fake financial records |
| Customer balances / outstanding amounts | Real money at stake |
| Cross-user data access | Tenant isolation breach = catastrophic |
| Secrets (JWT_SECRET, SUPABASE_SERVICE_ROLE_KEY, etc.) | Full system compromise |
| RLS policies (Supabase row-level security) | Data leakage across tenants |
| External WhatsApp / Twilio message sending | Regulatory + brand risk |
| Rust production enablement (Rust flags) | Untested code in critical path |
| Database migrations (ALTER, CREATE TABLE, DROP) | Irreversible DB changes |
| Deletion / cancellation logic | Permanent data loss risk |
| Feature flag changes in production | Unexpected feature activation |
| CORS / rate limiting changes | Abuse vectors |
| Webhook endpoint changes | Payment processing disruption |

---

## Escalation Protocol

When any trigger above is detected, Claude Code must:

### Step 1 — Announce Escalation

```
⚠️  ESCALATION TRIGGERED
Reason: [which trigger was detected]
Risk:   CRITICAL
```

### Step 2 — Activate Mandatory Agents

- `vantro-security-sentinel` ← mandatory
- `vantro-database-rls-guardian` ← mandatory if DB/RLS involved
- `vantro-harness-x-verifier` ← mandatory
- `vantro-launch-readiness-officer` ← mandatory
- `vantro-chief-architect` ← mandatory
- `vantro-compliance-risk-agent` ← if external messaging or payment involved
- `vantro-rust-systems-engineer` ← if Rust flags involved

### Step 3 — Run Security Checks First (Before Implementation)

```bash
npm run security:secrets      # no leaked secrets
npm run security:cross-user   # tenant isolation still intact
npm run security:smoke        # auth + routes working
npm run cortex:test           # Harness X still 100%
```

All must PASS before any implementation begins.

### Step 4 — Produce Escalation Safe Plan

```
ESCALATION SAFE PLAN
--------------------
Trigger:          [which critical trigger]
Impact if wrong:  [what breaks, who is affected]
Files to inspect: [exact list]
Files to edit:    [exact list, minimal]
Migration safety: [additive/reversible/requires shadow test]
Rollback:         [exact steps to undo in <5 min]
Proof gates:      [exact commands]
Owner approval:   [required YES/NO — for external sends, payments]
```

### Step 5 — Mandatory Final Verdict

After implementation and proof gates, output:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ESCALATION VERDICT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Safe to deploy:      YES / NO / CONDITIONAL
  If conditional:    [exact conditions that must be met first]

Rollback plan:       [step-by-step, doable in <5 minutes]

Tests run:
  - [command] — PASS / FAIL / SKIPPED
  - [command] — PASS / FAIL / SKIPPED

Risks remaining:
  - [honest list of residual risks or "none"]

Tenant isolation:    VERIFIED / NOT VERIFIED
Financial integrity: VERIFIED / NOT VERIFIED
Harness X:           100/100 PASS / FAIL (score: X/100)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Escalation-Specific Rules

### Authentication Changes
- Read `verifyJWT()` in server.js before touching anything
- Confirm JWT middleware is applied to all protected routes after change
- Run `npm run security:smoke` and `npm run security:cross-user`
- Never change JWT_SECRET without dual-secret rotation pattern (`_CURRENT` + `_PREVIOUS`)

### Payment / Invoice Changes
- Confirm idempotency key is present
- Confirm mark-paid requires owner JWT (not just any authenticated user)
- Confirm Razorpay webhook signature still verified
- Validate: `cortex-lab/scenarios/ai-safety/fake-payment-received.json` still passes

### Database Migrations
- Migration must be additive (no column drops, no full-table rewrites)
- Must have rollback SQL ready
- Must be tested on shadow Supabase project before production
- Migration 006 (RLS) must NOT be applied without auth bridge

### External Message Sending (WhatsApp/Twilio)
- `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED` must be `false` in Railway (verify in Railway dashboard)
- Owner approval gate must be wired in UI before enabling
- Message content must pass `promptGuard.service.js`
- Validate: `cortex-lab/scenarios/ai-safety/external-message-without-approval.json` still passes
- Frequency limiting (max 3/day/customer) must be implemented

### Rust Flag Enablement
- `/rust-gate` command must be run and every item must PASS
- Node fallback must be verified DOWN-path (when Rust is unavailable)
- `auth_cache_isolation.rs` test must pass
- Harness X must still be 100% after flag enabled in dev

### Cross-User / Tenant Isolation
- `npm run security:cross-user` is mandatory, not optional
- Read every affected query and confirm `user_id = req.user.id` scope
- Validate: `cortex-lab/scenarios/security/cross-business-leak.json` still passes

---

## Non-Escalation Does Not Mean No Risk

Low/medium risk tasks still require:
- Correct agent routing
- File inspection before edit
- Proof gates appropriate to domain
- Final report with risks remaining

Escalation is a higher bar, not the only bar.
