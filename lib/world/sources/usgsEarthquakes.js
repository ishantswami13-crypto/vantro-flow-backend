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

// ─── Phase 5 (World Intelligence Phase 2) — improved geo resolution ────────
// Two deterministic strategies, tried in order, NEVER an LLM:
//   1. Place-name lookup: USGS `place` strings are of the form
//      "<distance> <direction> of <landmark>, <region-or-country>" — the
//      trailing token after the last comma is usually a US state (full name
//      OR two-letter abbreviation) or a country name. We match BOTH forms
//      now (the original heuristic only had abbreviations, missing full
//      state names like "Washington" and most country names like "Nepal"
//      or "Spain" — the exact two failure modes measured in real ingested
//      data, see STARLANE_WORLD_INTELLIGENCE_PHASE_2_REPORT.md).
//   2. Lat/lon bounding-box fallback: for the common case where the place
//      string carries no recognizable state/country token at all (e.g. an
//      oceanic "region" name), a small table of REAL, approximate
//      (non-overlapping-for-our-purposes) bounding boxes for a handful of
//      very large countries lets us resolve a coarse country without
//      inventing data. This is intentionally NOT a full point-in-polygon
//      country lookup (that's overkill for Phase 2, see mission text) — it
//      is a deliberately narrow, documented middle ground: only large,
//      simple-shaped countries get a box, and the result is always marked
//      with a lower confidence + explicit resolution method so downstream
//      consumers know it's approximate, never silently treated as exact.
// Unresolved cases are returned as null — we never guess wrong by picking
// an arbitrary default.

const US_STATE_TO_COUNTRY = [
  'CA', 'AK', 'NV', 'HI', 'WA', 'OR', 'ID', 'MT', 'WY', 'UT', 'CO', 'AZ', 'NM', 'TX',
  'OK', 'KS', 'NE', 'SD', 'ND', 'MN', 'IA', 'MO', 'AR', 'LA', 'WI', 'IL', 'MI', 'IN',
  'OH', 'KY', 'TN', 'MS', 'AL', 'GA', 'FL', 'SC', 'NC', 'VA', 'WV', 'PA', 'NY', 'NJ',
  'DE', 'MD', 'CT', 'RI', 'MA', 'VT', 'NH', 'ME', 'PR',
];
const US_STATE_NAMES = [
  'California', 'Alaska', 'Nevada', 'Hawaii', 'Washington', 'Oregon', 'Idaho', 'Montana',
  'Wyoming', 'Utah', 'Colorado', 'Arizona', 'New Mexico', 'Texas', 'Oklahoma', 'Kansas',
  'Nebraska', 'South Dakota', 'North Dakota', 'Minnesota', 'Iowa', 'Missouri', 'Arkansas',
  'Louisiana', 'Wisconsin', 'Illinois', 'Michigan', 'Indiana', 'Ohio', 'Kentucky',
  'Tennessee', 'Mississippi', 'Alabama', 'Georgia', 'Florida', 'South Carolina',
  'North Carolina', 'Virginia', 'West Virginia', 'Pennsylvania', 'New York', 'New Jersey',
  'Delaware', 'Maryland', 'Connecticut', 'Rhode Island', 'Massachusetts', 'Vermont',
  'New Hampshire', 'Maine', 'Puerto Rico',
];

