'use strict';
// FILE: lib/domain/operations/decimal.js
// Exact decimal arithmetic for quantities and prices that are stored as
// Postgres NUMERIC. Values are held as BigInt counts of millionths, so
// 0.1 + 0.2 is exactly 0.3 and a received quantity can be compared with an
// ordered quantity without floating-point drift. Six decimal places is more
// than any unit of measure in the import formats this serves (kg to the gram,
// metres to the micron).

const SCALE = 6;
const ONE = 10n ** BigInt(SCALE);
const DEC_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

/** Parses "1,250.5" / 1250.5 / "1250" into millionths. Returns null if unreadable or over 6 dp. */
function toMicro(value) {
  if (value == null) return null;
  if (typeof value === 'bigint') return value * ONE;
  let s = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : String(value).trim();
  if (/e/i.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    s = n.toFixed(SCALE);
  }
  const m = s.match(DEC_RE);
  if (!m) return null;
  const frac = m[3] || '';
  if (frac.length > SCALE && /[1-9]/.test(frac.slice(SCALE))) return null;
  const micro = BigInt(m[2]) * ONE + BigInt((frac.slice(0, SCALE)).padEnd(SCALE, '0') || '0');
  return m[1] ? -micro : micro;
}

/** Millionths back to a plain decimal string ("12", "12.5", "-0.25"). */
function fromMicro(micro) {
  if (micro == null) return null;
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  const whole = abs / ONE;
  const frac = (abs % ONE).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Normalises any accepted input to its canonical decimal string, or null. */
function normalize(value) {
  const m = toMicro(value);
  return m == null ? null : fromMicro(m);
}

module.exports = { SCALE, toMicro, fromMicro, normalize };
