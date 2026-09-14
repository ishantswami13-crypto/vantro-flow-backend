// FILE: lib/domain/intelligence/predictionVersioning.js
// Wires up temporal columns that already exist on `predictions`
// (supersedes_id, superseded_by_id, revision_trigger, revision_reason,
// revised_at) but were never written by anything — every re-analysis of a
// signal was silently inserting a brand-new, disconnected row, which is
// both a real duplicate-accumulation bug and a missed "what did we know at
// the time" capability. This module answers that honestly: a prediction is
// never overwritten or deleted, only ever superseded, and only ever
// superseded while it hasn't already resolved against real data — a
// RESOLVED prediction is a permanent historical fact.
const { getPool } = require('../../db/pg');

// Finds the current "live head" of a prediction chain for one
// (user, entity, target, horizon) — the one row, if any, that is neither
// resolved nor already superseded by something newer.
async function findLiveHead(userId, { entityId, target, horizonDays, signalId }) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT * FROM predictions
     WHERE user_id = $1 AND entity_id = $2 AND target = $3 AND horizon_days = $4
       AND evaluation_status IS DISTINCT FROM 'RESOLVED'
       AND superseded_by_id IS NULL
       AND evidence->>'signalId' = $5
     ORDER BY created_at DESC LIMIT 1`,
    [userId, entityId, target, horizonDays, signalId]
  );
  return res.rows[0] || null;
}

// Inserts a new prediction, superseding the current live head (if any) for
// the same (entity, target, horizon, signal). `insertFn` performs the
// actual INSERT and must return the new row — kept as a callback so this
// module never needs to know the full column list for every prediction
// target that exists or will exist.
async function insertWithSupersession(userId, { entityId, target, horizonDays, signalId, revisionReason }, insertFn) {
  const pool = getPool();
  const priorHead = await findLiveHead(userId, { entityId, target, horizonDays, signalId });

  const newRow = await insertFn({ supersedesId: priorHead ? priorHead.id : null });

  if (priorHead) {
    await pool.query(
      `UPDATE predictions SET superseded_by_id = $1, revision_trigger = 'RECOMPUTED', revision_reason = $2, revised_at = NOW() WHERE id = $3`,
      [newRow.id, revisionReason || 'Signal re-analyzed; recomputed against current data.', priorHead.id]
    );
  }

  return { row: newRow, supersededPriorId: priorHead ? priorHead.id : null };
}

// Walks supersedes_id backward from a given prediction id to reconstruct
// "what did we know at each point in time" — the full revision chain,
// oldest first. Answers the temporal-model question directly: never a
// separate history table, just following the links that already exist.
async function getPredictionHistory(userId, predictionId) {
  const pool = getPool();
  const chain = [];
  let currentId = predictionId;
  const seen = new Set();
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const res = await pool.query(`SELECT * FROM predictions WHERE id = $1 AND user_id = $2`, [currentId, userId]);
    if (res.rows.length === 0) break;
    chain.unshift(res.rows[0]);
    currentId = res.rows[0].supersedes_id;
  }
  return chain;
}

module.exports = { findLiveHead, insertWithSupersession, getPredictionHistory };
