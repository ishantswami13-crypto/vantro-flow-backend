// FILE: lib/domain/decisions/dates.js
// Business-date handling for the decision engine.
//
// invoices.invoice_date / due_date / payment_date are TEXT columns filled by
// CSV, Excel, Tally and manual entry, so they arrive as YYYY-MM-DD,
// DD/MM/YYYY, DD-MM-YYYY or full ISO timestamps. Everything here works on
// whole calendar days in UTC so day counts never drift with the server's
// timezone. An unparseable date returns null; callers must treat that as
// unknown, never as "today".

const DAY_MS = 86400000;

function parseBusinessDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  }
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return validUtc(+m[1], +m[2], +m[3]);
  // Indian convention: day first.
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return validUtc(+m[3], +m[2], +m[1]);
  return null;
}

function validUtc(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t;
}

// Whole days from a to b (b - a). Both are UTC-midnight epoch ms.
function daysBetween(a, b) {
  if (a == null || b == null) return null;
  return Math.round((b - a) / DAY_MS);
}

function toIsoDate(t) {
  if (t == null) return null;
  return new Date(t).toISOString().slice(0, 10);
}

function startOfUtcDay(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function addDays(t, n) {
  return t + n * DAY_MS;
}

// The calendar day of a Postgres DATE column as read through node-pg.
// node-pg builds a DATE as a JS Date at LOCAL midnight, so toISOString()
// gives the previous day on a server east of UTC (India) — read it with the
// local getters instead. Strings (PostgREST, ::text casts) pass through.
// Only for DATE columns: a TIMESTAMPTZ is an instant and keeps its UTC day.
function pgDateDay(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

module.exports = { DAY_MS, parseBusinessDate, daysBetween, toIsoDate, startOfUtcDay, addDays, pgDateDay };
