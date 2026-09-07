// FILE: lib/world/signalQueries.js
// Phase 15 — deterministic, tenant-scoped query functions over
// business_signals. EVERY function here takes userId and filters by it —
// none of these may ever be called without a tenant scope.
const { getPool } = require('../db/pg');

async function getActiveSignalsForTenant(userId, { limit = 100 } = {}) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT * FROM business_signals WHERE user_id = $1 AND status IN ('CANDIDATE','ACTIVE','UPDATED')
     ORDER BY last_updated_at DESC LIMIT $2`,
    [userId, limit]
  );
  return res.rows;
}

async function getSignalsForBusinessEntity(userId, businessEntityType, businessEntityId) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT * FROM business_signals WHERE user_id = $1 AND related_entity_type = $2 AND related_entity_id = $3
     ORDER BY last_updated_at DESC`,
    [userId, businessEntityType, businessEntityId]
  );
  return res.rows;
}

async function getSignalsByBusinessDimension(userId, dimension) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT * FROM business_signals WHERE user_id = $1 AND $2 = ANY(affected_business_dimensions)
     ORDER BY last_updated_at DESC`,
    [userId, dimension]
  );
  return res.rows;
}

async function getSignalsFromCountry(userId, countryCode) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT DISTINCT bs.* FROM business_signals bs
     JOIN world_events we ON we.id = bs.world_event_id
     WHERE bs.user_id = $1 AND $2 = ANY(we.country_codes)
     ORDER BY bs.last_updated_at DESC`,
    [userId, countryCode]
  );
  return res.rows;
}

async function getSignalsCreatedInLast24h(userId) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT * FROM business_signals WHERE user_id = $1 AND first_detected_at >= NOW() - INTERVAL '24 hours'
     ORDER BY first_detected_at DESC`,
    [userId]
  );
  return res.rows;
}

async function getSignalsForWorldEvent(userId, worldEventId) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT * FROM business_signals WHERE user_id = $1 AND
       (world_event_id = $2 OR $2 = ANY(current_supporting_event_ids))`,
    [userId, worldEventId]
  );
  return res.rows;
}

async function getSignalsByChannel(userId, channelId) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT * FROM business_signals WHERE user_id = $1 AND transmission_channel_id = $2 ORDER BY last_updated_at DESC`,
    [userId, channelId]
  );
  return res.rows;
}

module.exports = {
  getActiveSignalsForTenant,
  getSignalsForBusinessEntity,
  getSignalsByBusinessDimension,
  getSignalsFromCountry,
  getSignalsCreatedInLast24h,
  getSignalsForWorldEvent,
  getSignalsByChannel,
};
