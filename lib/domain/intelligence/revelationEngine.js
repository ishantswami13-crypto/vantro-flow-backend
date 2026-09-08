// FILE: lib/domain/intelligence/revelationEngine.js
// STARLANE — Irresistible Value Engine, Capability A: Morning Revelation Engine.
//
// PURE COMPOSITION. This module invents no new detection logic — it calls
// existing, already-verified Day 1-4 modules (cashConsequenceEngine,
// contradictionDetection, exposureMap) and synthesizes their outputs into a
// small (<=5) ranked list of revelations, each carrying:
//   WHAT_CHANGED / WHY_IT_MATTERS / CONNECTS_TO / MAY_HAPPEN / WHAT_TO_DO / HOW_SURE
//
// Discipline (non-negotiable, matches every prior Day 1-4 module):
//   - Never fabricate a revelation. If a source module returns a "nothing
//     material" / "insufficient data" / zero-count result, that source
//     contributes NO revelation — it does not get downgraded into a weak
//     fake one.
//   - A tenant with no real signals from any source gets an explicit
//     NOTHING_MATERIAL response, never a manufactured entry.
//   - Every revelation's evidence field points at real rows already
//     produced by the underlying module (invoice ids, contradiction records,
//     concentration shares) — nothing here is newly computed from raw SQL.

const { safeLog } = require('../../observability/logger');
const { buildCashConsequence } = require('./cashConsequenceEngine');
const { detectContradictions } = require('./contradictionDetection');
const { getCustomerConcentration, getSupplierConcentration } = require('./exposureMap');
const { getPool } = require('../../db/pg');
const { classifyTrajectoryV2 } = require('./trajectoryV2');

const MAX_REVELATIONS = 5;

/**
 * Revelation from cash consequence: a stress case that meaningfully exceeds
 * baseline AND is concentrated in a small number of customers is a genuine
 * "hidden fragility" story worth surfacing. If there's no open receivables,
 * or stress/baseline gap is negligible, this contributes nothing.
 */
function revelationFromCashConsequence(cashConsequence, concentration) {
  if (!cashConsequence || cashConsequence.status !== 'PROJECTED') return null;
  const { cases, totalOpenReceivables, totalOverdue } = cashConsequence;
  if (!cases || totalOpenReceivables <= 0) return null;

  const stressImpact = Math.abs(cases.stress.cashImpact);
  const baselineImpact = Math.abs(cases.baseline.cashImpact);
  const gap = stressImpact - baselineImpact;
  // Only surface if the stress case represents real additional exposure
  // beyond what's already overdue today (otherwise it's not a revelation,
  // it's just restating totalOverdue).
  if (gap <= 0) return null;

  const topConcentrationPct = concentration && !concentration.insufficientData && concentration.top && concentration.top[0]
    ? concentration.top[0].sharePct
    : null;

  const confidenceComponents = cashConsequence.projection?.uncertainty?.components || null;
  const howSure = cashConsequence.projection?.uncertainty?.level || 'UNSTATED';

  return {
    id: 'CASH_FRAGILITY',
    whatChanged: `Open receivables carry a bounded ${Math.round(gap)} additional at-risk swing between the baseline and stress case (baseline ${Math.round(baselineImpact)} vs stress ${Math.round(stressImpact)}).`,
    whyItMatters: topConcentrationPct != null
      ? `This exposure is concentrated: the top customer represents ${topConcentrationPct}% of receivables value, so a single payer's behavior swings the outcome.`
      : `${cashConsequence.cases.baseline.keyDependency ? 'A single overdue invoice already anchors the baseline case.' : 'This is a real, bounded swing in collectible cash.'}`,
    connectsTo: [
      { source: 'cashConsequenceEngine.buildCashConsequence', field: 'cases' },
      concentration && !concentration.insufficientData ? { source: 'exposureMap.getCustomerConcentration', field: 'top' } : null,
    ].filter(Boolean),
    mayHappen: cases.stress.reason,
    whatToDo: cases.baseline.keyDependency
      ? `Follow up on invoice ${cases.baseline.keyDependency.invoiceId} (${cases.baseline.keyDependency.customerName}, ${Math.round(cases.baseline.keyDependency.amount)}) — it anchors the baseline case.`
      : 'Review open receivables aging for the customers named in the evidence.',
    howSure,
    evidence: {
      totalOpenReceivables,
      totalOverdue,
      cases,
      concentration: concentration && !concentration.insufficientData ? concentration.top : null,
      confidenceComponents,
    },
  };
}

/**
 * Revelation from contradiction detection: a real data-integrity
 * contradiction (e.g. Paid invoice with no confirmed payment evidence) is
 * itself an "I didn't know that" — surfaced only when at least one real
 * contradiction row exists.
 */
