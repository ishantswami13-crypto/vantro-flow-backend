// FILE: lib/domain/intelligence/supplierExposureNarrative.js
// STARLANE Day 2 Multidimensional Reality Intelligence — Chain B:
// Supplier + Geography + World Event -> Operational Risk (minus the
// product-dependency leg, which is explicitly NOT buildable today — see
// `missingContext` below).
//
// Pure composition, no reimplementation:
//   - business_exposure (real LOCATED_IN/OPERATES_IN rows, VERIFIED only)
//   - lib/world/relevance.js's computeSignalCandidatesForEvent (existing,
//     already-tested matching engine — NOT reimplemented here)
//   - world_events / world_entities (existing tables)
//   - lib/domain/intelligence/uncertainty.js's assessUncertainty (Part 11)
//
// Chain C (product-level dependency -> stockout) is NOT attempted: products
// has no supplier_id column and purchases.items/.notes/.description are 100%
// NULL in the real data (confirmed by prior audit and re-confirmed against
// live DATABASE_URL on 2026-09-08). Every narrative this module returns
// explicitly states this as a `missingContext` entry — never silently omits it.

const { getPool } = require('../../db/pg');
const { assessUncertainty } = require('./uncertainty');

const PRODUCT_DEPENDENCY_MISSING_NOTE =
  'product-level dependency not currently trackable: products has no supplier_id column, and purchases.items/.notes/.description are 100% NULL across real rows in this database — so which specific products/SKUs would be affected by a disruption at this supplier cannot be honestly stated today.';

/**
 * Finds every VERIFIED business_exposure row for one supplier, and for each,
 * asks the existing relevance engine whether any real world_event currently
 * matches it. Returns one narrative per real match found (zero narratives if
 * no real match exists — never fabricates one).
 */
async function buildSupplierExposureNarrative({ userId, supplierId }) {
  if (!userId) throw new Error('buildSupplierExposureNarrative: userId is required');
  if (!supplierId) throw new Error('buildSupplierExposureNarrative: supplierId is required');

  const pool = getPool();
  const { computeSignalCandidatesForEvent } = require('../../world/relevance');

  const supRes = await pool.query(`SELECT id, name FROM suppliers WHERE id = $1 AND user_id = $2`, [supplierId, userId]);
  if (supRes.rows.length === 0) {
    return { insufficientEvidence: true, reasons: ['no supplier row found for this id/tenant'] };
  }
  const supplier = supRes.rows[0];

  const expRes = await pool.query(
    `SELECT * FROM business_exposure
     WHERE user_id = $1 AND business_entity_type = 'supplier' AND business_entity_id = $2
       AND verification_status = 'VERIFIED' AND exposure_type IN ('LOCATED_IN','OPERATES_IN')`,
    [userId, supplierId]
  );
  if (expRes.rows.length === 0) {
    return {
      insufficientEvidence: true,
      reasons: [`no VERIFIED LOCATED_IN/OPERATES_IN business_exposure row exists for supplier ${supplierId} — cannot honestly assert a geography for this supplier (suppliers.country is also NULL for all sampled rows in this database, so geography only lives in business_exposure today).`],
    };
  }

  // Candidate real events: any world_events row linked (via world_event_entities)
  // to the same world_entity as one of this supplier's exposures. We ask the
  // EXISTING matcher (computeSignalCandidatesForEvent) per event rather than
  // reimplementing any matching logic here.
  const narratives = [];
  const reasonsNoMatch = [];

  for (const exposure of expRes.rows) {
    const evRes = await pool.query(
      `SELECT we.id FROM world_events we
       JOIN world_event_entities wee ON wee.event_id = we.id
       WHERE wee.entity_id = $1`,
      [exposure.world_entity_id]
    );
    if (evRes.rows.length === 0) {
      reasonsNoMatch.push(`no world_events currently linked to world_entity ${exposure.world_entity_id} (this supplier's ${exposure.exposure_type} exposure)`);
      continue;
    }

    for (const evRow of evRes.rows) {
      const candidates = await computeSignalCandidatesForEvent(evRow.id, userId);
      const matchesForThisExposure = candidates.filter(c => c.exposureId === exposure.id);
      for (const candidate of matchesForThisExposure) {
        narratives.push(await composeNarrative({ pool, userId, supplier, exposure, eventId: evRow.id, candidate }));
      }
    }
  }

  if (narratives.length === 0) {
    return {
      insufficientEvidence: true,
      reasons: reasonsNoMatch.length ? reasonsNoMatch : ['no real world_events row currently matches any VERIFIED exposure for this supplier via the existing transmission-channel rules'],
    };
  }

  return { insufficientEvidence: false, supplier: { id: supplier.id, name: supplier.name }, narratives };
}

