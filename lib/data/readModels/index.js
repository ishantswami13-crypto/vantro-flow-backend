'use strict';
// lib/data/readModels — L3 read models and how they are kept current.
//
//   getReceivables(userId)      summary + customers, rebuilt first if stale
//   receivablesConsumer()       durable event consumer: rebuild on invoice /
//                               payment / receivable events
//   sweepStale(pool)            rebuild every tenant whose invoices changed or
//                               whose as-of day rolled over (catches writes
//                               that do not emit events yet)

const { withTenant, readTenant } = require('../tenantDb');
const receivables = require('./receivables');

const RECEIVABLE_EVENT = /^(invoice|payment|receivable|customer)\./;

async function ensureFresh(userId, { asOf, pool } = {}) {
  const day = receivables.asOfDay(asOf);
  const stale = await readTenant(userId, (db) => receivables.isStale(db, { asOf: day }), { pool });
  if (stale) await withTenant(userId, (db) => receivables.refreshReceivables(db, { asOf: day }), { pool, timeoutMs: 60000 });
  return { refreshed: stale, asOf: day };
}

async function getReceivables(userId, { asOf, pool, currency, sort, limit, offset } = {}) {
  const fresh = await ensureFresh(userId, { asOf, pool });
  return readTenant(userId, async (db) => ({
    summary: await receivables.readSummary(db),
    customers: await receivables.readCustomers(db, { currency, sort, limit, offset }),
    rebuiltForThisRequest: fresh.refreshed,
  }), { pool });
}

// Runs inside the dispatcher's transaction, so the rebuild and the cursor move
// commit together. The tenant handle is scoped to the event's own tenant.
function receivablesConsumer({ name = 'readmodel.receivables', asOf } = {}) {
  return {
    name,
    mode: 'durable',
    async handle(event, { db }) {
      if (!RECEIVABLE_EVENT.test(event.type)) return;
      await db.query("SELECT set_config('app.user_id', $1, true)", [event.userId]);
      const tenantDb = { userId: event.userId, query: (t, p) => db.query(t, p) };
      await receivables.refreshReceivables(tenantDb, { asOf: typeof asOf === 'function' ? asOf() : asOf });
    },
  };
}

// Finds tenants whose model is missing or out of date and rebuilds them, at
// most `limit` per call. Safe to run on every server: rebuilds are serialised
// per tenant and a tenant that is already fresh is skipped.
async function sweepStale(pool, { asOf, limit = 50 } = {}) {
  const day = receivables.asOfDay(asOf);
  const r = await pool.query(
    `WITH src AS (
       SELECT user_id, ${receivables.FINGERPRINT} AS fp, count(*)::bigint AS n
         FROM invoices WHERE user_id IS NOT NULL GROUP BY user_id
     )
     SELECT COALESCE(src.user_id, s.user_id)::text AS user_id
       FROM src
       FULL JOIN (SELECT * FROM rm_refresh_state WHERE model = $1) s ON s.user_id = src.user_id
      WHERE s.user_id IS NULL
         OR src.user_id IS NULL AND s.source_rows > 0
         OR s.as_of <> $2::date
         OR s.source_rows <> COALESCE(src.n, 0)
         OR s.source_fingerprint IS DISTINCT FROM COALESCE(src.fp, '0')
      LIMIT $3`,
    [receivables.MODEL, day, Math.max(1, Math.min(Number(limit) || 50, 1000))]
  );
  let rebuilt = 0;
  const failed = [];
  for (const { user_id: userId } of r.rows) {
    try {
      await withTenant(userId, (db) => receivables.refreshReceivables(db, { asOf: day }), { pool, timeoutMs: 60000 });
      rebuilt += 1;
    } catch (err) {
      failed.push({ userId, error: err.message });
    }
  }
  return { candidates: r.rows.length, rebuilt, failed };
}

module.exports = { receivables, ensureFresh, getReceivables, receivablesConsumer, sweepStale };