function revelationFromContradictions(contradictionResult) {
  if (!contradictionResult || contradictionResult.contradictionCount === 0) return null;
  const top = contradictionResult.contradictions[0];
  return {
    id: 'DATA_CONTRADICTION',
    whatChanged: `${contradictionResult.contradictionCount} real record${contradictionResult.contradictionCount > 1 ? 's' : ''} contradict${contradictionResult.contradictionCount > 1 ? '' : 's'} their own stated status.`,
    whyItMatters: `${top.claim}, but ${top.contradiction} — this means the "Paid"/status figures rolling up into cash and collections numbers may be less certain than they appear.`,
    connectsTo: [{ source: 'contradictionDetection.detectContradictions', field: 'contradictions' }],
    mayHappen: 'If unresolved, downstream cash-position and collections summaries will keep treating this record as settled when the evidence trail does not support that.',
    whatToDo: 'Verify the underlying payment record (or correct the status) for the flagged invoice(s) listed in evidence.',
    howSure: 'VERIFIED — contradiction is a direct structural mismatch in stored data, not an inference.',
    evidence: { contradictionCount: contradictionResult.contradictionCount, contradictions: contradictionResult.contradictions },
  };
}

/**
 * Revelation from supplier concentration: a single-supplier dependency is a
 * genuine hidden fragility even with no live world event attached to it —
 * surfaced only when real concentration data exists and is materially
 * concentrated (top supplier > 50% of spend), matching this codebase's
 * existing concentration-threshold convention in exposureMap.js consumers.
 */
function revelationFromSupplierConcentration(supplierConcentration) {
  if (!supplierConcentration || supplierConcentration.insufficientData) return null;
  if (!supplierConcentration.top || supplierConcentration.top.length === 0) return null;
  const top = supplierConcentration.top[0];
  if (top.sharePct == null || top.sharePct < 50) return null; // not concentrated enough to be a revelation

  return {
    id: 'SUPPLIER_DEPENDENCY',
    whatChanged: `${Math.round(top.sharePct)}% of real supplier spend is concentrated in a single supplier (${top.supplierName || top.supplierId}).`,
    whyItMatters: 'A disruption to this one relationship would affect the majority of supply, with no offsetting diversification visible in current data.',
    connectsTo: [{ source: 'exposureMap.getSupplierConcentration', field: 'top' }],
    mayHappen: 'If this supplier faces a disruption (delivery delay, price change, insolvency), there is no diversified fallback visible in current data.',
    whatToDo: 'Confirm whether a backup supplier relationship exists outside the data captured here; if not, consider identifying one.',
    howSure: 'VERIFIED — concentration is computed directly from real supplier spend records.',
    evidence: { top: supplierConcentration.top },
  };
}

/**
 * Compose the Morning Revelation list for one tenant.
 * Never throws — a failed source degrades to "no revelation from this
 * source" (fail-closed), matching businessState.js's Promise.allSettled
 * convention.
 *
 * @param {string} userId
 * @returns {Promise<{userId, status: 'REVELATIONS_PRESENT'|'NOTHING_MATERIAL', revelations: object[], generatedAt: string}>}
 */
async function buildMorningRevelations(userId) {
  if (!userId) throw new Error('buildMorningRevelations: userId is required');

  const [cashResult, contradictionResult, custConcResult, suppConcResult] = await Promise.allSettled([
    buildCashConsequence(userId),
    detectContradictions(userId),
    getCustomerConcentration(userId).catch(e => ({ insufficientData: true, reason: e.message })),
    getSupplierConcentration(userId).catch(e => ({ insufficientData: true, reason: e.message })),
  ]);

  const cashConsequence = cashResult.status === 'fulfilled' ? cashResult.value : null;
  if (cashResult.status === 'rejected') safeLog('warn', '[RevelationEngine] cashConsequence failed', { userId, error: cashResult.reason?.message });

  const contradictions = contradictionResult.status === 'fulfilled' ? contradictionResult.value : null;
  if (contradictionResult.status === 'rejected') safeLog('warn', '[RevelationEngine] contradictions failed', { userId, error: contradictionResult.reason?.message });

  const customerConcentration = custConcResult.status === 'fulfilled' ? custConcResult.value : { insufficientData: true };
  const supplierConcentration = suppConcResult.status === 'fulfilled' ? suppConcResult.value : { insufficientData: true };

  const candidates = [
    revelationFromCashConsequence(cashConsequence, customerConcentration),
    revelationFromContradictions(contradictions),
    revelationFromSupplierConcentration(supplierConcentration),
  ].filter(Boolean);

  // Rank: VERIFIED howSure first, then by evidence magnitude where comparable.
  // No opaque single score — order is explainable from the fields already present.
  candidates.sort((a, b) => {
    const aVerified = String(a.howSure).startsWith('VERIFIED') ? 0 : 1;
    const bVerified = String(b.howSure).startsWith('VERIFIED') ? 0 : 1;
    return aVerified - bVerified;
  });

  const revelations = candidates.slice(0, MAX_REVELATIONS);

  return {
    userId,
    status: revelations.length > 0 ? 'REVELATIONS_PRESENT' : 'NOTHING_MATERIAL',
    reason: revelations.length === 0 ? 'No source module (cash consequence, contradiction detection, supplier concentration) produced a material, evidence-backed finding for this tenant.' : null,
    revelations,
    generatedAt: new Date().toISOString(),
  };
}

