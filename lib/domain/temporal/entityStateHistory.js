// FILE: lib/domain/temporal/entityStateHistory.js
// STARLANE Global Context + Temporal Foundation -- Part E.
//
// recordEntityStateChange() is the single write path into
// entity_state_history (migration 023). It is ADDITIVE-ONLY: callers use it
// alongside their existing UPDATE statement, never instead of it. It never
// duplicates a full row -- only the fields that actually changed, as
// { field: { previous, new } }.
const { getPool } = require('../../db/pg');

const VALID_ENTITY_TYPES = ['invoice', 'payment', 'sale', 'purchase', 'inventory', 'supplier', 'customer'];

/**
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.entityType - one of VALID_ENTITY_TYPES
 * @param {string} params.entityId
 * @param {string} params.eventType - e.g. 'invoice_status_changed'
 * @param {object} params.previousRow - the row BEFORE the update (plain object)
 * @param {object} params.newRow - the row AFTER the update (plain object)
 * @param {string[]} params.fields - which field names to diff (only these are compared/stored)
 * @param {string} [params.source]
 * @param {string} [params.actor]
 * @param {object} [params.metadata]
 * @returns {Promise<object|null>} the inserted row, or null if nothing actually changed
 */
async function recordEntityStateChange({
  userId, entityType, entityId, eventType, previousRow, newRow, fields,
  source = null, actor = null, metadata = {},
}) {
  if (!userId) throw new Error('recordEntityStateChange: userId is required');
  if (!VALID_ENTITY_TYPES.includes(entityType)) {
    throw new Error(`recordEntityStateChange: invalid entityType "${entityType}"`);
  }
  if (!entityId) throw new Error('recordEntityStateChange: entityId is required');
  if (!eventType) throw new Error('recordEntityStateChange: eventType is required');
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error('recordEntityStateChange: fields[] is required');
  }

  const changedFields = {};
  for (const field of fields) {
    const prev = previousRow ? previousRow[field] : undefined;
    const next = newRow ? newRow[field] : undefined;
    // Loose stringified comparison handles Date vs string / numeric vs string
    // mismatches between a freshly-read row and a driver-normalized one,
    // without ever fabricating a "changed" event for a value that is really
    // the same.
    const prevStr = prev === undefined || prev === null ? null : String(prev);
    const nextStr = next === undefined || next === null ? null : String(next);
    if (prevStr !== nextStr) {
      changedFields[field] = { previous: prev ?? null, new: next ?? null };
    }
  }

  if (Object.keys(changedFields).length === 0) return null; // nothing meaningful changed -- write nothing

  const pool = getPool();
  const res = await pool.query(
    `INSERT INTO entity_state_history
       (user_id, entity_type, entity_id, event_type, changed_fields, source, actor, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [userId, entityType, String(entityId), eventType, JSON.stringify(changedFields), source, actor, JSON.stringify(metadata || {})]
  );
  return res.rows[0];
}

/** Read history for one entity, most recent first. Bounded, tenant-scoped. */
async function getEntityStateHistory(userId, entityType, entityId, { limit = 100 } = {}) {
  if (!userId) throw new Error('getEntityStateHistory: userId is required');
  const pool = getPool();
  const res = await pool.query(
    `SELECT * FROM entity_state_history
     WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3
     ORDER BY observed_at DESC
     LIMIT $4`,
    [userId, entityType, String(entityId), limit]
  );
  return res.rows;
}

module.exports = { recordEntityStateChange, getEntityStateHistory, VALID_ENTITY_TYPES };
