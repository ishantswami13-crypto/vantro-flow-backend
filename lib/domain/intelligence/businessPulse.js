// FILE: lib/domain/intelligence/businessPulse.js
// STARLANE — Irresistible Value Engine, Capability B (part 1): Business Pulse.
//
// PURE COMPOSITION, same discipline as revelationEngine.js. This module
// invents no new detection/scoring math — every component is built by
// calling an existing, already-verified module and re-shaping its real
// output into one of a small set of qualitative labels. A component with no
// real supporting evidence reports INSUFFICIENT_DATA — it NEVER gets
// defaulted to a fabricated neutral/'OK' value.
//
// Output is DECOMPOSABLE by design (mission requirement: "not one opaque
// score"): the caller gets 8 named components, each independently labeled
// and independently evidenced, plus one OVERALL category derived
// transparently from how many real components moved and in which direction
// — never a weighted numeric blend that would hide which factor drove it
// (same posture as lib/world/materiality.js's composition_policy).

const { safeLog } = require('../../observability/logger');
const { buildCashConsequence } = require('./cashConsequenceEngine');
const { getCustomerConcentration, getSupplierConcentration } = require('./exposureMap');
const { detectContradictions } = require('./contradictionDetection');
const { forecastCashPositionV2 } = require('./forecastEngine');
const { widenSupplierUncertaintyFromEvent } = require('../../world/worldEventConsequence');
const { getPool } = require('../../db/pg');

const INSUFFICIENT = 'INSUFFICIENT_DATA';

function component(name, state, headline, evidence, extra = {}) {
  return { name, state, headline, evidence, ...extra };
}

// --- 1. Cash stability -------------------------------------------------
// Reuses cashConsequenceEngine.buildCashConsequence's three bounded cases.
// A meaningful gap between baseline and stress (relative to total open
// receivables) is read as instability; a small/zero gap is stable.
function cashStabilityComponent(cashConsequence) {
  if (!cashConsequence || cashConsequence.status !== 'PROJECTED') {
    return component('cashStability', INSUFFICIENT, 'No open receivables to assess cash stability from.', null);
  }
  const { cases, totalOpenReceivables } = cashConsequence;
  const stress = Math.abs(cases.stress.cashImpact);
  const baseline = Math.abs(cases.baseline.cashImpact);
  const gap = stress - baseline;
  const gapPct = totalOpenReceivables > 0 ? Math.round((gap / totalOpenReceivables) * 1000) / 10 : 0;
  let state;
  if (totalOpenReceivables === 0) state = INSUFFICIENT;
  else if (gapPct <= 5) state = 'STABLE';
  else if (gapPct <= 30) state = 'WATCH';
  else state = 'FRAGILE';
  return component(
    'cashStability',
    state,
    state === INSUFFICIENT
      ? 'No open receivables recorded.'
      : `Stress case exceeds baseline by ${gapPct}% of total open receivables (${Math.round(gap)} of ${Math.round(totalOpenReceivables)}).`,
    { totalOpenReceivables, totalOverdue: cashConsequence.totalOverdue, cases, gapPct },
  );
}

// --- 2. Collection health -----------------------------------------------
// Reuses cashConsequenceEngine's real overdue totals — never a new aging
// computation.
function collectionHealthComponent(cashConsequence) {
  if (!cashConsequence || cashConsequence.status !== 'PROJECTED') {
    return component('collectionHealth', INSUFFICIENT, 'No open receivables to assess collection health from.', null);
  }
  const { totalOpenReceivables, totalOverdue } = cashConsequence;
  if (totalOpenReceivables === 0) {
    return component('collectionHealth', INSUFFICIENT, 'No open receivables recorded.', { totalOpenReceivables, totalOverdue });
  }
  const overduePct = Math.round((totalOverdue / totalOpenReceivables) * 1000) / 10;
  const state = overduePct === 0 ? 'STABLE' : overduePct <= 20 ? 'WATCH' : 'FRAGILE';
  return component(
    'collectionHealth',
    state,
    `${overduePct}% of open receivables (${Math.round(totalOverdue)} of ${Math.round(totalOpenReceivables)}) are overdue.`,
    { totalOpenReceivables, totalOverdue, overduePct },
  );
}

// --- 3. Customer concentration -------------------------------------------
function customerConcentrationComponent(concentration) {
  if (!concentration || concentration.insufficientData) {
    return component('customerConcentration', INSUFFICIENT, concentration ? concentration.reason : 'No customer concentration data.', null);
  }
  const top = concentration.top && concentration.top[0];
  const sharePct = top ? top.sharePct : 0;
  const state = sharePct >= 50 ? 'FRAGILE' : sharePct >= 25 ? 'WATCH' : 'STABLE';
  return component(
    'customerConcentration',
    state,
    top ? `Top customer (${top.customerName}) is ${sharePct}% of trailing revenue.` : 'No concentrated customer identified.',
    { top: concentration.top, windowDays: concentration.windowDays },
  );
}

