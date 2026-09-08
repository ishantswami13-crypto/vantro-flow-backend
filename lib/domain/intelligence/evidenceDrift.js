// FILE: lib/domain/intelligence/evidenceDrift.js
// STARLANE Temporal Intelligence — Part 4: Evidence Drift Engine.
//
// The phase's defining new capability: a categorical label (e.g. Business
// Pulse component state, credit-risk band) can stay IDENTICAL across two
// checkpoints while the underlying numeric evidence has materially moved.
// Existing modules (businessPulse.js, whatChangedSinceLastLook.js) only
// diff CATEGORICAL transitions — a same-state pair is invisible to them.
// This module diffs the raw numeric evidence underneath, independent of
// whether the label changed.
//
// Materiality gate: reuses lib/world/materiality.js's discipline of NEVER
// collapsing multiple signals into one hidden score and ALWAYS disclosing
// the threshold used — materiality.js itself has no generic numeric-percent
// threshold (it's built for event/exposure signals), so, exactly like
// whatChangedSinceLastLook.js already does, this module defines its own
// small set of DISCLOSED per-field thresholds rather than reimplementing or
// faking a materiality.js threshold that doesn't exist there.
//
// detectEvidenceDrift(before, after) is a pure function over two evidence
// snapshots (each a flat {field: number} map) — callers assemble the
// snapshot from whatever real source is relevant (business_exposure rows,
// customer_score_history rows, cash forecast components, concentration %).
// This keeps the engine reusable across every entity type in the mission
// without duplicating per-domain fetch logic.

// Disclosed default thresholds. A caller may override per-field via the
// `thresholds` param; unlisted fields fall back to DEFAULT_PCT.
const DEFAULT_PCT = 10; // 10% relative move is the default materiality bar
const FIELD_THRESHOLDS_PCT = {
  credit_risk_score: 8,
  promise_reliability_score: 8,
  collection_priority_score: 10,
  concentration_pct: 5,          // percentage-POINT field, see absolute handling below
  dependency_share_pct: 5,       // percentage-POINT field
  payment_delay_days: 15,
  cash_buffer_days: 10,
};

// Fields expressed as percentage points (0-100) use an ABSOLUTE point-delta
// threshold (the number itself, since FIELD_THRESHOLDS_PCT stores points for
// these), not a relative-percent-of-value threshold — a move from 2% to 6%
// concentration is a 4-point move, not a "200% relative change" framing.
const ABSOLUTE_POINT_FIELDS = new Set(['concentration_pct', 'dependency_share_pct']);

function relativePctChange(a, b) {
  if (a == null || b == null) return null;
  const base = Math.abs(a) > 0 ? Math.abs(a) : Math.abs(b);
  if (base === 0) return 0;
  return (Math.abs(b - a) / base) * 100;
}

/**
 * Diff two flat numeric evidence snapshots field-by-field.
 * @param {Object<string,number>} before
 * @param {Object<string,number>} after
 * @param {Object} [opts]
 * @param {Object<string,number>} [opts.thresholds] - per-field threshold overrides
 * @param {string} [opts.entityLabel] - human label for the statement text
 * @param {string} [opts.categoricalBefore] - the categorical state BEFORE (if unchanged, this is the drift-under-stable-label case)
 * @param {string} [opts.categoricalAfter] - the categorical state AFTER
 */
function detectEvidenceDrift(before, after, opts = {}) {
  if (!before || !after) throw new Error('detectEvidenceDrift: before and after evidence snapshots are required');
  const thresholds = { ...FIELD_THRESHOLDS_PCT, ...(opts.thresholds || {}) };
  const entityLabel = opts.entityLabel || 'entity';
  const categoricalUnchanged = opts.categoricalBefore != null && opts.categoricalAfter != null
    ? opts.categoricalBefore === opts.categoricalAfter
    : null;

  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  const driftItems = [];
  const suppressedItems = [];

  for (const field of fields) {
    const b = before[field];
    const a = after[field];
    if (b == null || a == null) continue; // no fabricated drift from missing data
    const threshold = thresholds[field] != null ? thresholds[field] : DEFAULT_PCT;
    const isAbsolutePoints = ABSOLUTE_POINT_FIELDS.has(field);
    const delta = a - b;
    const magnitude = isAbsolutePoints ? Math.abs(delta) : relativePctChange(b, a);
    const isMaterial = magnitude != null && magnitude >= threshold;

    const item = {
      field,
      before: b,
      after: a,
      delta: Math.round(delta * 1000) / 1000,
      magnitude: magnitude == null ? null : Math.round(magnitude * 100) / 100,
      unit: isAbsolutePoints ? 'points' : 'percent_relative',
      thresholdUsed: threshold,
      material: isMaterial,
    };

    if (isMaterial) {
      item.statement = `${entityLabel}: ${field} moved from ${b} to ${a} ` +
        `(${isAbsolutePoints ? item.delta + ' pts' : item.magnitude + '% relative'}), ` +
        `exceeding the disclosed ${threshold}${isAbsolutePoints ? '-point' : '%'} materiality threshold` +
        (categoricalUnchanged === true ? `, even though the categorical state stayed "${opts.categoricalAfter}".` : '.');
      driftItems.push(item);
    } else {
      suppressedItems.push(item);
    }
  }

  return {
    entityLabel,
    categoricalBefore: opts.categoricalBefore ?? null,
    categoricalAfter: opts.categoricalAfter ?? null,
    categoricalUnchanged,
    driftDetected: driftItems.length > 0,
    driftUnderStableLabel: categoricalUnchanged === true && driftItems.length > 0,
    driftItems,
    suppressedItems, // real, disclosed — these were checked and found immaterial, not silently dropped
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { detectEvidenceDrift, FIELD_THRESHOLDS_PCT, ABSOLUTE_POINT_FIELDS, DEFAULT_PCT };
