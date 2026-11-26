'use strict';
// lib/data/analytics — L4: fact tables (migration 093) and a small cube query
// that slices whitelisted measures by whitelisted dimensions.
//
//   refreshAnalytics(userId)   bring fact_invoices up to date and record
//                              today's receivables snapshot
//   queryCube(db, spec)        { fact, measures, by, time, from, to, filters }
//
// Rules the cube enforces:
//   - every statement is scoped to the tenant handle's user id
//   - only names from the FACTS table below reach SQL; values are bound
//   - money is never added across currencies: a money measure always groups by
//     currency, even when the caller did not ask for it
//   - snapshot measures (open, overdue) are not summed over time: each period
//     uses the last snapshot day inside it

const { withTenant, readTenant } = require('../tenantDb');
const receivables = require('../readModels/receivables');
const { ensureFresh } = require('../readModels');

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const GRAINS = ['day', 'week', 'month', 'quarter', 'year'];
const MAX_ROWS = 5000;

const FACTS = {
  invoices: {
    table: 'fact_invoices',
    time: { invoice: 'invoice_date', due: 'due_date', paid: 'paid_date' },
    defaultTime: 'invoice',
    snapshot: false,
    dims: { currency: 'currency', status: 'status_group' },
    measures: {
      count: { sql: 'count(*)::int', money: false },
      invoiced: { sql: 'sum(amount)', money: true },
      collected: { sql: 'sum(paid_amount)', money: true },
      outstanding: { sql: 'sum(open_amount)', money: true },
      avg_days_to_pay: { sql: 'round(avg(days_to_pay)::numeric, 1)', money: false },
      avg_days_late: { sql: 'round(avg(days_late)::numeric, 1)', money: false },
      on_time_rate: { sql: 'round(avg(CASE WHEN days_late IS NULL THEN NULL WHEN days_late = 0 THEN 1 ELSE 0 END)::numeric, 3)', money: false },
    },
  },
  receivables_daily: {
    table: 'fact_receivables_daily',
    time: { snapshot: 'snapshot_date' },
    defaultTime: 'snapshot',
    snapshot: true,
    dims: { currency: 'currency' },
    measures: {
      open_amount: { sql: 'sum(open_amount)', money: true },
      overdue_amount: { sql: 'sum(overdue_amount)', money: true },
      current: { sql: 'sum(bucket_current)', money: true },
      d1_30: { sql: 'sum(bucket_1_30)', money: true },
      d31_60: { sql: 'sum(bucket_31_60)', money: true },
      d61_90: { sql: 'sum(bucket_61_90)', money: true },
      d90_plus: { sql: 'sum(bucket_90_plus)', money: true },
      customers: { sql: 'count(DISTINCT customer_key)::int', money: false },
      overdue_customers: { sql: '(count(DISTINCT customer_key) FILTER (WHERE overdue_amount > 0))::int', money: false },
    },
  },
};

const SETTLED_OTHER = receivables.SETTLED.filter((s) => s !== 'paid');

function requireTenant(db) {
  if (!db || typeof db.query !== 'function' || !db.userId) throw new TypeError('analytics: pass the tenant handle from withTenant()');
  return db.userId;
}

// ── loading ────────────────────────────────────────────────────────────────

