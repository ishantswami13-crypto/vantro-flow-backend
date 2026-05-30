# Vantro Product Psychology Skill

## Overview

Use this skill when designing collection message tone, escalation flows, owner briefing content, daily habit design, or any UX that touches owner behavior or customer psychology.

Trigger: "tone", "message content", "escalation", "collection psychology", "owner habit", "retention", "payment behavior", "customer psychology", "/today page", "PaymentCelebration".

## What This Skill Does

1. Evaluates message tone against behavior profile
2. Validates escalation ladder is appropriate
3. Reviews habit loop design for `/today`
4. Identifies psychological elements that drive payment
5. Flags anything that could harm customer relationships

## Payment Psychology for Indian MSMEs

**Why customers delay payment:**
1. Cash flow problems (genuine — needs understanding)
2. Month-end pattern (predictable — time around it)
3. Excuse habit (broken promise pattern — needs firmness)
4. Dispute (contested — halt collection, verify)
5. Credit abuse (builds up credit then goes silent — needs credit block)
6. Relationship test (testing how persistent you are — needs consistency)

**What actually makes customers pay:**
1. Personal connection (owner calling vs staff calling)
2. Specific amount mentioned (₹48,500, not "outstanding amount")
3. Specific deadline with consequence (not vague "please pay soon")
4. Relationship preservation framing ("to keep our account smooth...")
5. Cash pressure awareness ("we have to pay our suppliers by...")

## Tone Selection Logic

| Customer Profile | Correct Tone |
|-----------------|-------------|
| First reminder, good history | polite |
| 2nd reminder, good history | polite |
| 3rd+ reminder or 1 broken promise | firm |
| Repeated broken promises (2+) | urgent |
| High-value + long relationship | owner_direct (owner calls personally) |
| Credit abuse pattern | credit block (stop new sales) |
| Dispute raised | halt collection (verify dispute first) |

**NEVER:** threats, legal ultimatums, public shaming, abusive language — blocked by promptGuard.

## Behavior Metrics for Tone

```javascript
// Select tone based on these metrics:
if (polite_reminder_success > 0.6) → polite
if (broken_promise_count >= 2) → urgent
if (silence_days > 14 && !dispute) → firm + escalate
if (owner_call_dependency === true) → owner_direct
if (credit_abuse_risk > 0.7) → credit_block
```

## Daily Habit Design (/today page)

**What makes owners open the app every day:**
1. Something new to act on (personalized, not generic)
2. Clear cash number (₹ amount due today, ₹ expected this week)
3. One action that takes <30 seconds (tap → approve → done)
4. Celebration when cash comes in (PaymentCelebration.tsx)

**Habit loop:**
- Trigger: push notification / WhatsApp from Vantro "Your daily briefing is ready"
- Action: open `/today`, see top 3 customers to contact
- Reward: cash came in → PaymentCelebration → dopamine hit
- Investment: each action tracked → better recommendations over time

**Do not remove PaymentCelebration.tsx** — this is the retention anchor.

## Message Quality Checklist

For every AI-drafted collection message:
- [ ] Contains specific ₹ amount (not "outstanding amount")
- [ ] Contains specific due date or deadline
- [ ] Tone matches customer behavior profile
- [ ] Not threatening (no legal threats)
- [ ] Not public shaming
- [ ] Relationship-preserving language
- [ ] Under 160 characters for WhatsApp readability
- [ ] Passes promptGuard validation

## Owner Psychology

**Rajesh's fears:**
1. "I'll lose the customer if I push too hard" → show relationship_risk metric, give him confidence
2. "I don't know who to call" → ranked priority list removes decision paralysis
3. "I don't know how much to ask for" → exact ₹ amount with breakdown
4. "I don't know when they'll pay" → cashflow projection with confidence range

## Verdict Format

Message tone: APPROPRIATE / NEEDS ESCALATION / TOO AGGRESSIVE
Customer profile fit: MATCHES / MISMATCH (explain)
Relationship safety: SAFE / AT RISK
promptGuard: PASS / BLOCK
Habit loop: REINFORCES / BREAKS
Action clarity: CLEAR (30 sec to act) / UNCLEAR
