'use strict';
// lib/data/readModels/receivables.js — L3 read model: open receivables per
// tenant and per customer, with ageing buckets (migration 092).
//
// Correctness first: readers check the model's watermark against invoices and
// rebuild the tenant's rows before answering if anything changed, so a reader
// never sees stale numbers even when no background refresh is running. The
// event consumer and the sweep only make that rebuild happen ahead of time.
//
// Definitions (match the rest of the codebase):
//   settled      payment_status is Paid / Cancelled / Void / Written off (any case)
//   open amount  invoice_amount - payment_amount, never below 0, for unsettled rows
//   overdue      due_date before the as-of date (default: today in
//                BUSINESS_TIMEZONE, Asia/Kolkata unless set)
//   ageing       days past due: current (not yet due or no due date), 1-30,
//                31-60, 61-90, 90+
//   currency     upper-cased; '' means the account's base currency (no currency set)
// Amounts in different currencies are never added together.

const MODEL = 'receivables';
const SETTLED = ['paid', 'cancelled', 'canceled', 'void', 'written_off', 'written off'];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

// The owner's calendar day, not UTC's: before 05:30 IST the UTC date is still
// yesterday, which would age invoices a day late and file the day's receivables
// snapshot under the wrong date. Same rule as businessToday() in server.js;
// BUSINESS_TIMEZONE overrides the default for non-Indian tenants.
function businessToday(now = new Date(), tz = process.env.BUSINESS_TIMEZONE || 'Asia/Kolkata') {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now); } catch { return now.toISOString().slice(0, 10); }
}

function asOfDay(asOf) {
  const d = asOf || businessToday();
  if (!ISO_DAY.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) throw new TypeError(`receivables: asOf must be YYYY-MM-DD, got "${asOf}"`);
  return d;
}

function requireTenant(db) {
  if (!db || typeof db.query !== 'function' || !db.userId) {
    throw new TypeError('receivables: pass the tenant handle from withTenant() as the first argument');
  }
  return db.userId;
}

const OPEN_INVOICES = `
  WITH inv AS (
    SELECT COALESCE(customer_id::text, 'name:' || lower(btrim(customer_name))) AS customer_key,
           customer_id, btrim(customer_name) AS customer_name,
           COALESCE(upper(NULLIF(btrim(currency), '')), '') AS currency,
           GREATEST(COALESCE(invoice_amount, 0) - COALESCE(payment_amount, 0), 0) AS open_amt,
           starlane_try_date(due_date) AS due,
           starlane_try_date(payment_date) AS paid_on,
           lower(btrim(COALESCE(payment_status, ''))) AS status
      FROM invoices
     WHERE user_id = $1
  ),
  paid AS (
    SELECT customer_key, currency, max(paid_on) AS last_paid FROM inv GROUP BY customer_key, currency
  ),
  open_inv AS (
    SELECT inv.*, CASE WHEN due IS NULL THEN 0 ELSE GREATEST($2::date - due, 0) END AS dpd
      FROM inv
     WHERE status <> ALL($3::text[]) AND open_amt > 0
  )`;

const BUCKETS = `
  sum(open_amt) AS open_amount,
  COALESCE(sum(open_amt) FILTER (WHERE dpd > 0), 0) AS overdue_amount,
  COALESCE(sum(open_amt) FILTER (WHERE dpd = 0), 0) AS bucket_current,
  COALESCE(sum(open_amt) FILTER (WHERE dpd BETWEEN 1 AND 30), 0) AS bucket_1_30,
  COALESCE(sum(open_amt) FILTER (WHERE dpd BETWEEN 31 AND 60), 0) AS bucket_31_60,
  COALESCE(sum(open_amt) FILTER (WHERE dpd BETWEEN 61 AND 90), 0) AS bucket_61_90,
  COALESCE(sum(open_amt) FILTER (WHERE dpd > 90), 0) AS bucket_90_plus,
  count(*)::int AS open_invoices,
  (count(*) FILTER (WHERE dpd > 0))::int AS overdue_invoices`;

