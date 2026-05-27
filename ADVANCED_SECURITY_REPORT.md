# Advanced Security Report

## Security Score

Current score: 72/100.

This is materially safer than the initial state because backend auth, route ownership, route compatibility, throttling, webhook hardening, CORS tightening, and audit hooks now exist. It is not yet fintech-complete until RLS, cookie auth, dependency remediation, signed-link enforcement, and cross-user staging tests are complete.

## Layers Added

- Authenticated `/api/inventory` alias.
- Targeted rate limits for auth, uploads, AI, public bills, and heavy read endpoints.
- Strict production frontend CORS allowlist with explicit dev origins.
- Signed public bill token verification support.
- Legacy public bill deprecation headers.
- Production rejection of unsigned/misconfigured webhook paths.
- Timing-safe HMAC comparison for webhook and public link signatures.
- Financial/business audit logging for key write paths.

## Auth Status

Private routes broadly use JWT middleware or owner/admin wrappers. `/api/auth/me` uses backend token identity and no longer returns 404 for the route itself.

## Authorization and User Isolation

Major user-owned route groups are scoped by `req.user.userId` or `requireOwner`. Cross-user verification still needs two real test users.

## Query Safety

Most access uses Supabase query builder. Raw SQL is used for migrations and maintenance. Those endpoints are admin-only and should remain tightly controlled.

## Secret Management

No obvious tracked secret values were found in the inspected files. `.gitignore` excludes env/key patterns. GitHub push protection and secret scanning should be enabled.

## Supabase RLS

RLS is not yet verified or applied. See `SECURITY_RLS_PLAN.md`.

## Financial Integrity

Razorpay webhook verifies signatures when configured and avoids duplicate invoice bank transactions. Manual payment, sales, purchases, inventory, and bank transaction actions now create audit log attempts. Ledger immutability still needs a stronger policy before real financial operations.

## Webhook Security

Razorpay requires `RAZORPAY_WEBHOOK_SECRET` in production. WhatsApp and voice routes now reject production calls without their shared secret. Provider-native signature validation should be added later where available.

## Rate Limiting

General API, auth, upload, AI, public bill, and heavy endpoints are rate limited. Limits are conservative enough for normal use and stricter for abuse-prone routes.

## Headers and CORS

Manual API security headers are present. CORS is no longer wildcard for all Vercel domains; production frontend and localhost dev are explicitly allowed, with optional `ALLOWED_ORIGINS`.

## Dependency Risks

`xlsx`, Next.js, and `node-cron`/`uuid` risks remain. See `DEPENDENCY_SECURITY_PLAN.md`.

## CI and Automation

See `SECURITY_CI_PLAN.md`. Add blocking syntax/build checks first; make dependency audit blocking after known advisories are resolved.

## Remaining Critical Risks

- Supabase RLS not verified.
- Valid cross-user staging test matrix not executed.
- JWT still readable by JavaScript.
- Public bill signed links are not yet mandatory unless `REQUIRE_SIGNED_PUBLIC_BILLS=true`.

## Remaining High Risks

- `xlsx` no-fix advisory.
- Frontend Next.js audit findings.
- Provider-native WhatsApp/voice signature verification not complete.
- Ledger immutability and financial edit approvals need more work.

## Before Real Customers

1. Run cross-user tests.
2. Verify Supabase key posture.
3. Enable RLS in staging.
4. Enforce signed public bill links.
5. Enable GitHub secret scanning/push protection.
6. Add CI build/syntax checks.

## Before Payments

1. Confirm `RAZORPAY_WEBHOOK_SECRET` in Railway.
2. Verify webhook event idempotency with real test events.
3. Add ledger immutability or reversal-entry workflow.
4. Add ActivityLog review UI or export.

## Before WhatsApp/Calls

1. Configure shared webhook secrets.
2. Prefer provider-native signatures.
3. Remove secrets from user-visible webhook URLs.
4. Add replay protection where provider timestamp is available.

## 7-Day Roadmap

1. Execute valid-login production QA.
2. Execute cross-user staging tests.
3. Confirm Railway/Supabase secret posture.
4. Enable GitHub secret scanning and branch protection.
5. Decide public bill signed-link enforcement date.

## 30-Day Roadmap

1. Stage Supabase RLS policies.
2. Migrate auth toward HttpOnly cookies.
3. Replace or isolate `xlsx` parsing.
4. Plan and test Next.js upgrade.
5. Implement financial reversal ledger model.
