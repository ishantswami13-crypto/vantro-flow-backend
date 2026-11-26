# Starlane data layers

Starlane's backend is four layers (API, application, domain, data access) over
six data layers that all live in one Postgres. Postgres stays the system of
record; everything else is derived from it and can be rebuilt.

| Layer | Purpose | Status |
| --- | --- | --- |
| L0 System of record | Ledgers, orders, POs, shipments, decisions | Live. RLS on the `pg` path planned (PR 6) |
| L1 Cache | Hot reads shared across replicas | **This PR:** `lib/data/cache` (memory or Postgres backend) |
| L2 Event log | Outbox written in the business transaction, `LISTEN/NOTIFY` delivery | PR 2 |
| L3 Read models | Precomputed Home, Decisions, exposure | PR 3 |
| L4 Analytics | Star schema: daily facts by customer, product, supplier, date, currency | PR 4 |
| L5 Search | `pg_trgm` fuzzy entity names; `pgvector` for Vault when needed | PR 5 |

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

### Tests

- `tests/dataLayer.unit.test.mjs` — no database.
- `tests/dataLayer.db.test.mjs` — real Postgres (local only): no setting leaks
  after commit or rollback, Postgres enforces the timeout and read-only mode,
  two tenants cannot read, change or delete each other's rows, and the shared
  cache is visible across two cache instances.
