# Starlane data layers

Starlane's backend is four layers (API, application, domain, data access) over
six data layers that all live in one Postgres. Postgres stays the system of
record; everything else is derived from it and can be rebuilt.

| Layer | Purpose | Status |
| --- | --- | --- |
| L0 System of record | Ledgers, orders, POs, shipments, decisions | Live. RLS on the `pg` path planned (PR 6) |
| L1 Cache | Hot reads shared across replicas | **Added:** `lib/data/cache` (memory or Postgres backend) |
| L2 Event log | Outbox written in the business transaction, `LISTEN/NOTIFY` delivery | **Added:** `lib/data/events`, migration 091 |
| L3 Read models | Receivables by tenant and customer with ageing, served at `/api/data` | **Added:** `lib/data/readModels`, migration 092 |
| L4 Analytics | Fact tables sliced by time, customer, currency and status through a cube API | **Added:** `lib/data/analytics`, migration 093 |
| L5 Search | Typo-tolerant names (`pg_trgm`) and duplicate detection; `pgvector` for Vault later | **Added:** `lib/data/search`, migration 094 |

Redis, ClickHouse, Kafka and a graph database are deliberately not added yet.
Each layer has an interface so one can be swapped in when volume calls for it.

## Data access layer (`lib/data`)

New code reaches the database through `lib/data`. Existing routes keep their
current paths and move over one area at a time.

```js
const { withTenant, readTenant, defineRepository, getCache } = require('./lib/data');

const purchaseOrders = defineRepository({
  table: 'purchase_orders',
  columns: ['po_number', 'supplier_name', 'status', 'expected_date'],
});

// userId comes from req.user.id (the verified JWT), never the request body.
const open = await readTenant(req.user.id, (db) =>
  purchaseOrders.findMany(db, { status: ['open', 'partial'] }, { orderBy: 'expected_date asc', limit: 200 })
);

const summary = await getCache().getOrSet(req.user.id, 'home:summary', 60, () => buildSummary(req.user.id));
```

### Guarantees

- **Tenant on every statement.** Repository methods take the tenant handle from
  `withTenant` and add `user_id = <tenant>` to every SELECT, UPDATE and DELETE.
  INSERT sets `user_id` from the handle and refuses one in the row. An update
  cannot change `user_id` or the primary key.
- **No identifier injection.** Table, column and sort names come from the
  repository definition and are validated; every value is a bound parameter.
- **Transaction-local settings only.** `withTenant` sets `app.user_id` and
  `statement_timeout` with `set_config(..., true)` (SET LOCAL). They end with
  the transaction, so nothing leaks onto pooled connections (see the 6 Oct 2026
  `search_path` incident in `lib/db/testDatabaseGuard.js`).
- **Bounded work.** Default statement timeout 15 s, capped at 120 s; list reads
  default to 100 rows, capped at 1,000.
- **Cache keyed by tenant.** Every cache call names the tenant; stored keys are
  `<namespace>:<tenant>:<key>`. Values are JSON copies, so callers cannot
  mutate cached objects. A cached `0`, `false` or `null` is a hit. Concurrent
  misses for one key share a single fetch. A backend failure fails open.

### Cache backend

`STARLANE_CACHE_BACKEND=memory` (default) or `postgres`. The Postgres backend
uses the UNLOGGED table `starlane_cache` from `migrations/090_data_layer_cache.sql`,
so every replica sees the same values and invalidations. Expired rows are
purged every 10 minutes by the process that uses the cache. Rollback: unset the
variable (back to memory); the table can be dropped with no data loss.

## Event log (`lib/data/events`)

```js
const { withTenant, events } = require('./lib/data');

await withTenant(req.user.id, async (db) => {
  await db.query('UPDATE purchase_orders SET expected_date = $2 WHERE user_id = $1 AND id = $3', [db.userId, newDate, poId]);
  await events.appendEvent(db, {
    stream: `purchase_order:${poId}`,
    type: 'purchase_order.delayed',
    payload: { poId, from: oldDate, to: newDate },
    idempotencyKey: req.get('Idempotency-Key') || undefined,
  });
});
```