async function loadInvoiceFacts(db) {
  const tenant = requireTenant(db);
  await db.query("SELECT pg_advisory_xact_lock(hashtext('fact:invoices'), hashtext($1))", [tenant]);
  await db.query('DELETE FROM fact_invoices WHERE user_id = $1', [tenant]);
  const r = await db.query(
    `WITH inv AS (
       SELECT id, COALESCE(customer_id::text, 'name:' || lower(btrim(customer_name))) AS customer_key,
              btrim(customer_name) AS customer_name,
              COALESCE(upper(NULLIF(btrim(currency), '')), '') AS currency,
              lower(btrim(COALESCE(payment_status, ''))) AS status,
              starlane_try_date(invoice_date) AS invoice_date,
              starlane_try_date(due_date) AS due_date,
              starlane_try_date(payment_date) AS paid_date,
              COALESCE(invoice_amount, 0) AS amount,
              COALESCE(payment_amount, 0) AS paid_amount
         FROM invoices WHERE user_id = $1
     )
     INSERT INTO fact_invoices (user_id, invoice_id, customer_key, customer_name, currency, status_group,
                                invoice_date, due_date, paid_date, amount, paid_amount, open_amount, days_to_pay, days_late)
     SELECT $1, id, customer_key, customer_name, currency,
            CASE WHEN status = 'paid' THEN 'paid' WHEN status = ANY($2::text[]) THEN 'cancelled' ELSE 'open' END,
            invoice_date, due_date, paid_date, amount,
            CASE WHEN status = 'paid' AND paid_amount = 0 THEN amount ELSE paid_amount END,
            CASE WHEN status = 'paid' OR status = ANY($2::text[]) THEN 0 ELSE GREATEST(amount - paid_amount, 0) END,
            CASE WHEN status = 'paid' AND paid_date IS NOT NULL AND invoice_date IS NOT NULL THEN paid_date - invoice_date END,
            CASE WHEN status = 'paid' AND paid_date IS NOT NULL AND due_date IS NOT NULL THEN GREATEST(paid_date - due_date, 0) END
       FROM inv`,
    [tenant, SETTLED_OTHER]
  );
  return r.rowCount;
}

// Copies the tenant's current receivables read model into the day's snapshot.
// The read model must already be fresh for `day` (refreshAnalytics does that).
async function snapshotReceivables(db, day) {
  const tenant = requireTenant(db);
  await db.query('SELECT starlane_ensure_month_partition($1::date)', [day]);
  await db.query('DELETE FROM fact_receivables_daily WHERE user_id = $1 AND snapshot_date = $2', [tenant, day]);
  await db.query('INSERT INTO fact_snapshot_days (user_id, snapshot_date) VALUES ($1, $2) ON CONFLICT DO NOTHING', [tenant, day]);
  const r = await db.query(
    `INSERT INTO fact_receivables_daily (user_id, snapshot_date, customer_key, currency, customer_name, open_amount, overdue_amount,
       bucket_current, bucket_1_30, bucket_31_60, bucket_61_90, bucket_90_plus, open_invoices, overdue_invoices, max_days_overdue)
     SELECT user_id, $2::date, customer_key, currency, customer_name, open_amount, overdue_amount,
            bucket_current, bucket_1_30, bucket_31_60, bucket_61_90, bucket_90_plus, open_invoices, overdue_invoices, max_days_overdue
       FROM rm_receivables_customer WHERE user_id = $1 AND as_of = $2::date`,
    [tenant, day]
  );
  return r.rowCount;
}

async function stateMatches(db, model, day, mark) {
  const r = await db.query(
    'SELECT source_fingerprint, source_rows::text AS source_rows, as_of::text AS as_of FROM rm_refresh_state WHERE user_id = $1 AND model = $2',
    [db.userId, model]
  );
  const s = r.rows[0];
  return !!s && s.as_of === day && s.source_rows === mark.rows && s.source_fingerprint === mark.fingerprint;
}

async function recordState(db, model, day, mark, ms) {
  await db.query(
    `INSERT INTO rm_refresh_state (user_id, model, source_fingerprint, source_rows, as_of, refreshed_at, duration_ms)
     VALUES ($1, $2, $3, $4, $5, now(), $6)
     ON CONFLICT (user_id, model) DO UPDATE SET source_fingerprint = EXCLUDED.source_fingerprint, source_rows = EXCLUDED.source_rows,
       as_of = EXCLUDED.as_of, refreshed_at = EXCLUDED.refreshed_at, duration_ms = EXCLUDED.duration_ms`,
    [db.userId, model, mark.fingerprint, mark.rows, day, ms]
  );
}

