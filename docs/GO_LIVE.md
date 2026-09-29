# Starlane 0.1.0 — go-live plan

Backend PR ishantswami13-crypto/vantro-flow-backend#41 and frontend PR
ishantswami13-crypto/vantro-flow-frontend#22 are the release candidate. Nothing
below has been run against production. Every step that writes to production
waits for the owner's explicit go-ahead.

Railway does **not** run migrations on deploy (`startCommand` is
`node server.js`), so the database is upgraded **first**, while today's backend
is still live. That is safe because 049–053 only add (tables, nullable
columns, indexes, one trigger) — proven on a rehearsal copy, below.

## Rehearsal evidence (production-like copy, 2026-09-28)

A database built the way production was: `main`'s base schema, migrations
001–048 applied by hand (006 failed — no Supabase `auth`; 020 and 024 failed
silently on `suppliers.id`), `main`'s server booted once, 400 invoices, 60
actions, customers and promises for two businesses, no migration ledger.

| Check | Result |
| --- | --- |
| Preflight (read-only) | PASS after one fix (below): record 19 files, apply 27 |
| Baseline + migrate | clean; `migrate --status` shows nothing pending |
| Existing data | all 90 pre-existing tables byte-identical over their original columns |
| Old backend (`main`) on the upgraded schema | boots, deep health OK, serves |
| New backend on it | each business's Bridge equals its invoices in SQL (₹60,39,884 / 213 open; ₹30,48,116 / 107 open); Watch, Memory, Prepared work; cross-tenant read → 404 |
| `npm test` against it | 40/40 |

The rehearsal found that the original preflight would have **failed on
production**: a hand-migrated history has gaps (the error-events table file
was never applied while later files were). The preflight now runs such a file
out of order only if every statement is a no-op when its object exists, still
fails on any other gap, lists the files it cannot verify (006, 016, 019), and
checks the facts the new code depends on (019's `suggested_by` constraint, and
that the connecting role can read the new RLS-protected tables).

