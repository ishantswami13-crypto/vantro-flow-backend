# /cashops-review

Domain review of a collections, cashflow, credit risk, or inventory feature.

## What This Command Does

Reviews a CashOps feature for domain correctness — behavior metrics, tone safety, cashflow accuracy, credit risk scoring, and dispute handling.

## CashOps Review Checklist

### Behavior Metrics
- [ ] Feature uses actual DB data (not hardcoded assumptions)
- [ ] Behavior metrics sourced from correct fields: `promise_reliability`, `broken_promise_count`, `silence_days`, `average_delay_days`, `credit_abuse_risk`
- [ ] Metrics updated after each interaction (evaluation agent)
- [ ] Insufficient data handled gracefully (not scored as "safe" when data is missing)

### Collection Tone
- [ ] Tone selected based on customer behavior profile (not one-size-fits-all)
- [ ] Tone escalation ladder respected: polite → firm → urgent → owner_direct
- [ ] No legal threats in any message path
- [ ] No public shaming language
- [ ] Message passes `promptGuard.service.js`
- [ ] Cortex Lab: `unsafe-legal-threat` scenario still passing

### Cashflow Projection
- [ ] Projection discounted by `promise_reliability` per customer
- [ ] Shows confidence range (not single point estimate)
- [ ] High-risk items flagged separately (broken_promise_count > 2)
- [ ] Supplier payables included in net cash pressure calculation
- [ ] 7-day vs 30-day confidence levels differ appropriately

### Credit Risk
- [ ] Credit risk score includes confidence level
- [ ] Credit block requires owner approval (not autonomous)
- [ ] Insufficient data explicitly flagged (not defaulted to "safe")
- [ ] Score explains which behavior pattern triggered it

### Dispute Handling
- [ ] Disputed invoice halts ALL collection actions for that customer
- [ ] Dispute flag requires owner confirmation to set AND to clear
- [ ] Dispute logs to audit_logs
- [ ] Cortex Lab: `dispute-first` scenario passing

### Timing
- [ ] Contact only between 8am-8pm (timing_engine rule)
- [ ] Max 3 contacts per day per customer
- [ ] Best contact time from `best_reply_time` metric used when available

### Promise Tracking
- [ ] Promise dates from `call_logs.promised_payment_date` used in projection
- [ ] Broken promise detected when payment_date > promised_payment_date + 3 days
- [ ] `broken_promise_count` incremented correctly
- [ ] `promise_reliability` recalculated after each outcome

## Domain Review Verdict

```
Behavior metrics: CORRECT / INCORRECT / MISSING
Tone safety: SAFE / AT RISK (specify)
Cashflow accuracy: RISK-ADJUSTED / NOT ADJUSTED
Credit risk: CONFIDENCE INCLUDED / MISSING
Dispute safety: HALTS CORRECTLY / MISSING
Timing compliance: RESPECTED / VIOLATION
Promise tracking: ACCURATE / INACCURATE

Harness X coverage: [scenario name that validates this]
Domain verdict: CORRECT / INCORRECT / NEEDS REVISION
```
