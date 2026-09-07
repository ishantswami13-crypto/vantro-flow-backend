// FILE: lib/world/impactPath.js
// World Intelligence Phase 3, Part B — Phase 14 (Impact Path primitive).
//
// Given a business_signal, returns an explicit, queryable, structured path
// from WORLD_EVENT through EXPOSURE and (via signalPropagation.js) whatever
// real internal relationships exist, ending with a classification against
// Phase 2's business-dimension enum (affected_business_dimensions on the
// signal/channel — never invented here). Never returns a financial number
// unless it is a real already-stored value (e.g. products.current_stock).
const { getPool } = require('../db/pg');
const { propagateSignal } = require('./signalPropagation');

async function buildImpactPath(userId, signalId) {
  const pool = getPool();
  const sigRes = await pool.query(`SELECT * FROM business_signals WHERE id = $1 AND user_id = $2`, [signalId, userId]);
  const signal = sigRes.rows[0];
  if (!signal) return null;

  const path = [];

  const eventRes = await pool.query(`SELECT * FROM world_events WHERE id = $1`, [signal.world_event_id]);
  const event = eventRes.rows[0] || null;
  path.push({
    step: 'WORLD_EVENT',
    id: event ? event.id : signal.world_event_id,
    eventType: event ? event.event_type : null,
    title: event ? event.title : null,
    severity: event ? event.severity : null,
    magnitude: event ? event.magnitude : null,
    observedAt: event ? event.observed_at : null,
  });

  let exposure = null;
  if (signal.business_exposure_id) {
    const expRes = await pool.query(`SELECT * FROM business_exposure WHERE id = $1 AND user_id = $2`, [signal.business_exposure_id, userId]);
    exposure = expRes.rows[0] || null;
  }

  const propagationSteps = await propagateSignal(userId, signal, exposure);
  path.push(...propagationSteps);

  // Classification: surfaced from the already-computed, already-real
  // affected_business_dimensions on the signal (set by relevance.js from
  // the matched transmission channel's business_dimensions). Never guessed
  // here — if the signal has none, that is reported honestly as [].
  path.push({
    step: 'POTENTIAL_DIMENSION',
    dimensions: signal.affected_business_dimensions || [],
    impactStatus: signal.impact_status || 'POTENTIALLY_AFFECTED',
    note: 'These are the business dimensions the matched transmission channel classifies this signal under. ' +
      'They describe what MAY be affected, not what has been, or will be, affected.',
  });

  return { signalId: signal.id, userId, path };
}

module.exports = { buildImpactPath };
