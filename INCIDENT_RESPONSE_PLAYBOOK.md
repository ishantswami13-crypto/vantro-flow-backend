# Incident Response Playbook

Status: operational playbook. No production systems were changed by this document.

## Severity Levels

- Critical: confirmed data leak, payment/ledger tampering, exposed production secret, account takeover, or production database corruption.
- High: suspected unauthorized access, webhook abuse, broken auth, repeated 500s on financial routes.
- Medium: dependency advisory with realistic exploit path, excessive failed login attempts, suspicious scan/upload abuse.

## First 15 Minutes

1. Preserve evidence: logs, commit hashes, deployment timestamps, affected routes.
2. Stop active harm: pause risky integration, disable affected webhook, or roll back the deploy.
3. Do not delete logs or production data.
4. Do not rotate secrets blindly; identify affected secret first.
5. Notify owner/admin stakeholders.

## Secret Leak

1. Identify secret type and scope without printing the value.
2. Revoke or rotate in provider dashboard.
3. Update Railway/Vercel/Supabase environment variables.
4. Redeploy affected services.
5. Search Git history and enable GitHub push protection.

## User Data Leak

1. Identify route, user IDs, time range, and data categories.
2. Disable or patch vulnerable route.
3. Run cross-user tests.
4. Review `activity_logs` and API logs.
5. Prepare user/regulatory notification if legally required.

## Payment Or Ledger Tampering

1. Freeze payment/webhook processing if abuse is active.
2. Export affected invoices, payments, bank transactions, and activity logs.
3. Compare against provider dashboard records.
4. Restore or correct records only after reviewed repair plan.
5. Add regression tests for the abuse path.

## Webhook Abuse

1. Confirm unsigned/fake requests and source IP/origin if available.
2. Ensure required secret/signature is configured.
3. Reject unsigned requests.
4. Check idempotency and duplicate payment records.
5. Rotate webhook secret if it was exposed.

## Broken Deploy

1. Confirm latest Git commit and Railway/Vercel deployment ID.
2. Run `/api/health`, `/api/auth/me` invalid-token check, and core page checks.
3. Redeploy previous known-good commit if customer impact is high.
4. Keep a note of exact failure, stack, and route.

## Database Corruption

1. Stop write-heavy jobs or affected endpoints.
2. Take an immediate snapshot if possible.
3. Restore latest backup into staging.
4. Compare damaged tables with restored data.
5. Plan targeted repair or full restore.

## Account Takeover

1. Disable or lock affected user account if supported.
2. Invalidate sessions after auth architecture supports token versions.
3. Reset password and review login activity.
4. Check business data modifications and financial audit logs.

## Suspicious API Abuse

1. Identify endpoint, IP/user, request volume, and error rate.
2. Tighten endpoint rate limit if needed.
3. Confirm private APIs return `401/403` correctly.
4. Check uploads/scans for oversized or unsupported files.
