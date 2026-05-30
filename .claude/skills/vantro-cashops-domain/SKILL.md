# Vantro CashOps Domain Skill

## Overview

Use this skill when building or reviewing collections logic, cashflow projections, credit risk scoring, payment behavior analysis, tone/timing selection, promise tracking, dispute handling, or any MSME business domain logic.

Trigger: "collections", "receivables", "overdue", "payment behavior", "promise", "credit risk", "cashflow", "inventory cash", "tone", "timing", "dispute", "MSME", "Rajesh", "dunning".

## What This Skill Does

1. Validates domain logic against real MSME payment behavior patterns
2. Checks behavior metrics are correctly used
3. Verifies tone selection is appropriate and safe
4. Confirms cashflow projections are risk-adjusted
5. Ensures dispute handling halts collection safely
6. Checks against Harness X scenario coverage

## Core Domain Logic Files

| Algorithm | JS Implementation | Rust Implementation |
|-----------|------------------|-------------------|
| Collection Priority | collectionsAgent.js | cashops/collection_priority.rs |
| Credit Control | creditRiskAgent.js | cashops/credit_control.rs |
| Payment Behavior | collectionsAgent.js | cashops/payment_behavior.rs |
| Timing | (timing logic) | cashops/timing_engine.rs |
| Tone | (tone selection) | cashops/tone_engine.rs |
| Cashflow Projection | cashflowAgent.js | (Node only currently) |

## Key Behavior Metrics

```
promise_reliability      # % of promises kept within 3 days
broken_promise_count     # total broken promises
silence_days             # days since last response
average_delay_days       # avg days late across all payments
credit_abuse_risk        # credit builds up then goes silent
customer_value           # total annual purchase value
```

## Tone Escalation Ladder

1. `polite` — first 1-2 reminders
2. `firm` — after silence or one broken promise
3. `urgent` — after multiple broken promises or >30 days silence
4. `owner_direct` — only for high-value, high-relationship customers

**promptGuard blocks**: legal threats, public shaming, abusive language.

## Cashflow Projection Rules

- Discount by `promise_reliability` (30% reliable = 30% contribution)
- Show ₹ amounts with confidence range, not single number
- 7-day: high confidence (committed + high-reliability only)
- 30-day: moderate confidence (include medium-reliability)
- Flag: customers with `broken_promise_count > 2` as high risk

## Dispute Handling

When dispute detected:
1. Flag invoice as disputed
2. Halt all collection actions for that customer
3. Require owner to confirm dispute before resuming
4. Log to audit_logs

Harness X: `cortex-lab/scenarios/collections/dispute-first.json`

## Domain Review Checklist

- [ ] Behavior metrics sourced from DB, not hardcoded
- [ ] Tone appropriate for customer profile (not one-size-fits-all)
- [ ] Cashflow projection discounted by promise_reliability
- [ ] Credit risk score includes confidence level
- [ ] Dispute detection halts collection (not just flags it)
- [ ] Time window respected (8am-8pm, max 3 contacts/day)
- [ ] No unsafe collection language (blocked by promptGuard)
- [ ] Harness X scenario exists for this behavior

## Verdict Format

Domain logic: CORRECT / INCORRECT / MISSING DATA
Behavior metrics used: YES / NO (list which ones)
Tone safety: SAFE / BLOCKED (by promptGuard)
Cashflow risk-adjusted: YES / NO
Dispute safety: ACTIVE / MISSING
Harness X coverage: COVERED / UNCOVERED (scenario needed)
