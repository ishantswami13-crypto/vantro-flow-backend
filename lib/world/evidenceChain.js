// FILE: lib/world/evidenceChain.js
// Phase 8 — Evidence Chain. No opaque score: every signal traces through
// real rows at every link: business signal -> transmission channel ->
// business exposure -> world entity -> world event -> source record -> source.
const { getPool } = require('../db/pg');

async function getSignalEvidenceChain(signalId) {
  const pool = getPool();
  const signalRes = await pool.query(`SELECT * FROM business_signals WHERE id = $1`, [signalId]);
  if (signalRes.rows.length === 0) return null;
  const signal = signalRes.rows[0];

  const channelRes = signal.transmission_channel_id
    ? await pool.query(`SELECT * FROM world_transmission_channels WHERE id = $1`, [signal.transmission_channel_id])
    : { rows: [] };

  const exposureRes = signal.business_exposure_id
    ? await pool.query(`SELECT * FROM business_exposure WHERE id = $1`, [signal.business_exposure_id])
    : { rows: [] };
  const exposure = exposureRes.rows[0] || null;

  const worldEntityRes = exposure
    ? await pool.query(`SELECT * FROM world_entities WHERE id = $1`, [exposure.world_entity_id])
    : { rows: [] };

  const eventIds = [signal.world_event_id, ...(signal.current_supporting_event_ids || [])]
    .filter((v, i, a) => v && a.indexOf(v) === i);
  const eventsRes = eventIds.length
    ? await pool.query(`SELECT * FROM world_events WHERE id = ANY($1)`, [eventIds])
    : { rows: [] };

  const sourceRecordsRes = eventIds.length
    ? await pool.query(`SELECT * FROM world_source_records WHERE canonical_event_id = ANY($1)`, [eventIds])
    : { rows: [] };

  const sourceIds = [...new Set(eventsRes.rows.map(e => e.source_id).filter(Boolean))];
  const sourcesRes = sourceIds.length
    ? await pool.query(`SELECT * FROM world_sources WHERE id = ANY($1)`, [sourceIds])
    : { rows: [] };

  return {
    signal,
    transmissionChannel: channelRes.rows[0] || null,
    businessExposure: exposure,
    worldEntity: worldEntityRes.rows[0] || null,
    worldEvents: eventsRes.rows,
    sourceRecords: sourceRecordsRes.rows,
    sources: sourcesRes.rows,
    complete: Boolean(channelRes.rows[0] && exposure && worldEntityRes.rows[0] && eventsRes.rows.length > 0),
  };
}

module.exports = { getSignalEvidenceChain };
