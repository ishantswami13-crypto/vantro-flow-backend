'use strict';
// lib/domain/outbound/localTime.js
// Recipient-local sending windows and the market rotation.
//
// Every contact needs a timezone. It is either stored on the contact or
// derived from its country, but only for countries with a single civil
// timezone; for the US, Canada, Australia, Brazil, Russia, Mexico and
// similar, a country alone is not enough and the contact stays ineligible
// until a timezone is set. Nothing is ever sent at a guessed local hour.

const SINGLE_TZ_COUNTRIES = {
  IN: 'Asia/Kolkata', GB: 'Europe/London', IE: 'Europe/Dublin', DE: 'Europe/Berlin', FR: 'Europe/Paris', NL: 'Europe/Amsterdam',
  BE: 'Europe/Brussels', IT: 'Europe/Rome', ES: 'Europe/Madrid', CH: 'Europe/Zurich', AT: 'Europe/Vienna', SE: 'Europe/Stockholm',
  NO: 'Europe/Oslo', DK: 'Europe/Copenhagen', FI: 'Europe/Helsinki', PL: 'Europe/Warsaw', CZ: 'Europe/Prague', PT: 'Europe/Lisbon',
  AE: 'Asia/Dubai', SA: 'Asia/Riyadh', QA: 'Asia/Qatar', KW: 'Asia/Kuwait', BH: 'Asia/Bahrain', OM: 'Asia/Muscat', IL: 'Asia/Jerusalem',
  TR: 'Europe/Istanbul', EG: 'Africa/Cairo', SG: 'Asia/Singapore', MY: 'Asia/Kuala_Lumpur', TH: 'Asia/Bangkok', VN: 'Asia/Ho_Chi_Minh',
  PH: 'Asia/Manila', JP: 'Asia/Tokyo', KR: 'Asia/Seoul', CN: 'Asia/Shanghai', HK: 'Asia/Hong_Kong', TW: 'Asia/Taipei', BD: 'Asia/Dhaka',
  LK: 'Asia/Colombo', PK: 'Asia/Karachi', NP: 'Asia/Kathmandu', NZ: 'Pacific/Auckland', ZA: 'Africa/Johannesburg', KE: 'Africa/Nairobi',
  NG: 'Africa/Lagos',
};

const REGIONS = [
  { key: 'INDIA_APAC', label: 'India / APAC', test: (tz) => /^(Asia\/(Kolkata|Calcutta|Singapore|Kuala_Lumpur|Bangkok|Ho_Chi_Minh|Manila|Tokyo|Seoul|Shanghai|Hong_Kong|Taipei|Dhaka|Colombo|Karachi|Kathmandu|Jakarta)|Australia\/|Pacific\/Auckland)/.test(tz) },
  { key: 'MIDDLE_EAST', label: 'Middle East', test: (tz) => /^(Asia\/(Dubai|Riyadh|Qatar|Kuwait|Bahrain|Muscat|Jerusalem|Tehran|Baghdad)|Africa\/Cairo|Europe\/Istanbul)/.test(tz) },
  { key: 'EUROPE_UK', label: 'Europe / UK', test: (tz) => /^Europe\//.test(tz) || /^Africa\/(Johannesburg|Lagos|Nairobi)/.test(tz) },
  { key: 'NA_EAST', label: 'North America East', test: (tz) => /^America\/(New_York|Toronto|Detroit|Montreal|Indiana|Kentucky)/.test(tz) || tz === 'US/Eastern' },
  { key: 'NA_CENTRAL', label: 'Central', test: (tz) => /^America\/(Chicago|Winnipeg|Mexico_City|Monterrey)/.test(tz) || tz === 'US/Central' },
  { key: 'NA_MOUNTAIN', label: 'Mountain', test: (tz) => /^America\/(Denver|Edmonton|Phoenix|Boise)/.test(tz) || tz === 'US/Mountain' },
  { key: 'NA_PACIFIC', label: 'Pacific', test: (tz) => /^America\/(Los_Angeles|Vancouver|Tijuana)/.test(tz) || tz === 'US/Pacific' },
];

function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function resolveTimeZone({ timezone, country }) {
  if (timezone && isValidTimeZone(timezone)) return { tz: timezone, derived: false };
  const cc = String(country || '').trim().toUpperCase();
  if (SINGLE_TZ_COUNTRIES[cc]) return { tz: SINGLE_TZ_COUNTRIES[cc], derived: true };
  return { tz: null, derived: false };
}

function regionOf(tz) {
  const r = REGIONS.find((x) => x.test(tz || ''));
  return r ? { key: r.key, label: r.label } : { key: 'OTHER', label: 'Other' };
}

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Local wall-clock parts of an instant in a timezone.
function localParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { weekday: WD[p.weekday], minutes: Number(p.hour) * 60 + Number(p.minute), date: `${p.year}-${p.month}-${p.day}` };
}

function parseHm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v <= 24 * 60 ? v : null;
}

function normalizeWindow(w) {
  const win = w || {};
  const days = Array.isArray(win.days) && win.days.length ? win.days.map(Number).filter((d) => d >= 0 && d <= 6) : [1, 2, 3, 4, 5];
  const start = parseHm(win.start) ?? 9 * 60;
  const end = parseHm(win.end) ?? 17 * 60;
  if (end <= start) throw Object.assign(new Error('send window end must be after start'), { status: 400 });
  return { days, start, end };
}

function inWindow(date, tz, window) {
  if (!tz) return false;
  const w = normalizeWindow(window);
  const lp = localParts(date, tz);
  return w.days.includes(lp.weekday) && lp.minutes >= w.start && lp.minutes < w.end;
}

/**
 * Earliest instant >= `from` that falls inside the window, searched at
 * 5-minute resolution for up to 8 days (DST-safe because every candidate is
 * re-checked in the recipient's zone). Returns null if none.
 */
function nextWindowStart(from, tz, window) {
  if (!tz) return null;
  const step = 5 * 60 * 1000;
  let t = Math.ceil(from.getTime() / step) * step;
  if (inWindow(from, tz, window)) return new Date(from.getTime());
  const limit = from.getTime() + 8 * 86400000;
  while (t <= limit) {
    if (inWindow(new Date(t), tz, window)) return new Date(t);
    t += step;
  }
  return null;
}

// Minutes of window left at `date` (0 when outside).
function minutesLeftInWindow(date, tz, window) {
  if (!inWindow(date, tz, window)) return 0;
  const w = normalizeWindow(window);
  return w.end - localParts(date, tz).minutes;
}

module.exports = { SINGLE_TZ_COUNTRIES, REGIONS, isValidTimeZone, resolveTimeZone, regionOf, localParts, normalizeWindow, inWindow, nextWindowStart, minutesLeftInWindow };