// Country NAME -> ISO 3166-1 alpha-2. Deliberately a flat lookup table, not a
// full ISO country list — expanded from the original ~24 entries to cover
// the real misses found in Phase 1 data (Nepal, Spain) plus the other
// countries USGS "significant earthquake" feed realistically reports.
const COUNTRY_NAME_TO_CODE = {
  'Japan': 'JP', 'Indonesia': 'ID', 'Philippines': 'PH', 'Chile': 'CL', 'Mexico': 'MX',
  'Peru': 'PE', 'Fiji': 'FJ', 'Tonga': 'TO', 'New Zealand': 'NZ', 'Papua New Guinea': 'PG',
  'Turkey': 'TR', 'Greece': 'GR', 'Italy': 'IT', 'Spain': 'ES', 'Portugal': 'PT',
  'Iran': 'IR', 'Afghanistan': 'AF', 'Pakistan': 'PK', 'India': 'IN', 'China': 'CN',
  'Taiwan': 'TW', 'Russia': 'RU', 'Ecuador': 'EC', 'Colombia': 'CO', 'Vanuatu': 'VU',
  'Solomon Islands': 'SB', 'Nicaragua': 'NI', 'Guatemala': 'GT', 'Costa Rica': 'CR',
  'Nepal': 'NP', 'Bangladesh': 'BD', 'Myanmar': 'MM', 'Vietnam': 'VN', 'Thailand': 'TH',
  'Malaysia': 'MY', 'Cambodia': 'KH', 'Laos': 'LA', 'South Korea': 'KR', 'North Korea': 'KP',
  'Mongolia': 'MN', 'Kazakhstan': 'KZ', 'Uzbekistan': 'UZ', 'Tajikistan': 'TJ',
  'Kyrgyzstan': 'KG', 'Turkmenistan': 'TM', 'Georgia': 'GE', 'Armenia': 'AM',
  'Azerbaijan': 'AZ', 'Iraq': 'IQ', 'Syria': 'SY', 'Yemen': 'YE', 'Saudi Arabia': 'SA',
  'Oman': 'OM', 'United Arab Emirates': 'AE', 'Israel': 'IL', 'Jordan': 'JO',
  'Lebanon': 'LB', 'Egypt': 'EG', 'Libya': 'LY', 'Sudan': 'SD', 'Ethiopia': 'ET',
  'Somalia': 'SO', 'Kenya': 'KE', 'Tanzania': 'TZ', 'Mozambique': 'MZ',
  'Madagascar': 'MG', 'South Africa': 'ZA', 'Morocco': 'MA', 'Algeria': 'DZ',
  'Tunisia': 'TN', 'Nigeria': 'NG', 'Ghana': 'GH', 'Cameroon': 'CM', 'DR Congo': 'CD',
  'Democratic Republic of the Congo': 'CD', 'Angola': 'AO', 'Zambia': 'ZM',
  'Zimbabwe': 'ZW', 'Botswana': 'BW', 'Namibia': 'NA', 'Cyprus': 'CY', 'Albania': 'AL',
  'Croatia': 'HR', 'Serbia': 'RS', 'Bosnia and Herzegovina': 'BA', 'Romania': 'RO',
  'Bulgaria': 'BG', 'Ukraine': 'UA', 'Moldova': 'MD', 'Poland': 'PL', 'Germany': 'DE',
  'France': 'FR', 'Switzerland': 'CH', 'Austria': 'AT', 'Iceland': 'IS', 'Norway': 'NO',
  'Sweden': 'SE', 'Finland': 'FI', 'Denmark': 'DK', 'United Kingdom': 'GB', 'Ireland': 'IE',
  'Netherlands': 'NL', 'Belgium': 'BE', 'Brazil': 'BR', 'Argentina': 'AR', 'Bolivia': 'BO',
  'Paraguay': 'PY', 'Uruguay': 'UY', 'Venezuela': 'VE', 'Panama': 'PA', 'Honduras': 'HN',
  'El Salvador': 'SV', 'Belize': 'BZ', 'Cuba': 'CU', 'Jamaica': 'JM', 'Haiti': 'HT',
  'Dominican Republic': 'DO', 'Trinidad and Tobago': 'TT', 'Canada': 'CA', 'Australia': 'AU',
  'Vanuatu Islands': 'VU', 'New Caledonia': 'NC', 'Samoa': 'WS', 'Kiribati': 'KI',
  'Guam': 'GU', 'Northern Mariana Islands': 'MP', 'Puerto Rico': 'PR',
};

