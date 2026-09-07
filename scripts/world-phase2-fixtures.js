// FILE: scripts/world-phase2-fixtures.js
// Phase 11 — first real proof, using test fixtures (per the audit's honest
// disclosure: real tenant data has no usable location/currency fields, so
// business_exposure facts here are explicitly recorded test fixtures, not
// auto-derived). Creates:
//   - "Phase2 Test Tenant A" (real users row) with a supplier LOCATED_IN a
//     REAL already-ingested earthquake's country, and a purchase
//     CURRENCY_DENOMINATED in a REAL already-ingested FX event's currency.
//   - "Phase2 Test Tenant B" (real users row) with NO matching exposure —
//     the mandatory negative/tenant-isolation control.
// Run: node scripts/world-phase2-fixtures.js
require('dotenv').config();
const { randomUUID } = require('crypto');
const { getPool } = require('../lib/db/pg');
const { resolveAndRecordExposure } = require('../lib/world/businessEntityResolution');

async function ensureTestUser(pool, email, businessName) {
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length) return existing.rows[0].id;
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users (id, email, business_name, password_hash, plan, onboarding_done)
     VALUES ($1,$2,$3,'test-fixture-no-login','free', true)`,
    [id, email, businessName]
  );
  return id;
}

async function main() {
  const pool = getPool();

  // Real already-ingested earthquake with a resolved COUNTRY entity (CN).
  const eqRes = await pool.query(
    `SELECT we.id, we.title, wen.code FROM world_events we
     JOIN world_event_entities wee ON wee.event_id = we.id
     JOIN world_entities wen ON wen.id = wee.entity_id
     WHERE we.event_type = 'NATURAL_HAZARD' AND wen.entity_type = 'COUNTRY'
     ORDER BY we.observed_at DESC LIMIT 1`
  );
  if (eqRes.rows.length === 0) throw new Error('No real ingested earthquake with a resolved country found — run world ingestion first.');
  const eq = eqRes.rows[0];

  // Real already-ingested FX event with a CURRENCY entity.
  const fxRes = await pool.query(
    `SELECT we.id, we.title, wen.code FROM world_events we
     JOIN world_event_entities wee ON wee.event_id = we.id
     JOIN world_entities wen ON wen.id = wee.entity_id
     WHERE we.event_type = 'MACROECONOMICS' AND wen.entity_type = 'CURRENCY'
     ORDER BY we.observed_at DESC LIMIT 1`
  );
  if (fxRes.rows.length === 0) throw new Error('No real ingested FX event with a currency entity found — run world ingestion first.');
  const fx = fxRes.rows[0];

  console.log('Using real earthquake:', eq.title, '(country', eq.code + ')');
  console.log('Using real FX event:', fx.title, '(currency', fx.code + ')');

  const tenantAId = await ensureTestUser(pool, 'phase2-test-tenant-a@starlane.test', 'Phase2 Test Tenant A');
  const tenantBId = await ensureTestUser(pool, 'phase2-test-tenant-b@starlane.test', 'Phase2 Test Tenant B');
  console.log('Tenant A:', tenantAId, ' Tenant B:', tenantBId);

  const supplierAId = 'phase2-fixture-supplier-a';
  const purchaseAId = 'phase2-fixture-purchase-a';
  const supplierBId = 'phase2-fixture-supplier-b';

  // Exposures must be valid BEFORE the real event happened to match (this is
  // the honest scenario: "we already knew the supplier was there when the
  // earthquake hit"), so validFrom is set well in the past rather than NOW().
  const longAgo = '2020-01-01T00:00:00Z';

  const existingLoc = await pool.query(
    `SELECT * FROM business_exposure WHERE user_id=$1 AND business_entity_id=$2 AND exposure_type='LOCATED_IN'`,
    [tenantAId, supplierAId]
  );
  const locExposure = existingLoc.rows.length
    ? { exposure: existingLoc.rows[0] }
    : await resolveAndRecordExposure({
        userId: tenantAId,
        businessEntityType: 'supplier',
        businessEntityId: supplierAId,
        exposureType: 'LOCATED_IN',
        kind: 'country',
        rawValue: eq.code,
        validFrom: longAgo,
        sourceOfFact: 'test_fixture',
        evidenceNotes: 'Phase 11 fixture: supplier explicitly recorded as located in ' + eq.code,
      });

  const existingFx = await pool.query(
    `SELECT * FROM business_exposure WHERE user_id=$1 AND business_entity_id=$2 AND exposure_type='CURRENCY_DENOMINATED'`,
    [tenantAId, purchaseAId]
  );
  const fxExposure = existingFx.rows.length
    ? { exposure: existingFx.rows[0] }
    : await resolveAndRecordExposure({
        userId: tenantAId,
        businessEntityType: 'purchase',
        businessEntityId: purchaseAId,
        exposureType: 'CURRENCY_DENOMINATED',
        kind: 'currency',
        rawValue: fx.code,
        validFrom: longAgo,
        sourceOfFact: 'test_fixture',
        evidenceNotes: 'Phase 11 fixture: purchase explicitly recorded as denominated in ' + fx.code,
      });

  // Tenant B: a supplier located in a DIFFERENT, non-matching country —
  // proves negative/tenant-isolation, not just absence of any exposure.
  const nonMatchCountry = eq.code === 'US' ? 'FR' : 'US';
  const existingNoMatch = await pool.query(
    `SELECT * FROM business_exposure WHERE user_id=$1 AND business_entity_id=$2 AND exposure_type='LOCATED_IN'`,
    [tenantBId, supplierBId]
  );
  const noMatchExposure = existingNoMatch.rows.length
    ? { exposure: existingNoMatch.rows[0] }
    : await resolveAndRecordExposure({
        userId: tenantBId,
        businessEntityType: 'supplier',
        businessEntityId: supplierBId,
        exposureType: 'LOCATED_IN',
        kind: 'country',
        rawValue: nonMatchCountry,
        validFrom: longAgo,
        sourceOfFact: 'test_fixture',
        evidenceNotes: 'Phase 11 fixture: negative control, deliberately non-matching country',
      });

  console.log(JSON.stringify({
    tenantAId, tenantBId,
    earthquakeEventId: eq.id, earthquakeCountry: eq.code,
    fxEventId: fx.id, fxCurrency: fx.code,
    locExposureId: locExposure.exposure.id,
    fxExposureId: fxExposure.exposure.id,
    noMatchExposureId: noMatchExposure.exposure.id,
  }, null, 2));

  return {
    tenantAId, tenantBId, eqEventId: eq.id, fxEventId: fx.id,
    locExposureId: locExposure.exposure.id, fxExposureId: fxExposure.exposure.id,
    noMatchExposureId: noMatchExposure.exposure.id,
  };
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { main, ensureTestUser };
