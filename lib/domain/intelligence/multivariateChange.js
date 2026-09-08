// FILE: lib/domain/intelligence/multivariateChange.js
// STARLANE Multidimensional Intelligence Expansion — Capability 1:
// Multivariate Change Detection.
//
// Detects when MULTIPLE real dimensions move materially in a concerning
// direction AT THE SAME TIME for one tenant, producing a composite signal
// that is more significant than any single-variable alert alone would be.
// This module reuses existing proven primitives — it computes NOTHING new
// numerically:
//   - customer payment-trajectory: variables.js's getVariable() / classifyTrend()
//     (via cashConsequenceEngine.getCustomerTrajectory)
//   - customer concentration: exposureMap.js's getCustomerConcentration()
//   - cash buffer pressure: cashConsequenceEngine.js's buildCashConsequence()
//
// Each dimension is independently classified as MATERIAL_CONCERN or not,
// using thresholds already disclosed elsewhere in the codebase (never a new
// invented threshold): concentration >=25% (exposureMap's own HIGH band cut),
// overdue ratio >=30% of open receivables (a plain, disclosed fraction, not a
// statistical claim), and a WORSENING/DIRECTIONAL_CHANGE_ONLY_DOWN or
// DIRECTIONAL_CHANGE_ONLY_UP-on-a-higher-is-worse-field trend on
// credit_risk_score. A dimension with insufficient real data is marked
// INSUFFICIENT_DATA, never guessed into either bucket — it does not count
// toward or against materiality.
//
// significance:
//   NONE            - 0 of the checkable dimensions are materially concerning
//   SINGLE_DIMENSION- exactly 1 dimension is concerning (no composite effect
//                      claimed — same as an existing single-variable alert)
//   COMPOSITE       - 2+ dimensions are concerning AT THE SAME TIME for the
//                      same tenant — this is the higher-significance signal
//                      this module exists to surface, never claimed unless
//                      >=2 real, independently-material dimensions concur.

const { getPool } = require('../../db/pg');
const { buildCashConsequence, getCustomerTrajectory } = require('./cashConsequenceEngine');
const { getCustomerConcentration } = require('./exposureMap');

const CONCENTRATION_MATERIAL_PCT = 25; // reuses exposureMap's own HIGH materiality band cut
const OVERDUE_RATIO_MATERIAL = 0.30; // disclosed plain fraction, not a statistical threshold
const WORSENING_TRENDS = new Set(['DIRECTIONAL_CHANGE_ONLY_UP', 'SIMPLE_TREND_UP']); // credit_risk_score rising = worse

async function assessConcentrationDimension(userId) {
  const concentration = await getCustomerConcentration(userId).catch(e => ({ insufficientData: true, reason: e.message }));
  if (concentration.insufficientData || !concentration.top || concentration.top.length === 0) {
    return { dimension: 'customer_concentration', status: 'INSUFFICIENT_DATA', reason: concentration.reason || 'no concentration data', raw: concentration };
  }
  const top = concentration.top[0];
  const material = top.sharePct >= CONCENTRATION_MATERIAL_PCT;
  return {
    dimension: 'customer_concentration',
    status: material ? 'MATERIAL_CONCERN' : 'NOT_MATERIAL',
    reason: `top customer ${top.customerName} is ${top.sharePct}% of trailing revenue (threshold ${CONCENTRATION_MATERIAL_PCT}%)`,
    evidence: { customerId: top.customerId, customerName: top.customerName, sharePct: top.sharePct },
  };
}

async function assessCashBufferDimension(userId) {
  const cash = await buildCashConsequence(userId).catch(e => ({ status: 'ERROR', reason: e.message }));
  if (cash.status !== 'PROJECTED') {
    return { dimension: 'cash_buffer', status: 'INSUFFICIENT_DATA', reason: cash.reason || cash.status, raw: cash };
  }
  const ratio = cash.totalOpenReceivables > 0 ? cash.totalOverdue / cash.totalOpenReceivables : 0;
  const material = ratio >= OVERDUE_RATIO_MATERIAL;
  return {
    dimension: 'cash_buffer',
    status: material ? 'MATERIAL_CONCERN' : 'NOT_MATERIAL',
    reason: `${Math.round(ratio * 1000) / 10}% of open receivables (${cash.totalOverdue} of ${cash.totalOpenReceivables}) are overdue (threshold ${OVERDUE_RATIO_MATERIAL * 100}%)`,
    evidence: { totalOpenReceivables: cash.totalOpenReceivables, totalOverdue: cash.totalOverdue, overdueRatio: Math.round(ratio * 1000) / 1000 },
  };
}

