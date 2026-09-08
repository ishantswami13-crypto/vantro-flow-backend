// FILE: lib/domain/intelligence/historicalReconstruction.js
// STARLANE Temporal Intelligence — Part 42: Lookahead safety for historical
// reconstruction. Mirrors Day 3's backtestEngine.js leakage-prevention
// discipline exactly: every query here filters strictly to
// recorded_at/created_at <= asOf, never using any row created after the
// reconstruction point, even if that row's own payload claims an earlier
// "effective" date.
//
// reconstructCustomerScoreAsOf answers "what did we honestly believe about
// this customer's score as of time T" using only customer_score_history rows
// that existed (were recorded) at or before T. This is the concrete worked
// case for the mission's adversarial no-lookahead test.

const { getPool } = require('../../db/pg');

/**
 * @param {string} userId
 * @param {string} customerId
 * @param {string} asOfIso - reconstruction point; rows recorded after this are excluded
 */
async function reconstructCustomerScoreAsOf(userId, customerId, asOfIso) {
  if (!userId || !customerId || !asOfIso) throw new Error('reconstructCustomerScoreAsOf: userId, customerId, asOfIso are all required');
  const pool = getPool();
  const res = await pool.query(
    `SELECT id, credit_risk_score, promise_reliability_score, recorded_at
     FROM customer_score_history
     WHERE user_id = $1 AND customer_id = $2 AND recorded_at <= $3
     ORDER BY recorded_at DESC LIMIT 1`,
    [userId, customerId, asOfIso]
  );
  const row = res.rows[0] || null;
  return {
    userId, customerId, asOf: asOfIso,
    status: row ? 'RECONSTRUCTED' : 'NO_DATA_AT_THIS_POINT',
    believedScore: row ? Number(row.credit_risk_score) : null,
    believedReliability: row ? Number(row.promise_reliability_score) : null,
    sourceRowId: row ? row.id : null,
    sourceRecordedAt: row ? row.recorded_at : null,
    reason: row ? null : `no customer_score_history row for this customer exists with recorded_at <= ${asOfIso}`,
  };
}

/**
 * Reconstruct the full checkpoint history view as of a point in time — used
 * by compareWindow-style consumers that need "what did the checkpoint say
 * N days ago" without ever letting a checkpoint recorded AFTER that point
 * leak in. Thin wrapper documenting the same <= discipline for the
 * checkpoint history table.
 */
async function reconstructCheckpointAsOf(userId, asOfIso) {
  if (!userId || !asOfIso) throw new Error('reconstructCheckpointAsOf: userId and asOfIso are required');
  const pool = getPool();
  const res = await pool.query(
    `SELECT id, checkpoint_at, snapshot FROM tenant_review_checkpoint_history
     WHERE user_id = $1 AND checkpoint_at <= $2
     ORDER BY checkpoint_at DESC LIMIT 1`,
    [userId, asOfIso]
  );
  const row = res.rows[0] || null;
  return {
    userId, asOf: asOfIso,
    status: row ? 'RECONSTRUCTED' : 'NO_DATA_AT_THIS_POINT',
    checkpoint: row || null,
  };
}

module.exports = { reconstructCustomerScoreAsOf, reconstructCheckpointAsOf };
