# Vantro Launch Execution Skill

## Overview

Use this skill when running a launch audit, triaging 22 June deadline risk, deciding what to build vs defer, or checking if a specific area is ready to ship.

**22 June 2026. Today: 30 May. 23 days.**

Trigger: "launch", "22 June", "ready to ship", "launch audit", "deadline", "what to build", "what to defer", "launch readiness", "ship safe".

## What This Skill Does

1. Rates every launch item: 🔴 RED / 🟡 YELLOW / 🟢 GREEN / ⚪ UNKNOWN
2. No fake greens — unknown = assume broken
3. Identifies what blocks launch (🔴 only)
4. Prioritizes work for remaining 23 days
5. Issues CAN LAUNCH / CANNOT LAUNCH verdict

## Launch Status (as of 2026-05-30)

### 🔴 RED — Launch Blockers

| Item | Gap |
|------|-----|
| TWILIO_WHATSAPP_NUMBER in Railway | Not set — WhatsApp blocked |
| Milestone C: Collections AI + Action Center | Not built — core product loop |
| FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED approval gate | Not wired in UI |

### 🟡 YELLOW — Should Fix Before Launch

| Item | Notes |
|------|-------|
| Live Harness X | 5 N/A categories — needs TEST_BASE_URL + creds |
| ENABLE_AUTH_COOKIES in Railway | Status unknown — verify |
| Frontend loading.tsx on all 40 pages | Some missing |
| Empty states on all data lists | Not fully verified |
| Mobile layout at 375px | Not verified across all pages |
| WhatsApp message frequency limiting | Not implemented yet |
| RLS 006 applied | Defence-in-depth — not blocking (service role bypasses) |

### ⚪ UNKNOWN — Verify

| Item | How to Check |
|------|-------------|
| node-cron in Railway (cron on single instance?) | Check Railway restart behavior |
| /metrics endpoint secured (METRICS_TOKEN set?) | Check Railway env vars |
| ENABLE_AUTH_COOKIES flag in Railway | Check Railway env vars |
| PostHog events firing | PostHog dashboard |

### 🟢 GREEN — Verified Ready

| Item | Evidence |
|------|---------|
| JWT auth implemented | server.js: verifyJWT(), bcryptjs |
| Harness X static 100% | cortex-lab/reports/latest.md |
| Rust flags OFF | lib/featureFlags.js: RUST_CORTEX_CORE_ENABLED=false |
| promptGuard active | FEATURE_PROMPT_GUARD_ENABLED defaults true |
| Rate limiting active | express-rate-limit in server.js |
| Security env validation | validateSecurityEnvironment() in server.js |
| Razorpay integrated | package.json: razorpay |
| 40+ frontend pages built | app/ directory |
| Cookie auth middleware | middleware.ts |

## 23-Day Priority Plan

**Week 1 (May 30 - June 6): Unblock**
- [ ] Set TWILIO_WHATSAPP_NUMBER in Railway (30 min)
- [ ] Verify ENABLE_AUTH_COOKIES in Railway
- [ ] Set up live Harness X test environment
- [ ] Start Milestone C design

**Week 2 (June 7 - June 13): Build Core**
- [ ] Build Collections AI + Action Center (Milestone C)
- [ ] Wire owner approval gate for WhatsApp sending
- [ ] Frontend audit: loading.tsx, empty states, 375px

**Week 3 (June 14 - June 22): Polish + Ship**
- [ ] Full Harness X run (all modes)
- [ ] Security smoke test + cross-user test
- [ ] Performance test
- [ ] Soft launch preparation

## Launch Audit Commands

```bash
npm run cortex:test              # Harness X static (must be 100%)
npm run cortex:test:all          # All modes (live needs env)
npm run security:smoke           # Auth + route check
npm run security:secrets         # No leaked secrets
npm run security:cross-user      # Tenant isolation
npm run perf:test                # Performance baseline
node --check server.js           # Syntax check
```

## Verdict Format

Items audited: [N]
🔴 RED: [count + list]
🟡 YELLOW: [count + list]
🟢 GREEN: [count]
⚪ UNKNOWN: [count + list]

CAN LAUNCH by 22 June: YES / NO / CONDITIONAL
If conditional: [exact conditions that must be met]
Days of work remaining: [estimate]
