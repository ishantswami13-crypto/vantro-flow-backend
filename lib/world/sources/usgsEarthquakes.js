// FILE: lib/world/sources/usgsEarthquakes.js
// USGS Earthquake feed — free, structured, no API key. Real live fetch,
// confirmed working in this environment (see ingestion test output).
// Docs: https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php
const { safeLog } = require('../../observability/logger');
const { ensureSource, recordSuccess, recordFailure, upsertCheckpoint } = require('../sourceRegistry');
const { upsertRawRecord, markRawRecord } = require('../dedup');
const { upsertCanonicalEvent } = require('../events');
const { upsertCountry, upsertEntity, linkEventEntity } = require('../entities');

const FEED_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_month.geojson';

const SOURCE_DEF = {
  provider: 'USGS',
  dataset: 'significant_earthquakes_month',
  authorityType: 'government_agency',
  homepageUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php',
  licenseNotes: 'Public domain (US Government work). Usage per USGS terms.',
  updateCadence: 'every 5 minutes (feed), significant-event definition per USGS',
  geographicCoverage: 'global',
  historicalCoverageNotes: 'Rolling 30-day window of "significant" magnitude earthquakes',
  dataCategory: 'NATURAL_HAZARD',
  reliabilityTier: 'authoritative',
};

async function fetchRaw() {
  const res = await fetch(FEED_URL, { headers: { 'User-Agent': 'starlane-world-intelligence/1.0' } });
  if (!res.ok) throw new Error(`USGS feed HTTP ${res.status}`);
  const json = await res.json();
  return json.features || [];
}

// Best-effort country guess from GeoJSON place string, e.g. "10km SW of Ridgecrest, CA"
// or "Fiji region" — a heuristic, not authoritative geocoding. Falls back to
// null (no country entity linked) rather than guessing wrong.
function guessCountryFromPlace(place) {
  if (!place) return null;
  const map = {
    ', CA': 'US', ', AK': 'US', ', NV': 'US', ', HI': 'US', ', WA': 'US', ', OR': 'US',
    'Japan': 'JP', 'Indonesia': 'ID', 'Philippines': 'PH', 'Chile': 'CL', 'Mexico': 'MX',
    'Peru': 'PE', 'Fiji': 'FJ', 'Tonga': 'TO', 'New Zealand': 'NZ', 'Papua New Guinea': 'PG',
    'Alaska': 'US', 'California': 'US', 'Turkey': 'TR', 'Greece': 'GR', 'Italy': 'IT',
    'Iran': 'IR', 'Afghanistan': 'AF', 'Pakistan': 'PK', 'India': 'IN', 'China': 'CN',
    'Taiwan': 'TW', 'Russia': 'RU', 'Ecuador': 'EC', 'Colombia': 'CO', 'Vanuatu': 'VU',
    'Solomon Islands': 'SB', 'Nicaragua': 'NI', 'Guatemala': 'GT', 'Costa Rica': 'CR',
  };
  for (const [needle, code] of Object.entries(map)) {
    if (place.includes(needle)) return code;
  }
  return null;
}

function magnitudeToSeverity(mag) {
  if (mag == null) return null;
  if (mag >= 7) return 'critical';
  if (mag >= 6) return 'severe';
  if (mag >= 5) return 'high';
  if (mag >= 4) return 'moderate';
  return 'low';
}

function normalizeFeature(feature) {
  const p = feature.properties || {};
  const geom = feature.geometry || {};
  const [lon, lat] = geom.coordinates || [null, null];
  const observedAt = p.time ? new Date(p.time).toISOString() : null;
  const updatedAt = p.updated ? new Date(p.updated).toISOString() : null;
  const countryCode = guessCountryFromPlace(p.place);
  return {
    sourceExternalId: feature.id,
    eventType: 'NATURAL_HAZARD',
    eventSubtype: 'earthquake',
    title: p.title || `M ${p.mag} - ${p.place}`,
    summary: p.place || null,
    observedAt,
    publishedAt: updatedAt,
    sourcePublishedAt: updatedAt,
    countryCodes: countryCode ? [countryCode] : [],
    regionCodes: [],
    latitude: lat,
    longitude: lon,
    sourceUrl: p.url || null,
    confidence: p.status === 'reviewed' ? 0.95 : 0.75,
    truthState: 'OBSERVED',
    severity: magnitudeToSeverity(p.mag),
    magnitude: p.mag ?? null,
    magnitudeUnit: p.magType ? `richter_${p.magType}` : 'richter',
    status: 'active',
    countryCode,
  };
}

async function ingest() {
  const sourceId = await ensureSource(SOURCE_DEF);
  const stats = { fetched: 0, normalized: 0, parseFailed: 0, duplicateSkipped: 0, revised: 0 };
  try {
    const features = await fetchRaw();
    stats.fetched = features.length;
    for (const feature of features) {
      try {
        const raw = await upsertRawRecord(sourceId, feature.id, feature);
        if (!raw.isNew && raw.parseStatus === 'normalized') {
          stats.duplicateSkipped++;
          continue;
        }
        const norm = normalizeFeature(feature);
        if (!norm.title || !norm.observedAt) {
          await markRawRecord(raw.id, { parseStatus: 'parse_failed', parseError: 'missing title/observedAt' });
          stats.parseFailed++;
          continue;
        }
        const { id: eventId, isNew, revisedFields } = await upsertCanonicalEvent({ ...norm, sourceId, rawRecordId: raw.id });
        if (!isNew && revisedFields.length > 0) stats.revised++;
        await markRawRecord(raw.id, { parseStatus: 'normalized', canonicalEventId: eventId });

        if (norm.countryCode) {
          const countryEntityId = await upsertCountry(norm.countryCode);
          await linkEventEntity(eventId, countryEntityId, 'AFFECTS');
        }
        const hazardEntityId = await upsertEntity({ entityType: 'NATURAL_HAZARD', code: null, name: 'Earthquake', attributes: { kind: 'earthquake' } });
        await linkEventEntity(eventId, hazardEntityId, 'INVOLVES');

        stats.normalized++;
      } catch (innerErr) {
        stats.parseFailed++;
        safeLog('error', '[USGS] Failed to process feature', { error: innerErr.message, featureId: feature.id });
      }
    }
    await recordSuccess(sourceId);
    await upsertCheckpoint(sourceId, { cursorValue: new Date().toISOString(), status: 'succeeded', recordsProcessed: stats.normalized });
    safeLog('info', '[USGS] Ingestion complete', stats);
    return { sourceId, stats };
  } catch (err) {
    await recordFailure(sourceId, err.message);
    await upsertCheckpoint(sourceId, { status: 'failed', lastError: err.message, recordsProcessed: 0 });
    safeLog('error', '[USGS] Ingestion failed', { error: err.message });
    throw err;
  }
}

module.exports = { ingest, fetchRaw, normalizeFeature, guessCountryFromPlace, magnitudeToSeverity, SOURCE_DEF, FEED_URL };
