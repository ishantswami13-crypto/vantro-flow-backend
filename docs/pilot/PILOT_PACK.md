# Starlane pilot pack (receivables wedge)

What we can put in front of a real business today, exactly as built. Everything
here was run end to end on fixture data on 29 Sep 2026 (see "Proof" at the end).
No real business dataset has been run yet; that is the first pilot's job.

## 1. How to run it

**Production (after go-live).** The pilot path needs, merged and deployed in this
order: backend #41 (migration tooling), #42 (decision loop), this PR; frontend #27
(decision screens), then this frontend PR; and migration `060_decision_core.sql`
applied to production. Until then, production does not have Decisions or the
upload page. Keep `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED=false`. New tenants
start in **Shadow** mode: Starlane analyses and prepares but changes nothing
outside itself.

Before the first pilot, on production:

```bash
# read-only: what would Starlane find for an existing tenant? writes nothing.
DATABASE_URL=<prod> node scripts/decision-dry-run.js --list
DATABASE_URL=<prod> node scripts/decision-dry-run.js --email <owner email>
```

**Local (works today).**

```bash
# backend
PORT=4000 DATABASE_URL=postgresql://postgres@127.0.0.1:5432/starlane JWT_SECRET=<32+ chars> npm start
npm run pilot:readiness -- --frontend-url http://localhost:3000   # must print VERDICT: READY
# frontend
NEXT_PUBLIC_API_URL=http://localhost:4000 npm run build && npm start
```

## 2. Pilot login flow

1. The business owner signs up at `/signup` (email, phone, business name, password).
2. They enter the one-time code. It is sent by email (Resend) and WhatsApp.
   **Unverified in production:** `TWILIO_WHATSAPP_NUMBER` is not set, so the
   WhatsApp code will not arrive; the email code depends on Resend being
   configured on Railway. Do one real signup yourself before the pilot.
3. They land on Today. With no data, the Decisions card says "Upload your
   receivables file" and links to `/decisions/import`.

## 3. Supported inputs

| Input | Status |
|---|---|
| CSV (comma, semicolon, tab or pipe), with a title block above the header | Supported |
| Excel `.xlsx` / `.xls` (first sheet with a header row; real date cells) | Supported |
| Tally outstanding / sales register exported to Excel or CSV | Supported (same importer; column names like "Party Name", "Bill No", "Voucher Date" are recognised) |
| Live Tally sync via the desktop connector | Exists (`/api/import/tally`), not re-verified in this pass |
| Up to 50,000 rows per file | Supported |
| Purchases, inventory, suppliers, orders | **Not used by the decision loop yet.** Do not ask for them for this pilot. |

Dates: `DD/MM/YYYY`, `DD-MM-YYYY`, `YYYY-MM-DD`, `1-Apr-2026`, `Apr 1, 2026`,
Excel date cells. When day/month order can't be proven from the data, the page
asks. Amounts: `1,20,000.50`, `₹45,000`, `Rs. 1,000`, `(5,000)`; rows marked
`Cr` or negative are skipped as credit notes. Currency: a column, a symbol on the
amount, or the default the user confirms. Currencies are never added together.

## 4. What to ask the business for

One file, **9–12 months** of invoices (6 is the minimum for trends), **both paid
and unpaid**:

- Required: customer name, invoice date, invoice amount
- Strongly wanted: invoice number, due date (or credit days), payment date, amount paid (or balance)
- Optional: status, currency, phone

Why each matters: without due dates Starlane will not say anything is overdue;
without payment dates it cannot see a customer slowing down; without invoice
numbers re-uploads can't be matched as reliably. Template:
`docs/pilot/receivables-template.csv` (also downloadable on the upload page).

Ask them to send a fresh export again after 1–2 weeks. Re-uploading updates the
same invoices (never duplicates), and that is how Starlane observes whether a
decision worked.

## 5. Five-minute demo script

1. **Decisions → Bring data** (`/decisions/import`). Upload their file.
2. Show **What each column means**: green "Matched", amber "Please check". Fix
   anything wrong; answer the questions (date order, "treat all as unpaid?").
3. Show **What this file gives Starlane**: customers, invoices, history,
   overdue now, and **What limits this analysis**. Read one limitation aloud.
4. Click **Import and analyse**. Read the first finding. Either:
   "1 decision needs you" (open it), or "No material decision currently
   requires attention", or "I don't have enough information…" (say what's missing).
5. Open the decision. Walk **Why now**, **If you do nothing**, **Starlane
   suggests**, **Options and their likely futures** (every option vs do nothing).
6. **Evidence**: click the invoices behind the rupee figure.
7. **What Starlane doesn't know** and **Under pressure / Try a what-if**: move
   payment speed, watch the recommendation hold or change.
8. Choose an option → **Approve** → **Run**. It runs in Shadow: show "would
   have" and that nothing changed outside Starlane.
9. Tap feedback at the top: **Already knew this / This matters / Wrong / …**
10. **Track record** (`/decisions/proof`) shows the historical replay on their own data.

## 6. Pilot questions (ask, then tap the matching feedback)

- Did you already know this?
- Does this matter? How much money or time does it touch?
- Is any number or invoice in the evidence wrong?
- Would you act on this? Which option would you pick, and why?
- What data are we missing that would change this?
- Which decision do you make every week that Starlane should understand?

## 7. Success criteria (per pilot business)

Measured from the database, not from impressions:

| Measure | Target | Where it comes from |
|---|---|---|
| File imported without developer help | Yes, first session | `file_import_batches` status COMPLETED |
| Rows rejected | < 5% of rows, each with a reason they accept | import profile |
| First finding they did not already know | ≥ 1 in the first session | feedback `USEFUL`/`MATTERS`, not `ALREADY_KNEW` |
| Numbers marked `WRONG` | 0 after data fixes | feedback |
| Decision reaches Approved (shadow) | ≥ 1 in week 1 | `decision_events` APPROVED |
| Second upload within 14 days | Yes | a second completed batch |
| Outcome verified against the second upload | ≥ 1 contract checked | `decision_contracts` verification |
| Owner would be unhappy if Starlane disappeared | "Yes" when asked in week 2 | interview |

## 8. What is not ready (say so if asked)

- Only receivables decisions (collections, credit hold, payment plans) and the
  collection-cycle process check run on uploaded files. Supply-chain decisions
  need product/supplier data that the upload does not take.
- Live execution beyond internal records is off; customer messages are drafts.
- Password login and OTP were not exercised in this pass (they read users via
  Supabase, not configured locally).
- Customer names that look alike ("Kapoor & Sons" / "Kapoor and Sons Pvt Ltd")
  are flagged, not merged.