The first read-only preflight **on production** (2026-09-29) found more than
the rehearsal: six base-schema tables were never created (`billing_history`,
`bills`, `attendance`, `expenses`, `business_vocabulary`, `brain_rules` and
their indexes), `prospect_notes` (006) and two indexes (011, 049) are missing,
and 051 is half-applied. Re-running `supabase-schema.sql` whole is not an
option: it ends by turning RLS **off** on 16 tables. So for a partial file the
baseline records, it runs only that file's additive statements (`CREATE
TABLE/INDEX/EXTENSION IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`; never a
`DO` block, RLS toggle, constraint change or data change), then checks every
missing object exists, all in the baseline's one transaction. A missing object
that only a guarded block creates on an existing table still fails the
preflight. Partial files after the cut (049, 051) simply run again. On a copy
built to that exact shape: preflight PASS, baseline + migrate clean, nothing
pending, RLS unchanged on every pre-existing table, the unrelated
`schema_migrations` untouched (`tests/dbBaseline.test.mjs`, scenario
`production`).

**Estimated downtime: none.** The only locks are brief: indexes on `invoices`
and `ai_actions` (seconds for thousands of rows) and a trigger on
`ai_actions`. Run it at a quiet hour anyway.

## Execution order

Steps marked **(approval)** change production and need the owner's go-ahead.

1. **Preflight — read-only.** With `PROD_DATABASE_URL` in the environment:
   `DATABASE_URL="$PROD_DATABASE_URL" npm run db:preflight`
   (or `railway run npm run db:preflight`). Review the plan: which files are
   recorded without running, which run, the unverified list and the hazard
   lines. Stop if it says FAIL.
2. **Backup.** Production is on Neon: create a branch from the production
   branch (e.g. `backup-pre-golive-<date>`) and note its time; it is the
   rollback point. (Elsewhere: Supabase Database → Backups, or `pg_dump`.)
3. **(approval) Baseline.**
   `npm run db:baseline -- --execute --through=<file the preflight printed>`
   — in one transaction: creates the missing objects of partial files
   (additive statements only, listed by the preflight) and writes
   `starlane_migrations`; refuses if the database changed since the preflight. Production also has an unrelated,
   empty `schema_migrations` table (version, checksum, applied_at,
   applied_by) made outside this repo; the scripts never read or write it.
4. **(approval) Migrate.** `npm run db:migrate`, then `npm run db:migrate:status`
   (expect nothing pending). Stops at the first failure.
5. **Check the live (old) site still works** — sign in, open the dashboard.
6. **(approval) Merge #41 → Railway deploys the backend.** Check
   `GET /api/version`: `release 0.1.0`, `migrations.upToDate: true`, and the
   git SHA of the merge. Set `ACTION_EXECUTION_PAUSED=true` first if you want
   the pilot to start with nothing carried out (see Pilot controls).
7. **(approval) Merge #22 → Vercel deploys the website.** Its
   `NEXT_PUBLIC_API_URL` must be the production backend (https).
8. **Smoke test with your own login:** Bridge shows your real receivables (or
   "Connect your books"), the sidebar is the seven features + Sources +
   Settings, Scan finds a customer, Watch lists overdue items, a mission can be
   started and cancelled.
9. **Connect Tally** on the owner's PC (bridge from the setup page, or the
   Windows app) and watch the first sync land in Sources.
10. **Give the Windows installer / Android APK to the first business**
    (direct distribution; see Distribution).

## Rollback

| Situation | Action | Data risk |
| --- | --- | --- |
| Website misbehaves | Vercel → Deployments → promote the previous deployment | none |
| Backend misbehaves | Railway → redeploy the previous deployment. The old code runs fine on the upgraded schema (rehearsal step "old backend") | none |
| Something is being carried out that should not be | set `ACTION_EXECUTION_PAUSED=true` in Railway (no deploy) | none |
| A migration fails midway | it rolls back its own transaction and stops; fix and re-run `db:migrate`. The old backend keeps working | none |
| The schema itself must go back | restore the step-2 backup (loses writes since then). Additive migrations make this unnecessary in practice | writes since backup |

The new tables can also be dropped by hand if ever needed; nothing in the old
code reads them.

## Pilot controls (already in the code)

- **Who gets in:** `FEATURE_ACCESS_GATE_ENABLED=true` + `ACCESS_AUTO_APPROVE=false`
  — signups need an application an admin approves (`/admin/access`,
  admins from `ADMIN_EMAILS`).
- **Emergency stop:** `ACTION_EXECUTION_PAUSED=true` — owners can still
  approve; nothing is executed (no message, call, purchase order or payout);
  lift it and approved actions can proceed.
- **Messaging:** `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED` stays **off** —
  approving records the decision and shows the drafted message.
- **Payouts:** only possible if `RAZORPAYX_KEY_ID/SECRET` are set; keep them
  unset for the pilot (`env:check` warns if they are).
- **Which build is live:** `GET /api/version` (release, git SHA, API level,
  migration level expected vs applied).
- **Support references:** every failed request returns a `requestId`; the log
  line has request id, user id, route, status, release. Financial figures are
  never logged.
- **Connector health:** Sources shows each connector's state, last good sync
  and the device; failed syncs are recorded with their error.
- **Assistant stays read-only for apps:** every assistant tool must be
  classified (`lib/ai/assistantTools.test.mjs`); apps get look-ups only.

## Environment (Railway → backend)

Run `npm run env:check` against the production variables (values are never
printed). Required: `JWT_SECRET` (≥32 chars), `DATABASE_URL` (the owner/
`postgres` role — the preflight checks it can read RLS tables),
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PUBLIC_APP_URL`,
`PUBLIC_API_URL` (https), `ADMIN_EMAILS`; set `STARLANE_ENV=production`
explicitly (otherwise it is inferred, with a warning).
Recommended: `RESEND_API_KEY` + `ACCESS_EMAIL_FROM`. Keep unset:
`DEMO_RESET_ENABLED`, `TEST_MODE`, `RAZORPAYX_*`, `DESKTOP_DOWNLOAD_URL_*`
(until a signed build is published). CORS allows the website origin, the
desktop app's Tauri origins (without credentials) and mobile.