// Changes whenever any of the tenant's invoice rows is inserted, updated or
// deleted: an order-independent sum of md5(id, xmin) per row. updated_at alone
// is not enough, because many writers do not set it and invoices has no
// trigger for it.
const FINGERPRINT = "COALESCE(sum(('x' || substr(md5(id::text || ':' || xmin::text), 1, 8))::bit(32)::bigint), 0)::text";

async function sourceWatermark(db) {
  const r = await db.query(`SELECT ${FINGERPRINT} AS fp, count(*)::bigint AS n FROM invoices WHERE user_id = $1`, [requireTenant(db)]);
  return { fingerprint: r.rows[0].fp, rows: String(r.rows[0].n) };
}

// Rebuild this tenant's rows from invoices. Serialised per tenant with an
// advisory lock so two servers refreshing at once cannot collide.
async function refreshReceivables(db, { asOf } = {}) {
  const tenant = requireTenant(db);
  const day = asOfDay(asOf);
  const started = Date.now();
  await db.query("SELECT pg_advisory_xact_lock(hashtext('rm:receivables'), hashtext($1))", [tenant]);
  const mark = await sourceWatermark(db);
  await db.query('DELETE FROM rm_receivables_customer WHERE user_id = $1', [tenant]);
  await db.query('DELETE FROM rm_receivables_tenant WHERE user_id = $1', [tenant]);
  const params = [tenant, day, SETTLED];
  const customers = await db.query(
    `${OPEN_INVOICES}
     INSERT INTO rm_receivables_customer
       (user_id, customer_key, currency, customer_id, customer_name, open_amount, overdue_amount,
        bucket_current, bucket_1_30, bucket_31_60, bucket_61_90, bucket_90_plus,
        open_invoices, overdue_invoices, oldest_due_date, max_days_overdue, last_payment_date, as_of)
     SELECT $1, o.customer_key, o.currency, (array_agg(o.customer_id) FILTER (WHERE o.customer_id IS NOT NULL))[1],
            min(o.customer_name),
            sum(open_amt), COALESCE(sum(open_amt) FILTER (WHERE dpd > 0), 0),
            COALESCE(sum(open_amt) FILTER (WHERE dpd = 0), 0),
            COALESCE(sum(open_amt) FILTER (WHERE dpd BETWEEN 1 AND 30), 0),
            COALESCE(sum(open_amt) FILTER (WHERE dpd BETWEEN 31 AND 60), 0),
            COALESCE(sum(open_amt) FILTER (WHERE dpd BETWEEN 61 AND 90), 0),
            COALESCE(sum(open_amt) FILTER (WHERE dpd > 90), 0),
            count(*)::int, (count(*) FILTER (WHERE dpd > 0))::int,
            min(due), max(dpd)::int, max(p.last_paid), $2::date
       FROM open_inv o
       JOIN paid p ON p.customer_key = o.customer_key AND p.currency = o.currency
      GROUP BY o.customer_key, o.currency`,
    params
  );
  await db.query(
    `${OPEN_INVOICES}
     INSERT INTO rm_receivables_tenant
       (user_id, currency, open_amount, overdue_amount, bucket_current, bucket_1_30, bucket_31_60, bucket_61_90, bucket_90_plus,
        open_invoices, overdue_invoices, customers_open, customers_overdue, undated_invoices, as_of)
     SELECT $1, currency, ${BUCKETS},
            count(DISTINCT customer_key)::int,
            (count(DISTINCT customer_key) FILTER (WHERE dpd > 0))::int,
            (count(*) FILTER (WHERE due IS NULL))::int,
            $2::date
       FROM open_inv
      GROUP BY currency`,
    params
  );
  const ms = Date.now() - started;
  await db.query(
    `INSERT INTO rm_refresh_state (user_id, model, source_fingerprint, source_rows, as_of, refreshed_at, duration_ms)
     VALUES ($1, $2, $3, $4, $5, now(), $6)
     ON CONFLICT (user_id, model) DO UPDATE
       SET source_fingerprint = EXCLUDED.source_fingerprint, source_rows = EXCLUDED.source_rows,
           as_of = EXCLUDED.as_of, refreshed_at = EXCLUDED.refreshed_at, duration_ms = EXCLUDED.duration_ms`,
    [tenant, MODEL, mark.fingerprint, mark.rows, day, ms]
  );
  return { customers: customers.rowCount, asOf: day, durationMs: ms };
}

