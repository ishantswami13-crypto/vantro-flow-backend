# /launch-readiness

Run a full 22 June launch readiness audit. No fake greens. Unknown = assume broken.

## What This Command Does

Audits every launch-critical item across backend, frontend, security, UX, auth, DB, Harness X, Rust, agents, and deployment. Issues 🔴/🟡/🟢/⚪ for each.

## Run These First

```bash
node --check server.js
npm run cortex:test
npm run security:smoke
npm run security:secrets
npm run security:cross-user
```

## Audit Checklist

### Backend
- [ ] JWT auth working (bcryptjs + jsonwebtoken)
- [ ] Rate limiting active (express-rate-limit)
- [ ] validateSecurityEnvironment() passes on startup
- [ ] `node --check server.js` — clean
- [ ] All routes tested via security:smoke

### External Services
- [ ] TWILIO_WHATSAPP_NUMBER set in Railway (currently: NOT SET)
- [ ] RAZORPAY_WEBHOOK_SECRET set in Railway
- [ ] ENABLE_AUTH_COOKIES set in Railway (verify)
- [ ] METRICS_TOKEN set in Railway

### Harness X
- [ ] Static mode: 100/100 (`npm run cortex:test`)
- [ ] Live mode running (needs TEST_BASE_URL) — currently N/A
- [ ] All 5 N/A categories unlocked

### Frontend
- [ ] All 40+ pages have loading.tsx
- [ ] All data lists have empty states
- [ ] Mobile layout verified at 375px
- [ ] Cookie banner functional
- [ ] PWA install prompt working
- [ ] PostHog events firing on key actions

### Security
- [ ] `npm run security:secrets` — PASS
- [ ] `npm run security:cross-user` — PASS
- [ ] FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED=false in Railway
- [ ] FEATURE_PROMPT_GUARD_ENABLED=true

### Rust
- [ ] RUST_CORTEX_CORE_ENABLED=false in Railway
- [ ] RUST_AUTOMATION_API_ENABLED=false in Railway
- [ ] Node fallback working for both

### Product (Milestone C)
- [ ] Collections AI + Action Center built (/ai-actions)
- [ ] Owner approval gate for WhatsApp sending wired
- [ ] /today page functional as daily habit anchor
- [ ] cashflowAgent giving accurate 7/14/30 day projections

### Database
- [ ] 6 migrations applied (001-005 done, 006 NOT applied — OK)
- [ ] No pending migration needed for launch features
- [ ] Backup plan in place (BACKUP_RESTORE_PLAN.md)

## Rating Scale

- 🔴 RED — Blocker. Cannot launch without fixing.
- 🟡 YELLOW — Risk. Should fix before launch.
- 🟢 GREEN — Verified ready. Has proof.
- ⚪ UNKNOWN — Not verified. Assume broken.

## Output Format

```
Item                              | Status | Notes
----------------------------------|--------|-------
TWILIO_WHATSAPP_NUMBER in Railway | 🔴     | Not set
Milestone C built                 | 🔴     | Not started
Harness X static 100%             | 🟢     | cortex-lab/reports/latest.md
...

🔴 RED: [N] items
🟡 YELLOW: [N] items
🟢 GREEN: [N] items
⚪ UNKNOWN: [N] items

CAN LAUNCH by 22 June: YES / NO / CONDITIONAL
Days of work remaining: [estimate]
If conditional: [exact conditions]
```
