// FILE: lib/domain/intelligence/opportunityPropagation.js
// STARLANE Multidimensional Intelligence Expansion — Capability 5:
// Opportunity Propagation Chain.
//
// A structured UPSIDE chain, the mirror image of worldEventConsequence.js's
// downside chain: demand-rising + supplier-stable -> bounded opportunity.
// Every step is labeled OBSERVED (a real stored fact/aggregate) or DERIVED
// (a real computed comparison), and the final statement is ALWAYS qualified
// as a bounded possibility, NEVER guaranteed revenue — this is enforced by
// construction (the word "guaranteed" and any percentage-certainty language
// never appear in the output).
//
// Step 1 — demand rising: real sales revenue over the most recent 30-day
//          window vs the prior 30-day window (a plain real comparison, reused
//          from exposureMap.js's REVENUE_WINDOW_DAYS constant so the window
//          matches the rest of the codebase's revenue intelligence).
// Step 2 — supplier stability: reuses worldEventConsequence.js's
//          widenSupplierUncertaintyFromEvent — a NO_EFFECT result (no real
//          active event/exposure widening this supplier's uncertainty) is
//          the real, honest signal for "stable", never assumed by default.
// Step 3 — bounded opportunity: only asserted when BOTH real steps support
//          it; otherwise the chain honestly stops and says so.
//
// Real sales/customer data is used where available. Per the mission, if real
// data is too sparse for a full real chain for a given tenant, this module
// still only reads the real DB — it never fabricates data internally. A
// caller (e.g. the test suite) that needs to DEMONSTRATE the full chain end
// to end may seed real rows into the real dev DB as a clearly-labeled test
// fixture; that is a data-seeding decision made by the caller, not by this
// module inventing numbers.

const { getPool } = require('../../db/pg');
const { REVENUE_WINDOW_DAYS } = require('../../services/orchestrator/revenueIntelligence.service');
const { widenSupplierUncertaintyFromEvent } = require('../../world/worldEventConsequence');
const { IMPACT_MODES } = require('../../world/externalSignal');

const DEMAND_RISING_MATERIAL_PCT = 10; // disclosed: a <10% window-over-window change is treated as noise, not "rising"

async function checkDemandRisingStep(userId) {
  const pool = getPool();
  const now = Date.now();
  const recentStart = new Date(now - REVENUE_WINDOW_DAYS * 86400000).toISOString();
  const priorStart = new Date(now - 2 * REVENUE_WINDOW_DAYS * 86400000).toISOString();

  const [recentRes, priorRes] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total, COUNT(*)::int AS n FROM sales WHERE user_id = $1 AND sale_date >= $2`, [userId, recentStart]),
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total, COUNT(*)::int AS n FROM sales WHERE user_id = $1 AND sale_date >= $2 AND sale_date < $3`, [userId, priorStart, recentStart]),
  ]);
  const recentTotal = Number(recentRes.rows[0].total);
  const recentN = recentRes.rows[0].n;
  const priorTotal = Number(priorRes.rows[0].total);
  const priorN = priorRes.rows[0].n;

  if (recentN === 0 || priorN === 0) {
    return {
      step: 'demand_rising', label: 'INSUFFICIENT_DATA', supported: false,
      reason: `need real sales in both the trailing and prior ${REVENUE_WINDOW_DAYS}-day windows to compare (recent=${recentN} rows, prior=${priorN} rows)`,
    };
  }

  const pctChange = priorTotal > 0 ? ((recentTotal - priorTotal) / priorTotal) * 100 : (recentTotal > 0 ? 100 : 0);
  const rising = pctChange >= DEMAND_RISING_MATERIAL_PCT;

  return {
    step: 'demand_rising',
    label: 'DERIVED',
    supported: rising,
    reason: `trailing ${REVENUE_WINDOW_DAYS}d real sales (${Math.round(recentTotal)}) vs prior ${REVENUE_WINDOW_DAYS}d (${Math.round(priorTotal)}) is a ${Math.round(pctChange * 10) / 10}% change (threshold +${DEMAND_RISING_MATERIAL_PCT}%)`,
    evidence: { recentTotal: Math.round(recentTotal), priorTotal: Math.round(priorTotal), recentCount: recentN, priorCount: priorN, pctChange: Math.round(pctChange * 10) / 10 },
  };
}

async function checkSupplierStableStep(userId, supplierId) {
  if (!supplierId) {
    return { step: 'supplier_stable', label: 'INSUFFICIENT_DATA', supported: false, reason: 'no supplierId supplied to check stability against' };
  }
  const widened = await widenSupplierUncertaintyFromEvent({ userId, supplierId }).catch(e => ({ impact_mode: 'ERROR', reason: e.message }));
  if (widened.impact_mode === 'ERROR') {
    return { step: 'supplier_stable', label: 'ERROR', supported: false, reason: widened.reason };
  }
  const stable = widened.impact_mode === IMPACT_MODES.NO_EFFECT;
  return {
    step: 'supplier_stable',
    label: 'OBSERVED',
    supported: stable,
    reason: stable
      ? `no real active event/exposure widens this supplier's uncertainty: ${widened.reason}`
      : `this supplier currently has a real widened-uncertainty condition, so stability cannot be asserted: ${widened.reason}`,
  };
}

/**
 * @param {string} userId
 * @param {object} [opts]
 * @param {string} [opts.supplierId] - a supplier to check for stability (step 2). If omitted, step 2 reports INSUFFICIENT_DATA and the chain cannot complete.
 */
async function buildOpportunityChain(userId, opts = {}) {
  if (!userId) throw new Error('buildOpportunityChain: userId is required');

  const [demandStep, supplierStep] = await Promise.all([
    checkDemandRisingStep(userId),
    checkSupplierStableStep(userId, opts.supplierId),
  ]);

  const steps = [demandStep, supplierStep];
  const chainSupported = demandStep.supported && supplierStep.supported;
  const anyInsufficient = steps.some(s => s.label === 'INSUFFICIENT_DATA' || s.label === 'ERROR');

  return {
    userId,
    supplierId: opts.supplierId || null,
    steps,
    chainSupported,
    status: anyInsufficient ? 'INSUFFICIENT_DATA' : (chainSupported ? 'BOUNDED_OPPORTUNITY' : 'NO_OPPORTUNITY_SIGNAL'),
    statement: anyInsufficient
      ? 'Insufficient real data to evaluate the full opportunity chain for this tenant — no opportunity claim made.'
      : chainSupported
        ? `Real demand is rising (${demandStep.reason}) while the named real supplier shows no active stability concern (${supplierStep.reason}). This is a BOUNDED, non-guaranteed opportunity signal — it is not a revenue forecast and carries no guarantee of realized upside.`
        : 'Real data does not currently support both legs of the opportunity chain — no opportunity asserted.',
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildOpportunityChain, checkDemandRisingStep, checkSupplierStableStep, DEMAND_RISING_MATERIAL_PCT };
