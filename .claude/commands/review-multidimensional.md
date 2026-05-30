# /review-multidimensional

Run a 30-dimension review of the current change before it is merged or deployed.

## What This Command Does

Reviews a change across every dimension that matters for Vantro's MSME CashOps OS. No dimension gets skipped. No fake green verdicts.

## 30 Dimensions

Rate each: PASS / FAIL / N/A / UNKNOWN

1. **Product value** — Does this make Vantro more useful to Rajesh? Will MSME owners care?
2. **Owner workflow** — Can an owner act on this in <30 seconds? Mobile-first?
3. **Collections domain logic** — Is payment behavior, tone, timing, promise tracking correct?
4. **Human behavior psychology** — Does this match how Indian MSME owners and customers actually behave?
5. **Backend architecture** — Right layer? Monolith vs service? Orchestrator wired?
6. **Frontend UX/UI** — Owner-first action design? Loading/empty/error states? 375px mobile?
7. **Database schema** — RLS-ready structure? Indexes? Tenant scoping? Migration safe?
8. **Authentication + tenant isolation** — user_id from JWT? No cross-tenant queries?
9. **Security + secrets** — No leaked secrets? CORS correct? Rate limiting? Webhook verified?
10. **Cache + performance** — Per-tenant cache keys? No stale data risk? Response time <500ms?
11. **API design** — RESTful? Idempotent for financial actions? Consistent error format?
12. **Error handling** — Does it fail gracefully? Error logged? User sees human message?
13. **Testing + Harness X** — Cortex Lab scenario exists? 100% static pass? Live mode needed?
14. **Observability + logs** — Action logged? Metric tracked? Debuggable in <5 min?
15. **Scalability** — Breaks at 1,000 users? 10,000? N+1 queries? Missing indexes?
16. **Agent readiness** — Feature-flagged? policyGuard wired? promptGuard wired? audit.log firing?
17. **AI cost efficiency** — Model appropriate for task? Cost per action estimated? Cap set?
18. **Launch readiness (22 June)** — Helps or hurts the 23-day deadline?
19. **Hidden failure modes** — What fails silently? What fails noisily? What data corruption risk?
20. **Second-order effects** — What else breaks when this breaks? What does this change unlock or block?
21. **Data integrity** — Idempotent? Race condition safe? Concurrent update safe?
22. **Fintech/compliance risk** — Collection message safe? Audit trail complete? RBI-compliant?
23. **Deployment + rollback safety** — Can we roll back in <5 minutes? Migration reversible?
24. **HighRadius benchmark** — Are we simpler/faster/cheaper? Not falling into enterprise complexity trap?
25. **Rust fallback safety** — If Rust is OFF (it is), does Node fallback work correctly?
26. **Customer trust** — Would this embarrass Vantro if a customer saw it fail in production?
27. **Operational support** — Can we debug a production incident from logs alone?
28. **Pricing/GTM implications** — Does this change what plan this feature is in?
29. **Reliability under load** — Tested with 100 concurrent users? Railway restart-safe?
30. **Ethical automation boundaries** — No unsafe collection actions? No autonomous financial writes? Owner approval preserved?

## Output Format

```
Dimension            | Score      | Notes
---------------------|------------|------------------------------------------
Product value        | PASS/FAIL  | [specific observation]
Owner workflow       | PASS/FAIL  | [specific observation]
...

Overall: PASS (25/30) / FAIL (X dimensions failed)
Blockers: [dimensions that are FAIL and must be fixed before ship]
Ship safe: YES / NO / CONDITIONAL
```