- **Outbox.** `event_log` is written in the same transaction as the change, so
  an event exists exactly when its change committed.
- **Idempotent appends.** The same `idempotencyKey` for the same tenant returns
  the first event and writes nothing.
- **Commit order.** Each row stores its transaction id; consumers only read rows
  whose transaction is older than every open one, so a slow transaction's event
  is never skipped (a plain `id > cursor` reader would skip it).
- **Durable consumers** keep one cursor in `event_consumers`. A run locks the
  consumer row with `SKIP LOCKED` (one server at a time) and runs the handler in
  the same transaction as the cursor move, each event under a savepoint. A
  projection written by the handler is therefore applied exactly once. A failing
  handler stops at that event, records `last_error`, and retries next run.
- **Broadcast consumers** keep an in-memory cursor per process starting at
  "now"; `cacheInvalidationConsumer(cache)` clears a tenant's cache on every
  server when one of its events commits.
- **Delivery.** Polling every 2 s by default. Set `EVENT_LISTEN_DATABASE_URL` to
  a session-mode or direct connection for instant `LISTEN/NOTIFY` wake-ups;
  Supabase's transaction pooler (port 6543) does not support `LISTEN`.
- **Started by** `lib/data/boot.js` when `STARLANE_DATA_LAYER_ENABLED=true` (see below).

## Read models (`lib/data/readModels`)

`rm_receivables_tenant` and `rm_receivables_customer` hold open and overdue
receivables per tenant, currency and customer, with ageing buckets (current,
1-30, 31-60, 61-90, 90+ days past due), oldest due date and last payment date.
Currencies are never added together; `''` / `null` is the base currency.

- **Never stale.** Every read compares a fingerprint of the tenant's invoice
  rows (row count plus an order-independent sum of `md5(id, xmin)`, which
  changes on any insert, update or delete, even ones that skip `updated_at`)
  and the as-of day with what the model was built from. If they differ it
  rebuilds that tenant first. The background work below only makes that
  rebuild happen ahead of the request.
- **Kept current in the background** by a durable consumer on `invoice.*`,
  `payment.*`, `receivable.*` and `customer.*` events, and by a sweep every
  5 minutes (`READ_MODEL_SWEEP_MS`) for writes that do not emit events yet.
- **Rebuild any time:** `npm run data:rebuild` (stale tenants) or
  `npm run data:rebuild -- --all`. The tables are derived data only.
- **As-of day** is the UTC date. Dates go out as `YYYY-MM-DD` text, never via a
  JS `Date`, so servers east of UTC do not shift them.

### Endpoints (404 unless `STARLANE_DATA_LAYER_ENABLED=true`)

| Endpoint | Returns |
| --- | --- |
| `GET /api/data/receivables` | Summary by currency + the 10 most overdue customers |
| `GET /api/data/receivables/customers?currency=&sort=overdue\|open\|age\|name&limit=&offset=` | Paged customer exposure |
| `GET /api/data/status` | Whether this server runs the dispatcher, consumer and cache stats |

### Turning it on

1. Apply migrations 090-092 (`npm run db:migrate`), staging first.
2. Set `STARLANE_DATA_LAYER_ENABLED=true`. Optional: `EVENT_LISTEN_DATABASE_URL`
   (session-mode connection) for instant wake-ups, `STARLANE_CACHE_BACKEND=postgres`
   for a cache shared across replicas.
3. Rollback: unset the flag. Nothing else reads these tables.

Scale note: the fingerprint and the sweep scan a tenant's invoices (a few ms
per 10,000 rows). Past roughly a million invoices per tenant, switch to a
per-tenant version counter maintained by a statement-level trigger.

## Analytics cube (`lib/data/analytics`)

Two fact tables, loaded by the same freshness rule as the read models:

