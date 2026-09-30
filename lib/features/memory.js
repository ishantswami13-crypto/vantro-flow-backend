'use strict';
// lib/features/memory.js — MEMORY: what Starlane has learned about the
// business, where it came from, and whether the owner agrees.
//
// Status
//   inferred   derived from records by a stated method; may be wrong
//   confirmed  the owner said it is right (the statement is kept as is)
//   corrected  the owner replaced the statement with their own
//   removed    the owner said forget it; never re-inferred
// Staleness: an inferred record is stale after STALE_DAYS without being
// re-derived, or when the data behind it changed after the owner confirmed
// it (value.latest differs) — shown, never silently overwritten.
//
// infer() is pure. What it infers today, and only when the data supports it:
//   payment_timing (per customer): from >= MIN_PAID paid invoices with both a
//     due date and a payment date — the median days paid after the due date.
// Missions add mission_result records when they close (see routes/features).

const { customerKey, n } = require('./core');

const STALE_DAYS = 30;
const MIN_PAID = 3;

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function timingStatement(name, med, count) {
  if (med <= 0) return `${name} usually pays on or before the due date (median of ${count} paid invoices).`;
  return `${name} usually pays about ${med} day${med === 1 ? '' : 's'} after the due date (median of ${count} paid invoices).`;
}

function infer({ paidInvoices }) {
  const groups = new Map();
  for (const p of paidInvoices) {
    const due = Date.parse(p.due_date), pay = Date.parse(p.payment_date);
    if (!Number.isFinite(due) || !Number.isFinite(pay)) continue;
    const k = customerKey(p.customer_name);
    if (!k) continue;
    const g = groups.get(k) || { label: p.customer_name, ids: [], lates: [] };
    g.ids.push(String(p.id)); g.lates.push(Math.round((pay - due) / 86400000));
    groups.set(k, g);
  }
  const out = [];
  for (const [k, g] of groups) {
    if (g.lates.length < MIN_PAID) continue;
    const med = median(g.lates);
    out.push({
      subject_type: 'customer', subject_key: k, subject_label: g.label, topic: 'payment_timing',
      statement: timingStatement(g.label, med, g.lates.length),
      value: { medianDaysLate: med, sample: g.lates.length, min: Math.min(...g.lates), max: Math.max(...g.lates) },
      provenance: { source: 'your_books', table: 'invoices', ids: g.ids.slice(0, 50), method: 'Median of (payment date − due date) over paid invoices', sampleSize: g.lates.length },
    });
  }
  return out;
}

async function refresh(pool, userId) {
  const paid = (await pool.query(
    `SELECT id, customer_name, due_date, payment_date FROM invoices
      WHERE user_id = $1 AND payment_status IN ('Paid','paid','PAID') AND due_date IS NOT NULL AND payment_date IS NOT NULL
      ORDER BY updated_at DESC NULLS LAST LIMIT 5000`, [userId]).catch(() => ({ rows: null }))).rows;
  if (!paid) return { inferred: 0, partial: true };
  const recs = infer({ paidInvoices: paid });
  // One set-based upsert per 500 records. Inferred rows are refreshed;
  // confirmed/corrected keep the owner's words but record the latest value so
  // a change can be shown; removed stays removed.
  for (let i = 0; i < recs.length; i += 500) {
    await pool.query(
      `INSERT INTO memory_records (user_id, subject_type, subject_key, subject_label, topic, statement, value, status, provenance, observed_at, stale_after)
       SELECT $1, r.subject_type, r.subject_key, r.subject_label, r.topic, r.statement, r.value, 'inferred', r.provenance, now(), now() + interval '${STALE_DAYS} days'
         FROM jsonb_to_recordset($2::jsonb) AS r(subject_type text, subject_key text, subject_label text, topic text, statement text, value jsonb, provenance jsonb)
       ON CONFLICT (user_id, subject_type, subject_key, topic) DO UPDATE SET
         statement   = CASE WHEN memory_records.status = 'inferred' THEN EXCLUDED.statement ELSE memory_records.statement END,
         value       = CASE WHEN memory_records.status = 'inferred' THEN EXCLUDED.value
                            ELSE COALESCE(memory_records.value, '{}'::jsonb) || jsonb_build_object('latest', EXCLUDED.value) END,
         provenance  = CASE WHEN memory_records.status = 'removed' THEN memory_records.provenance ELSE EXCLUDED.provenance END,
         observed_at = CASE WHEN memory_records.status = 'removed' THEN memory_records.observed_at ELSE now() END,
         stale_after = CASE WHEN memory_records.status = 'removed' THEN memory_records.stale_after ELSE EXCLUDED.stale_after END,
         updated_at  = now()`,
      [userId, JSON.stringify(recs.slice(i, i + 500))]);
  }
  return { inferred: recs.length, partial: false };
}

function shape(r, now = Date.now()) {
  const v = r.value || {};
  const changed = r.status !== 'inferred' && v.latest && r.topic === 'payment_timing' && n(v.latest.medianDaysLate) !== n(v.medianDaysLate ?? v.latest.medianDaysLate);
  const stale = r.status === 'inferred' && r.stale_after && Date.parse(r.stale_after) < now;
  return {
    id: r.id, subject: { type: r.subject_type, key: r.subject_key, label: r.subject_label }, topic: r.topic,
    statement: r.statement, value: r.value, status: r.status, provenance: r.provenance,
    observedAt: r.observed_at, decidedAt: r.decided_at, updatedAt: r.updated_at,
    freshness: stale ? 'stale' : changed ? 'changed_since_confirmed' : 'current',
  };
}

module.exports = { infer, refresh, shape, STALE_DAYS, MIN_PAID, median };
