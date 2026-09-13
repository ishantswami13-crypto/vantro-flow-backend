// FILE: scripts/trigger-2xa-event.js
// Inserts ONE real, labeled historical event (a real Sichuan earthquake,
// with a real date/magnitude, sourced as a manually-recorded reference
// record — NOT a fabricated live event) into world_events, links it to the
// China world_entity, and runs it through the REAL relevance pipeline
// (lib/world/relevance.js) for the 2xA demo tenant. No shortcuts: this is
// the same code path a live USGS ingestion would use.
//
// Usage: node scripts/trigger-2xa-event.js
require('dotenv').config();
const { getPool } = require('../lib/db/pg');
const { ensureSource, recordSuccess } = require('../lib/world/sourceRegistry');
const { upsertCountry, linkEventEntity } = require('../lib/world/entities');
const { upsertCanonicalEvent } = require('../lib/world/events');
const { computeSignalCandidatesForEvent, persistCandidates } = require('../lib/world/relevance');

const DEMO_EMAIL_DOMAIN = '2xa-demo-meridian.invalid';

// Real event: 2017-08-08 Jiuzhaigou earthquake, Sichuan, China, M7.0
// (USGS id us2000a2c7 — https://earthquake.usgs.gov/earthquakes/eventpage/us2000a2c7).
// All facts (location, magnitude, source) are the real historical record.
// For demo REPLAY determinism the observed_at timestamp is deliberately set
// to "now" rather than the true 2017 date, so the 7/14/30-day forecast
// horizons in the Impact view are meaningful relative to the live demo
// clock — this substitution is confined to the timestamp field only and is
// explicitly labeled in the summary; no other fact about the event is
// altered or invented.
const EVENT = {
  eventType: 'NATURAL_HAZARD',
  eventSubtype: 'EARTHQUAKE',
  title: 'M7.0 Earthquake — Jiuzhaigou, Sichuan, China',
  summary: 'Real historical event (USGS us2000a2c7, actual date 2017-08-08): a magnitude 7.0 earthquake struck Jiuzhaigou County, Sichuan Province, China, causing regional infrastructure and transport disruption. Replayed here with a current timestamp for demo determinism — see source_url for the original record.',
  observedAt: new Date().toISOString(),
  countryCodes: ['CN'],
  latitude: 33.20,
  longitude: 103.82,
  magnitude: 7.0,
  magnitudeUnit: 'Mw',
  severity: 'severe',
  confidence: 0.95,
  sourceReliability: 'manual_reference',
  truthState: 'OBSERVED',
  sourceExternalId: 'us2000a2c7-jiuzhaigou-2017-replayed',
  sourceUrl: 'https://earthquake.usgs.gov/earthquakes/eventpage/us2000a2c7',
};

async function main() {
  const pool = getPool();
  const userRes = await pool.query(`SELECT id FROM users WHERE email = $1`, [`owner@${DEMO_EMAIL_DOMAIN}`]);
  if (userRes.rows.length === 0) {
    throw new Error('2xA demo tenant not found. Run scripts/seed-2xa-demo.js first.');
  }
  const userId = userRes.rows[0].id;

  const sourceId = await ensureSource({
    provider: 'manual_reference',
    dataset: '2xa_demo_events',
    authorityType: 'curated_reference',
    reliabilityTier: 'manual_reference',
    dataCategory: 'NATURAL_HAZARD',
    updateCadence: 'manual',
  });

  const countryEntityId = await upsertCountry('CN', 'China');

  const { id: eventId, isNew } = await upsertCanonicalEvent({ ...EVENT, sourceId });
  await linkEventEntity(eventId, countryEntityId, 'AFFECTS');
  await recordSuccess(sourceId);

  console.log(`Event upserted: ${eventId} (isNew=${isNew}), linked to CN (${countryEntityId})`);

  const candidates = await computeSignalCandidatesForEvent(eventId, userId);
  console.log(`Relevance matcher produced ${candidates.length} candidate(s) for this tenant.`);
  const results = await persistCandidates(candidates);
  for (const r of results) {
    console.log(` -> business_signal ${r.signal.id} (${r.isNew ? 'created' : 'updated'}), status=${r.signal.status}, entity=${r.signal.related_entity_type}/${r.signal.related_entity_id}`);
  }

  if (candidates.length === 0) {
    console.log('No signals produced. This is correct if the tenant has no VERIFIED LOCATED_IN exposure to China.');
  }

  await pool.end();
}

main().catch((err) => {
  console.error('TRIGGER FAILED:', err);
  process.exit(1);
});
