// FILE: scripts/test-phase20-world-intelligence-phase2.js
// World Intelligence Phase 2 — comprehensive test suite. Runs against the
// real local dev DATABASE_URL (never NEON_READONLY_URL, never production).
// Run: node scripts/test-phase20-world-intelligence-phase2.js
require('dotenv').config();
const { randomUUID } = require('crypto');
const { getPool } = require('../lib/db/pg');
const { matchEventToExposures, computeSignalCandidatesForEvent, persistCandidates, loadEventWithEntities, loadActiveChannels } = require('../lib/world/relevance');
const { getSignalEvidenceChain } = require('../lib/world/evidenceChain');
const { getActiveSignalsForTenant } = require('../lib/world/signalQueries');
const { resolveAndRecordExposure, resolveCountryValue, resolveCurrencyValue } = require('../lib/world/businessEntityResolution');
const usgs = require('../lib/world/sources/usgsEarthquakes');
const fixtures = require('./world-phase2-fixtures');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS -', name); }
  else { fail++; console.log('FAIL -', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

async function ensureTestUser(pool, email, name) {
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length) return existing.rows[0].id;
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users (id, email, business_name, password_hash, plan, onboarding_done) VALUES ($1,$2,$3,'x','free',true)`,
    [id, email, name]
  );
  return id;
}

async function main() {
  const pool = getPool();

  // ============ Geo-matching improvement (Phase 5), real data before/after ============
  const rawUsgs = await pool.query(
    `SELECT wsr.raw_payload AS rp FROM world_source_records wsr JOIN world_sources s ON s.id = wsr.source_id WHERE s.provider = 'USGS'`
  );
  const legacyMap = {
    ', CA': 'US', ', AK': 'US', ', NV': 'US', ', HI': 'US', ', WA': 'US', ', OR': 'US',
    'Japan': 'JP', 'Indonesia': 'ID', 'Philippines': 'PH', 'Chile': 'CL', 'Mexico': 'MX',
    'Peru': 'PE', 'Fiji': 'FJ', 'Tonga': 'TO', 'New Zealand': 'NZ', 'Papua New Guinea': 'PG',
    'Alaska': 'US', 'California': 'US', 'Turkey': 'TR', 'Greece': 'GR', 'Italy': 'IT',
    'Iran': 'IR', 'Afghanistan': 'AF', 'Pakistan': 'PK', 'India': 'IN', 'China': 'CN',
    'Taiwan': 'TW', 'Russia': 'RU', 'Ecuador': 'EC', 'Colombia': 'CO', 'Vanuatu': 'VU',
    'Solomon Islands': 'SB', 'Nicaragua': 'NI', 'Guatemala': 'GT', 'Costa Rica': 'CR',
  };
  let legacyMiss = 0, newMiss = 0;
  const total = rawUsgs.rows.length;
  for (const row of rawUsgs.rows) {
    const p = row.rp.properties;
    const [lon, lat] = row.rp.geometry.coordinates;
    const legacyHit = Object.keys(legacyMap).some(k => p.place.includes(k));
    if (!legacyHit) legacyMiss++;
    if (!usgs.resolveCountry(p.place, lat, lon)) newMiss++;
  }
  console.log(`Geo-matching on real data: total=${total} legacy_miss=${legacyMiss} (${(legacyMiss/total*100).toFixed(1)}%) new_miss=${newMiss} (${(newMiss/total*100).toFixed(1)}%)`);
  check('Phase 5: geo-matching miss rate improved on real data', newMiss < legacyMiss);
  check('Phase 5: geo-matching miss rate is now 0 on real sampled data', newMiss === 0, { newMiss, total });

  // ============ Phase 11 A/B/C proof using fixtures ============
  const fx = await fixtures.main();
  const candidatesA_eq = await computeSignalCandidatesForEvent(fx.eqEventId, fx.tenantAId);
  check('Phase 11.A: earthquake matches tenant A supplier LOCATED_IN exposure', candidatesA_eq.length > 0, candidatesA_eq.length);
  const persistedA_eq = await persistCandidates(candidatesA_eq);
  check('Phase 11.A: signal persisted', persistedA_eq.length > 0);
  if (persistedA_eq.length > 0) {
    const chain = await getSignalEvidenceChain(persistedA_eq[0].signal.id);
    check('Phase 11.A: evidence chain complete', chain && chain.complete === true, chain && chain.complete);
    console.log('Phase 11.A evidence chain summary:', JSON.stringify({
      signalId: chain.signal.id, channel: chain.transmissionChannel && chain.transmissionChannel.channel_code,
      exposureType: chain.businessExposure && chain.businessExposure.exposure_type,
      worldEntity: chain.worldEntity && chain.worldEntity.code, eventCount: chain.worldEvents.length,
    }, null, 2));
  }

  const candidatesA_fx = await computeSignalCandidatesForEvent(fx.fxEventId, fx.tenantAId);
  check('Phase 11.B: FX event matches tenant A currency exposure', candidatesA_fx.length > 0, candidatesA_fx.length);
  const persistedA_fx = await persistCandidates(candidatesA_fx);
  check('Phase 11.B: signal persisted', persistedA_fx.length > 0);
  if (persistedA_fx.length > 0) {
    const chain = await getSignalEvidenceChain(persistedA_fx[0].signal.id);
    check('Phase 11.B: evidence chain complete', chain && chain.complete === true);
  }

  const candidatesB_eq = await computeSignalCandidatesForEvent(fx.eqEventId, fx.tenantBId);
  const candidatesB_fx = await computeSignalCandidatesForEvent(fx.fxEventId, fx.tenantBId);
  check('Phase 11.C: tenant B (no matching exposure) gets ZERO signals from earthquake', candidatesB_eq.length === 0, candidatesB_eq.length);
  check('Phase 11.C: tenant B (no matching exposure) gets ZERO signals from FX event', candidatesB_fx.length === 0, candidatesB_fx.length);

  // ============ Phase 12 — false positive tests ============
  const channels = await loadActiveChannels();

  // 12.1 event region doesn't match supplier location
  const fakeEvent1 = { id: 'ev1', event_type: 'NATURAL_HAZARD', observed_at: new Date().toISOString(), linkedEntityIds: ['non-matching-entity-id'] };
  const exp1 = [{ id: 'exp1', user_id: 'u1', exposure_type: 'LOCATED_IN', world_entity_id: 'different-entity-id', valid_from: new Date(Date.now() - 1000).toISOString(), valid_to: null }];
  check('Phase 12.1: no signal when event region does not match exposure', matchEventToExposures(fakeEvent1, exp1, channels).length === 0);

  // 12.2 currency pair doesn't match tenant's purchase currency
  const fakeEvent2 = { id: 'ev2', event_type: 'MACROECONOMICS', observed_at: new Date().toISOString(), linkedEntityIds: ['usd-entity'] };
  const exp2 = [{ id: 'exp2', user_id: 'u1', exposure_type: 'CURRENCY_DENOMINATED', world_entity_id: 'eur-entity', valid_from: new Date(Date.now() - 1000).toISOString(), valid_to: null }];
  check('Phase 12.2: no signal when currency does not match', matchEventToExposures(fakeEvent2, exp2, channels).length === 0);

  // 12.3 tenant lacks any relevant exposure
  check('Phase 12.3: no signal when exposures array is empty', matchEventToExposures(fakeEvent1, [], channels).length === 0);

  // 12.4 exposure valid_to has passed (expired relationship)
  const entityId = 'shared-entity-x';
  const fakeEvent4 = { id: 'ev4', event_type: 'NATURAL_HAZARD', observed_at: new Date().toISOString(), linkedEntityIds: [entityId] };
  const exp4 = [{ id: 'exp4', user_id: 'u1', exposure_type: 'LOCATED_IN', world_entity_id: entityId, valid_from: new Date(Date.now() - 1000 * 3600 * 24 * 200).toISOString(), valid_to: new Date(Date.now() - 1000 * 3600 * 24 * 30).toISOString() }];
  check('Phase 12.4: no signal for expired exposure (valid_to in the past)', matchEventToExposures(fakeEvent4, exp4, channels).length === 0);

  // 12.5 entity resolution confidence below threshold — a low-confidence exposure still MATCHES
  // structurally (matching is not confidence-gated by design; confidence is exposed as a
  // separate component per Phase 9). We prove the LOW confidence is honestly carried through
  // rather than silently dropped or upgraded.
  const exp5 = [{ id: 'exp5', user_id: 'u1', exposure_type: 'LOCATED_IN', world_entity_id: entityId, valid_from: new Date(Date.now() - 1000).toISOString(), valid_to: null, resolution_confidence: 0.1, confidence: 0.1 }];
  const cands5 = matchEventToExposures(fakeEvent4, exp5, channels);
  check('Phase 12.5: low-confidence exposure candidate carries low confidence honestly (not upgraded)', cands5.length > 0 && cands5[0].confidenceComponents.entityResolutionConfidence === 0.1);

  // 12.6 wrong tenant owns the business entity — a signal query for tenant A must never surface tenant B's exposure
  const dbExposuresA = await require('../lib/world/relevance').loadExposuresForTenant(fx.tenantAId);
  const leaksTenantB = dbExposuresA.some(e => e.user_id === fx.tenantBId);
  check('Phase 12.6: tenant A exposure load never returns tenant B rows', !leaksTenantB);

  // ============ Phase 13 — deduplication ============
  const beforeCount = (await getActiveSignalsForTenant(fx.tenantAId, { limit: 1000 })).length;
  const candidatesAgain = await computeSignalCandidatesForEvent(fx.eqEventId, fx.tenantAId);
  await persistCandidates(candidatesAgain);
  const afterCount = (await getActiveSignalsForTenant(fx.tenantAId, { limit: 1000 })).length;
  check('Phase 13: reprocessing the same event does not create a duplicate signal', beforeCount === afterCount, { beforeCount, afterCount });

  // ============ Phase 14 — temporal relevance (bitemporal) ============
  const movedExposure = await resolveAndRecordExposure({
    userId: fx.tenantAId, businessEntityType: 'supplier', businessEntityId: 'phase2-fixture-supplier-moved',
    exposureType: 'LOCATED_IN', kind: 'country', rawValue: 'US',
    validFrom: new Date(Date.now() - 1000 * 3600 * 24 * 400).toISOString(),
    validTo: new Date(Date.now() - 1000 * 3600 * 24 * 180).toISOString(), // moved 6 months ago
    sourceOfFact: 'test_fixture', evidenceNotes: 'Phase 14 fixture: supplier moved countries 6 months ago',
  });
  const eventNow = await loadEventWithEntities(fx.eqEventId);
  const eventNowCurrent = { ...eventNow, observed_at: new Date().toISOString() };
  const stillMatches = matchEventToExposures(eventNowCurrent, [movedExposure.exposure], channels);
  check('Phase 14: expired (moved) exposure does not match a CURRENT event', stillMatches.length === 0, stillMatches.length);

  // ============ Entity resolution ============
  const r1 = await resolveCountryValue('India');
  check('Entity resolution: country name lookup resolves India->IN', r1 && r1.code === 'IN');
  const r2 = await resolveCountryValue('xx-not-a-country');
  check('Entity resolution: unresolvable value returns null (never guesses)', r2 === null);
  const r3 = await resolveCurrencyValue('USD');
  check('Entity resolution: exact currency code resolves', r3 && r3.code === 'USD');

  // ============ Confidence component separation ============
  if (persistedA_eq.length > 0) {
    const sig = persistedA_eq[0].signal;
    const componentFields = ['source_reliability_component', 'event_confidence_component', 'entity_resolution_confidence_component', 'exposure_confidence_component', 'transmission_confidence_component'];
    const distinctFieldsPresent = componentFields.filter(f => sig[f] !== undefined);
    check('Phase 9: signal carries 5 separate confidence component fields (not collapsed)', distinctFieldsPresent.length === 5, distinctFieldsPresent);
  }

  // ============ Impact classification has no financial numbers ============
  if (persistedA_eq.length > 0) {
    const sig = persistedA_eq[0].signal;
    check('Phase 10: impact_status is a qualitative enum value', ['EXPOSED', 'POTENTIALLY_AFFECTED', 'OBSERVED_IMPACT'].includes(sig.impact_status));
    const hasNoAmountField = !('amount' in sig) && !('financial_impact' in sig) && !('estimated_cost' in sig);
    check('Phase 10: no financial-amount field on business_signals row', hasNoAmountField);
  }

  // ============ Evidence chain completeness for FX ============
  if (persistedA_fx.length > 0) {
    const chain = await getSignalEvidenceChain(persistedA_fx[0].signal.id);
    check('Evidence chain (FX): resolves through exposure -> world_entity -> event -> source', chain.complete && chain.sources.length > 0);
  }

  // ============ Signal lifecycle transitions ============
  const historyRes = await pool.query('SELECT * FROM business_signal_status_history WHERE signal_id = $1 ORDER BY changed_at ASC', [persistedA_eq[0].signal.id]);
  check('Signal lifecycle: status history recorded at least the creation transition', historyRes.rows.length >= 1, historyRes.rows.length);
  check('Signal lifecycle: first transition is NULL -> CANDIDATE', historyRes.rows[0].previous_status === null && historyRes.rows[0].new_status === 'CANDIDATE');

  // ============ Tenant isolation (mandatory, real two-tenant proof) ============
  const tenantASignals = await getActiveSignalsForTenant(fx.tenantAId, { limit: 1000 });
  const tenantBSignals = await getActiveSignalsForTenant(fx.tenantBId, { limit: 1000 });
  check('Tenant isolation: tenant B has zero signals despite tenant A having real signals', tenantASignals.length > 0 && tenantBSignals.length === 0, { a: tenantASignals.length, b: tenantBSignals.length });

  // ============ Event revision propagation ============
  const revBefore = await getSignalEvidenceChain(persistedA_eq[0].signal.id);
  const revInsert = await pool.query(
    `INSERT INTO world_event_revisions (event_id, field_name, previous_value, new_value) VALUES ($1,'magnitude','3.7','4.1') RETURNING id`,
    [fx.eqEventId]
  );
  const revAfter = await getSignalEvidenceChain(persistedA_eq[0].signal.id);
  check('Event revision: evidence chain still resolves correctly through a revised event', revAfter.complete === true && revAfter.worldEvents.some(e => e.id === fx.eqEventId));

  console.log(`\n=== RESULTS: ${pass} passed, ${fail} failed (of ${pass + fail}) ===`);

  // ── Cleanup audit fix (World Intelligence Phase 3, Part B) ──
  // This file previously left residue on every run: scripts/world-phase2-fixtures.js
  // reuses two FIXED tenant users (by design, matched by email) but
  // resolveAndRecordExposure/persistCandidates have no dedup-across-runs
  // guard, so re-running this test kept inserting new business_exposure and
  // business_signals rows for the same fixture tenants forever, plus a
  // synthetic world_event_revisions row against a REAL world_events row.
  // Fix: delete all business_exposure/business_signals/candidates data for
  // the two fixture tenants and the synthetic revision row at the end of
  // every run. The fixture USERS rows themselves are intentionally kept
  // (they are the stable, idempotent fixture the mission's Phase 11 proof
  // was built around, matched by fixed email — not synthetic per-run junk).
  await pool.query(`DELETE FROM world_event_revisions WHERE id = $1`, [revInsert.rows[0].id]);
  const fixtureTenantIds = [fx.tenantAId, fx.tenantBId];
  await pool.query(`DELETE FROM business_signal_status_history WHERE signal_id IN (SELECT id FROM business_signals WHERE user_id = ANY($1::uuid[]))`, [fixtureTenantIds]);
  await pool.query(`DELETE FROM business_signals WHERE user_id = ANY($1::uuid[])`, [fixtureTenantIds]);
  await pool.query(`DELETE FROM business_exposure_candidates WHERE user_id = ANY($1::uuid[])`, [fixtureTenantIds]);
  await pool.query(`DELETE FROM business_exposure WHERE user_id = ANY($1::uuid[])`, [fixtureTenantIds]);
  const residueCheck = await pool.query(
    `SELECT (SELECT COUNT(*) FROM business_exposure WHERE user_id = ANY($1::uuid[])) AS bexp,
            (SELECT COUNT(*) FROM business_signals WHERE user_id = ANY($1::uuid[])) AS bsig,
            (SELECT COUNT(*) FROM world_event_revisions WHERE id = $2) AS rev`,
    [fixtureTenantIds, revInsert.rows[0].id]
  );
  console.log('Cleanup residue check (bexp/bsig/rev must be 0):', residueCheck.rows[0]);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
