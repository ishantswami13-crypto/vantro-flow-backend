// FILE: lib/domain/intelligence/overallState.js
// Deterministic Overall State classifier for STARLANE Business State.
//
// This introduces NO new data source and NO new arbitrary numbers where an
// existing one already exists:
//   - the 20%/50% cashflow-gap severity split matches lib/services/agents/cashflowAgent.js
//     (urgent when gapPct >= 50, high when gapPct >= 20)
//   - the 70-score high-risk-customer threshold matches
//     lib/services/agents/creditRiskAgent.js::deriveTier / customer_scores tier convention
// The only genuinely new number is the ">= 3 high-risk customers" boundary
// between NEEDS_ATTENTION and UNDER_PRESSURE, called out explicitly below —
// it is not derived from any existing system value.
//
// Pure function. No DB access, no LLM, no ML model. Given the same
// businessState fields, always returns the same verdict.

/**
 * @param {object} businessState - { rankedActions, cashflow } (the two sections
 *   this classifier reads; brain/receivablesRisk/payablesRisk are not needed —
 *   they are derived views of rankedActions already covered by urgentActionCount).
 * @returns {{state: 'HEALTHY'|'UNDER_PRESSURE'|'NEEDS_ATTENTION', reasons: string[],
 *   computedFrom: {urgentActionCount:number, highRiskCustomerCount:number, cashflowGapPct: number|null}} | null}
 *   null when there isn't enough data to classify honestly (no actions AND cashflow
 *   section failed) — callers must render this as "not enough data yet", never as HEALTHY.
 */
function computeOverallState(businessState) {
  const rankedActions = businessState?.rankedActions || [];
  const cashflow = businessState?.cashflow || null;

  const cashflowUnavailable = !cashflow || cashflow.error === 'unavailable';
  if (cashflowUnavailable && rankedActions.length === 0) {
    return null;
  }

  const urgentActionCount = rankedActions.filter(a => a.priority === 'urgent').length;
  const highPriorityCount = rankedActions.filter(a => a.priority === 'high').length;

  const highRiskCustomerIds = new Set(
    rankedActions
      .filter(a => a.customer && typeof a.customer.credit_risk_score === 'number' && a.customer.credit_risk_score >= 70)
      .map(a => a.customer.id)
  );
  const highRiskCustomerCount = highRiskCustomerIds.size;

  let cashflowGapPct = null;
  if (!cashflowUnavailable) {
    const inflow = Number(cashflow.expected_inflow || 0);
    const outflow = Number(cashflow.expected_outflow || 0);
    const gap = outflow - inflow;
    cashflowGapPct = inflow > 0 ? (gap / inflow) * 100 : (outflow > 0 ? 100 : 0);
  }

  const computedFrom = { urgentActionCount, highRiskCustomerCount, cashflowGapPct };

  // NEEDS_ATTENTION — any one condition is sufficient (union, not a weighted score).
  const attentionReasons = [];
  if (urgentActionCount > 0) {
    attentionReasons.push(`${urgentActionCount} urgent action${urgentActionCount > 1 ? 's' : ''} pending`);
  }
  if (highRiskCustomerCount >= 3) {
    attentionReasons.push(`${highRiskCustomerCount} customers at high credit risk`);
  }
  if (cashflowGapPct !== null && cashflowGapPct >= 50) {
    attentionReasons.push(`Projected 7-day cash gap of ${Math.round(cashflowGapPct)}%`);
  }
  if (attentionReasons.length > 0) {
    return { state: 'NEEDS_ATTENTION', reasons: attentionReasons, computedFrom };
  }

  // UNDER_PRESSURE — meaningful pressure, nothing critical.
  const pressureReasons = [];
  if (highPriorityCount > 0) {
    pressureReasons.push(`${highPriorityCount} high-priority action${highPriorityCount > 1 ? 's' : ''} pending`);
  }
  if (highRiskCustomerCount > 0 && highRiskCustomerCount < 3) {
    pressureReasons.push(`${highRiskCustomerCount} customer${highRiskCustomerCount > 1 ? 's' : ''} at high credit risk`);
  }
  if (cashflowGapPct !== null && cashflowGapPct >= 20 && cashflowGapPct < 50) {
    pressureReasons.push(`Projected 7-day cash gap of ${Math.round(cashflowGapPct)}%`);
  }
  if (pressureReasons.length > 0) {
    return { state: 'UNDER_PRESSURE', reasons: pressureReasons, computedFrom };
  }

  // HEALTHY — no material risk signal present.
  return {
    state: 'HEALTHY',
    reasons: ['No urgent or high-priority actions pending', 'No material cashflow gap projected'],
    computedFrom,
  };
}

module.exports = { computeOverallState };