async function composeNarrative({ pool, userId, supplier, exposure, eventId, candidate }) {
  const [entityRes, eventRes, channelRes] = await Promise.all([
    pool.query(`SELECT * FROM world_entities WHERE id = $1`, [exposure.world_entity_id]),
    pool.query(`SELECT * FROM world_events WHERE id = $1`, [eventId]),
    pool.query(`SELECT * FROM world_transmission_channels WHERE id = $1`, [candidate.channelId]),
  ]);
  const worldEntity = entityRes.rows[0];
  const event = eventRes.rows[0];
  const channel = channelRes.rows[0];

  const recencyDays = event?.observed_at ? Math.abs((Date.now() - new Date(event.observed_at).getTime()) / 86400000) : null;

  const confidence = assessUncertainty({
    sourceReliability: exposure.verification_status, // 'VERIFIED'
    recencyDays,
    sampleSize: 1, // one real supporting event
    relationshipCertainty: exposure.verification_status === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED',
    missingContextCount: 1, // the product-dependency leg is always missing for Chain B today
  });

  const geographyLabel = worldEntity ? (worldEntity.name || worldEntity.code) : exposure.world_entity_id;

  return {
    observation: `Supplier "${supplier.name}" has a VERIFIED ${exposure.exposure_type} exposure to ${geographyLabel}, and a real ${event.event_type} world event (observed ${event.observed_at}) is linked to that same location.`,
    what_changed: `A new/existing ${event.event_type} event in ${geographyLabel} now has a real transmission path (${channel.channel_code}) to this supplier's ${exposure.exposure_type} exposure.`,
    related_variables: [
      { name: 'business_exposure.verification_status', value: exposure.verification_status },
      { name: 'world_event.event_type', value: event.event_type },
      { name: 'world_event.observed_at', value: event.observed_at },
      { name: 'transmission_channel.channel_code', value: channel.channel_code },
    ],
    dependencies: {
      geographyLeg: `real: supplier is ${exposure.exposure_type} ${geographyLabel} (business_exposure ${exposure.id}, VERIFIED)`,
      eventLeg: `real: ${event.event_type} event ${event.id} linked to ${geographyLabel} (world_entity ${exposure.world_entity_id})`,
      productDependencyLeg: 'NOT AVAILABLE — ' + PRODUCT_DEPENDENCY_MISSING_NOTE,
    },
    why_it_matters: `A disruption affecting ${geographyLabel} can plausibly affect this supplier's ability to operate/deliver, per the ${channel.channel_code} transmission rule (${channel.rule_explanation || channel.mechanism}). Affected business dimensions: ${(candidate.affectedBusinessDimensions || []).join(', ') || 'none listed'}.`,
    likely_consequence: `Possible disruption to sourcing from this supplier — hedged: this is a plausibility signal from real geography+event matching, not a quantified impact estimate (no product/inventory linkage exists to size it).`,
    recommended_action: `Review this supplier's near-term deliveries and consider contacting them directly to confirm operational status, given the real ${event.event_type} event in ${geographyLabel}.`,
    uncertainty_band: confidence.band,
    uncertainty_factors: confidence.factors,
    missingContext: [PRODUCT_DEPENDENCY_MISSING_NOTE],
    evidence: [
      { type: 'business_exposure', id: exposure.id, verification_status: exposure.verification_status, exposure_type: exposure.exposure_type, world_entity_id: exposure.world_entity_id },
      { type: 'world_event', id: event.id, event_type: event.event_type, observed_at: event.observed_at, country_codes: event.country_codes },
      { type: 'world_entity', id: worldEntity?.id, name: geographyLabel },
      { type: 'transmission_channel', id: channel.id, channel_code: channel.channel_code },
      { type: 'supplier', id: supplier.id, name: supplier.name },
    ],
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildSupplierExposureNarrative, PRODUCT_DEPENDENCY_MISSING_NOTE };