// --- 4. Supplier dependency ----------------------------------------------
function supplierDependencyComponent(concentration) {
  if (!concentration || concentration.insufficientData) {
    return component('supplierDependency', INSUFFICIENT, concentration ? concentration.reason : 'No supplier spend data.', null);
  }
  const top = concentration.top && concentration.top[0];
  const sharePct = top ? top.sharePct : 0;
  const state = sharePct >= 50 ? 'FRAGILE' : sharePct >= 25 ? 'WATCH' : 'STABLE';
  return component(
    'supplierDependency',
    state,
    top ? `Top supplier (${top.supplierName}) is ${sharePct}% of real purchase spend.` : 'No concentrated supplier identified.',
    { top: concentration.top },
  );
}

// --- 5. Operational risk --------------------------------------------------
// Reuses contradictionDetection.js's real structural findings only.
function operationalRiskComponent(contradictions) {
  if (!contradictions) {
    return component('operationalRisk', INSUFFICIENT, 'Contradiction detection did not run.', null);
  }
  const state = contradictions.contradictionCount === 0 ? 'STABLE' : contradictions.contradictionCount <= 2 ? 'WATCH' : 'FRAGILE';
  return component(
    'operationalRisk',
    state,
    contradictions.contradictionCount === 0
      ? 'No data-integrity contradictions detected.'
      : `${contradictions.contradictionCount} real data-integrity contradiction(s) detected (e.g. ${contradictions.contradictions[0].claim}).`,
    { contradictionCount: contradictions.contradictionCount, contradictions: contradictions.contradictions },
  );
}

// --- 6. Forecast stability -------------------------------------------------
// Reuses forecastEngine.forecastCashPositionV2's own model-tournament result
// and uncertainty band — never a new forecast-quality metric.
function forecastStabilityComponent(forecast) {
  if (!forecast) {
    return component('forecastStability', INSUFFICIENT, 'Cash forecast did not run.', null);
  }
  if (forecast.data_quality === 'IMPLEMENTED_BUT_DATA_INSUFFICIENT_FOR_MODEL_SELECTION') {
    return component('forecastStability', INSUFFICIENT, 'Insufficient real resolved-payment history to select a forecast model.', { model_selected: forecast.model_selected, uncertainty_band: forecast.uncertainty_band });
  }
  const band = forecast.uncertainty_band;
  const state = band === 'VERIFIED' || band === 'STRONG' ? 'STABLE' : band === 'MODERATE' ? 'WATCH' : 'FRAGILE';
  return component(
    'forecastStability',
    state,
    `Cash forecast model '${forecast.model_selected}' carries uncertainty band '${band}'.`,
    { model_selected: forecast.model_selected, uncertainty_band: band, historical_performance: forecast.historical_performance ? { mae: forecast.historical_performance.winner?.backtest?.mae, wape: forecast.historical_performance.winner?.backtest?.wape } : null },
  );
}

// --- 7. World exposure -----------------------------------------------------
// Reuses worldEventConsequence.js's real EVENT->EXPOSURE chain check per
// top supplier. Never invents a world-risk claim without a real chain.
async function worldExposureComponent(userId, supplierConcentration) {
  const top = supplierConcentration && !supplierConcentration.insufficientData ? supplierConcentration.top[0] : null;
  if (!top) {
    return component('worldExposure', INSUFFICIENT, 'No supplier data to assess world-event exposure against.', null);
  }
  try {
    const widened = await widenSupplierUncertaintyFromEvent({ userId, supplierId: top.supplierId });
    if (widened.impact_mode === 'RANGE_WIDENING') {
      return component('worldExposure', 'WATCH', `Real world event matched to real exposure for top supplier (${top.supplierName}); operational uncertainty widened.`, { chains: widened.chains, supplier: widened.supplier });
    }
    return component('worldExposure', 'STABLE', 'No real world-event chain currently matches top supplier exposure.', { supplierId: top.supplierId, supplierName: top.supplierName });
  } catch (e) {
    safeLog('warn', '[BusinessPulse] worldExposure failed', { userId, error: e.message });
    return component('worldExposure', INSUFFICIENT, 'World-event exposure check failed to run.', null);
  }
}

// --- 8. Data quality ---------------------------------------------------
// Honest meta-component: how much real evidence backed the OTHER components.
function dataQualityComponent(components) {
  const evaluable = components.filter(c => c.state !== INSUFFICIENT);
  const total = components.length;
  const pct = total > 0 ? Math.round((evaluable.length / total) * 100) : 0;
  const state = pct >= 75 ? 'STABLE' : pct >= 40 ? 'WATCH' : 'FRAGILE';
  return component(
    'dataQuality',
    state,
    `${evaluable.length} of ${total} components had sufficient real data to evaluate (${pct}%).`,
    { evaluableCount: evaluable.length, totalComponents: total, pct },
  );
}

