# /no-blindspots

Adversarial review of a change to find hidden failure modes before they hit production.

## What This Command Does

Actively tries to break, exploit, or find edge cases in a proposed change. Looks for what can go wrong, not just what works in the happy path.

## Adversarial Review Framework

For every change, attack these angles:

### Tenant Isolation Attacks
- What happens if user_id is missing from the JWT?
- What happens if user_id is spoofed in the request body?
- Can User A's data be returned to User B through any code path?
- Does caching create cross-tenant data leakage?

### Financial Integrity Attacks
- Can an invoice be marked paid without a real payment?
- Can an invoice amount be changed without audit trail?
- Can a payment record be created without a matching Razorpay webhook?
- Can a double-payment be triggered by submitting twice?
- Can a negative amount create a credit?

### AI Safety Attacks
- Can prompt injection bypass promptGuard?
- Can an AI response trigger an autonomous financial action?
- Can a customer's WhatsApp reply inject a command into Vantro?
- Can the AI hallucinate a payment that didn't happen?
- Validate: `cortex-lab/scenarios/ai-safety/prompt-injection-followup.json` passing

### WhatsApp Sending Attacks
- Can external message sending be triggered without FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED=true?
- Can a message be sent without owner approval?
- Can the prompt guard be bypassed for a specific message?
- What happens if TWILIO_WHATSAPP_NUMBER is wrong or expired?
- Validate: `cortex-lab/scenarios/ai-safety/external-message-without-approval.json` passing

### Rate Limiting + Abuse Attacks
- Can a user exhaust AI budget by rapidly calling AI endpoints?
- Can file upload be used for DoS (large files, many files)?
- Can auth endpoint be brute-forced?
- What happens at 100 concurrent requests?

### Data Corruption Attacks
- Race condition: two requests updating the same invoice simultaneously?
- What if Supabase returns a network error mid-transaction?
- What if the Rust binary crashes mid-computation?
- What if node-cron fires twice (Railway restart + cron overlap)?

### Silent Failure Attacks
- What fails silently (no error, no log, wrong result)?
- What fails noisily and correctly (error returned, logged)?
- What data gets corrupted instead of erroring?
- What metric would catch this failure if it happened in production?

### Second-Order Effects
- Does this change break any existing feature flag?
- Does this change make any Harness X scenario harder to pass?
- Does this change affect performance under load?
- Does this change create a migration that's hard to roll back?

## Blindspot Report Format

```
Change: [description]

Tenant isolation: [vulnerabilities found or "none"]
Financial integrity: [vulnerabilities found or "none"]
AI safety: [vulnerabilities found or "none"]
WhatsApp gate: [vulnerabilities found or "none"]
Rate limiting: [vulnerabilities found or "none"]
Data corruption: [risks found or "none"]
Silent failures: [risks found or "none"]
Second-order effects: [risks found or "none"]

Harness X scenarios that would catch these: [list or "need to write"]

Critical blindspots found: [N]
Must fix before deploy: [list or "none"]
Can ship with mitigations: YES / NO
```
