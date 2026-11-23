# Starlane supplier-delay pilot: demo pack

This pack shows one workflow, end to end, on synthetic data: a business uploads
its own records as CSV/Excel files, reports that a supplier moved a delivery
date, and sees exactly which customer orders become late, why, and what it can
do. It then approves a response and reviews the drafted customer updates. Nothing is sent.

Every number below was checked by an automated browser run against a local
database. The run starts from an empty account. No data was inserted by hand.

## What is verified, and how

- **Browser journey.** Run `npm run demo:real-pilot:journey`. It covers 48 checks and passed twice in a row, on 23 Nov 2026. It drives the real frontend and backend in headless Chromium against local Postgres 16.
- **Backend suite.** Run `npm test`, which runs all test files. `npm run test:operations` covers this workflow: 8 integration tests and 8 pure checks.
- **Frontend.** `tsc --noEmit`, eslint and `next build` all pass.

Expected results are worked out by hand in `tests/fixtures/realPilot.js` (`EXPECTED`). The engine's output is compared to them exactly.

## The synthetic business

The business is Nirmal Pumps (invented). It assembles Pump A1, which needs 1 motor and 1 impeller. It also resells valves.

| File | Rows | What the import does with it |
|---|---|---|
| `1-nirmal-item-master.csv` | 9 | Creates 6 products with stock on hand: motors 4, impellers 30, valves 40. It refuses 3 rows: a second product on SKU GSK-1, a new product with no stock stated, and a negative stock. |
| `2-nirmal-bill-of-materials.csv` | 3 | Links Pump A1 to 1 motor and 1 impeller. It refuses the nut, which is not in the product master. |
| `3-nirmal-open-purchase-orders.csv` | 9 | Creates 5 open purchase lines. It refuses 3 bad rows: received is more than ordered, the quantity is "abc", and the date is 31 Feb. The unknown part UNK-9 is held until the owner answers, and is then skipped. 10 motors were already received in the source system, and they are not counted again. |
| `4-nirmal-open-sales-orders.xlsx` | 8 | Creates 7 open order lines. The delivered order is skipped. The title block above the header is ignored. A missing pending quantity is shown as an assumption, and a missing promised date as missing. |

Generate the files, dated relative to today, with `npm run demo:real-pilot:files [folder]`. Blank templates with example rows are downloadable from the import page. They live in the frontend's `public/templates`.

### Hand-worked result

The supplier, Volt Motors, moves PO-901 (40 motors) from today+5 to today+12.

- **At risk because of the delay:**
  - Arora Agro, SO-1: slips 6 days.
  - Bharat Irrigation, SO-2: slips 4 days, counting the 15 still pending.
- **Value at risk:** ₹2,25,000. That is 10 × 9,000 + 15 × 9,000, using the pending quantity, not the ordered quantity.
- **Already late, and not blamed on this delay:** Evergreen Estates, SO-5.
- **On time:** 3 orders. **Can't be checked:** 1 order, which has no promised date.
- **After 20 motors are received today:** only Bharat Irrigation is still at risk, at ₹1,35,000.
- **After the remaining 20 arrive:** motor stock is 44. That is 4 on hand plus 40 received. The 10 received before import are not double counted.

## Setup (local only; never point this at production)

Prerequisites: Node 20+, Postgres 16, and the two repos on the pilot branches. Use backend `claude/project-thread-i30drx`, which sits on #87, and frontend `claude/project-thread-i30drx`, which sits on #95.

```bash
# 1. A local test database (the scripts refuse a non-test DATABASE_URL)
createdb starlane_test
export DATABASE_URL=postgres://postgres@127.0.0.1:5432/starlane_test PGSSLMODE=disable
export JWT_SECRET=$(openssl rand -hex 32) NODE_ENV=test

# 2. Backend: migrations up to 078, then run with outbound messaging off
cd vantro-flow-backend && npm ci && node scripts/migrate.js
PORT=3001 FRONTEND_URL=http://localhost:3000 FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED=false node server.js

# 3. Frontend, pointed at the local backend
cd vantro-flow-frontend && npm ci
NEXT_PUBLIC_API_URL=http://localhost:3001 npx next build && npx next start -p 3000

# 4a. Automated proof (creates its own empty account each run)
cd vantro-flow-backend && npm run demo:real-pilot:journey   # screenshots in ./real-pilot-journey

# 4b. Or present it by hand: write the four files, sign in to a fresh account, follow the script below
npm run demo:real-pilot:files ./pilot-demo-files
```

## Demo script (about 4 minutes)

1. **The problem (20 s).** "A supplier just told you a shipment is a week late. Which customer orders does that break, and what do you tell them?"
2. **Bring your records (70 s).** Go to Decisions → Import orders & POs.
   - Upload the item master. Point out what the preview shows before anything is saved: the columns it matched, and the three rows it refuses, each with its reason.
   - Show that "Stock on hand" means physical stock only. Name the source system and import.
   - Choose Next and import the bill of materials (the unknown nut is refused).
   - Import the open purchase orders. Choose who records stock, answer the one product question, and show the rejected rows.
   - Import the open sales orders.
   - Show the recent-imports table.