// Brings both facts up to date for `asOf` (default: today, UTC). Cheap when
// nothing changed: one fingerprint read per fact.
async function refreshAnalytics(userId, { asOf, pool } = {}) {
  const day = receivables.asOfDay(asOf);
  await ensureFresh(userId, { asOf: day, pool });
  return withTenant(userId, async (db) => {
    const mark = await receivables.sourceWatermark(db);
    const out = { invoices: null, snapshot: null };
    for (const [model, load] of [
      ['fact_invoices', () => loadInvoiceFacts(db)],
      ['fact_receivables_daily', () => snapshotReceivables(db, day)],
    ]) {
      if (await stateMatches(db, model, day, mark)) continue;
      const started = Date.now();
      const n = await load();
      await recordState(db, model, day, mark, Date.now() - started);
      out[model === 'fact_invoices' ? 'invoices' : 'snapshot'] = n;
    }
    return out;
  }, { pool, timeoutMs: 60000 });
}

// ── querying ───────────────────────────────────────────────────────────────

function parseSpec(spec = {}) {
  const fact = FACTS[spec.fact || 'invoices'];
  if (!fact) throw new RangeError(`cube: fact must be one of ${Object.keys(FACTS).join(', ')}`);
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => String(s).trim()).filter(Boolean);
  const measures = list(spec.measures);
  if (!measures.length) throw new RangeError('cube: at least one measure is required');
  if (measures.length > 10) throw new RangeError('cube: at most 10 measures');
  for (const m of measures) if (!fact.measures[m]) throw new RangeError(`cube: unknown measure "${m}" (have ${Object.keys(fact.measures).join(', ')})`);
  const by = list(spec.by);
  if (by.length > 3) throw new RangeError('cube: at most 3 dimensions');
  const grains = by.filter((d) => GRAINS.includes(d));
  if (grains.length > 1) throw new RangeError('cube: only one time grain at a time');
  for (const d of by) if (!GRAINS.includes(d) && d !== 'customer' && !fact.dims[d]) throw new RangeError(`cube: unknown dimension "${d}"`);
  const timeName = spec.time || fact.defaultTime;
  const timeCol = fact.time[timeName];
  if (!timeCol) throw new RangeError(`cube: time must be one of ${Object.keys(fact.time).join(', ')}`);
  for (const k of ['from', 'to']) if (spec[k] !== undefined && !ISO_DAY.test(String(spec[k]))) throw new RangeError(`cube: ${k} must be YYYY-MM-DD`);
  const filters = spec.filters || {};
  for (const k of Object.keys(filters)) if (!['currency', 'customer', 'status'].includes(k)) throw new RangeError(`cube: unknown filter "${k}"`);
  if (filters.status !== undefined && !fact.dims.status) throw new RangeError('cube: this fact has no status');
  const limit = Math.min(Math.max(1, Math.floor(Number(spec.limit)) || 1000), MAX_ROWS);
  return { fact, factName: spec.fact || 'invoices', measures, by, grain: grains[0] || null, timeName, timeCol, from: spec.from, to: spec.to, filters, limit };
}

