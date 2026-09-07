// FILE: lib/world/sources/fxRates.js
// Frankfurter API (wraps ECB reference rates) — free, structured, no API
// key. Real live fetch, confirmed working in this environment.
// Docs: https://www.frankfurter.app/docs/
const { safeLog } = require('../../observability/logger');
const { ensureSource, recordSuccess, recordFailure, upsertCheckpoint } = require('../sourceRegistry');
const { upsertRawRecord, markRawRecord } = require('../dedup');
const { upsertCanonicalEvent } = require('../events');
const { upsertCurrency, linkEventEntity } = require('../entities');

const LATEST_URL = 'https://api.frankfurter.app/latest';

const SOURCE_DEF = {
  provider: 'Frankfurter/ECB',
  dataset: 'ecb_reference_rates_daily',
  authorityType: 'intergovernmental',
  homepageUrl: 'https://www.frankfurter.app/',
  licenseNotes: 'Frankfurter is a free API wrapping the European Central Bank\'s public reference rates.',
  updateCadence: 'daily, ~16:00 CET on ECB business days',
  geographicCoverage: 'EU + major global currencies (base EUR)',
  historicalCoverageNotes: 'Frankfurter supports historical date queries; Phase 1 ingests latest only',
  dataCategory: 'MACROECONOMICS',
  reliabilityTier: 'authoritative',
};

async function fetchRaw() {
  const res = await fetch(LATEST_URL);
  if (!res.ok) throw new Error(`Frankfurter HTTP ${res.status}`);
  return res.json();
}

// One "event" per (date, base, quote) triple — an FX reference rate is a
// state-fact, not a discrete happening, but it fits the world_events shape
// via valid_from/valid_to (see migration 015 header): valid_from = the
// rate's reference date, valid_to = the next expected publication (best-
// effort, left null here since Frankfurter doesn't announce the next date).
function normalizeRatesPayload(payload) {
  const { base, date, rates } = payload;
  const observedAt = date ? new Date(date + 'T16:00:00Z').toISOString() : null;
  return Object.entries(rates || {}).map(([quote, rate]) => ({
    sourceExternalId: `${date}:${base}:${quote}`,
    eventType: 'MACROECONOMICS',
    eventSubtype: 'fx_reference_rate',
    title: `${base}/${quote} reference rate: ${rate}`,
    summary: `ECB/Frankfurter reference rate for ${base} to ${quote} on ${date}`,
    observedAt,
    validFrom: observedAt,
    publishedAt: observedAt,
    sourcePublishedAt: observedAt,
    temporalPrecision: 'day',
    countryCodes: [],
    regionCodes: [],
    confidence: 0.98,
    truthState: 'OBSERVED',
    magnitude: rate,
    magnitudeUnit: `${quote}_per_${base}`,
    status: 'active',
    base,
    quote,
    date,
  }));
}

async function ingest() {
  const sourceId = await ensureSource(SOURCE_DEF);
  const stats = { fetched: 0, normalized: 0, parseFailed: 0, duplicateSkipped: 0, revised: 0 };
  try {
    const payload = await fetchRaw();
    const rows = normalizeRatesPayload(payload);
    stats.fetched = rows.length;
    // One raw record per fetch (the whole payload), not one per currency pair —
    // Frankfurter returns the full rate table atomically per call.
    const rawKey = `${payload.date}:${payload.base}`;
    const raw = await upsertRawRecord(sourceId, rawKey, payload);
    if (!raw.isNew && raw.parseStatus === 'normalized') {
      stats.duplicateSkipped = rows.length;
      await recordSuccess(sourceId);
      return { sourceId, stats };
    }

    const baseEntityId = await upsertCurrency(payload.base);
    let anyFailed = false;
    for (const norm of rows) {
      try {
        if (!norm.title || !norm.observedAt || !Number.isFinite(norm.magnitude)) {
          stats.parseFailed++;
          anyFailed = true;
          continue;
        }
        const { id: eventId, isNew, revisedFields } = await upsertCanonicalEvent({ ...norm, sourceId, rawRecordId: raw.id });
        if (!isNew && revisedFields.length > 0) stats.revised++;
        const quoteEntityId = await upsertCurrency(norm.quote);
        await linkEventEntity(eventId, baseEntityId, 'INVOLVES');
        await linkEventEntity(eventId, quoteEntityId, 'INVOLVES');
        stats.normalized++;
      } catch (innerErr) {
        stats.parseFailed++;
        anyFailed = true;
        safeLog('error', '[FX] Failed to process rate row', { error: innerErr.message, pair: `${norm.base}/${norm.quote}` });
      }
    }
    await markRawRecord(raw.id, { parseStatus: anyFailed && stats.normalized === 0 ? 'parse_failed' : 'normalized' });
    await recordSuccess(sourceId);
    await upsertCheckpoint(sourceId, { cursorValue: payload.date, status: 'succeeded', recordsProcessed: stats.normalized });
    safeLog('info', '[FX] Ingestion complete', stats);
    return { sourceId, stats };
  } catch (err) {
    await recordFailure(sourceId, err.message);
    await upsertCheckpoint(sourceId, { status: 'failed', lastError: err.message, recordsProcessed: 0 });
    safeLog('error', '[FX] Ingestion failed', { error: err.message });
    throw err;
  }
}

module.exports = { ingest, fetchRaw, normalizeRatesPayload, SOURCE_DEF, LATEST_URL };