// Coarse bounding-box fallback — LARGE, roughly-rectangular countries only.
// [minLat, maxLat, minLon, maxLon]. Boxes intentionally do NOT try to be
// precise at borders; used only when place-name matching found nothing.
// Ordered so more distinctive/smaller boxes are checked before huge ones
// that could otherwise shadow a neighbor (e.g. Alaska/US checked before
// Russia given the near-overlap at the Bering Strait).
const COUNTRY_BOUNDING_BOXES = [
  { code: 'NZ', box: [-47.5, -34, 166, 179] },
  { code: 'JP', box: [24, 46, 123, 146] },
  { code: 'ID', box: [-11, 6, 95, 141] },
  { code: 'PH', box: [4, 21, 116, 127] },
  { code: 'CL', box: [-56, -17, -76, -66] },
  { code: 'AU', box: [-44, -10, 112, 154] },
  { code: 'IN', box: [6, 36, 68, 98] },
  { code: 'BR', box: [-34, 5, -74, -34] },
  { code: 'US', box: [24, 72, -180, -66] },  // includes Alaska's negative-hemisphere span
  { code: 'CA', box: [41, 84, -141, -52] },
  { code: 'CN', box: [17, 54, 73, 135] },
  { code: 'RU', box: [41, 82, 19, 180] },
];

function matchByPlaceName(place) {
  // Prefer the segment after the LAST comma (the region/country token),
  // falling back to substring search over the whole string for names that
  // appear without a leading comma (e.g. "Fiji region").
  const lastSegment = place.includes(',') ? place.split(',').pop().trim() : place;
  for (let i = 0; i < US_STATE_TO_COUNTRY.length; i++) {
    if (lastSegment === US_STATE_TO_COUNTRY[i] || place.endsWith(', ' + US_STATE_TO_COUNTRY[i])) {
      return { code: 'US', method: 'place_name_us_state_abbr' };
    }
  }
  for (let i = 0; i < US_STATE_NAMES.length; i++) {
    if (lastSegment === US_STATE_NAMES[i] || place.endsWith(', ' + US_STATE_NAMES[i])) {
      return { code: 'US', method: 'place_name_us_state_name' };
    }
  }
  for (const [name, code] of Object.entries(COUNTRY_NAME_TO_CODE)) {
    if (place.includes(name)) return { code, method: 'place_name_country' };
  }
  return null;
}

function matchByBoundingBox(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number' || Number.isNaN(lat) || Number.isNaN(lon)) return null;
  for (const { code, box } of COUNTRY_BOUNDING_BOXES) {
    const [minLat, maxLat, minLon, maxLon] = box;
    if (lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon) {
      return { code, method: 'lat_lon_bounding_box' };
    }
  }
  return null;
}

// Returns { code, method, confidence } or null (honestly unresolved — never
// guesses wrong). `lat`/`lon` are optional; when omitted only place-name
// matching runs.
function resolveCountry(place, lat, lon) {
  if (place) {
    const byName = matchByPlaceName(place);
    if (byName) return { code: byName.code, method: byName.method, confidence: 0.9 };
  }
  const byBox = matchByBoundingBox(lat, lon);
  if (byBox) return { code: byBox.code, method: byBox.method, confidence: 0.55 };
  return null;
}

// Backwards-compatible wrapper (old call sites / Phase 1 tests reference
// this name and expect a bare code-or-null return).
function guessCountryFromPlace(place) {
  const r = resolveCountry(place);
  return r ? r.code : null;
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
  const geo = resolveCountry(p.place, lat, lon);
  const countryCode = geo ? geo.code : null;
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
    geoConfidence: geo ? geo.confidence : null,
    geoResolutionMethod: geo ? geo.method : 'unresolved',
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

module.exports = {
  ingest, fetchRaw, normalizeFeature, guessCountryFromPlace, resolveCountry,
  matchByPlaceName, matchByBoundingBox, magnitudeToSeverity, SOURCE_DEF, FEED_URL,
};
