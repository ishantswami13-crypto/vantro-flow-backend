// FILE: lib/domain/intelligence/whatChangedSinceLastLook.js
// STARLANE — Irresistible Value Engine, Capability C: "What Changed Since
// Last Look".
//
// PURE COMPOSITION + DIFF. This module invents no new detection logic — it
// calls buildBusinessPulse (Business Pulse), buildMorningRevelations, and
// forecastCashPositionV2 to get the current real state, compares it against
// the tenant's last stored checkpoint (migrations/027_tenant_review_checkpoints.sql),
// and reports only what materially changed. After reporting, it upserts the
// new checkpoint.
//
// Honesty discipline (non-negotiable):
//   - No prior checkpoint -> status FIRST_REVIEW. This must NEVER be
//     reported as "nothing changed" — there is no baseline to compare against.
//   - A prior checkpoint exists but nothing material changed -> status
//     NOTHING_MATERIAL, an honest, positive statement, not silence.
//   - A prior checkpoint exists and something material changed -> status
//     MATERIAL_CHANGES with one item per real, evidenced difference.
//   - Materiality: lib/world/materiality.js's own components
//     (business_dependency / event_severity / recency / composition_policy)
//     are built specifically for the EVENT->EXPOSURE world-signal shape and
//     deliberately expose no single numeric threshold for a generic
//     percentage-change-in-a-number comparison (see its composition_policy
//     field) — there is no existing generic "is this numeric diff material"
//     helper anywhere in lib/. Reusing materiality.js's actual, applicable
//     rule here: never collapse multiple signals into one hidden score, and
//     never assert a change is material without a named, disclosed
//     threshold. This module therefore defines ONE small, explicitly
//     disclosed set of thresholds (below) in the same spirit, applied only
//     to the categorical/enumerable fields Business Pulse and the Revelation
//     Engine already produce (component state transitions, revelation
//     id set, overall pulse state) — never a fabricated new numeric-diff
//     scoring formula.

const { getPool } = require('../../db/pg');
const { buildBusinessPulse } = require('./businessPulse');
const { buildMorningRevelations } = require('./revelationEngine');
const { forecastCashPositionV2 } = require('./forecastEngine');
const { recordCheckpoint, compareWindow } = require('./checkpointHistory');

// Disclosed materiality thresholds (percentage points) for the one numeric
// field carried in the snapshot for cross-checkpoint comparison purposes
// (the cash forecast's point_estimate). Anything else compared here is a
// categorical (state/id) transition, which is material by definition when it
// changes at all — no threshold needed or invented for those.
const CASH_FORECAST_MATERIAL_PCT = 15; // matches forecastCashPositionV2's own disclosed +/-15% fallback band

async function getCheckpoint(userId) {
  const pool = getPool();
  const res = await pool.query(`SELECT * FROM tenant_review_checkpoints WHERE user_id = $1`, [userId]);
  return res.rows[0] || null;
}

