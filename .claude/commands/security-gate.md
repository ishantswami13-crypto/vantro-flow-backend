# /security-gate

Security review gate. Run before any production deployment or major feature merge.

## What This Command Does

Verifies security posture before deploying to Railway/Vercel. Checks auth, tenant isolation, AI safety, secrets, and external message gate.

## Run Security Suite

```bash
npm run security:secrets        # scan for leaked secrets in code
npm run security:smoke          # auth + route smoke test
npm run security:cross-user     # cross-tenant isolation test
npm run security:audit          # npm audit --audit-level=high
npm run cortex:test             # Harness X (includes ai-safety scenarios)
```

## Security Gate Checklist

### Auth & JWT
- [ ] `req.user.id` used everywhere — not `req.body.user_id`
- [ ] `verifyJWT()` called in auth middleware
- [ ] JWT secret from `getSecret('JWT_SECRET')` — not `process.env` direct
- [ ] HttpOnly cookie set when `ENABLE_AUTH_COOKIES=true`

### Tenant Isolation
- [ ] Every Supabase query: `.eq('user_id', req.user.id)`
- [ ] Every pg query: `WHERE user_id = $1` with parameterized `req.user.id`
- [ ] `npm run security:cross-user` — PASS

### AI Safety
- [ ] `FEATURE_PROMPT_GUARD_ENABLED` — still `true` (default ON, must not be false)
- [ ] All LLM calls pass through `promptGuard.service.js`
- [ ] All risky agent actions pass through `policyGuard.service.js`
- [ ] Cortex Lab ai-safety scenarios: all 6 passing

### External Messaging Gate
- [ ] `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED=false` in Railway (VERIFY in Railway dashboard)
- [ ] No Twilio `client.messages.create()` reachable without this flag
- [ ] Cortex Lab: external-message-without-approval scenario passing

### Secrets
- [ ] `npm run security:secrets` — PASS
- [ ] `.env` files in `.gitignore` — no secrets committed
- [ ] `JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `RAZORPAY_WEBHOOK_SECRET` set in Railway (not in code)

### Webhooks
- [ ] Razorpay webhook: `crypto.createHmac` signature verification active
- [ ] Webhook endpoints not in public docs

### Rate Limiting
- [ ] `express-rate-limit` active on auth routes
- [ ] Rate limit on AI endpoints
- [ ] Rate limit on file upload endpoints

### CORS
- [ ] `ALLOWED_ORIGINS` from env var (not hardcoded in code)
- [ ] Only known Vercel frontend origins allowed

## Security Gate Verdict

```
npm run security:secrets    — PASS / FAIL
npm run security:smoke      — PASS / FAIL
npm run security:cross-user — PASS / FAIL
npm run security:audit      — PASS / FAIL
npm run cortex:test         — Score: X/100 — PASS / FAIL

FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED — false / true (DANGER if true)
FEATURE_PROMPT_GUARD_ENABLED — true / false (DANGER if false)
RUST_CORTEX_CORE_ENABLED — false / true (check if intentional)
RUST_AUTOMATION_API_ENABLED — false / true (check if intentional)

P0 blockers: [list or "none"]
P1 risks: [list or "none"]

SECURITY GATE: PASS / FAIL
DEPLOY: APPROVED / BLOCKED
```
