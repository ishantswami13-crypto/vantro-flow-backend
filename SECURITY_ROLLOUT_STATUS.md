# Security Rollout Status

Updated: 2026-05-28

## Implemented In Code

- Bearer JWT auth remains supported for the current frontend.
- Optional HttpOnly cookie auth is available behind `ENABLE_AUTH_COOKIES=true`.
- Cookie auth uses:
  - HttpOnly access token cookie: `vantro_access_token`
  - double-submit CSRF cookie/header: `vantro_csrf` + `x-csrf-token`
  - `Secure` cookies by default
  - `SameSite=None` by default because the production frontend and backend are on different domains
- `/api/auth/logout` clears session cookies.
- Cross-user test harness added at `scripts/cross-user-security-test.js`.
- RLS rollout SQL added at `supabase-rls-rollout.sql`, but it has not been applied.
- GitHub Actions security baseline added.
- Webhook secret rollout checklist added.
- Private API no-store cache headers are applied to `/api`.
- Security headers include frame, MIME sniffing, HSTS, referrer, permissions, cross-origin resource, opener, and DNS-prefetch controls.
- Uploads are memory-only, authenticated, size-limited, extension/MIME checked, and row-limited for spreadsheet/CSV imports.
- Production scan responses suppress raw OCR/AI debug text.
- Financial delete paths now create audit-log attempts for products, bills, purchases, sales, and bank transactions.
- Backup/restore, incident response, and security verification command docs are present.

## Not Done Automatically

- No production Supabase RLS migration was applied.
- No production test users were created.
- No secrets were rotated or written.
- No frontend token-storage migration was made.
- No breaking dependency upgrades were applied.
- Public bill signed links remain backward-compatible until `REQUIRE_SIGNED_PUBLIC_BILLS=true`.

## Required Production Steps

1. Create two real staging/test users and run:

```powershell
$env:USER_A_TOKEN = "<user-a-token>"
$env:USER_B_ID = "<user-b-id>"
npm run security:cross-user
```

2. Apply `supabase-rls-rollout.sql` in staging first, then rerun the cross-user tests.
3. Configure Railway webhook secrets from `WEBHOOK_SECRET_ROLLOUT.md`.
4. Enable `ENABLE_AUTH_COOKIES=true` only after the frontend sends `credentials: "include"` and `x-csrf-token` for unsafe cookie-auth requests.
5. Plan dependency upgrades in a staging branch because the current audit fixes require major or breaking upgrades.
6. Review `BACKUP_RESTORE_PLAN.md` and `INCIDENT_RESPONSE_PLAYBOOK.md` before production migrations.