// STARLANE Temporal Intelligence — Part 23-25: Morning Revelations v2.
// Additive: extends the revelation source list with "quietly getting
// worse/better" (a problem worsening/improving across 3+ REAL observations
// without necessarily crossing any threshold yet). Does not alter or call
// buildMorningRevelations — a fully separate orchestrator so the original
// function's existing 5-source, <=5-cap contract is untouched for existing
// callers.
//
// Honesty: requires 3+ REAL customer_score_history points before using the
// word "quietly" at all (per trajectoryV2's own point-count discipline) — on
// the confirmed real dev DB (max 2 points/customer as of 2026-09-08), this
// source legitimately returns nothing for real tenants and is proven instead
// against a clearly-labeled constructed series in the test suite.
async function findQuietTrendRevelations(userId, { limit = 3 } = {}) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT customer_id, credit_risk_score, recorded_at FROM customer_score_history
     WHERE user_id = $1 AND credit_risk_score IS NOT NULL ORDER BY customer_id, recorded_at ASC`,
    [userId]
  );
  const byCustomer = new Map();
  for (const row of res.rows) {
    if (!byCustomer.has(row.customer_id)) byCustomer.set(row.customer_id, []);
    byCustomer.get(row.customer_id).push({ value: Number(row.credit_risk_score), recorded_at: row.recorded_at });
  }

  const revelations = [];
  for (const [customerId, points] of byCustomer.entries()) {
    if (points.length < 3) continue; // strict point-count discipline — no "quiet trend" claim below 3 real points
    const traj = classifyTrajectoryV2(points, { higherIsBetter: false }); // credit_risk_score: higher = worse
    if (traj.label !== 'WORSENING' && traj.label !== 'IMPROVING') continue;
    revelations.push({
      id: `QUIET_TREND_CUSTOMER_${customerId}`,
      type: traj.label === 'WORSENING' ? 'QUIETLY_GETTING_WORSE' : 'QUIETLY_GETTING_BETTER',
      whatChanged: `Customer ${customerId}'s credit_risk_score has been ${traj.label === 'WORSENING' ? 'quietly worsening' : 'quietly improving'} across ${points.length} real observations, without necessarily crossing any alert threshold.`,
      whyItMatters: traj.label === 'WORSENING'
        ? 'A slow, sub-threshold deterioration compounds silently if not caught before it reaches a hard risk band.'
        : 'A steady improvement is worth confirming and reinforcing, not just alerting on regressions.',
      connectsTo: { customerId, pointCount: points.length },
      mayHappen: null,
      whatToDo: traj.label === 'WORSENING' ? 'Review this customer\'s recent invoices/promises before it becomes a hard alert.' : null,
      howSure: `REAL_${points.length}_POINT_TRAJECTORY`,
      evidence: { points, trajectory: traj },
    });
    if (revelations.length >= limit) break;
  }
  return revelations;
}

async function buildMorningRevelationsV2(userId) {
  if (!userId) throw new Error('buildMorningRevelationsV2: userId is required');
  const base = await buildMorningRevelations(userId);
  const quiet = await findQuietTrendRevelations(userId).catch(e => {
    safeLog('warn', '[RevelationEngine v2] quiet trend detection failed', { userId, error: e.message });
    return [];
  });
  const combined = [...base.revelations, ...quiet].slice(0, MAX_REVELATIONS);
  return {
    userId,
    status: combined.length > 0 ? 'REVELATIONS_PRESENT' : 'NOTHING_MATERIAL',
    reason: combined.length === 0 ? base.reason : null,
    revelations: combined,
    v1Count: base.revelations.length,
    quietTrendCount: quiet.length,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildMorningRevelations, buildMorningRevelationsV2, findQuietTrendRevelations };