3. **What is missing (15 s).** On Open orders, point out that one order has no promised date and one assumes the full quantity is still due. Starlane says so rather than guessing.
4. **Report the delay (30 s).** On Inbound shipments, find the 40 motors on PO-901. Choose Report a delay, enter today+12 with the reason "Copper shortage", and choose Check affected orders.
5. **The decision (50 s).**
   - The decision names Arora Agro (late by 6 days) and Bharat Irrigation (late by 4 days), worth ₹2.25L.
   - Open the evidence cards. Each is marked as a fact, a calculation or an assumption.
   - Point out the line "Counts come from a fixed calculation … No simulation and no language model."
   - Evergreen Estates was already late, and the decision does not blame this delay for it.
6. **Goods arrive (30 s).** Back on Inbound shipments, record a receipt of 20 motors with GRN-55. Typing 41 is blocked before it is sent. Re-open the decision: only Bharat Irrigation is now at risk, at ₹1.35L.
7. **Approve the response (35 s).**
   - In Control → Decisions, switch the account to live. External sending stays off.
   - On the decision, choose "Prepare updates for 1 affected customer", then Approve, then Run.
   - In Approvals, one draft to Bharat Irrigation waits for approval. Nothing has been sent.
8. **Audit (10 s).** Open the decision's History. It shows the revision, the choice, the approval and the run, with who did each.

## Supported data sources (what is actually supported)

- **CSV and Excel exports from any system.** Starlane reads `.csv` (comma, semicolon or tab separated), `.xlsx` and `.xls`. It skips title rows above the header. There are four kinds of record: products with stock on hand, bill of materials, open purchase orders, and open sales orders.
- **Column names.** The column-name suggestions know common Tally, Zoho, Busy and spreadsheet column names. However, **only the synthetic files above have been tested**. No real export from Tally, Zoho or Busy has been imported yet. Every mapping is shown to the owner for confirmation.
- **Not supported.** There is no live connector for these records (no API sync), and no Google Sheets link for these four kinds.

## Known limitations

- **Possible double count with Tally.** A Tally purchase voucher that syncs after a receipt was already recorded in Starlane could count the same goods twice. To prevent this, when importing purchase orders the owner chooses who records stock: Starlane or the accounting system.
- **Stock is one count per account.** It is not split by business entity or warehouse.
- **Only one level of bill of materials** is used by the delay check.
- **Imported open POs appear in Purchases at ₹0 with status "ordered".** They are not bills.
- **Order lines without a currency** are left out of value totals. Values in a different currency are shown, not converted.
- **Decisions under a contract are not rewritten.** Once a decision is selected, approved or run, later receipts don't rewrite it.
- **No per-user roles.** Access is per account: every signed-in user of an account can import and record receipts.
- **Size limits.** At most 15 MB and 50,000 rows per file. Files are parsed in memory.
- **The planner uses floating-point arithmetic internally** for allocation. Imported and stored values are exact decimals.
- **A malformed sign-in token** returns a 500 instead of a 401 on some older decisions routes.

## Security and data handling

- **Tenant isolation.** The account is always taken from the verified sign-in token, never from the request, the file or a form field. Every read and write is scoped to that account. Tests show another account cannot see, import into, or receive against these records, and that a forged or ghost token is refused.
- **Uploads.** One file per request, held in memory and never written to disk. Over 15 MB is refused with a 413 before parsing; over 50,000 rows is refused.
- **What is stored.** The imported records themselves, and a copy of each accepted row as a provenance record (`raw_observations`). For every import, a batch record keeps the file name, file hash, source system, row counts, status and any failure message, plus an audit event.
- **What is not stored.** The original file bytes.
- **Writes.** Preview writes nothing. Commit runs in one transaction under a per-account lock: a failure saves nothing and is recorded as FAILED. The same file with the same choices is imported only once. Nothing is deleted because a newer file leaves it out.
- **Receipts.** Every receipt carries an idempotency key, and row locks are held while it is recorded. Over-receipts are refused, and corrections need a reason. Stock is posted once, through the ledger.
- **No outbound messages.** `FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED` stays off. Customer updates are template drafts, not written by a language model, and each one needs its own approval in Approvals.
- **Certifications.** None are claimed.

## What a real-data pilot still needs

1. **Merge the stack.** Merge #87 and #95, then #89 and #98. Resolve the expected `server.js` conflicts with #88.
2. **Staging environment.** Apply migrations up to 078 on a staging database and deploy on Node 20+. External sending stays off.
3. **One real export of each kind.** Get one export of each of the four kinds from a pilot customer's actual system, with permission and under a data agreement. Run them through **preview only** and fix any column names or formats the importer does not read.

**Exact next task:** item 3, previewing one real export from the pilot customer's system on staging. It is the first point where Starlane meets data it was not designed around.