## Distribution for the first businesses

No store is needed for a pilot.

- **Windows:** the NSIS `.exe` (per-user, no admin rights) or `.msi` from the
  latest Desktop workflow run. **Unsigned:** Windows SmartScreen shows
  "Windows protected your PC — unknown publisher"; the user clicks *More
  info → Run anyway*. Tell them this in advance; do not ask them to turn off
  SmartScreen. The app's own updater stays off until the updater key exists.
- **Android:** the APK from the latest Mobile workflow run, debug-signed.
  Android asks to allow installs from the source (e.g. Files/Chrome). Play
  Protect may warn about an unknown developer. A later release-signed APK
  cannot update over a debug one: pilot users uninstall first.
- **iPhone:** not available until TestFlight (below).

## Signing

**Windows code signing.** Needs an OV or EV code-signing certificate issued to
the company (DigiCert, Sectigo, SSL.com…; EV builds SmartScreen reputation
immediately, OV over time). Export it as `.pfx`, then add GitHub Actions
secrets on `vantro-flow-frontend`: `WINDOWS_CERTIFICATE` (base64 of the
.pfx) and `WINDOWS_CERTIFICATE_PASSWORD`. The Desktop workflow already imports
it and signs both installers. Updater: generate a key pair with
`npx tauri signer generate`, add secret `TAURI_SIGNING_PRIVATE_KEY`
(+ `_PASSWORD`) and the public half as the Actions *variable*
`TAURI_UPDATER_PUBKEY`; releases are published from `desktop-v*` tags.

