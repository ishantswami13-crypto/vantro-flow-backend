# 2xA Demo — Supply Chain Disruption Vertical Slice

## Demo objective

Prove that Starlane can run the full intelligence loop — CONTEXT → EVIDENCE →
CURRENT BUSINESS STATE → EXTERNAL WORLD STATE → DEPENDENCY UNDERSTANDING →
REASONING → FORECAST → DECISION → ACTION → EXECUTION → VERIFICATION — against
one real, coherent scenario: an earthquake disrupting a Chinese supplier of a
bicycle manufacturer, traced all the way to real revenue exposure and a real
executed purchase order. Every number shown is computed by deterministic
backend code, never invented by an LLM or the frontend.

## Setup

Requires both repos running locally against the same Postgres instance
(`DATABASE_URL` in `.env`):

```bash
# Backend (D:\Vantro\vantro-flow-backend)
npm install
node server.js
```

```bash
# Frontend (D:\Vantro\vantro-flow-frontend)
npm install
NEXT_PUBLIC_API_URL=http://localhost:3001 npm run dev -- -p 3100
```

Seed the demo tenant and trigger the event (from the backend directory):

```bash
node scripts/seed-2xa-demo.js
node scripts/trigger-2xa-event.js
```

This creates tenant **Meridian Cycles** (`owner@2xa-demo-meridian.invalid`) —
a bicycle manufacturer with 5 suppliers across CN/IN/DE/US/VN, 10 components,
5 finished products with real bills-of-materials, 6 customers, and 6 open
orders — then inserts the real 2017 M7.0 Jiuzhaigou earthquake (USGS
`us2000a2c7`, replayed with a current timestamp for demo determinism — see
`scripts/trigger-2xa-event.js` for the exact honesty note) and runs it
through the unmodified real relevance pipeline (`lib/world/relevance.js`).

To log in as the demo tenant during local testing, mint a JWT directly
(no password flow exists for seeded tenants):

```bash
node -e "
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { getPool } = require('./lib/db/pg');
(async () => {
  const pool = getPool();
  const u = await pool.query(\"SELECT id FROM users WHERE email='owner@2xa-demo-meridian.invalid'\");
  console.log(jwt.sign({ userId: u.rows[0].id, email: 'owner@2xa-demo-meridian.invalid' }, process.env.JWT_SECRET, { expiresIn: '4h' }));
  await pool.end();
})();
"
```

Then in the browser console on `http://localhost:3100`:

```js
localStorage.setItem('vantro_token', '<token>');
localStorage.setItem('vantro_user', JSON.stringify({ email: 'owner@2xa-demo-meridian.invalid' }));
document.cookie = 'vantro_token=' + encodeURIComponent('<token>') + '; path=/; max-age=14400; SameSite=Lax';
```

## Reset

**Preferred (fast, reliable):** re-run the two CLI commands above. The seed
script is idempotent — it deletes and recreates only the
`owner@2xa-demo-meridian.invalid` tenant, never touching any other tenant.

**In-app control:** the Intelligence page (`/intelligence`) has a small,
deliberately understated "Reset 2xA demo" link at the bottom — internal use
only, never a customer-facing control. It calls `POST /api/demo/2xa/reset`,
which shells out to the same two CLI scripts. **Known limitation:** on this
host, spawning two child Node processes from inside the Express process has
been observed taking 15–70+ seconds (see Known Limitations) — the frontend
timeout is set to 120s to accommodate this, but the CLI path is faster and
more predictable for a live meeting. Prefer the CLI reset immediately before
the meeting; use the in-app button only as a secondary/backup control.

## Meeting walkthrough

1. **Reset** — run the two CLI commands above in a terminal a few minutes
   before the meeting.
2. **Open `/intelligence`** — the entry point. Shows one card: "Supplier
   exposure detected — M7.0 Earthquake — Jiuzhaigou, Sichuan, China."
3. **Click the card** → opens `/intelligence/[signalId]` — the Impact hero
   view. Top row: Revenue exposed ₹35,50,000 · Time to stockout 12.5d ·
   Affected orders 3 · Confidence HIGH.
4. **Point at "What happened" / "Why it matters"** — the real event record
   and the real relevance explanation from the transmission-channel engine.
5. **Scroll to the dependency chain** — EVENT → SUPPLIER (Sichuan Alloy
   Works) → COMPONENT (Aluminum Frame Alloy Tube Set) → INVENTORY (20 days
   coverage) → PRODUCTS (2 affected) → ORDERS (3) → REVENUE (₹35,50,000).
