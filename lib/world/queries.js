// FILE: lib/world/queries.js
// Deterministic repository functions over world_events/entities. No LLM
// summarization anywhere in this file (Phase 16/17).
const { getPool } = require('../db/pg');

async function getEventsForCountryInRange(countryCode, from, to, { limit = 200 } = {}) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT * FROM world_events
     WHERE $1 = ANY(country_codes) AND observed_at BETWEEN $2 AND $3
     ORDER BY observed_at DESC LIMIT $4`,
    [countryCode, from, to, limit]
  );
  return res.rows;
}

async function getEventsForEntity(entityId, { limit = 200 } = {}) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT we.*, wee.relationship_type
     FROM world_events we
     JOIN world_event_entities wee ON wee.event_id = we.id
     WHERE wee.entity_id = $1
     ORDER BY we.observed_at DESC LIMIT $2`,
    [entityId, limit]
  );
  return res.rows;
}

async function getRecentEventsByCategory(eventType, { limit = 50 } = {}) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT * FROM world_events WHERE event_type = $1 ORDER BY observed_at DESC LIMIT $2`,
    [eventType, limit]
  );
  return res.rows;
}

async function getEventRevisionHistory(eventId) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT * FROM world_event_revisions WHERE event_id = $1 ORDER BY revised_at ASC`,
    [eventId]
  );
  return res.rows;
}

// Phase 17 — deterministic composition, NOT an LLM summary. Returns material
// current events + recent changes for a scope (country code or event_type)
// as of a given timestamp.
async function getWorldStateSnapshot({ asOf, scope } = {}) {
  const pool = getPool();
  const cutoff = asOf ? new Date(asOf) : new Date();
  const params = [cutoff.toISOString()];
  let where = `ingested_at <= $1 AND status = 'active'`;
  if (scope && scope.countryCode) {
    params.push(scope.countryCode);
    where += ` AND $${params.length} = ANY(country_codes)`;
  }
  if (scope && scope.eventType) {
    params.push(scope.eventType);
    where += ` AND event_type = $${params.length}`;
  }
  const events = await pool.query(
    `SELECT * FROM world_events WHERE ${where} ORDER BY observed_at DESC LIMIT 100`,
    params
  );
  const recentRevisions = await pool.query(
    `SELECT wer.* FROM world_event_revisions wer
     JOIN world_events we ON we.id = wer.event_id
     WHERE wer.revised_at <= $1 ${scope && scope.countryCode ? `AND $2 = ANY(we.country_codes)` : ''}
     ORDER BY wer.revised_at DESC LIMIT 50`,
    scope && scope.countryCode ? [cutoff.toISOString(), scope.countryCode] : [cutoff.toISOString()]
  );
  return {
    asOf: cutoff.toISOString(),
    scope: scope || null,
    eventCount: events.rows.length,
    events: events.rows,
    recentRevisions: recentRevisions.rows,
  };
}

module.exports = {
  getEventsForCountryInRange,
  getEventsForEntity,
  getRecentEventsByCategory,
  getEventRevisionHistory,
  getWorldStateSnapshot,
};
