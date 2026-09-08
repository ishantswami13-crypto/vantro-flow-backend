// FILE: lib/world/worldEventConsequence.js
// STARLANE Day 3 — Part 13: World event consequence v2.
//
// Explicitly separates EVENT -> EXPOSURE -> DEPENDENCY -> POSSIBLE CONSEQUENCE
// for the supplier+geography+world-event chain, reusing
// supplierExposureNarrative.js's real matching (never reimplemented) rather
// than inventing a shipment-delay or product-impact claim when the
// product-dependency leg is honestly unknown.

const { buildSupplierExposureNarrative } = require('../domain/intelligence/supplierExposureNarrative');
const { propagateSignalV2 } = require('./signalPropagation');
const { getPool } = require('../db/pg');

async function buildWorldEventConsequenceV2({ userId, supplierId }) {
  const result = await buildSupplierExposureNarrative({ userId, supplierId });
  if (result.insufficientEvidence) {
    return {
      status: 'INSUFFICIENT_EVIDENCE',
      reasons: result.reasons,
      chain: null,
    };
  }

  const chains = result.narratives.map(n => {
    const dependencyEvidence = n.evidence.find(e => e.type === 'business_exposure');
    return {
      EVENT: n.evidence.find(e => e.type === 'world_event'),
      EXPOSURE: dependencyEvidence,
      DEPENDENCY: {
        geographyDependency: 'REAL: ' + n.dependencies.geographyLeg,
        productDependency: 'UNKNOWN: ' + n.dependencies.productDependencyLeg,
      },
      POSSIBLE_CONSEQUENCE: {
        statement: n.likely_consequence,
        language: 'possible / plausible — not a causal claim, not a quantified shipment-delay estimate',
        recommended_action: n.recommended_action,
      },
      uncertainty_band: n.uncertainty_band,
      missingContext: n.missingContext,
    };
  });

  return { status: 'CHAINS_FOUND', supplier: result.supplier, chainCount: chains.length, chains };
}

/**
 * Extends the chain down to a real business_signal's propagation (order-
 * labeled, capped depth) when a signal id is available for this exposure.
 */
async function attachPropagationV2(userId, signalId) {
  if (!signalId) return { attached: false, reason: 'no business_signal id available to propagate' };
  const pool = getPool();
  const sigRes = await pool.query(`SELECT * FROM business_signals WHERE id = $1 AND user_id = $2`, [signalId, userId]);
  const signal = sigRes.rows[0];
  if (!signal) return { attached: false, reason: 'signal not found for this tenant' };
  const propagation = await propagateSignalV2(userId, signal);
  return { attached: true, propagation };
}

module.exports = { buildWorldEventConsequenceV2, attachPropagationV2 };
