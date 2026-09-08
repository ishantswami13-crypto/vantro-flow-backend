// FILE: lib/domain/intelligence/checkpointHistory.js
// STARLANE Temporal Intelligence — Part 1: Checkpoint History.
//
// Fixes the known limitation of migrations/027_tenant_review_checkpoints.sql
// (one row per tenant, overwritten every review — no "N days ago" query is
// possible). This module is purely ADDITIVE: it writes to the new
// append-only tenant_review_checkpoint_history table
// (migrations/028_temporal_intelligence.sql) alongside — never instead of —
// whatChangedSinceLastLook.js's existing upsertCheckpoint call into the
// original 027 table. Nothing about the original single-checkpoint contract
// (FIRST_REVIEW/NOTHING_MATERIAL/MATERIAL_CHANGES) changes for existing
// callers.
//
// No lookahead: getCheckpointAsOf/getCheckpointNDaysAgo only ever select
// rows with checkpoint_at <= the requested instant. This mirrors Day 3's
// backtestEngine.js leakage-prevention discipline exactly.

const { getPool } = require('../../db/pg');

async function recordCheckpoint(userId, snapshot, checkpointAt = new Date().toISOString()) {
  if (!userId) throw new Error('recordCheckpoint: userId is required');
  const pool = getPool();
  const res = await pool.query(
    `INSERT INTO tenant_review_checkpoint_history (user_id, checkpoint_at, snapshot)
     VALUES ($1, $2, $3) RETURNING id, checkpoint_at`,
    [userId, checkpointAt, JSON.stringify(snapshot)]
  );
  return res.rows[0];
}

/** Latest checkpoint strictly at or before `asOf` (default now). Never returns a future row. */
async function getCheckpointAsOf(userId, asOf = new Date().toISOString()) {
  if (!userId) throw new Error('getCheckpointAsOf: userId is required');
  const pool = getPool();
  const res = await pool.query(
    `SELECT * FROM tenant_review_checkpoint_history
     WHERE user_id = $1 AND checkpoint_at <= $2
     ORDER BY checkpoint_at DESC LIMIT 1`,
    [userId, asOf]
  );
  return res.rows[0] || null;
}

/** Checkpoint closest to (but not after) `now - days`. Used for 7/30/90-day comparisons. */
async function getCheckpointNDaysAgo(userId, days, now = new Date()) {
  const asOf = new Date(now.getTime() - days * 86400000).toISOString();
  return getCheckpointAsOf(userId, asOf);
}

async function listCheckpoints(userId, { limit = 50 } = {}) {
  if (!userId) throw new Error('listCheckpoints: userId is required');
  const pool = getPool();
  const res = await pool.query(
    `SELECT id, checkpoint_at, snapshot FROM tenant_review_checkpoint_history
     WHERE user_id = $1 ORDER BY checkpoint_at DESC LIMIT $2`,
    [userId, limit]
  );
  return res.rows;
}

/**
 * Honest N-day-window comparison. If no checkpoint exists at/before the
 * requested window, returns INSUFFICIENT_HISTORY rather than fabricating a
 * comparison against whatever the oldest row happens to be.
 */
async function compareWindow(userId, days, { toleranceDays = Math.max(1, Math.floor(days * 0.34)) } = {}) {
  if (!userId) throw new Error('compareWindow: userId is required');
  const now = new Date();
  const target = getCheckpointNDaysAgo.bind(null); // no-op, keeps signature obvious
  const past = await getCheckpointNDaysAgo(userId, days, now);
  const current = await getCheckpointAsOf(userId, now.toISOString());

  if (!current) {
    return { userId, windowDays: days, status: 'INSUFFICIENT_HISTORY', reason: 'no checkpoint exists at all yet', past: null, current: null };
  }
  if (!past) {
    return { userId, windowDays: days, status: 'INSUFFICIENT_HISTORY', reason: `no checkpoint exists at or before ${days} days ago`, past: null, current };
  }
  const actualGapDays = (new Date(current.checkpoint_at).getTime() - new Date(past.checkpoint_at).getTime()) / 86400000;
  // Guard against comparing "7-day" to a checkpoint that's actually 90 days
  // old just because it's the oldest one available — be honest about the gap.
  if (Math.abs(actualGapDays - days) > days + toleranceDays && actualGapDays < days) {
    return { userId, windowDays: days, status: 'INSUFFICIENT_HISTORY', reason: `nearest checkpoint is only ${actualGapDays.toFixed(1)} days back, not ~${days}`, past: null, current };
  }

  return { userId, windowDays: days, status: 'OK', actualGapDays: Math.round(actualGapDays * 10) / 10, past, current };
}

module.exports = { recordCheckpoint, getCheckpointAsOf, getCheckpointNDaysAgo, listCheckpoints, compareWindow };
