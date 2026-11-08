# Starlane production runbook

How to ship and check Starlane in production. `GO_LIVE.md` has the first go-live, the baseline procedure and signing; this page is the routine.

Steps marked **(owner)** change production and need the owner's explicit go-ahead.

## Where things run

| Part | Where | How it deploys |
|---|---|---|
| Backend (`vantro-flow-backend`) | Railway | A merge to `main` deploys it |
| Website (`vantro-flow-frontend`) | Vercel | A merge to `main` deploys it |
| Database | Neon (Postgres) | `npm run db:migrate`, by hand, never automatically |
| Desktop app | GitHub Releases on `vantro-flow-frontend` | A `desktop-v<version>` tag runs `desktop.yml`, which builds, signs and publishes the installer and update manifest |

The release number lives in `lib/release.js` (backend) and `desktop/src-tauri/tauri.conf.json` and `desktop/package.json` (desktop). All three must agree, or `release:readiness` fails DESKTOP.

## Shipping a change

1. CI green on the PR in both repos.
2. **Migrations first**, if the backend PR adds one:
   1. Read-only plan: `DATABASE_URL="$PROD_DATABASE_URL" npm run db:migrate:status`.
   2. Backup: in Neon, create a branch from production named `backup-<date>-<migration>`. Note the time. It is the rollback point.
   3. **(owner)** `DATABASE_URL="$PROD_DATABASE_URL" npm run db:migrate`, then `db:migrate:status` again; expect nothing pending.
   4. The old backend keeps working on the new schema (every migration is additive), so the site stays up between this step and the deploy.
3. **(owner)** Merge the backend PR. When Railway finishes, `GET /api/version` must show the new `release`, `migrations.upToDate: true` and the merge's git SHA.
4. **(owner)** Merge the frontend PR. Vercel's `NEXT_PUBLIC_API_URL` must be the production backend over https.
5. Run the checks below.

### Migration 066 (pending in production as of 19 Oct 2026)

`066_connector_sync_run_status.sql` fixes Tally sync runs stuck as `RUNNING` (57 of them in production). It is forward-only and deletes nothing:
- the column default becomes `running`
- uppercase statuses become lowercase
- runs still `RUNNING` after an hour are closed as `failed`, with the reason written on the row

After it runs, Sources stops counting those runs as in progress. Check: `SELECT status, count(*) FROM connector_sync_runs GROUP BY 1` shows no uppercase statuses.

## Checks after every deploy

```bash
npm run demo:readiness -- --api https://<backend> --site https://<website> --full
```

It reports PASS, WARN or FAIL for the demo files, backend release, migrations, sign-up code delivery, the sign-up API and the public pages. With `--full`, it also runs `npm run release:readiness`, which signs in with `RELEASE_TEST_*` and `RELEASE_PILOT_*` (set them in your shell, never in a file in the repo) and checks tenancy, Bridge, Watch, decisions, Ask Starlane, desktop, installer, download and updater.

Then do one real sign-up yourself, with a fresh inbox. That is the only way to prove a code reaches a stranger.

## Environment (Railway → backend)

`npm run env:check` against the production variables prints names and states, never values.

| Variable | Why it matters |
|---|---|
| `RESEND_API_KEY` | Sign-up and password codes are emailed through Resend. |
| `EMAIL_FROM` (or `ACCESS_EMAIL_FROM`) | Must be an address on a domain verified in Resend. Without it, codes go from Resend's sandbox sender, which **only delivers to the Resend account owner**: nobody else can sign up. `/api/ready` reports `signupEmail: own_sender | sandbox_sender | not_configured`. |
| `TWILIO_WHATSAPP_NUMBER` | Optional second route for codes. |
| AI provider key (see `/api/ai/health`) | Ask Starlane. Without one it says it isn't set up yet; Watch, decisions, Simulate and missions still work. |
| `ACTION_EXECUTION_PAUSED` | Emergency stop: approvals are recorded, nothing is carried out. |
| `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED` | Keep **off** until the owner decides to send real messages. |
| `FEATURE_DECISION_SCHEDULER_ENABLED` | Hourly discovery and the daily outcome check. Imports, Tally syncs and recorded payments already form decisions, raise Watch events and check outcomes without it. |

## Rollback

| Situation | Action | Data risk |
|---|---|---|
| Website misbehaves | Vercel → Deployments → promote the previous deployment | none |
| Backend misbehaves | Railway → redeploy the previous deployment; it runs on the newer schema | none |
| Something is being carried out that shouldn't be | Set `ACTION_EXECUTION_PAUSED=true` in Railway (no deploy needed) | none |
| A migration fails midway | It rolls back its own transaction and stops; fix it and re-run | none |
| The schema itself must go back | Restore the Neon backup branch (loses writes since the backup) | writes since backup |

## Desktop release

1. Bump the version in `desktop/src-tauri/tauri.conf.json`, `desktop/package.json` and the backend's `lib/release.js`, in one PR per repo.
2. Merge both, then **(owner)** push the tag `desktop-v<version>` on the frontend repo.
3. `desktop.yml` signs the update with `TAURI_SIGNING_PRIVATE_KEY` (a GitHub secret; never copy, print or move the key file) and publishes the installer and `latest.json`.
4. Check: `npm run release:readiness -- --site https://<website>`. DESKTOP, INSTALLER and DOWNLOAD must pass, and an installed older version must offer the update.

## Email provider check

1. In Resend → Domains, the sending domain shows Verified (SPF and DKIM).
2. `EMAIL_FROM` uses that domain, e.g. `Starlane <codes@yourdomain>`.
3. `GET /api/ready` shows `signupEmail: "own_sender"`.
4. Sign up with an address that isn't the Resend account owner's. The code arrives from your domain.

## AI provider check

Sign in and open `/api/ai/health` (or run `release:readiness`; CHAT reads it without showing keys). Then ask one question on Scan and check that the answer quotes your own invoices.
