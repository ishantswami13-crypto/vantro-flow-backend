// FILE: lib/domain/intelligence/scenarioEngine.js
// STARLANE Day 3 — Part 3: Scenario engine v1.
//
// Builds named, explicit hypotheticals ON TOP OF a real BASELINE cash
// consequence (from cashConsequenceEngine.js) and compares them. A scenario
// NEVER writes to any real table and NEVER is returned/labeled as anything
// but kind: 'SCENARIO' — see futureProjection.js's PROJECTION_KIND. Scenario
// isolation is enforced structurally: this module takes the baseline's
// already-computed real numbers as plain JS values and does arithmetic on
// copies; it holds no DB write path at all.

const { assessUncertainty } = require('./uncertainty');
const { buildFutureProjection, PROJECTION_KIND } = require('./futureProjection');
const { HORIZON_DAYS } = require('./cashConsequenceEngine');

/**
 * @param {object} baselineCashConsequence - output of buildCashConsequence(userId)
 * @param {object} scenarioDef - { name, description, targetInvoiceId, daysEarlier } for
 *   a "pays earlier" scenario, or { name, description, targetInvoiceId, remainsUnpaid: true }
 *   for a "remains unpaid" scenario.
 */
function buildScenario(baselineCashConsequence, scenarioDef) {
  if (!baselineCashConsequence || baselineCashConsequence.status !== 'PROJECTED') {
    throw new Error('buildScenario: requires a PROJECTED baseline cash consequence (call buildCashConsequence first)');
  }
  if (!scenarioDef || !scenarioDef.name) throw new Error('buildScenario: scenarioDef.name is required');

  const evidenceRow = baselineCashConsequence.projection.evidence.find(e => e.id === scenarioDef.targetInvoiceId);

  const assumptions = [
    {
      assumption: scenarioDef.remainsUnpaid
        ? `Invoice ${scenarioDef.targetInvoiceId} remains completely unpaid through the horizon.`
        : `Invoice ${scenarioDef.targetInvoiceId} is paid ${scenarioDef.daysEarlier || 0} day(s) earlier than its current trajectory implies.`,
      basis: evidenceRow ? `real invoice row, current amount ${evidenceRow.amount}` : 'target invoice not found in baseline evidence — scenario is speculative for this subject',
      strength: evidenceRow ? 'MODERATE' : 'WEAK',
    },
    ...(scenarioDef.additionalAssumptions || []),
  ];

  let cashDelta = 0;
  let narrative;
  if (scenarioDef.remainsUnpaid) {
    cashDelta = evidenceRow ? -evidenceRow.amount : 0;
    narrative = evidenceRow
      ? `If this ${evidenceRow.amount} receivable remains unpaid (worse than baseline's own overdue treatment for it), cash position worsens by ${evidenceRow.amount} relative to a case where it is collected.`
      : 'Target invoice not present in real baseline evidence — no numeric delta can be honestly computed.';
  } else {
    // "pays earlier" scenario: cash realized inside the horizon that the
    // baseline (bounded, conservative) case did not assume as collected.
    cashDelta = evidenceRow ? evidenceRow.amount : 0;
    narrative = evidenceRow
      ? `If this ${evidenceRow.amount} receivable is collected within the horizon (vs. remaining in baseline's overdue bucket), cash position improves by ${evidenceRow.amount} relative to baseline.`
      : 'Target invoice not present in real baseline evidence — no numeric delta can be honestly computed.';
  }

  const uncertainty = assessUncertainty({
    sourceReliability: evidenceRow ? 'VERIFIED' : null,
    recencyDays: 0,
    sampleSize: evidenceRow ? 1 : 0,
    relationshipCertainty: evidenceRow ? 'VERIFIED' : 'UNVERIFIED',
    missingContextCount: evidenceRow ? 0 : 1,
  });

  const scenarioProjectedState = {
    cashImpactDelta: cashDelta,
    projectedTotalOverdue: baselineCashConsequence.totalOverdue - (scenarioDef.remainsUnpaid ? 0 : (evidenceRow ? evidenceRow.amount : 0)),
    narrative,
  };

  const projection = buildFutureProjection({
    kind: PROJECTION_KIND.SCENARIO,
    scenarioName: scenarioDef.name,
    subject: { type: 'tenant_cash', id: baselineCashConsequence.userId, label: scenarioDef.description || scenarioDef.name },
    horizon: { days: HORIZON_DAYS, label: `${HORIZON_DAYS}-day` },
    baseline_state: {
      totalOpenReceivables: baselineCashConsequence.totalOpenReceivables,
      totalOverdue: baselineCashConsequence.totalOverdue,
    },
    assumptions,
    driving_variables: ['invoice_amount', 'days_overdue'],
    projected_state: scenarioProjectedState,
    uncertainty,
    evidence: evidenceRow ? [evidenceRow] : [],
    invalidation_conditions: [
      `A real payment_status change on invoice ${scenarioDef.targetInvoiceId} that contradicts this hypothetical.`,
    ],
  });

  return projection;
}

/**
 * Compare a scenario projection against the real baseline it was built from.
 * Pure computation — never mutates either input, never touches the DB.
 */
function compareScenarios(baselineCashConsequence, scenarioProjection) {
  if (scenarioProjection.kind !== PROJECTION_KIND.SCENARIO) {
    throw new Error('compareScenarios: second argument must be a SCENARIO projection — refusing to compare two baselines as if one were hypothetical');
  }
  const baselineOverdue = baselineCashConsequence.totalOverdue;
  const scenarioOverdue = scenarioProjection.projected_state.projectedTotalOverdue;
  const delta = scenarioOverdue - baselineOverdue;
  return {
    baselineLabel: 'BASELINE (real, observed pattern)',
    scenarioLabel: scenarioProjection.label,
    baselineTotalOverdue: baselineOverdue,
    scenarioProjectedTotalOverdue: scenarioOverdue,
    delta,
    direction: delta < 0 ? 'IMPROVEMENT_VS_BASELINE' : delta > 0 ? 'WORSE_VS_BASELINE' : 'NO_CHANGE_VS_BASELINE',
    uncertainty: scenarioProjection.uncertainty,
    note: 'Comparison is arithmetic over real baseline numbers and one hypothetical scenario projection — the scenario never overwrote or altered the real baseline it was compared against.',
  };
}

module.exports = { buildScenario, compareScenarios };
