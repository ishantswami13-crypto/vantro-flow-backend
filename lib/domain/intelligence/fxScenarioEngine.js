// FILE: lib/domain/intelligence/fxScenarioEngine.js
// STARLANE Day 4 — Part 7: FX integration path (SEEDED ONLY).
//
// Full chain: FX_SIGNAL -> REAL_CURRENCY_EXPOSURE -> PURCHASE_COST_SCENARIO
// -> CASH_OUTFLOW_SCENARIO -> CASH_FORECAST_EFFECT.
//
// This module NEVER writes to business_exposure or predictions — it is pure
// computation over inputs the caller supplies. A caller (test or future
// route) is responsible for creating/cleaning up any seeded exposure row.
// Every output here is labeled kind: 'SCENARIO' and impact_mode is always
// SCENARIO_ONLY or NO_EFFECT — never POINT_ESTIMATE_ADJUSTMENT — because a
// single FX move is a hypothetical to weigh, not a fact to bake into the
// real point forecast without much stronger corroboration than one signal.

const { IMPACT_MODES, CAUSAL_LABELS } = require('../../world/externalSignal');

/**
 * @param {object} fxSignal - normalized externalSignal with signal_type FX
 * @param {object|null} currencyExposure - a business_exposure row with
 *   exposure_type CURRENCY_DENOMINATED for this tenant, or null if none
 *   exists (the real-tenant case today).
 * @param {number} openPayablesInExposedCurrency - real sum of open
 *   payables/purchase amounts denominated in the exposed currency (0 if
 *   none, which is also the honest real-tenant case).
 */
function buildFxScenarioChain({ fxSignal, currencyExposure, openPayablesInExposedCurrency = 0 }) {
  if (!currencyExposure) {
    return {
      impact_mode: IMPACT_MODES.NO_EFFECT,
      label: CAUSAL_LABELS.OBSERVED,
      chain: null,
      reason: 'No CURRENCY_DENOMINATED business_exposure row exists for this tenant — reuses fxExposureNarrative.js\'s existing zero-exposure finding. An FX signal cannot affect a forecast with no real exposure to it.',
    };
  }
  if (!openPayablesInExposedCurrency || openPayablesInExposedCurrency <= 0) {
    return {
      impact_mode: IMPACT_MODES.INSUFFICIENT_CONTEXT,
      label: CAUSAL_LABELS.EXPOSED,
      chain: { FX_SIGNAL: fxSignal, REAL_CURRENCY_EXPOSURE: currencyExposure },
      reason: 'A currency exposure exists but no real open payables amount in that currency was supplied — cannot construct a cost scenario without a real amount to apply the FX move to.',
    };
  }

  const pctMove = Number(fxSignal?.magnitude) || 0; // e.g. 0.05 = 5% move
  const direction = fxSignal?.direction === 'DOWN' ? -1 : 1;
  const costDeltaLow = openPayablesInExposedCurrency * pctMove * direction * 0.5; // scenario range, not a point claim
  const costDeltaHigh = openPayablesInExposedCurrency * pctMove * direction * 1.5;

  const purchaseCostScenario = {
    kind: 'SCENARIO',
    basis: `Real open payables of ${openPayablesInExposedCurrency} in exposed currency, hypothetically re-priced by the observed FX move magnitude ${pctMove} (${fxSignal?.direction || 'unknown direction'}).`,
    costDeltaRange: { low: Math.min(costDeltaLow, costDeltaHigh), high: Math.max(costDeltaLow, costDeltaHigh) },
  };

  const cashOutflowScenario = {
    kind: 'SCENARIO',
    basis: 'Purchase cost scenario range applied 1:1 to cash outflow timing already implied by the real payables (no new timing assumption introduced).',
    outflowDeltaRange: purchaseCostScenario.costDeltaRange,
  };

  return {
    impact_mode: IMPACT_MODES.SCENARIO_ONLY,
    label: CAUSAL_LABELS.SCENARIO,
    chain: {
      FX_SIGNAL: fxSignal,
      REAL_CURRENCY_EXPOSURE: currencyExposure,
      PURCHASE_COST_SCENARIO: purchaseCostScenario,
      CASH_OUTFLOW_SCENARIO: cashOutflowScenario,
      CASH_FORECAST_EFFECT: {
        kind: 'SCENARIO',
        note: 'This is a labeled scenario overlay only. It never mutates the real point-estimate cash forecast or any OBSERVED/DERIVED tenant state — it is presented alongside the real forecast as a what-if range.',
        rangeWidening: cashOutflowScenario.outflowDeltaRange,
      },
    },
    reason: 'Full seeded FX chain constructed from a real (test-seeded) currency exposure row and a supplied real payables amount.',
  };
}

module.exports = { buildFxScenarioChain };
