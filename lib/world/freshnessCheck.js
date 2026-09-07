// FILE: lib/world/freshnessCheck.js
// ─────────────────────────────────────────────────────────────────────────
// World Intelligence Backbone — source freshness / silent-outage detection.
//
// GAP THIS CLOSES: usgsEarthquakes.js and fxRates.js both correctly write
// last_successful_ingestion_at (sourceRegistry.recordSuccess) and
// last_failure_at/last_failure_reason (sourceRegistry.recordFailure) on
// every cron run, but nothing ever reads that data back to notice a source
// has gone silent. A multi-day outage of either external API would
// currently produce zero signal. This module is a pure, deterministic
// DB-read + comparison — no LLM, no outbound HTTP, no schema changes.
//
// CADENCE PARSING — why we don't take world_sources.update_cadence at face
// value:
//   `update_cadence` is free text describing the SOURCE's own publish rate
//   (e.g. USGS's SOURCE_DEF says 'every 5 minutes (feed)...', FX's says
//   'daily, ~16:00 CET...'). That is NOT the same as how often *our* cron
//   actually pulls it (server.js schedules USGS hourly at :10, FX daily at
//   17:00 UTC) — the feed refreshing every 5 minutes doesn't mean our
//   ingestion is broken if it's merely an hour old. Parsing "5 minutes"
//   literally and expecting a fresh success every ~10-15 min would false-
//   positive constantly against a healthy hourly cron.
//   To stay deterministic and honest without inventing a second source of
//   truth (e.g. reading server.js's cron strings, which would be fragile
//   string-parsing of a different file), we parse the cadence text into an
//   expected-interval-in-hours using a small keyword table, then CLAMP the
//   result to a floor of 1 hour — 1 hour is this codebase's finest actual
//   cron granularity for any job (verified: no cron.schedule(...) in
//   server.js runs more often than hourly). This keeps sub-hourly source
//   cadences (like USGS's 5-minute feed) from producing a threshold tighter
//   than any cron in this system could ever satisfy, while still treating
//   daily/weekly/monthly cadences literally since those match real cron
//   schedules 1:1.
//
// STALENESS THRESHOLD — 3x the expected cadence, floor 1 hour:
//   A single missed/delayed run (a deploy restart, a slow external API,
//   process downtime of a few minutes) must not trip an alert — that's
//   noise, not a silent outage. 3x cadence is a standard monitoring
//   heuristic that absorbs a couple of missed cycles before treating a gap
//   as a real problem:
//     USGS: floor(1h) cadence -> 3h threshold. Our cron runs hourly, so
//       under normal operation last_successful_ingestion_at is always well
//       under 3h old; 3h absorbs ~2 missed runs before flagging.
//     FX:   24h cadence -> 72h threshold. ECB doesn't publish on weekends,
//       so a legitimate Friday-evening success to Monday-evening success
//       gap can be ~63h. 72h comfortably covers that real gap without
//       false-alarming every weekend, while still catching an actual
//       multi-day outage (>3 days silent).
//
// A source is also flagged if last_failure_at is strictly more recent than
// last_successful_ingestion_at (the most recent attempt failed) AND that
// failure happened within the same staleness window — i.e. we're actively
// failing right now, not just recovering from an old blip.
'use strict';

const { getPool } = require('../db/pg');
const { safeLog } = require('../observability/logger');

const MS_PER_HOUR = 60 * 60 * 1000;
const STALENESS_MULTIPLIER = 3;
const MIN_CADENCE_HOURS = 1; // floor: no cron in this codebase runs more often than hourly
const DEFAULT_CADENCE_HOURS = 24; // conservative fallback when cadence text is unparseable

// Ordered, most-specific-unit-first. Each entry: [regex, hoursPerUnit].
// hoursPerUnit is multiplied by the captured number when present.
const CADENCE_PATTERNS = [
  [/(\d+)\s*minute/i, 1 / 60],
  [/(\d+)\s*hour/i, 1],
  [/(\d+)\s*day/i, 24],
  [/(\d+)\s*week/i, 24 * 7],
  [/(\d+)\s*month/i, 24 * 30],
];

// Bare keyword fallbacks (no explicit number in the text), checked in this
// order so more specific words win before generic ones.
const CADENCE_KEYWORDS = [
  ['minute', 1 / 60],
  ['hourly', 1],
  ['hour', 1],
  ['daily', 24],
  ['day', 24],
  ['weekly', 24 * 7],
  ['week', 24 * 7],
  ['monthly', 24 * 30],
  ['month', 24 * 30],
];