async function upsertCheckpoint(userId, snapshot) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO tenant_review_checkpoints (user_id, last_reviewed_at, snapshot, created_at, updated_at)
     VALUES ($1, now(), $2, now(), now())
     ON CONFLICT (user_id) DO UPDATE SET last_reviewed_at = now(), snapshot = $2, updated_at = now()`,
    [userId, JSON.stringify(snapshot)]
  );
}

/**
 * Build the current real, comparable snapshot for one tenant. Every field
 * here is read directly from an existing module's real output — nothing new
 * computed.
 */
async function buildCurrentSnapshot(userId) {
  const [pulse, revelations, forecast] = await Promise.all([
    buildBusinessPulse(userId),
    buildMorningRevelations(userId),
    forecastCashPositionV2(userId, { horizonDays: 30, asOf: new Date().toISOString() }).catch(e => ({ status: 'ERROR', reason: e.message })),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    pulseOverall: pulse.overall,
    pulseComponents: Object.fromEntries(pulse.components.map(c => [c.name, { state: c.state, headline: c.headline }])),
    revelationIds: revelations.revelations.map(r => r.id).sort(),
    revelationStatus: revelations.status,
    cashForecastPointEstimate: typeof forecast.point_estimate === 'number' ? forecast.point_estimate : null,
    cashForecastDataQuality: forecast.data_quality || null,
  };
}

function pctChange(a, b) {
  if (a == null || b == null) return null;
  if (a === 0 && b === 0) return 0;
  const base = Math.abs(a) > 0 ? Math.abs(a) : Math.abs(b);
  if (base === 0) return 0;
  return (Math.abs(b - a) / base) * 100;
}

/**
 * Diff two snapshots. Returns an array of material change items, each with
 * evidence pointing at the real before/after values. Immaterial/noise
 * differences (e.g. a component's headline wording changing while its state
 * stays the same, or a sub-15%-per-forecastCashPositionV2's own disclosed
 * band swing in the cash point estimate) are deliberately excluded.
 */
function diffSnapshots(prior, current) {
  const items = [];

  if (prior.pulseOverall !== current.pulseOverall) {
    items.push({
      type: 'PULSE_OVERALL_CHANGED',
      before: prior.pulseOverall,
      after: current.pulseOverall,
      statement: `Overall Business Pulse moved from ${prior.pulseOverall} to ${current.pulseOverall}.`,
      evidence: { before: prior.pulseOverall, after: current.pulseOverall },
    });
  }

  const allComponentNames = new Set([...Object.keys(prior.pulseComponents || {}), ...Object.keys(current.pulseComponents || {})]);
  for (const name of allComponentNames) {
    const before = prior.pulseComponents?.[name];
    const after = current.pulseComponents?.[name];
    const beforeState = before ? before.state : null;
    const afterState = after ? after.state : null;
    if (beforeState !== afterState) {
      items.push({
        type: 'PULSE_COMPONENT_CHANGED',
        component: name,
        before: beforeState,
        after: afterState,
        statement: `Component "${name}" moved from ${beforeState ?? 'not previously evaluable'} to ${afterState ?? 'no longer evaluable'}${after ? ' — ' + after.headline : ''}.`,
        evidence: { before, after },
      });
    }
  }

  const beforeIds = new Set(prior.revelationIds || []);
  const afterIds = new Set(current.revelationIds || []);
  const newRevelations = [...afterIds].filter(id => !beforeIds.has(id));
  const resolvedRevelations = [...beforeIds].filter(id => !afterIds.has(id));
  if (newRevelations.length > 0) {
    items.push({
      type: 'NEW_REVELATION',
      ids: newRevelations,
      statement: `${newRevelations.length} new revelation(s) surfaced since last review: ${newRevelations.join(', ')}.`,
      evidence: { newRevelations },
    });
  }
  if (resolvedRevelations.length > 0) {
    items.push({
      type: 'REVELATION_RESOLVED',
      ids: resolvedRevelations,
      statement: `${resolvedRevelations.length} previously-surfaced revelation(s) no longer apply: ${resolvedRevelations.join(', ')}.`,
      evidence: { resolvedRevelations },
    });
  }

  const cashPct = pctChange(prior.cashForecastPointEstimate, current.cashForecastPointEstimate);
  if (cashPct != null && cashPct >= CASH_FORECAST_MATERIAL_PCT) {
    items.push({
      type: 'CASH_FORECAST_CHANGED',
      before: prior.cashForecastPointEstimate,
      after: current.cashForecastPointEstimate,
      pctChange: Math.round(cashPct * 10) / 10,
      statement: `30-day cash forecast point estimate moved by ${Math.round(cashPct * 10) / 10}% (from ${prior.cashForecastPointEstimate} to ${current.cashForecastPointEstimate}), exceeding the disclosed ${CASH_FORECAST_MATERIAL_PCT}% materiality threshold.`,
      evidence: { before: prior.cashForecastPointEstimate, after: current.cashForecastPointEstimate, pctChange: cashPct, thresholdPct: CASH_FORECAST_MATERIAL_PCT },
    });
  }

  return items;
}

/**
 * Compute "What Changed Since Last Look" for one tenant, then persist the
 * new checkpoint. Never throws for the "no baseline" case — that's an
 * explicit, honest FIRST_REVIEW result, not an error.
 *
 * @param {string} userId
 * @returns {Promise<{userId, status: 'FIRST_REVIEW'|'NOTHING_MATERIAL'|'MATERIAL_CHANGES', changes: object[], lastReviewedAt: string|null, generatedAt: string}>}
 */
async function whatChangedSinceLastLook(userId) {
  if (!userId) throw new Error('whatChangedSinceLastLook: userId is required');

  const [checkpoint, current] = await Promise.all([
    getCheckpoint(userId),
    buildCurrentSnapshot(userId),
  ]);

  if (!checkpoint) {
    await upsertCheckpoint(userId, current);
    await recordCheckpoint(userId, current).catch(() => {}); // additive history write; never blocks the existing contract
    return {
      userId,
      status: 'FIRST_REVIEW',
      reason: 'No prior checkpoint exists for this tenant — this is the first review, so there is nothing honest to compare against yet. This is NOT the same as "nothing changed".',
      changes: [],
      lastReviewedAt: null,
      generatedAt: current.generatedAt,
    };
  }

  const prior = checkpoint.snapshot;
  const changes = diffSnapshots(prior, current);
  await upsertCheckpoint(userId, current);
  await recordCheckpoint(userId, current).catch(() => {}); // additive history write; never blocks the existing contract

  return {
    userId,
    status: changes.length === 0 ? 'NOTHING_MATERIAL' : 'MATERIAL_CHANGES',
    reason: changes.length === 0 ? 'Compared against the last real checkpoint; no component, revelation, or cash-forecast change crossed the disclosed materiality bar.' : null,
    changes,
    lastReviewedAt: checkpoint.last_reviewed_at,
    generatedAt: current.generatedAt,
  };
}

/**
 * STARLANE Temporal Intelligence — Part 21-22: What-Changed v2.
 * Compares the CURRENT real state against the checkpoint closest to (but not
 * after) `days` days ago, using the append-only history table (Part 1) so
 * multiple windows can be served without the single-row-overwrite limitation
 * of whatChangedSinceLastLook(). Does NOT alter or replace that function's
 * existing 3-state contract for existing callers — this is a new function
 * alongside it, per the mission's additive-only constraint.
 *
 * Honesty: if no checkpoint exists at/before the requested window, returns
 * INSUFFICIENT_HISTORY rather than silently comparing against whatever
 * happens to be the oldest available checkpoint.
 *
 * @param {string} userId
 * @param {number} days - 7, 30, or 90 (or any positive number)
 */
async function whatChangedOverWindow(userId, days) {
  if (!userId) throw new Error('whatChangedOverWindow: userId is required');
  if (!days || days <= 0) throw new Error('whatChangedOverWindow: days must be a positive number');

  const current = await buildCurrentSnapshot(userId);
  await recordCheckpoint(userId, current).catch(() => {});

  const cmp = await compareWindow(userId, days);
  if (cmp.status === 'INSUFFICIENT_HISTORY') {
    return {
      userId,
      windowDays: days,
      status: 'INSUFFICIENT_HISTORY',
      reason: cmp.reason,
      changes: [],
      generatedAt: current.generatedAt,
    };
  }

  const changes = diffSnapshots(cmp.past.snapshot, current);
  return {
    userId,
    windowDays: days,
    status: changes.length === 0 ? 'NOTHING_MATERIAL' : 'MATERIAL_CHANGES',
    actualGapDays: cmp.actualGapDays,
    pastCheckpointAt: cmp.past.checkpoint_at,
    changes,
    generatedAt: current.generatedAt,
  };
}

module.exports = {
  whatChangedSinceLastLook,
  whatChangedOverWindow,
  buildCurrentSnapshot,
  diffSnapshots,
  getCheckpoint,
  upsertCheckpoint,
  CASH_FORECAST_MATERIAL_PCT,
};