async function assessPaymentTrajectoryDimension(userId, customerId) {
  if (!customerId) {
    return { dimension: 'payment_trajectory', status: 'INSUFFICIENT_DATA', reason: 'no customerId supplied to check a real trajectory against' };
  }
  const trajectory = await getCustomerTrajectory(userId, customerId).catch(e => ({ error: e.message }));
  const creditRisk = trajectory.creditRisk;
  if (!creditRisk || creditRisk.quality === 'NO_DATA' || creditRisk.trend === 'UNKNOWN') {
    return { dimension: 'payment_trajectory', status: 'INSUFFICIENT_DATA', reason: creditRisk ? (creditRisk.trendNote || 'insufficient real history points') : 'trajectory lookup failed', raw: creditRisk || null };
  }
  const material = WORSENING_TRENDS.has(creditRisk.trend);
  return {
    dimension: 'payment_trajectory',
    status: material ? 'MATERIAL_CONCERN' : 'NOT_MATERIAL',
    reason: `credit_risk_score trend is ${creditRisk.trend} (real ${creditRisk.quality === 'REAL_MULTI_POINT' ? '2+' : '1'}-point history)`,
    evidence: { customerId, trend: creditRisk.trend, value: creditRisk.value, historicalBaseline: creditRisk.historical_baseline },
  };
}

/**
 * @param {string} userId
 * @param {object} [opts]
 * @param {string} [opts.customerId] - a specific customer to check payment trajectory against (typically the top-concentration customer). If omitted, that dimension will be looked up automatically from the top concentrated customer, when one exists.
 */
async function detectMultivariateChange(userId, opts = {}) {
  if (!userId) throw new Error('detectMultivariateChange: userId is required');

  const concentrationDim = await assessConcentrationDimension(userId);
  let customerId = opts.customerId || null;
  if (!customerId && concentrationDim.evidence && concentrationDim.evidence.customerId) {
    customerId = concentrationDim.evidence.customerId;
  }
  const [cashDim, trajectoryDim] = await Promise.all([
    assessCashBufferDimension(userId),
    assessPaymentTrajectoryDimension(userId, customerId),
  ]);

  const dimensions = [concentrationDim, cashDim, trajectoryDim];
  const checkable = dimensions.filter(d => d.status !== 'INSUFFICIENT_DATA');
  const concerning = checkable.filter(d => d.status === 'MATERIAL_CONCERN');

  let significance;
  if (checkable.length === 0) significance = 'INSUFFICIENT_DATA';
  else if (concerning.length === 0) significance = 'NONE';
  else if (concerning.length === 1) significance = 'SINGLE_DIMENSION';
  else significance = 'COMPOSITE';

  return {
    userId,
    dimensions,
    checkableDimensionCount: checkable.length,
    concerningDimensionCount: concerning.length,
    significance,
    isCompositeSignal: significance === 'COMPOSITE',
    statement: significance === 'COMPOSITE'
      ? `${concerning.length} real dimensions (${concerning.map(d => d.dimension).join(', ')}) are concurrently material for this tenant — a higher-significance composite signal, not just one isolated alert.`
      : significance === 'SINGLE_DIMENSION'
        ? `Only 1 real dimension (${concerning[0].dimension}) is material — no composite effect, equivalent to an existing single-variable alert.`
        : significance === 'NONE'
          ? 'No real dimension currently crosses its disclosed materiality threshold for this tenant.'
          : 'Insufficient real data across all checkable dimensions for this tenant — no composite claim made.',
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { detectMultivariateChange, CONCENTRATION_MATERIAL_PCT, OVERDUE_RATIO_MATERIAL };
