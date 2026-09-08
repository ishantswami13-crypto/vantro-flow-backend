// FILE: lib/domain/intelligence/cashConsequenceEngine.js
// STARLANE Day 3 — Parts 2, 4, 5: Baseline/do-nothing projection for
// receivables and cash, Cash consequence engine (BASELINE / BEST-REASONABLE /
// STRESS), and Receivable consequence intelligence.
//
// Everything here reads REAL rows from invoices/customer_score_history and
// reuses exposureMap.js's customer-concentration logic (no reimplementation).
// No probability distributions are computed — only bounded, labeled cases
// built from real observed amounts and real trend classifications.

const { getPool } = require('../../db/pg');
const { assessUncertainty } = require('./uncertainty');
const { getVariable, classifyTrend } = require('./variables');
const { getCustomerConcentration } = require('./exposureMap');
const { buildFutureProjection, PROJECTION_KIND } = require('./futureProjection');

const HORIZON_DAYS = 30;

/**
 * Real, currently-open receivables for a tenant (payment_status not Paid),
 * with days_overdue as stored (never recomputed/estimated).
 */
async function getOpenReceivables(userId) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT id, customer_id, customer_name, invoice_amount, payment_status, days_overdue, due_date, invoice_date, currency
     FROM invoices
     WHERE user_id = $1 AND (payment_status IS NULL OR payment_status != 'Paid')
     ORDER BY days_overdue DESC NULLS LAST, invoice_amount DESC`,
    [userId]
  );
  return res.rows.map(r => ({ ...r, invoice_amount: Number(r.invoice_amount || 0), days_overdue: r.days_overdue != null ? Number(r.days_overdue) : null }));
}

/**
 * Real trajectory for one customer's credit_risk_score / promise_reliability_score,
 * reusing variables.js — never a new trend computation.
 */
async function getCustomerTrajectory(userId, customerId) {
  if (!customerId) {
    return { insufficientData: true, reason: 'invoice has no customer_id — cannot look up customer_score_history trajectory' };
  }
  const [creditRisk, reliability] = await Promise.all([
    getVariable(userId, 'credit_risk_score', customerId).catch(e => ({ error: e.message })),
    getVariable(userId, 'promise_reliability_score', customerId).catch(e => ({ error: e.message })),
  ]);
  return { creditRisk, reliability };
}

/**
 * Part 5: Receivable consequence intelligence for one high-risk receivable.
 * Real numbers only: current due amount, days overdue (stored), trajectory
 * (reused from variables.js), and an honest "what happens if it stays late"
 * statement bounded to the receivable's own real amount — never a downstream
 * cash forecast invented beyond what's in cashConsequenceEngine's cases.
 */
async function buildReceivableConsequence(userId, receivable) {
  const trajectory = await getCustomerTrajectory(userId, receivable.customer_id);
  const isWorsening = trajectory.creditRisk && ['SIMPLE_TREND_DOWN', 'DIRECTIONAL_CHANGE_ONLY_DOWN'].includes(
    // credit_risk_score rising is worse; treat trend on the raw score value
    trajectory.creditRisk.trend
  );
  const sampleSize = trajectory.creditRisk && trajectory.creditRisk.quality !== 'NO_DATA'
    ? (trajectory.creditRisk.quality === 'REAL_MULTI_POINT' ? 2 : 1)
    : 0;

  const uncertainty = assessUncertainty({
    sourceReliability: sampleSize > 0 ? 'VERIFIED' : null,
    recencyDays: trajectory.creditRisk && trajectory.creditRisk.freshness ? trajectory.creditRisk.freshness.days : null,
    sampleSize,
    relationshipCertainty: receivable.customer_id ? 'VERIFIED' : 'UNVERIFIED',
    missingContextCount: receivable.customer_id ? 0 : 1,
  });

  return {
    invoiceId: receivable.id,
    customerId: receivable.customer_id,
    customerName: receivable.customer_name,
    currentDue: receivable.invoice_amount,
    currency: receivable.currency,
    daysOverdue: receivable.days_overdue,
    trajectory: {
      creditRiskTrend: trajectory.creditRisk ? trajectory.creditRisk.trend : 'UNKNOWN',
      reliabilityTrend: trajectory.reliability ? trajectory.reliability.trend : 'UNKNOWN',
      note: trajectory.insufficientData ? trajectory.reason : 'reused from variables.js classifyTrend — real history rows only',
    },
    ifStaysLate: {
      statement: `If this ${receivable.invoice_amount} ${receivable.currency || ''} receivable (${receivable.days_overdue ?? 'unknown'} days overdue) remains unpaid through the ${HORIZON_DAYS}-day horizon, that exact amount stays outside collected cash — this is the receivable's own real balance, not an estimate.`,
      amountAtRisk: receivable.invoice_amount,
    },
    isWorsening: !!isWorsening,
    uncertainty,
  };
}

/**
 * Part 2/4: Baseline/do-nothing cash consequence for receivables — "if the
 * recent observed pattern persists" (nothing collected beyond what's already
 * trending toward payment; every open receivable's real amount is at risk).
 * Also BEST-REASONABLE (concentration-adjusted: assumes the top concentrated
 * customer keeps their currently-observed payment behavior) and STRESS
 * (assumes the top concentrated / highest-days-overdue customer does NOT pay
 * within the horizon at all).
 */
