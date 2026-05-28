# Advanced Security Report

## Security Score

Current score: 80/100.

This is materially safer than the initial state because backend auth, route ownership, route compatibility, throttling, webhook hardening, CORS tightening, anti-cache controls, upload validation, CI checks, and audit hooks now exist. It is not yet fintech-complete until RLS, cookie auth rollout, dependency remediation, signed-link enforcement, and cross-user staging tests are complete.

## Layers Added

- Authenticated `/api/inventory` alias.
- Targeted rate limits for auth, uploads, AI, public bills, and heavy read endpoints.
- Strict production frontend CORS allowlist with explicit dev origins.
- Signed public bill token verification support.
- Legacy public bill deprecation headers.
- Production rejection of unsigned/misconfigured webhook paths.
- Timing-safe HMAC comparison for webhook and public link signatures.
- Financial/business audit logging for key write paths.
- Private API no-store cache protection.
- Hardened upload validation and spreadsheet row limits.
- Production suppression of raw scan debug payloads.
- Backup/restore and incident response playbooks.

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

Manual API security headers are present. CORS is no longer wildcard for all Vercel domains; production frontend and localhost dev are explicitly allowed, with optional `ALLOWED_ORIGINS`. Credentialed CORS is now tied to cookie-auth rollout.

## Cache Security

Private API responses now set `Cache-Control: no-store, no-cache, must-revalidate, private`, `Pragma: no-cache`, `Expires: 0`, and `Surrogate-Control: no-store`. This reduces browser, CDN, and shared-proxy leakage risk for financial/business JSON.

## Upload Security

Multer uploads are memory-only, 5 MB capped, single-file only, and restricted to CSV/XLS/XLSX extension and MIME combinations. Spreadsheet/CSV imports are capped at 5000 rows. Image/PDF scan payloads are type and size checked before AI/OCR processing.

## Logging Safety

Production scan endpoints no longer return raw OCR/AI debug text, and raw scan logging is dev-only. Remaining log hardening should continue route by route, especially around cron jobs and user-visible names/phone numbers.

## Backup and Incident Response

See `BACKUP_RESTORE_PLAN.md` and `INCIDENT_RESPONSE_PLAYBOOK.md`. No production backup configuration was changed automatically.

## Dependency Risks

`xlsx`, Next.js, and `node-cron`/`uuid` risks remain. See `DEPENDENCY_SECURITY_PLAN.md`.

## CI and Automation

See `SECURITY_CI_PLAN.md`. Add blocking syntax/build checks first; make dependency audit blocking after known advisories are resolved.

## Remaining Critical Risks

- Supabase RLS not verified.
- Valid cross-user staging test matrix not executed.
- JWT still readable by JavaScript.
- Public bill signed links are not yet mandatory unless `REQUIRE_SIGNED_PUBLIC_BILLS=true`.
- Production RLS SQL exists but has not been applied.

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
7. Verify backup/restore drill in staging.

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