**Android release signing.** Create one upload keystore and keep it backed up
forever (losing it means the Play listing can never be updated):
`keytool -genkeypair -v -keystore starlane-release.jks -alias starlane -keyalg RSA -keysize 2048 -validity 10000`.
Add secrets `ANDROID_KEYSTORE` (base64 of the .jks), `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. The Mobile workflow uses them when
present and the debug key otherwise; the keystore never goes into Git. For
the Play Store, enrol in Play App Signing with this as the upload key.

## iPhone (TestFlight)

Needs from the owner: Apple Developer Program membership (USD 99/year; an
organisation account needs a D-U-N-S number), an Expo account, and a
confirmed bundle identifier — `mobile/app.json` sets `app.starlane.mobile` for
both iOS and Android; confirm you own that name before the first build, as it
cannot change after publishing.
Shortest path, from `vantro-flow-frontend/mobile`:

1. `npx eas-cli login`, then `npx eas-cli init` (links the Expo project; writes
   the project id).
2. `npx eas-cli build --platform ios --profile preview` — EAS creates the
   certificate and provisioning profile on the first run (Apple login needed).
3. `npx eas-cli submit --platform ios` → App Store Connect → TestFlight →
   add testers by email.
4. Push notifications: create an APNs key in the Apple portal; EAS stores it
   on the first build that asks.

## Real TallyPrime

Tested so far against the TallyPrime HTTP/XML protocol with the bridge's
sample vouchers and a simulated Tally (desktop golden flow). Not yet tested
against a real TallyPrime installation. Before the first business: run the
first sync on a real company and compare invoice count, amounts, due dates and
paid invoices with Tally's own Outstanding report.

What the import does with a company's books:

| Tally | Starlane |
|---|---|
| Sales with a bill credit period ("30 Days", a date) | Invoice due on that date |
| Sales with no credit period | Invoice due on its own date |
| Receipt / Credit Note "Agst Ref <bill>" | Reduces that bill (same party, same bill name, bill dated on or before). Paid in full → Paid on the receipt date |
| Receipt "On Account" / "Advance" | Bank credit only; counted under `unapplied.on_account` |
| Agst Ref bill not found, or more than one open match | Nothing applied; counted under `unapplied.bill_not_found` |
| Debit Note | Nothing created; counted under `unapplied.debit_notes` |
| Company with bill-wise details off (no allocations) | Receipts stay unmatched bank credits; bills stay open until paid in Starlane |
| Bills Receivable as of the day before the synced range (earlier years' unpaid bills) | Invoices for the amount still owed then, sent before the day book so this year's receipts settle them. Credit balances are left out. The same bill arriving later as a sale (or the reverse) stays one invoice |
| Any new Tally bill | Takes the phone number already on file for that customer (their other invoices). Tally vouchers carry none |
| Customer ledgers under Sundry Debtors (name + mobile/phone fields only) | A valid Indian mobile fills bills that have no number. A number already on file is never replaced. Landlines and anything else are counted, not used |
| A sale edited in Tally (amount or credit period) | The invoice follows on the next sync. What was paid is kept, and the bill is Paid exactly when that covers the new amount |
| A receipt / credit note edited, re-allocated or cancelled | The bill it settled moves by the difference (each application is recorded on the invoice with the amount it moved); a cancelled one gives its amount back and re-opens the bill |
| A sale cancelled in Tally (ISCANCELLED) | Invoice becomes `Cancelled`: not owed on any screen, never chased (every sending path only chases `Pending`), not counted as collected in a Mission (shown as a blocker instead) |
| A receipt / payment / purchase cancelled | Its unmatched bank line or purchase is marked cancelled; a bank line already matched by reconciliation is left alone |
| An optional voucher (ISOPTIONAL, a memorandum) | Never imported |
| A sale or purchase cancelled after its stock moved | Each stock movement it made is reversed once (`<ref>:cancelled`) |
| A voucher deleted in Tally (not cancelled) | After a full sync, the client lists every voucher in the range; what Starlane imported there and is missing is treated like a cancellation (bill Cancelled, settlement taken back, unmatched bank line cancelled). Held when the export looks partial (see below) |
| An empty day book | A successful sync with nothing imported (previously a failed sync and a "sync failed" notification) |

Known limits to check on the first real company:
- A bill renamed in Tally so that its name differs from the voucher number
  will not match.
- The Bills Receivable export format (BILLFIXED / BILLCL / BILLDUE, debit
  negative) is built from TallyPrime's documented XML shape and a fictional
  sample. It has not been checked against a real export. If Tally refuses
  the report, the sync continues with the day book only (the CLI says so;
  the desktop app records `client.opening_bills_failed`).
- The customer-ledger contacts request (TDL collection of Ledger under
  $$GroupSundryDebtors, FETCH NAME, LEDGERMOBILE, LEDGERPHONE) has not been
  checked against a real TallyPrime. A customer with no valid mobile in
  Tally or Starlane still can't be reminded ("No phone number on file").
- Deletions are detected only for the synced range (1 April to today),
  by comparing against the list the client sends after a full sync. That
  list covers every voucher Tally exported, whatever the voucher-type
  filter; the CLI sends all its companies together. The comparison is
  held (nothing applied, a message shown) when more than max(3, 10%) of
  what is live in the range would go, or more than half of it. A held
  result stays held until the export looks complete again.
- Switching the desktop app to another Tally company therefore holds
  deletion checks for the old company's bills rather than removing them.
- The CLI bridge now sends at most 1000 vouchers per request. Before, one
  request carried the whole range and anything over the 5000 limit was
  rejected outright.
- Bills show Tally's bill number without punctuation ("S201" for "S/201").
  Scan finds either spelling. The stored reference is unchanged, so
  re-syncs stay idempotent.
Compare the Outstanding report after the first sync.