// True when the rows no longer match invoices or the as-of day has moved on.
async function isStale(db, { asOf } = {}) {
  const tenant = requireTenant(db);
  const day = asOfDay(asOf);
  const state = await db.query('SELECT source_fingerprint, source_rows::text AS source_rows, as_of::text AS as_of FROM rm_refresh_state WHERE user_id = $1 AND model = $2', [tenant, MODEL]);
  const mark = await sourceWatermark(db);
  const s = state.rows[0];
  if (!s) return true;
  if (s.as_of !== day) return true;
  if (s.source_rows !== mark.rows) return true;
  return s.source_fingerprint !== mark.fingerprint;
}

const num = (v) => (v === null || v === undefined ? 0 : Number(v));
function shapeAmounts(r) {
  return {
    currency: r.currency || null,
    openAmount: num(r.open_amount),
    overdueAmount: num(r.overdue_amount),
    ageing: {
      current: num(r.bucket_current), d1_30: num(r.bucket_1_30), d31_60: num(r.bucket_31_60),
      d61_90: num(r.bucket_61_90), d90Plus: num(r.bucket_90_plus),
    },
    openInvoices: r.open_invoices,
    overdueInvoices: r.overdue_invoices,
  };
}

async function readSummary(db) {
  const tenant = requireTenant(db);
  const rows = await db.query('SELECT * FROM rm_receivables_tenant WHERE user_id = $1 ORDER BY open_amount DESC', [tenant]);
  const state = await db.query('SELECT as_of::text AS as_of, refreshed_at, duration_ms FROM rm_refresh_state WHERE user_id = $1 AND model = $2', [tenant, MODEL]);
  const s = state.rows[0] || null;
  return {
    asOf: s ? s.as_of : null,
    refreshedAt: s ? s.refreshed_at : null,
    byCurrency: rows.rows.map((r) => ({
      ...shapeAmounts(r),
      customersOpen: r.customers_open,
      customersOverdue: r.customers_overdue,
      undatedInvoices: r.undated_invoices,
    })),
  };
}

const SORTS = {
  overdue: 'overdue_amount DESC, open_amount DESC',
  open: 'open_amount DESC, overdue_amount DESC',
  age: 'max_days_overdue DESC, overdue_amount DESC',
  name: 'customer_name ASC',
};

async function readCustomers(db, { currency, sort = 'overdue', limit = 50, offset = 0 } = {}) {
  const tenant = requireTenant(db);
  const order = SORTS[sort];
  if (!order) throw new TypeError(`receivables: sort must be one of ${Object.keys(SORTS).join(', ')}`);
  const n = Math.min(Math.max(1, Math.floor(Number(limit)) || 50), 500);
  const skip = Math.max(0, Math.floor(Number(offset)) || 0);
  const params = [tenant, n, skip];
  let filter = '';
  if (currency !== undefined && currency !== null) { params.push(String(currency).toUpperCase()); filter = ' AND currency = $4'; }
  const r = await db.query(
    `SELECT *, oldest_due_date::text AS oldest_due, last_payment_date::text AS last_paid, count(*) OVER ()::int AS total
       FROM rm_receivables_customer
      WHERE user_id = $1${filter} ORDER BY ${order}, customer_key LIMIT $2 OFFSET $3`,
    params
  );
  return {
    total: r.rows.length ? r.rows[0].total : 0,
    customers: r.rows.map((row) => ({
      customerKey: row.customer_key,
      customerId: row.customer_id,
      name: row.customer_name,
      ...shapeAmounts(row),
      // Dates go out as the stored YYYY-MM-DD text: node-pg turns a DATE into a
      // local-midnight Date, which shifts a day on servers east of UTC.
      oldestDueDate: row.oldest_due,
      maxDaysOverdue: row.max_days_overdue,
      lastPaymentDate: row.last_paid,
    })),
  };
}

module.exports = { sourceWatermark, FINGERPRINT, MODEL, SETTLED, refreshReceivables, isStale, readSummary, readCustomers, asOfDay, utcToday, businessToday, SORTS };
