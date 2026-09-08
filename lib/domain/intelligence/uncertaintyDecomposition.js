// FILE: lib/domain/intelligence/uncertaintyDecomposition.js
// STARLANE Multidimensional Intelligence Expansion — Capability 3:
// Uncertainty Decomposition for the real cash forecast.
//
// Ranks the top real contributors to cashConsequenceEngine.js's already-live
// cash-consequence uncertainty — specific named real customers/invoices —
// rather than reporting a single opaque confidence band. This module
// computes NO new forecast and NO new probability; it reuses:
//   - cashConsequenceEngine.js's buildCashConsequence()/buildReceivableConsequence()
//     (BASELINE/BEST-REASONABLE/STRESS cases, real open receivables)
//   - uncertainty.js's assessUncertainty() (already-attached per-case band)
// and adds only a ranked "what is driving this uncertainty" breakdown: each
// real open receivable's dollar magnitude (the spread between the
// BEST-REASONABLE and STRESS case it could swing) combined with its real
// trajectory quality, so a customer whose payment behavior is both LARGE and
// WORSENING/unverified ranks above a small, stable one. Ranking weight is a
// disclosed, simple product of (amount, worseningFlag, dataThinness) — never
// an invented percentage-of-total-uncertainty number.

const { buildCashConsequence, getOpenReceivables, buildReceivableConsequence } = require('./cashConsequenceEngine');

const WORSENING_TREND_MULTIPLIER = 1.5; // disclosed: a worsening trajectory doubles-ish this receivable's rank weight vs a stable one
const THIN_DATA_MULTIPLIER = 1.25; // disclosed: real-but-thin evidence (WEAK/INSUFFICIENT band) increases how much this receivable's true payment behavior is uncertain

async function decomposeForecastUncertainty(userId) {
  if (!userId) throw new Error('decomposeForecastUncertainty: userId is required');

  const cash = await buildCashConsequence(userId);
  if (cash.status !== 'PROJECTED') {
    return {
      userId,
      status: cash.status,
      reason: cash.reason || 'no cash forecast available to decompose',
      contributors: [],
      generatedAt: new Date().toISOString(),
    };
  }

  const receivables = await getOpenReceivables(userId);
  const consequences = await Promise.all(receivables.map(r => buildReceivableConsequence(userId, r)));

  const ranked = consequences.map(c => {
    let weight = c.currentDue;
    const reasons = [`real open amount ${c.currentDue}`];
    if (c.isWorsening) {
      weight *= WORSENING_TREND_MULTIPLIER;
      reasons.push(`worsening real credit_risk_score trend (${c.trajectory.creditRiskTrend}) applies the disclosed ${WORSENING_TREND_MULTIPLIER}x weight`);
    }
    const band = c.uncertainty.band;
    if (band === 'WEAK' || band === 'INSUFFICIENT') {
      weight *= THIN_DATA_MULTIPLIER;
      reasons.push(`thin real evidence (${band} confidence band) applies the disclosed ${THIN_DATA_MULTIPLIER}x weight`);
    }
    return {
      invoiceId: c.invoiceId,
      customerId: c.customerId,
      customerName: c.customerName,
      amount: c.currentDue,
      daysOverdue: c.daysOverdue,
      confidenceBand: band,
      trajectory: c.trajectory.creditRiskTrend,
      rankWeight: Math.round(weight * 100) / 100,
      reasons,
    };
  }).sort((a, b) => b.rankWeight - a.rankWeight);

  const total = ranked.reduce((s, r) => s + r.rankWeight, 0);
  const withShare = ranked.map(r => ({
    ...r,
    // A real relative share of the TOTAL RANK WEIGHT (a disclosed weighting
    // formula's own denominator) — explicitly NOT a probability or a share
    // of "total forecast uncertainty" in any statistical sense.
    shareOfRankedWeightPct: total > 0 ? Math.round((r.rankWeight / total) * 1000) / 10 : 0,
  }));

  return {
    userId,
    status: 'DECOMPOSED',
    forecastCases: cash.cases,
    topContributors: withShare.slice(0, 10),
    contributorCount: withShare.length,
    methodology: 'Rank weight = real open amount, multiplied by disclosed factors (worsening trajectory x1.5, thin/WEAK-or-INSUFFICIENT confidence x1.25). This is a ranking device over real evidence, never an invented percentage of statistical forecast variance.',
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { decomposeForecastUncertainty, WORSENING_TREND_MULTIPLIER, THIN_DATA_MULTIPLIER };