6. **Click "View evidence"** — the drawer groups every claim as External,
   Observed, Calculated, Assumption, or Forecast. Point out that lead time
   is explicitly labeled an Assumption, not a fact.
7. **Click "Analyze impact"** — runs the real forecast + ranking endpoints
   live. Forecast timeline appears: Today (20d coverage) → Day 7 (holds) →
   Day 14 (stocked out) → Day 30 (stocked out).
8. **Scroll to Recommended interventions** — Without action vs. With
   recommended action comparison, then the ranked action card (Expedite
   reorder — benefit-to-cost ratio 33.33×).
9. **Click "Approve & execute"** — the "what will happen" box already told
   the room this creates a draft PO via the Demo ERP Adapter, not a live
   Odoo write.
10. **Point at the result** — "Executed via Demo ERP Adapter," real PO
    number, status "Draft — Demo Adapter," timestamp.
11. **Point at "Outcome verification: Awaiting observation"** — the closed
    loop exists structurally even though actual-value verification hasn't
    run yet (there's been no time for new data to arrive).

## Talking points (one line each)

- **Intelligence entry point:** "Starlane watches your business and the
  outside world continuously — this is the only thing it found relevant
  today."
- **Impact hero:** "One earthquake, traced automatically to a dollar figure
  and a date — not a headline, a calculation."
- **Dependency chain:** "This is a real bill-of-materials and a real open
  order book, not a mockup."
- **Evidence drawer:** "Every number is labeled — fact, assumption, or
  forecast. Nothing is hidden or blurred."
- **Forecast:** "This is what happens if we do nothing — a deterministic
  projection, not a guess."
- **Decision:** "Two real options, ranked by benefit-to-cost, not a generic
  AI suggestion."
- **Approval & execution:** "One click creates a real purchase order in
  Starlane's own database — and we tell you exactly which system executed
  it."

## Technical architecture

```
Frontend (Next.js /intelligence, /intelligence/[signalId])
  → GET  /api/intelligence/signals
  → GET  /api/intelligence/signals/:id/impact
  → POST /api/intelligence/signals/:id/forecast
  → POST /api/intelligence/signals/:id/actions
  → POST /api/intelligence/actions/:id/approve-and-execute
      ↓
lib/domain/intelligence/supplyChainOrchestrator.js  (DB orchestration)
  → lib/world/relevance.js                (real, unmodified relevance matcher)
  → lib/domain/intelligence/supplyChainImpact.js  (pure calculations)
  → lib/domain/automation/supplyChainExecutionAdapter.js  (demo ERP adapter)
      ↓
Postgres: world_events, business_exposure, business_signals,
          product_components, order_line_items, predictions,
          ai_actions, purchase_orders, execution_records
```

## Honesty boundaries

- **Real:** the relevance-matching pipeline (`lib/world/relevance.js`), all
  BOM/inventory/revenue calculations (`supplyChainImpact.js`), the
  approval/execution lifecycle (`ai_actions`, `execution_records`), and the
  purchase order created on approval.
- **Deterministic, not AI-guessed:** every dollar and day figure comes from
  a pure function with named inputs — see the evidence drawer for the exact
  source of each number.
- **Historical/demo event data:** the earthquake is a real, verifiable
  historical event (USGS `us2000a2c7`, actual date 2017-08-08), replayed
  with a current timestamp so the 7/14/30-day forecast horizons are
  meaningful during a live demo. This substitution is confined to the
  timestamp field and is disclosed in the event's own summary field.
- **Demo ERP execution:** approving an action creates a real
  `purchase_orders` row in Starlane's own database, tagged
  `draft_demo_adapter`. **No live Odoo (or any external ERP) write ever
  occurs** — `lib/domain/automation/connectorCatalog.js` reports ODOO as
  `state: 'PLANNED'` with no write capability, and the execution adapter
  checks this before ever claiming a live write, throwing loudly rather
  than lying if that ever changes without a real adapter behind it.
- **Not yet live Odoo:** connecting a real Odoo write requires implementing
  `executeSupplyChainAction`'s `LIVE_ODOO` branch in
  `supplyChainExecutionAdapter.js` and flipping `connectorCatalog.js`'s
  ODOO entry to `WRITE_SYNC_READY` — intentionally left undone until a real
  Odoo integration exists.

## Outcome verification

`POST /api/intelligence/signals/:id/verify-outcome` (see
`lib/domain/intelligence/outcomeVerification.js`) closes the loop for real:

- Reuses `forecastEngine.resolvePrediction` (existing, tested prediction-error
  math) rather than a parallel scoring mechanism.
- Never resolves a `stockout_within_horizon` prediction before its horizon
  (`as_of + horizon_days`) has actually elapsed — calling it early is a no-op
  that reports `AWAITING_OBSERVATION`, proven by
  `tests/outcomeVerification.test.js`.
- The only "actual value" a resolved prediction can take is a real, current
  read of `products.current_stock` for the affected component — never an
  estimate.
- Once every relevant horizon for a signal has resolved, the executed
  `ai_actions` row for that signal is stamped `outcome = 'effective'` (no
  real stockout occurred) or `'ineffective'` (one did anyway), with a
  human-readable `outcome_notes` explanation — reusing the existing
  `ai_actions.outcome` column rather than inventing a new status field.

This is intentionally a small, honest slice of full outcome verification —
see Known limitations below for what a production version still needs.

## Known limitations

- **Predictions are now versioned, not duplicated.** Re-running "Analyze
  impact" on the same signal used to insert a brand-new, disconnected
  prediction row every time — a real bug that produced dozens of stale,
  never-resolving duplicates under repeated testing. `writeDoNothingForecast`
  now calls `lib/domain/intelligence/predictionVersioning.js`, which supersedes
  the prior live prediction for each (entity, target, horizon) — the old row
  is preserved with `superseded_by_id`/`revision_reason`/`revised_at` set,
  never deleted or overwritten, and `getPredictionHistory()` walks the
  `supersedes_id` chain back to reconstruct "what did we know at each point
  in time." An already-`RESOLVED` prediction is a permanent historical fact
  and is never superseded by a later re-analysis — a fresh chain starts
  after it instead. `verifySignalOutcomes` only ever resolves the current
  live head of a chain (`superseded_by_id IS NULL`).
- **Two prediction types now resolve.** `verifySignalOutcomes` resolves both
  `stockout_within_horizon` (against real `current_stock`) and
  `revenue_exposure_within_horizon` (recomputed against real, current
  `order_line_items`/`product_components` state — not the original
  snapshot). Only the stockout target rolls up into the executed action's
  `effective`/`ineffective` outcome today; the revenue-exposure resolution
  is real and persisted but has no rollup rule defined yet.
- **Revenue exposure has no per-horizon decay model.** The 7/14/30-day
  revenue-exposure predictions all carry the same point estimate today
  (the current exposure, carried forward) — this is recorded explicitly as
  an assumption (`assumptions.noDecayModel`) rather than hidden, but a real
  model would need to account for orders shipping, being cancelled, or new
  ones appearing between now and each horizon.
- **Verification now runs on a schedule.** A daily cron (`03:10 UTC`,
  gated by the existing `world_intelligence_enabled` feature flag) iterates
  every tenant's active signals and calls the same `verifySignalOutcomes`
  used by the API route — it is no longer only callable by hand. It can
  also still be triggered on demand via `POST
  /api/intelligence/signals/:id/verify-outcome`.
- **In-app demo reset can be slow.** Shelling out to two child Node
  processes from inside the Express server has been observed taking
  anywhere from ~15s to over a minute on this host, likely compounded by
  Neon Postgres connection-pool cold-starts under load. The CLI reset path
  is faster and should be preferred before a live meeting.
- **Frontend has no automated test suite.** The vantro-flow-frontend repo
  has no Jest/RTL/Playwright infrastructure at all (confirmed via audit) —
  this vertical slice was verified by live manual click-through in the
  browser (screenshots on file) plus full backend test coverage
  (`tests/supplyChainImpact.test.js`, `tests/supplyChainOrchestrator.test.js`)
  rather than new frontend unit tests.
- **Multiple transmission channels legitimately fire per event.** The
  earthquake matches three real channels (SUPPLY_SHOCK, DEMAND_SHOCK,
  GEOGRAPHIC_DISRUPTION) for the same supplier, producing three real
  `business_signals` rows — correct backend behavior. The `/intelligence`
  list page deduplicates these for display by `(event, supplier)` pair so
  the meeting doesn't show three near-identical cards for one story.
- **Neon connection stability during heavy local testing.** Several
  transient `Connection terminated due to connection timeout` errors were
  observed during this session's testing under rapid repeated connections —
  not a code defect, but worth a quick connectivity check before the
  meeting starts.