async function buildCashConsequence(userId) {
  const [receivables, concentration] = await Promise.all([
    getOpenReceivables(userId),
    getCustomerConcentration(userId).catch(e => ({ insufficientData: true, reason: e.message })),
  ]);

  if (receivables.length === 0) {
    return {
      userId,
      status: 'NO_OPEN_RECEIVABLES',
      reason: 'This tenant has zero open (non-Paid) invoices — no cash consequence to project.',
      cases: null,
      generatedAt: new Date().toISOString(),
    };
  }

  const totalOpen = receivables.reduce((s, r) => s + r.invoice_amount, 0);
  const overdue = receivables.filter(r => r.days_overdue != null && r.days_overdue > 0);
  const totalOverdue = overdue.reduce((s, r) => s + r.invoice_amount, 0);

  // Highest concentration real customer among open receivables, if concentration data exists.
  let concentratedCustomer = null;
  if (!concentration.insufficientData && concentration.top && concentration.top.length > 0) {
    const topId = concentration.top[0].customerId;
    concentratedCustomer = receivables.find(r => r.customer_id === topId) || null;
  }
  const worstOverdue = overdue.length > 0 ? overdue[0] : null; // already ordered by days_overdue DESC

  const assumptions = [
    { assumption: 'Open invoices not marked Paid represent real uncollected cash today.', basis: 'invoices.payment_status column, real stored value', strength: 'STRONG' },
    { assumption: 'days_overdue reflects real elapsed time since due_date, not an estimate.', basis: 'invoices.days_overdue column, real stored value', strength: 'STRONG' },
  ];

  const baselineCase = {
    label: 'BASELINE — if recent observed pattern persists',
    cashImpact: -totalOverdue,
    horizonDays: HORIZON_DAYS,
    reason: `${overdue.length} real overdue invoice(s) totaling ${Math.round(totalOverdue)} remain uncollected if no change in payment behavior occurs.`,
    keyDependency: worstOverdue ? { invoiceId: worstOverdue.id, customerName: worstOverdue.customer_name, amount: worstOverdue.invoice_amount } : null,
  };

  const bestCase = {
    label: 'BEST-REASONABLE — top concentrated customer keeps current observed behavior, remaining overdue balance unchanged',
    cashImpact: concentratedCustomer ? -(totalOverdue - concentratedCustomer.invoice_amount) : -totalOverdue,
    horizonDays: HORIZON_DAYS,
    reason: concentratedCustomer
      ? `Assumes the single highest-concentration real customer (${concentratedCustomer.customer_name}, ${Math.round(concentratedCustomer.invoice_amount)}) pays within the horizon per their existing relationship; remaining ${Math.round(totalOverdue - concentratedCustomer.invoice_amount)} stays at risk.`
      : 'No concentration data available to name a specific best-case payer — best-case equals baseline.',
    keyDependency: concentratedCustomer ? { invoiceId: concentratedCustomer.id, customerName: concentratedCustomer.customer_name, amount: concentratedCustomer.invoice_amount } : null,
  };

  const stressCase = {
    label: 'STRESS — highest-days-overdue customer also fails to pay within horizon',
    cashImpact: -totalOpen,
    horizonDays: HORIZON_DAYS,
    reason: `Assumes ALL currently-open receivables (${Math.round(totalOpen)}, including the ${worstOverdue ? worstOverdue.days_overdue : 'N/A'}-day-overdue balance) remain uncollected through the horizon — a bounded worst case using only real open amounts, not a fabricated tail probability.`,
    keyDependency: worstOverdue ? { invoiceId: worstOverdue.id, customerName: worstOverdue.customer_name, daysOverdue: worstOverdue.days_overdue } : null,
  };

  const uncertainty = assessUncertainty({
    sourceReliability: 'VERIFIED',
    recencyDays: 0, // invoices table queried live
    sampleSize: receivables.length,
    relationshipCertainty: concentration.insufficientData ? 'UNVERIFIED' : 'VERIFIED',
    missingContextCount: concentration.insufficientData ? 1 : 0,
  });

  const projection = buildFutureProjection({
    kind: PROJECTION_KIND.BASELINE,
    subject: { type: 'tenant_cash', id: userId, label: 'Open receivables / cash position' },
    horizon: { days: HORIZON_DAYS, label: `${HORIZON_DAYS}-day` },
    baseline_state: { totalOpenReceivables: Math.round(totalOpen), totalOverdue: Math.round(totalOverdue), openCount: receivables.length },
    assumptions,
    driving_variables: ['credit_risk_score', 'promise_reliability_score'],
    projected_state: { cases: { baseline: baselineCase, bestReasonable: bestCase, stress: stressCase } },
    uncertainty,
    evidence: receivables.map(r => ({ table: 'invoices', id: r.id, customer_id: r.customer_id, amount: r.invoice_amount, days_overdue: r.days_overdue })),
    invalidation_conditions: [
      'A payment_status transition to Paid on any of the receivables listed in evidence.',
      'A new invoice being added or an existing one being written off, changing totalOpenReceivables.',
    ],
  });

  return {
    userId,
    status: 'PROJECTED',
    totalOpenReceivables: Math.round(totalOpen),
    totalOverdue: Math.round(totalOverdue),
    concentration: concentration.insufficientData ? concentration : { top: concentration.top },
    cases: { baseline: baselineCase, bestReasonable: bestCase, stress: stressCase },
    projection,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildCashConsequence, buildReceivableConsequence, getOpenReceivables, getCustomerTrajectory, HORIZON_DAYS };