const OVERALL_RANK = { FRAGILE: 3, WATCH: 2, STABLE: 1, [INSUFFICIENT]: 0 };

/**
 * Compose the Business Pulse for one tenant. Never throws — a failed source
 * degrades that one component to INSUFFICIENT_DATA (fail-closed), matching
 * revelationEngine.js's Promise.allSettled convention.
 *
 * @param {string} userId
 * @returns {Promise<{userId, overall, why, components, generatedAt}>}
 */
async function buildBusinessPulse(userId) {
  if (!userId) throw new Error('buildBusinessPulse: userId is required');

  const [cashResult, custConcResult, suppConcResult, contradictionResult, forecastResult] = await Promise.allSettled([
    buildCashConsequence(userId),
    getCustomerConcentration(userId).catch(e => ({ insufficientData: true, reason: e.message })),
    getSupplierConcentration(userId).catch(e => ({ insufficientData: true, reason: e.message })),
    detectContradictions(userId),
    forecastCashPositionV2(userId, { horizonDays: 30, asOf: new Date().toISOString() }),
  ]);

  const cashConsequence = cashResult.status === 'fulfilled' ? cashResult.value : null;
  if (cashResult.status === 'rejected') safeLog('warn', '[BusinessPulse] cashConsequence failed', { userId, error: cashResult.reason?.message });

  const customerConcentration = custConcResult.status === 'fulfilled' ? custConcResult.value : { insufficientData: true };
  const supplierConcentration = suppConcResult.status === 'fulfilled' ? suppConcResult.value : { insufficientData: true };

  const contradictions = contradictionResult.status === 'fulfilled' ? contradictionResult.value : null;
  if (contradictionResult.status === 'rejected') safeLog('warn', '[BusinessPulse] contradictions failed', { userId, error: contradictionResult.reason?.message });

  const forecast = forecastResult.status === 'fulfilled' ? forecastResult.value : null;
  if (forecastResult.status === 'rejected') safeLog('warn', '[BusinessPulse] forecast failed', { userId, error: forecastResult.reason?.message });

  const worldExposure = await worldExposureComponent(userId, supplierConcentration);

  const components = [
    cashStabilityComponent(cashConsequence),
    collectionHealthComponent(cashConsequence),
    customerConcentrationComponent(customerConcentration),
    supplierDependencyComponent(supplierConcentration),
    operationalRiskComponent(contradictions),
    forecastStabilityComponent(forecast),
    worldExposure,
  ];
  components.push(dataQualityComponent(components));

  // NOTE on the overall category: this function computes a POINT-IN-TIME
  // snapshot, not a trend. "IMPROVING" would require comparing against a
  // prior snapshot, which this module deliberately does not fabricate —
  // that comparison is whatChangedSinceLastLook.js's job (it diffs two real
  // Business Pulse snapshots and is the only place 'IMPROVING' is emitted
  // here for a tenant that was previously WORSENING/WATCH and no longer is).
  // A bare call to buildBusinessPulse therefore only ever returns
  // WORSENING / STABLE / INSUFFICIENT_DATA — never a fabricated IMPROVING.
  const evaluable = components.filter(c => c.state !== INSUFFICIENT && c.name !== 'dataQuality');
  let overall;
  let why;
  if (evaluable.length === 0) {
    overall = INSUFFICIENT;
    why = 'No component had sufficient real data to evaluate — this tenant has not yet recorded enough sales/purchase/invoice activity for a Business Pulse.';
  } else {
    const fragileCount = evaluable.filter(c => c.state === 'FRAGILE').length;
    const watchCount = evaluable.filter(c => c.state === 'WATCH').length;
    if (fragileCount > 0) {
      overall = 'WORSENING';
      const worst = evaluable.filter(c => c.state === 'FRAGILE').map(c => c.name).join(', ');
      why = `${fragileCount} component(s) are FRAGILE: ${worst}. See each component's headline/evidence for the underlying real numbers.`;
    } else if (watchCount > 0) {
      overall = 'STABLE';
      const watching = evaluable.filter(c => c.state === 'WATCH').map(c => c.name).join(', ');
      why = `All components are STABLE or WATCH; keep an eye on: ${watching}.`;
    } else {
      overall = 'STABLE';
      why = `All ${evaluable.length} evaluable component(s) are STABLE, with no FRAGILE or WATCH signals from real data.`;
    }
  }

  return {
    userId,
    overall,
    why,
    components,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildBusinessPulse, OVERALL_RANK, INSUFFICIENT };