// Parses update_cadence free text into an expected max-interval-in-hours
// between successful ingestions. Never throws; falls back to a documented
// default. Returns { hours, method } for transparency/testability.
function parseCadenceHours(cadenceText) {
  if (typeof cadenceText !== 'string' || !cadenceText.trim()) {
    return { hours: DEFAULT_CADENCE_HOURS, method: 'default_no_text' };
  }
  for (const [pattern, hoursPerUnit] of CADENCE_PATTERNS) {
    const m = cadenceText.match(pattern);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) {
        return { hours: Math.max(n * hoursPerUnit, MIN_CADENCE_HOURS), method: `numeric:${pattern.source}` };
      }
    }
  }
  const lower = cadenceText.toLowerCase();
  for (const [kw, hours] of CADENCE_KEYWORDS) {
    if (lower.includes(kw)) {
      return { hours: Math.max(hours, MIN_CADENCE_HOURS), method: `keyword:${kw}` };
    }
  }
  return { hours: DEFAULT_CADENCE_HOURS, method: 'default_unparseable' };
}

// Pure comparison — no DB access. Exposed for direct unit testing.
function evaluateSourceFreshness(row, now = new Date()) {
  const { hours: cadenceHours } = parseCadenceHours(row.update_cadence);
  const thresholdHours = cadenceHours * STALENESS_MULTIPLIER;
  const lastSuccess = row.last_successful_ingestion_at ? new Date(row.last_successful_ingestion_at) : null;
  const lastFailure = row.last_failure_at ? new Date(row.last_failure_at) : null;

  if (!lastSuccess) {
    return {
      source_id: row.id,
      provider: row.provider,
      dataset: row.dataset,
      status: 'NEVER_SUCCEEDED',
      last_success: null,
      last_failure: lastFailure ? lastFailure.toISOString() : null,
      last_failure_reason: row.last_failure_reason || null,
      staleness_hours: null,
      cadence_hours: cadenceHours,
      threshold_hours: thresholdHours,
    };
  }

  const stalenessHours = (now.getTime() - lastSuccess.getTime()) / MS_PER_HOUR;
  const recentFailureAfterSuccess = !!(lastFailure && lastFailure.getTime() > lastSuccess.getTime()
    && (now.getTime() - lastFailure.getTime()) / MS_PER_HOUR <= thresholdHours);

  const isStale = stalenessHours > thresholdHours || recentFailureAfterSuccess;

  return {
    source_id: row.id,
    provider: row.provider,
    dataset: row.dataset,
    status: isStale ? 'STALE' : 'FRESH',
    last_success: lastSuccess.toISOString(),
    last_failure: lastFailure ? lastFailure.toISOString() : null,
    last_failure_reason: row.last_failure_reason || null,
    staleness_hours: Math.round(stalenessHours * 100) / 100,
    cadence_hours: cadenceHours,
    threshold_hours: thresholdHours,
  };
}

// Queries all world_sources rows and evaluates each for freshness.
// Pure DB read + deterministic comparison — no external calls, no LLM.
// Logs a safeLog('warn', ...) per STALE/NEVER_SUCCEEDED source found.
async function checkSourceFreshness() {
  const pool = getPool();
  const res = await pool.query(
    `SELECT id, provider, dataset, update_cadence, last_successful_ingestion_at,
            last_failure_at, last_failure_reason
     FROM world_sources
     ORDER BY provider, dataset`
  );

  const now = new Date();
  const results = res.rows.map((row) => evaluateSourceFreshness(row, now));

  for (const result of results) {
    if (result.status === 'STALE' || result.status === 'NEVER_SUCCEEDED') {
      safeLog('warn', '[WorldFreshness] Source ingestion is stale or has never succeeded', {
        provider: result.provider,
        dataset: result.dataset,
        status: result.status,
        staleness_hours: result.staleness_hours,
        threshold_hours: result.threshold_hours,
        last_success: result.last_success,
        last_failure: result.last_failure,
      });
    }
  }

  return results;
}

module.exports = {
  checkSourceFreshness,
  evaluateSourceFreshness,
  parseCadenceHours,
  STALENESS_MULTIPLIER,
  MIN_CADENCE_HOURS,
  DEFAULT_CADENCE_HOURS,
};