async function queryCube(db, rawSpec) {
  const tenant = requireTenant(db);
  const s = parseSpec(rawSpec);
  const params = [tenant];
  const bind = (v) => { params.push(v); return `$${params.length}`; };
  const where = ['user_id = $1'];
  if (s.from) where.push(`${s.timeCol} >= ${bind(s.from)}::date`);
  if (s.to) where.push(`${s.timeCol} <= ${bind(s.to)}::date`);
  if (s.filters.currency !== undefined) where.push(`currency = ${bind(String(s.filters.currency).toUpperCase())}`);
  if (s.filters.customer !== undefined) where.push(`customer_key = ${bind(String(s.filters.customer))}`);
  if (s.filters.status !== undefined) where.push(`status_group = ${bind(String(s.filters.status))}`);

  // Money is never added across currencies.
  const by = [...s.by];
  const forcedCurrency = s.measures.some((m) => s.fact.measures[m].money) && !by.includes('currency');
  if (forcedCurrency) by.push('currency');

  const select = [];
  const group = [];
  for (const d of by) {
    if (GRAINS.includes(d)) {
      select.push(`to_char(date_trunc('${d}', ${s.timeCol}), 'YYYY-MM-DD') AS "${d}"`);
      group.push(`date_trunc('${d}', ${s.timeCol})`);
    } else if (d === 'customer') {
      select.push('customer_key AS "customer_key"', 'min(customer_name) AS "customer"');
      group.push('customer_key');
    } else {
      select.push(`${s.fact.dims[d]} AS "${d}"`);
      group.push(s.fact.dims[d]);
    }
  }
  for (const m of s.measures) select.push(`${s.fact.measures[m].sql} AS "${m}"`);

  // Snapshot facts: use the last snapshot day in each period (or in the range).
  // The candidate days come from fact_snapshot_days, not from the fact rows:
  // a customer (or a whole tenant) with nothing open on a day has no rows that
  // day, and must read as zero then, not as its last non-zero day.
  let pick = '';
  if (s.fact.snapshot) {
    const groupPeriod = s.grain ? ` GROUP BY date_trunc('${s.grain}', snapshot_date)` : '';
    const range = ['user_id = $1'];
    if (s.from) range.push(`snapshot_date >= ${bind(s.from)}::date`);
    if (s.to) range.push(`snapshot_date <= ${bind(s.to)}::date`);
    pick = ` AND snapshot_date IN (SELECT max(snapshot_date) FROM fact_snapshot_days WHERE ${range.join(' AND ')}${groupPeriod})`;
  } else if (s.grain) {
    where.push(`${s.timeCol} IS NOT NULL`);
  }
  const order = by.filter((d) => GRAINS.includes(d)).map((d) => `"${d}"`);
  params.push(s.limit + 1);
  const sql = `SELECT ${select.join(', ')}
                 FROM ${s.fact.table}
                WHERE ${where.map((w) => `(${w})`).join(' AND ')}${pick}
                ${group.length ? `GROUP BY ${group.join(', ')}` : ''}
                ORDER BY ${order.length ? `${order.join(', ')}, ` : ''}${s.measures.map((m, i) => `${select.length - s.measures.length + i + 1} DESC NULLS LAST`).join(', ')}
                LIMIT $${params.length}`;
  const r = await db.query(sql, params);
  const rows = r.rows.slice(0, s.limit).map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) out[k] = (s.measures.includes(k) && v !== null) ? Number(v) : v;
    if ('currency' in out) out.currency = out.currency || null;
    return out;
  });
  return {
    fact: s.factName,
    time: s.timeName,
    by,
    measures: s.measures,
    currencyAdded: forcedCurrency,
    rows,
    truncated: r.rows.length > s.limit,
  };
}

async function cube(userId, spec, { pool, asOf } = {}) {
  parseSpec(spec); // reject bad input before doing any work
  await refreshAnalytics(userId, { pool, asOf });
  return readTenant(userId, (db) => queryCube(db, spec), { pool, timeoutMs: 30000 });
}

// Brings analytics up to date for tenants whose receivables model has moved
// on since their facts were built (new day, or invoices changed). Runs from the
// data-layer sweep so history is recorded even on days nobody opens the app.
async function sweepAnalytics(pool, { asOf, limit = 50 } = {}) {
  const day = receivables.asOfDay(asOf);
  const r = await pool.query(
    `SELECT rs.user_id::text AS user_id
       FROM rm_refresh_state rs
      WHERE rs.model = 'receivables'
        AND rs.source_rows > 0
        AND (SELECT count(*) FROM rm_refresh_state f
              WHERE f.user_id = rs.user_id AND f.model = ANY($1)
                AND f.as_of = $2::date AND f.source_fingerprint = rs.source_fingerprint
                AND f.source_rows = rs.source_rows) < 2
      LIMIT $3`,
    [['fact_invoices', 'fact_receivables_daily'], day, Math.max(1, Math.min(Number(limit) || 50, 1000))]
  );
  const failed = [];
  for (const { user_id: userId } of r.rows) {
    try { await refreshAnalytics(userId, { asOf: day, pool }); } catch (err) { failed.push({ userId, error: err.message }); }
  }
  return { candidates: r.rows.length, failed };
}

function describe() {
  return Object.fromEntries(Object.entries(FACTS).map(([name, f]) => [name, {
    time: Object.keys(f.time), dimensions: ['customer', ...Object.keys(f.dims), ...GRAINS], measures: Object.keys(f.measures), snapshot: f.snapshot,
  }]));
}

module.exports = { FACTS, GRAINS, loadInvoiceFacts, snapshotReceivables, refreshAnalytics, sweepAnalytics, queryCube, cube, parseSpec, describe };