| Fact | Grain | Measures |
| --- | --- | --- |
| `fact_invoices` | one row per invoice | `count`, `invoiced`, `collected`, `outstanding`, `avg_days_to_pay`, `avg_days_late`, `on_time_rate` |
| `fact_receivables_daily` | tenant x customer x currency x day, partitioned by month | `open_amount`, `overdue_amount`, `current`, `d1_30`, `d31_60`, `d61_90`, `d90_plus`, `customers`, `overdue_customers` |

Dimensions: `customer`, `currency`, `status` (invoices), and one time grain
(`day`, `week`, `month`, `quarter`, `year`) over a chosen date (`invoice`,
`due` or `paid` for invoices; `snapshot` for daily receivables).

```
GET /api/data/cube?fact=invoices&measures=invoiced,collected&by=month,customer&from=2026-04-01&to=2027-03-31
GET /api/data/cube?fact=receivables_daily&measures=open_amount,overdue_amount&by=week&currency=USD
GET /api/data/cube/schema
```

Rules the cube enforces:

- Only names from its whitelist reach SQL; every value is bound.
- Money is never added across currencies: a money measure always groups by
  currency (`currencyAdded: true` in the answer says it did).
- Daily receivables are balances, not flows: grouped by week or month, each
  period shows its last snapshot day, never a sum of days. Days with nothing
  open read as zero (no row), using `fact_snapshot_days`.
- New monthly partitions get row-level security and lose API-role grants as
  they are created, like every other data-layer table.

History: `fact_receivables_daily` records how things stood each day, so it
only has days from when the data layer was turned on. The sweep takes the
snapshot every day even if nobody opens the app.

## Search (`lib/data/search`)

`search_entities` indexes customer, supplier and product names (plus names
that only exist on invoices) with a trigram GIN index. Names are normalised
first: lower case, `&` to `and`, punctuation dropped, the `M/s` prefix and
legal forms (Pvt, Ltd, LLP, Inc, Co, ...) removed, so
`M/s. Sharma & Sons Pvt. Ltd.` and `sharma and sons` are the same text.

```
GET /api/data/search?q=sharma%20snos&types=customer,supplier,product
GET /api/data/search/duplicates?type=customer&minScore=0.6
```

- Typo-tolerant (`word_similarity`), and a GSTIN, phone or SKU prefix matches
  its record with score 1. `%` and `_` in a query are literal.
- On a tie a real customer record ranks above the same name seen only on
  invoices; invoice-only names use the read models' `name:<lower name>` key.
- Duplicates lists likely-same pairs (`similarity >= minScore`) for review. It
  never merges anything.
- Rebuilt per tenant when any of customers, suppliers, products or invoices
  changes (same fingerprint rule), so results are never stale. The source
  tables get no new indexes or triggers.

### Tests

- `tests/dataLayer.unit.test.mjs` — no database.
- `tests/dataLayer.db.test.mjs` — real Postgres (local only): no setting leaks
  after commit or rollback, Postgres enforces the timeout and read-only mode,
  two tenants cannot read, change or delete each other's rows, and the shared
  cache is visible across two cache instances.
- `tests/dataEvents.db.test.mjs` — outbox rollback, idempotency, tenant reads,
  failure and retry, exactly-once projection with two racing servers, commit
  order with an open transaction, broadcast invalidation and `LISTEN` wake-ups.
- `tests/dataReadModels.db.test.mjs` — hand-worked receivables (part payments,
  cancelled, undated, merged name variants, USD kept apart), freshness after
  writes with no event and no `updated_at`, deletes, day rollover, event
  consumer, sweep, and the HTTP endpoints with tenant isolation and the flag.
- `tests/dataAnalytics.db.test.mjs` — hand-worked invoice measures, days to
  pay and lateness, currency separation, daily snapshots across a month
  boundary with partitions, last-day-per-period, paid-off customers, spec
  validation and the HTTP cube.
- `tests/dataSearch.db.test.mjs` — normalisation, typos, GSTIN and SKU
  prefixes, invoice-only names, duplicates, renames and deletes, tenant
  isolation and the HTTP endpoints.
