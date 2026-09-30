# Starlane — source of truth and operator runbook

## Repositories

| Repo | Role | Deploy |
|---|---|---|
| `vantro-flow-backend` | Express API (`server.js` + `lib/`), migrations, Tally bridge, Rust sidecars | Railway |
| `vantro-flow-frontend` | Next.js 15 app (V32 product under `/bridge`, `/sources`, …) and the public site (`/`, `/access`, `/download`) | Vercel |
| `starlane-frontend` | Archived June static prototype. Not deployed. | — |

## Schema migrations (read before the first deploy of this change)

The step-by-step go-live order (preflight → baseline → migrate → deploy
backend → deploy website → connect books → signed apps) is in
[`GO_LIVE.md`](GO_LIVE.md); prefer `npm run db:preflight` / `db:baseline`
over the manual commands below.

`scripts/migrate.js` is now the only way schema is applied. It keeps a
`starlane_migrations` ledger (file + SHA-256) and stops on the first failure.
(Not `schema_migrations`: production already has an unrelated table by that
name. A copy migrated under the old name is renamed automatically.)

**Existing databases (staging, production) were migrated by hand and have
no ledger.** Not every legacy file is safe to re-run, so baseline first:

```bash
# 1. See what the ledger thinks (creates an empty ledger; changes nothing else)
node scripts/migrate.js --status

# 2. Confirm the hand-applied state really includes 046-048:
#    tables watches, watch_evaluations, connector_enrollments, connector_devices,
#    and users.onboarding_* columns must exist.

# 3. Record 001..048 as applied WITHOUT running them
node scripts/migrate.js --baseline=migrations/048_onboarding_profile.sql

# 4. Apply what is genuinely new (049 … 053)
node scripts/migrate.js
```

If step 2 shows 020/024's tables missing (`payment_allocations`,
`product_suppliers`, `purchase_line_items` — they failed silently on any
database bootstrapped from `supabase-schema.sql`), baseline only through
`migrations/019_ai_actions_suggested_by_widen.sql` and let the runner apply
020 onward: 020 and 024 now adapt to the real `suppliers.id` type.
Verified on a local copy (2026-09-27): with a complete schema, 020–050
re-apply cleanly; with the 020/024 tables dropped, the same run recreates
them. 001–019 are **not** all re-runnable (015 fails on existing
constraints) — never re-apply them to an existing database. Run `--status`
again afterwards.

Fresh databases: `node scripts/migrate.js` (or `npm run setup:database`).

## Tests

```bash
PGSSLMODE=disable DATABASE_URL=postgres://postgres@127.0.0.1:5432/starlane_test node scripts/migrate.js
PGSSLMODE=disable DATABASE_URL=postgres://postgres@127.0.0.1:5432/starlane_test npm test
```

`PGSSLMODE=disable` is honoured only for loopback hosts. CI runs the same
against `postgres:16` (`.github/workflows/db-tests.yml`). Frontend browser
E2E: `vantro-flow-frontend/scripts/e2e/golden-path.mjs` (see its header).

## Environment added by this change

Backend (Railway): `PUBLIC_APP_URL`, `PUBLIC_API_URL`, `ADMIN_EMAILS`
(reviewers), `ACCESS_AUTO_APPROVE` (default false), `FEATURE_ACCESS_GATE_ENABLED`
(default false — turn on to require an approved application for signup),
`ACCESS_ENTITLEMENT_TTL_DAYS` (14), `ACCESS_APPLY_LIMIT_PER_HOUR` (5),
`ACCESS_EMAIL_FROM` + `RESEND_API_KEY` (applicant email; without them the
admin is shown the link to send by hand), `DESKTOP_DOWNLOAD_URL_{WINDOWS,MACOS,LINUX}`
(leave unset until a signed build exists), `DEMO_RESET_ENABLED` (never in
production).

Frontend (Vercel): `NEXT_PUBLIC_DEMO_CONTROLS` (internal demo reset button;
leave unset in production).
