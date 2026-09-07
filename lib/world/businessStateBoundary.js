// FILE: lib/world/businessStateBoundary.js
// Phase 16 — Business State Integration Boundary (interface only).
//
// This module is DELIBERATELY the only touchpoint between World Intelligence
// Phase 2 and Business State. It does NOT import, call, or modify
// `lib/domain/intelligence/businessState.js` or anything reachable from the
// `/api/business-state` route in server.js. Those remain completely
// unmodified by this phase (verify with `git diff` — see
// STARLANE_WORLD_INTELLIGENCE_PHASE_2_REPORT.md for the confirmation).
//
// `getExternalConditionsSummary(userId)` is a self-contained function that
// Business State COULD call in some future phase to enrich its output, but
// nothing calls it today. It is exported for that future wiring and for
// direct testing only.
const { getActiveSignalsForTenant } = require('./signalQueries');

// A signal counts as "material" here using only already-separate, honestly
// available fields (never a fabricated score): status is live (not
// resolved/dismissed/expired) AND it carries at least one classified
// business dimension AND its exposure_confidence_component (if present) is
// not below a conservative floor. This mirrors Phase 12's confidence
// threshold discipline rather than inventing a new one.
const MATERIALITY_CONFIDENCE_FLOOR = 0.5;

function isMaterial(signal) {
  if (!['CANDIDATE', 'ACTIVE', 'UPDATED'].includes(signal.status)) return false;
  if (!signal.affected_business_dimensions || signal.affected_business_dimensions.length === 0) return false;
  const conf = signal.exposure_confidence_component;
  if (conf != null && conf < MATERIALITY_CONFIDENCE_FLOOR) return false;
  return true;
}

async function getExternalConditionsSummary(userId) {
  const signals = await getActiveSignalsForTenant(userId, { limit: 500 });
  const externalConditions = signals.map(s => ({
    signalId: s.id,
    status: s.status,
    impactStatus: s.impact_status,
    affectedBusinessDimensions: s.affected_business_dimensions,
    whyExists: s.why_exists,
    firstDetectedAt: s.first_detected_at,
    lastUpdatedAt: s.last_updated_at,
  }));
  const materialExternalSignals = externalConditions.filter((_, i) => isMaterial(signals[i]));
  return {
    external_conditions: externalConditions,
    external_signal_count: externalConditions.length,
    material_external_signals: materialExternalSignals,
  };
}

module.exports = { getExternalConditionsSummary, isMaterial, MATERIALITY_CONFIDENCE_FLOOR };
