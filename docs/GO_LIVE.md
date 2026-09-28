# Starlane — going live

Everything that can be built and tested without your accounts is done and
green (backend PR ishantswami13-crypto/vantro-flow-backend#41, frontend PR
ishantswami13-crypto/vantro-flow-frontend#22). What is left needs your
accounts, your keys or your approval. Do it in this order; each step says who
does it and how you know it worked.

Railway does **not** run migrations on deploy (`startCommand` is
`node server.js`), so the database is upgraded **before** the new backend
goes out. Migrations 049–053 only add tables, columns, indexes and one
trigger, so the backend that is live today keeps working on the upgraded
database.

## 1. Look at the production database — read-only (you run it, ~2 min)

From your computer, in `vantro-flow-backend`, with the Railway CLI logged in
and linked to the production service:

```bash
railway run npm run db:preflight
```

It runs inside a read-only transaction, prints no credentials and changes
nothing. It ends in **PASS** with a plan (which files to record as already
applied, which to apply), or **FAIL** with the file that needs a human look.
Send me the output (it contains no secrets) and I will check the plan with
you. If it fails, stop here.

## 2. Adopt the migration ledger (you run it, after we agree on step 1)

```bash
railway run npm run db:baseline -- --execute --through=<the file step 1 printed>
```

Writes only the `schema_migrations` table, in one transaction, and refuses
if the database no longer matches the plan. Nothing else runs.

## 3. Apply the new migrations (you run it)

```bash
railway run npm run db:migrate
railway run npm run db:migrate:status   # expect 049 … 053 applied, nothing pending
```

Stops at the first failure. Take a Railway/Supabase backup first if you have
not recently.

## 4. Backend environment (Railway → vantro-flow-backend → Variables)

Required (the server checks `JWT_SECRET` at start and stops without it;
without `DATABASE_URL` every data route fails):
`JWT_SECRET` (≥32 chars), `DATABASE_URL`, `SUPABASE_URL`, `PUBLIC_APP_URL`,
`PUBLIC_API_URL` (both https), `ADMIN_EMAILS`.

Recommended: `RESEND_API_KEY` + `ACCESS_EMAIL_FROM` (applicant emails; without
them an admin sends links by hand).

Leave as they are: `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED` **off** (nothing
is sent to customers; approving records the decision and shows the draft),
`DEMO_RESET_ENABLED` unset. Leave `DESKTOP_DOWNLOAD_URL_*` unset until a
signed build is published (step 8) — the website then says honestly that no
app is available.

Check them without printing values: `railway run npm run env:check`.

## 5. Merge and deploy the backend (you)

Merge #41. Railway deploys it. Check: `GET /health` is 200, and signing in on
the website still works.

## 6. Merge and deploy the website (you)

Merge #22. Vercel deploys it. In Vercel, `NEXT_PUBLIC_API_URL` must be the
production backend URL (https); leave `NEXT_PUBLIC_DEMO_CONTROLS` unset.

Check with your own login: The Bridge shows your real receivables (or "Connect
your books to start" if nothing is imported yet), and the sidebar shows the
seven features plus Sources and Settings.

## 7. Connect your books (you, on the PC that runs TallyPrime)

- **Tally:** Sources → Connect Tally. Until the signed Windows app is
  published, use the bridge the setup page offers; the Windows app does the
  same from the tray once installed.
- **Busy, Marg, Zoho Books, QuickBooks, Xero, anything else:** export a sheet
  and upload it in Sources. These are imports, not live connections.

Then: Watch lists what is overdue, Scan explains a customer, and a mission
from Scan proposes reminders for you to approve.

## 8. Signed apps (you provide the keys; the pipelines are already wired)

Add these as GitHub Actions secrets on `vantro-flow-frontend`; the next push
builds signed artifacts automatically:

| What | Secrets | Without it |
| --- | --- | --- |
| Windows code signing | `WINDOWS_CERTIFICATE` (base64 .pfx), `WINDOWS_CERTIFICATE_PASSWORD` | SmartScreen shows "unknown publisher" |
| In-app updates | secret `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`), and the public half as the Actions *variable* `TAURI_UPDATER_PUBKEY` | No automatic updates |
| Android release | `ANDROID_KEYSTORE` (base64), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | Debug-signed APK, not for the Play Store |
| Push notifications | Expo/EAS project id, Firebase project (Android), Apple APNs (iOS) | The app says push is off |
| iOS | Apple Developer account, then EAS build → TestFlight | No iOS build |

Keep the keystore and certificate backed up; losing the Android keystore means
you can never update the Play Store app.

After the first signed Windows build is on a GitHub Release, set
`DESKTOP_DOWNLOAD_URL_WINDOWS` in Railway so the website offers the download.

## 9. Later, when you decide

- **WhatsApp sending:** set `TWILIO_WHATSAPP_NUMBER`, then turn on
  `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED`. Until then nothing reaches a
  customer.
- **AI answers in Ask Starlane:** needs an AI provider key; without it, answers
  come from look-ups only.

## What I cannot do from my side

My cloud session cannot reach your computer, your Railway project, the
production database, or your Vercel team (the connected Vercel account has no
access to the `vantro` team). I will not merge or run anything against
production without your go-ahead. Everything above that says "you" needs one
of those.
