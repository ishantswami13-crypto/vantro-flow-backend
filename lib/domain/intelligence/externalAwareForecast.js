// FILE: lib/domain/intelligence/externalAwareForecast.js
// STARLANE WORLD INTELLIGENCE EXPANSION — Part 28: External-aware forecast
// candidate v1.
//
// Reuses naiveBaselines.persistenceModel (never reimplemented) as the
// fallback/base prediction, and only differs from it when a real/seeded
// external exposure signal is ACTIVE for the most recent point. Mechanism
// (named, per pointEstimateGate's "knownMechanism" condition): when the
// external signal has been active during past observations, this model
// looks at the REAL historical mean of points recorded while the signal was
// active vs. while it was not, and — only if that regime split is real and
// has at least MIN_REGIME_POINTS observations on the active side — shifts
// its point prediction toward the real active-regime historical mean
// (a "regime-conditional mean" correction) and widens its interval
// proportionally to the observed regime dispersion.
//
// Registered as a tournament candidate in modelTournament.js like any other
// model — the tournament is exactly the vetting mechanism whose result
// (`beatsNaive`) feeds pointEstimateGate.checkPointEstimateGate's
// `backtestSupport` condition. This module does NOT itself decide whether an
// adjustment may reach a live-served forecast; that is pointEstimateGate's
// job, and it must still pass all 4 conditions (verified exposure, named
// mechanism, numeric sensitivity, backtest beating naive) before a real
// forecast's point estimate is allowed to move. This file only produces a
// candidate whose accuracy can be honestly measured by backtestEngine.js —
// if the regime split does not genuinely predict the outcome (case b in the
// test suite), this model is expected, and required, to lose to persistence.
//
// Input contract: each point may carry an optional `externalActive: boolean`
// field (default false/undefined = not active). This is additive — every
// other candidate model in naiveBaselines.js ignores unknown fields on
// points, so passing externalActive-tagged points through the existing
// tournament causes no change to any other candidate's behavior.

const { persistenceModel } = require('./naiveBaselines');

const MODEL_VERSION = '1.0.0';
const MIN_REGIME_POINTS = 2; // minimum real active-regime observations before trusting the conditional mean
const MECHANISM = 'Regime-conditional mean: when a real/seeded external exposure signal is ACTIVE, the point estimate shifts toward the real historical mean of prior points observed during ACTIVE periods, rather than assuming the most recent value persists unchanged.';

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}
function stddev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}

/**
 * @param {Array<{date, value, externalActive?: boolean}>} points ascending real/constructed points
 * @param {object} [opts]
 * @param {number} [opts.blendWeight] how strongly to blend toward the active-regime mean (0..1). Named/fixed, not tuned per-tenant.
 * @returns {{prediction, interval, requiredData, assumptions, modelName, modelVersion, appliedAdjustment:boolean, mechanism:string, sensitivity:number|null}}
 */
function externalAwareIntervalModel(points, opts = {}) {
  const base = persistenceModel(points);
  if (base.insufficientData) {
    return { ...base, modelName: 'external_aware_v1', appliedAdjustment: false, mechanism: MECHANISM, sensitivity: null };
  }

  const blendWeight = typeof opts.blendWeight === 'number' ? opts.blendWeight : 0.5;
  const lastPoint = points[points.length - 1];
  const externalActiveNow = !!lastPoint.externalActive;

  if (!externalActiveNow) {
    // Signal not active for the current cutoff — no honest reason to differ
    // from the persistence baseline. Never adjust in the absence of an
    // active real/seeded signal.
    return {
      ...base,
      modelName: 'external_aware_v1',
      modelVersion: MODEL_VERSION,
      appliedAdjustment: false,
      mechanism: MECHANISM,
      sensitivity: null,
      assumptions: [...(base.assumptions || []), { assumption: 'External exposure signal is not active at this cutoff; model matches persistence.', basis: 'externalActive=false on most recent point', strength: 'MODERATE' }],
    };
  }

  // Only look at PRIOR points (never the current/target one — leakage
  // boundary is still enforced by backtestEngine's slicing; this function
  // only ever receives points up to the training cutoff).
  const priorActiveValues = points.slice(0, -1).filter(p => p.externalActive).map(p => p.value);

  if (priorActiveValues.length < MIN_REGIME_POINTS) {
    // Not enough real active-regime history to trust a conditional mean —
    // honestly fall back to persistence rather than guessing a shift.
    return {
      ...base,
      modelName: 'external_aware_v1',
      modelVersion: MODEL_VERSION,
      appliedAdjustment: false,
      mechanism: MECHANISM,
      sensitivity: null,
      assumptions: [...(base.assumptions || []), { assumption: `Fewer than ${MIN_REGIME_POINTS} prior real ACTIVE-regime observations exist; insufficient to trust a conditional-mean shift.`, basis: `priorActiveCount=${priorActiveValues.length}`, strength: 'WEAK' }],
    };
  }

  const activeMean = mean(priorActiveValues);
  const activeSd = stddev(priorActiveValues);
  const lastValue = lastPoint.value;
  const prediction = lastValue + blendWeight * (activeMean - lastValue);
  const sensitivity = blendWeight; // the estimable, numeric sensitivity coefficient pointEstimateGate requires
  // Interval widens (never narrows) relative to persistence's own interval when the regime is active,
  // reflecting the real added dispersion observed in the active regime.
  const baseSd = base.interval ? (base.interval.high - base.interval.low) / 2 : 0;
  const widenedHalf = Math.max(baseSd, activeSd) * 1.5;

  return {
    prediction,
    interval: { low: prediction - widenedHalf, high: prediction + widenedHalf },
    requiredData: `at least ${MIN_REGIME_POINTS} prior real points observed during an ACTIVE external-signal regime`,
    assumptions: [
      { assumption: 'The real historical mean observed during past ACTIVE-signal periods is informative about the current ACTIVE period.', basis: `activeMean=${activeMean.toFixed(4)} over n=${priorActiveValues.length} real prior ACTIVE point(s)`, strength: priorActiveValues.length >= 4 ? 'MODERATE' : 'WEAK' },
      { assumption: 'Uncertainty is wider during an active external-signal regime than during normal persistence.', basis: `widened half-width=${widenedHalf.toFixed(4)} vs persistence half-width=${baseSd.toFixed(4)}`, strength: 'MODERATE' },
    ],
    modelName: 'external_aware_v1',
    modelVersion: MODEL_VERSION,
    appliedAdjustment: true,
    mechanism: MECHANISM,
    sensitivity,
  };
}

module.exports = { externalAwareIntervalModel, MODEL_VERSION, MECHANISM, MIN_REGIME_POINTS };
