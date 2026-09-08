// FILE: lib/world/pointEstimateGate.js
// STARLANE WORLD INTELLIGENCE EXPANSION — Part 4: Point-Estimate Adjustment Gate.
//
// Makes explicit a discipline that fxScenarioEngine.js and
// worldEventConsequence.js already implicitly follow: NOTHING may touch a
// point estimate (a forecast's central number) on the strength of an
// external signal alone. Four conditions must ALL hold. Absent any one,
// the caller must fall back to SCENARIO_ONLY / RANGE_WIDENING /
// INSUFFICIENT_CONTEXT / NO_EFFECT — never POINT_ESTIMATE_ADJUSTMENT.
//
// Pure function, no DB access, no side effects.

const { IMPACT_MODES } = require('./externalSignal');

/**
 * @param {object} params
 * @param {boolean} params.verifiedExposure - a real (or explicitly seeded)
 *   business_exposure row ties this tenant to the signal's subject.
 * @param {string|null} params.mechanism - a named, documented causal
 *   mechanism (e.g. "FX move repriced foreign-currency payables 1:1").
 * @param {number|null} params.sensitivity - an estimable, numeric
 *   sensitivity coefficient (how much the variable moves per unit of signal).
 * @param {object|null} params.backtestSupport - result of running the
 *   candidate adjustment through backtestEngine.js; must show the adjusted
 *   candidate beating (or at least not losing to) a naive baseline on real
 *   historical data. Shape: { evaluated: boolean, beatsNaive: boolean, sampleSize: number }.
 * @returns {{ allowed: boolean, maxImpactMode: string, failedConditions: string[], reasons: object }}
 */
function checkPointEstimateGate({ verifiedExposure, mechanism, sensitivity, backtestSupport } = {}) {
  const conditions = {
    verifiedExposure: !!verifiedExposure,
    knownMechanism: typeof mechanism === 'string' && mechanism.trim().length > 0,
    estimableSensitivity: typeof sensitivity === 'number' && Number.isFinite(sensitivity),
    backtestSupport: !!(backtestSupport && backtestSupport.evaluated && backtestSupport.beatsNaive && Number(backtestSupport.sampleSize) >= 1),
  };

  const failedConditions = Object.entries(conditions)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

  const allowed = failedConditions.length === 0;

  // Degrade gracefully: pick the strongest honest impact_mode available given
  // which conditions are met, never higher than what's earned.
  let maxImpactMode;
  if (allowed) {
    maxImpactMode = IMPACT_MODES.POINT_ESTIMATE_ADJUSTMENT;
  } else if (!conditions.verifiedExposure) {
    maxImpactMode = IMPACT_MODES.NO_EFFECT;
  } else if (!conditions.knownMechanism || !conditions.estimableSensitivity) {
    maxImpactMode = IMPACT_MODES.INSUFFICIENT_CONTEXT;
  } else {
    // exposure + mechanism + sensitivity known, but backtest doesn't support it yet
    maxImpactMode = IMPACT_MODES.SCENARIO_ONLY;
  }

  return {
    allowed,
    maxImpactMode,
    failedConditions,
    reasons: {
      verifiedExposure: conditions.verifiedExposure ? 'exposure verified' : 'no verified (real or seeded) exposure row ties this tenant to the signal subject',
      knownMechanism: conditions.knownMechanism ? 'mechanism named' : 'no named causal mechanism supplied',
      estimableSensitivity: conditions.estimableSensitivity ? 'sensitivity is a finite number' : 'sensitivity coefficient missing or not numeric',
      backtestSupport: conditions.backtestSupport ? 'backtest shows the adjustment beating a naive baseline on real historical data' : 'no backtest evidence (or it does not beat naive) supports this adjustment',
    },
  };
}

module.exports = { checkPointEstimateGate };
