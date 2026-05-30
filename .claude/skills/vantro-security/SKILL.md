# Vantro Security Skill

## Overview

Use this skill before any auth changes, new API routes, DB schema changes, webhook additions, Twilio/WhatsApp enabling, or production deployment.

Trigger: "auth", "JWT", "security review", "RLS", "CORS", "webhook", "WhatsApp sending", "Twilio enable", "production deploy", "tenant isolation", "cross-user", "prompt injection".

## What This Skill Does

1. Runs security checklist against the change
2. Identifies P0/P1/P2 vulnerabilities
3. Verifies tenant isolation
4. Checks AI safety gates
5. Runs (or reports status of) `npm run security:smoke` and `npm run security:cross-user`
6. Issues SAFE / UNSAFE verdict

## Security Hierarchy

```
P0 (launch blocker) → P1 (ship risk) → P2 (post-launch hardening)
```

## Core Security Checks

**Auth:**
- [ ] `user_id` from `req.user.id` (JWT), NEVER from `req.body`
- [ ] Auth middleware on all protected routes
- [ ] JWT verified via `verifyJWT()` in server.js
- [ ] Cookie flags: HttpOnly, Secure, SameSite=Strict

**Tenant isolation:**
- [ ] Every query: `.eq('user_id', req.user.id)` or `WHERE user_id = $1`
- [ ] No query without user_id scope
- [ ] `npm run security:cross-user` passes

**AI safety:**
- [ ] All LLM input through `promptGuard.service.js`
- [ ] `FEATURE_PROMPT_GUARD_ENABLED` stays ON
- [ ] `cortex-lab/scenarios/ai-safety/` all passing

**WhatsApp safety:**
- [ ] `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED=false` in Railway (default)
- [ ] No Twilio send without flag AND owner approval
- [ ] Message content through promptGuard
- [ ] cortex-lab: external-message-without-approval scenario passing

**Secrets:**
- [ ] No secrets in code — only via `getSecret()`
- [ ] `npm run security:secrets` passes
- [ ] `.env` files in `.gitignore`

**Webhooks:**
- [ ] Razorpay webhook: `crypto.createHmac` signature verify
- [ ] `RAZORPAY_WEBHOOK_SECRET` set in Railway

## Quick Security Commands

```bash
npm run security:smoke         # auth + route smoke test
npm run security:secrets       # scan for leaked secrets
npm run security:cross-user    # tenant isolation test
npm run security:audit         # npm audit --audit-level=high
npm run cortex:test            # Harness X (ai-safety scenarios)
```

## Verdict Format

SAFE TO DEPLOY: [YES / NO]
P0 blockers: [list or "none"]
P1 risks: [list or "none"]
Required before deploy: [specific commands to run]
