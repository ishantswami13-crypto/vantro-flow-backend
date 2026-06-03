# Emergency Fix — Ledger / Forecast / AI Real-Data Pipeline
**Date:** 2026-06-03
**Trigger:** Live demo. Production frontend (https://vantro-flow-frontend.vercel.app) showing ₹0 ledger, stuck forecast skeleton, and fake "Cortex Test Customer" data on AI pages.
**Engineer:** Atlas Emergency Production Fix
**Constraint:** No production data deleted. No secrets printed. No prod env vars touched. WhatsApp/SMS sending untouched (stays off). Tenant isolation preserved.

---

## Root Cause(s)

### 1. Fake "Cortex Test Customer" data on AI Founder + Neural Engine (CONFIRMED — primary)
`cortex-lab/seed.js` creates synthetic test rows through the **real** `/api/sales` API, tagged
`[cortex-test <runId>]` with the default customer name **"Cortex Test Customer"**. When the
cortex-lab harness was pointed at the pilot/demo tenant, those rows landed in the production
`invoices` / `sales` / `customers` tables **under the pilot user's `user_id`**.

Every AI/analytics read endpoint is correctly tenant-scoped (`requireOwner` / `req.user.userId`),
so it faithfully returned the seed rows as if they were real debtors:
- `POST /api/ml/briefing` → AI Founder + Neural Engine debtor list
- `GET /api/invoices/:userId` → dashboard table, collections, customers, forecast top-impact
- `GET /api/customer-scores` → risk-tier badges on Collections/Customers
- `getReceivableRows()` / `getPayableRows()` → metrics + forecast inputs

This was **not** a hardcoded frontend fallback — it was real test data leaking into a real
tenant's view. **Tenant isolation was NOT broken** (no cross-tenant leak); the test data simply
belonged to the same tenant it was seeded into.

### 2. Bank Ledger shows ₹0 while rows are visible (CONFIRMED — frontend)
`app/ledger/page.tsx` rendered the transaction **table** from `mergedRows`
(backend rows **+** localStorage fallback rows) but computed the **summary cards** from
`data.summary` (backend-only totals):

```js
setTransactions(mergedRows);
setSummary(data.summary || buildSummary(mergedRows));  // ← totals exclude local rows
```

If a manual transaction insert ever fell back to localStorage (the page does this when the
backend insert errors), the row appeared in the table but the four summary cards
(Net Balance / Received / Paid Out / This-Month) read **₹0** because `data.summary` never
included it. Rows visible, totals wrong.

### 3. Cash Forecast "stuck" skeleton (LATENCY, not a hang)
`app/forecast/page.tsx` already uses `Promise.allSettled` + `try/catch/finally`, so `loading`
always resolves (worst case at the API client's 30s abort). The perceived "stuck" was backend
latency: `/api/cash-forecast/:userId` runs `ensureConnectedBusinessData()` +
`syncExistingSalesReceivables()` (up to 100 sequential row syncs) on every load, inflated further
by the cortex-test rows. The endpoint's own `catch` always returns a `success:true` flat-line
fallback, so it never errors out — it was just slow. Hardened with a client-side watchdog.

---

## Fix Applied

A single shared backend guard that **HIDES** (never deletes) cortex-test seed rows from every
tenant-facing response, plus three frontend robustness fixes.

### Backend — `server.js`
New helper (near the ledger helpers):
```js
const CORTEX_TEST_PATTERN = /\[cortex-test|cortex[\s_-]*test|cortex[\s_-]*chain/i;
function isCortexTestRow(row) { /* checks customer_name, party_name, supplier_name, name, notes, description */ }
function stripCortexTestRows(rows) { return rows.filter(r => !isCortexTestRow(r)); }
```
Applied at 7 read sites (one helper, all additive):

| Line | Endpoint / function | Cleans up |
|------|--------------------|-----------|
| `/api/invoices/:userId` | dashboard table, collections, customers, forecast top-impact |
| `getReceivableRows()` (invoices + sales) | metrics, forecast, khata |
| `getPayableRows()` (purchases) | metrics, forecast payables |
| `POST /api/ml/briefing` (invoices + calls) | **AI Founder, Neural Engine** |
| `GET /api/customer-scores` | Collections / Customers risk-tier badges |

Regex validated 7/7 against real-vs-test names (e.g. "Cortexa Industries" and a hypothetical real
"Cortex Solutions Pvt Ltd" are **kept**; only seed-tagged rows are hidden).

### Frontend
| File | Change |
|------|--------|
| `app/ledger/page.tsx` | Summary now always `buildSummary(mergedRows)` — totals match the rows actually shown |
| `app/ai-chat/page.tsx` | Empty state when no real debtors → "No verified business data yet" (instead of empty health ring) |
| `app/neural-engine/page.tsx` | Live-output card gated on real debtors; clear "No verified business data yet" card otherwise |
| `app/forecast/page.tsx` | 15s client-side watchdog — skeleton can never persist even if the network layer hangs |

---

## API Endpoints Touched (read-only filtering added)
- `GET  /api/invoices/:userId`
- `GET  /api/metrics/:userId` (via `getReceivableRows`/`getPayableRows`)
- `GET  /api/cash-forecast/:userId` (via `getReceivableRows`/`getPayableRows`)
- `POST /api/ml/briefing`
- `GET  /api/customer-scores`

No write paths changed. No auth changed. No env vars changed. WhatsApp/voice send paths untouched.

---

## Pages Affected
Bank Ledger · Cash Flow Forecast · AI Founder · Neural Engine · Dashboard · Collections · Customers (all read the filtered endpoints).

---

## Commands Run
- `node --check server.js` → **OK** (syntax valid)
- Regex unit test (inline node) → **7/7 cases correct** (no false positives on real names)
- `npm run build` (frontend) → **Compiled successfully · 51/51 static pages**

Backend was **not** started against production (would hit prod DB / trigger crons mid-demo).
Syntax-checked only.

---

## Tenant / Data Safety
- Every touched endpoint is scoped by `requireOwner` (validates `:userId` against the JWT) or
  `authMiddleware` + `req.user.userId`. Writes use `req.user.userId`, never a body-supplied id.
- The guard only **filters output**; it performs **zero deletes/updates**. The seed rows remain in
  the DB and can be purged later by their `[cortex-test <runId>]` marker.
- No cross-tenant access introduced or removed.

---

## Remaining Risks / Honest Notes
1. **DEPLOY BRANCHES — verify before pushing.** At fix time:
   - Backend working branch: `performance-bootstrap-cortex-fix-v1`
   - Frontend working branch: `main`
   Older project notes say Railway deploys backend `main` and Vercel deploys frontend
   `security-operating-system-v1`. **If those notes still hold, these commits must be merged/
   cherry-picked onto the deploy branches to reach the live demo URL.** Confirm each platform's
   production branch in the Railway/Vercel dashboards before pushing.
2. **Not pushed.** Commits are local only — pushing will trigger an auto-deploy (Railway restart +
   Vercel rebuild). Avoided mid-demo on purpose. Push when safe.
3. **Underlying test data still present.** We hide it; we did not delete it (per rules). Recommend a
   separate cleanup that deletes rows matching `[cortex-test ` once the demo is over.
4. **Ledger ₹0 (backend-insert path):** if the true cause was the `bank_transactions` insert failing
   in production (table/column issue), the now-corrected summary will surface localStorage rows, but
   the data won't be cloud-persisted until the insert path is confirmed. Verify a freshly-added
   transaction survives a hard refresh on the demo device.
5. **Forecast latency:** the watchdog stops the skeleton, but the real cure is throttling/batching
   `syncExistingSalesReceivables` (up to 100 sequential syncs per load). Deferred — too risky to
   rewrite mid-demo.

---

## How To Verify Live (after deploying to the correct branches)
1. Log in as the pilot user on https://vantro-flow-frontend.vercel.app
2. **Bank Ledger** → added transactions appear; Net Balance / Received / Paid Out reflect them (not ₹0).
3. **Cash Forecast** → 30d/60d/90d buttons work; page resolves to chart **or** a clear empty/error state within ~15s (never an endless skeleton).
4. **AI Founder** → no "Cortex Test Customer"; real debtors or "No verified business data yet".
5. **Neural Engine** → live output only with real debtors; otherwise "No verified business data yet".
6. **Dashboard / Collections / Customers** → no Cortex test names in tables or risk badges.
7. Confirm all data is the logged-in tenant's only.
