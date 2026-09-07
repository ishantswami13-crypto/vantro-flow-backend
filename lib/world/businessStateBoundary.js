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
const { listTenantExposures } = require('./exposureRegistry');
const { computeMaterialityComponents } = require('./materiality');
const { computeDependencyEvidence } = require('./dependencyEvidence');
const { rankSignals } = require('./signalRanking');
const { getPool } = require('../db/pg');

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

// Phase 17 (Part B) — the mandatory three-state external-conditions summary
// for Business State integration. This is the ONLY function businessState.js
// calls; it is purely additive and never touches any existing Business
// State field.
//
// STATES (mandatory, tested — never conflate "no data" with "no risk"):
//   DATA_INCOMPLETE   — this tenant has zero VERIFIED business_exposure rows.
//                        We genuinely do not know whether they are exposed
//                        to anything. NEVER reported as "no material
//                        external signals" — that would falsely imply a
//                        verified absence of risk.
//   NO_MATERIAL_SIGNALS — tenant HAS verified exposure data, but no
//                        currently-active/material signals exist right now.
//   signals present    — ranked, materiality-annotated list returned.
// Global Context + Temporal Foundation, Part D — additive field only.
// Never throws: a readiness-lookup failure must never break the existing
// three-state world_exposure_status contract above it.
async function safeGetIntelligenceReadiness(userId) {
  try {
    const { getIntelligenceReadiness } = require('../domain/globalContext/readiness');
    return await getIntelligenceReadiness(userId);
  } catch (err) {
    return { error: 'intelligence_readiness lookup failed', message: err.message };
  }
}

async function getWorldExposureStatus(userId) {
  const verifiedExposures = await listTenantExposures(userId, { verificationStatus: 'VERIFIED' });
  const intelligenceReadiness = await safeGetIntelligenceReadiness(userId);

  if (verifiedExposures.length === 0) {
    return {
      world_exposure_status: 'DATA_INCOMPLETE',
      reason: 'This tenant has zero VERIFIED business_exposure rows. Whether this business is exposed to any ' +
        'world event is genuinely unknown — this is NOT a determination that no risk exists.',
      verified_exposure_count: 0,
      signals: [],
      intelligence_readiness: intelligenceReadiness,
    };
  }

  const signals = await getActiveSignalsForTenant(userId, { limit: 200 });
  const materialSignals = signals.filter(isMaterial);

  if (materialSignals.length === 0) {
    return {
      world_exposure_status: 'NO_MATERIAL_SIGNALS',
      reason: `This tenant has ${verifiedExposures.length} verified exposure(s) on record but no currently-active, ` +
        'material external signal matches them right now.',
      verified_exposure_count: verifiedExposures.length,
      signals: [],
      intelligence_readiness: intelligenceReadiness,
    };
  }

  const pool = getPool();
  const entries = [];
  for (const signal of materialSignals) {
    let exposure = null;
    let event = null;
    if (signal.business_exposure_id) {
      const expRes = await pool.query(`SELECT * FROM business_exposure WHERE id = $1 AND user_id = $2`, [signal.business_exposure_id, userId]);
      exposure = expRes.rows[0] || null;
    }
    if (signal.world_event_id) {
      const evRes = await pool.query(`SELECT * FROM world_events WHERE id = $1`, [signal.world_event_id]);
      event = evRes.rows[0] || null;
    }
    const dependencyEvidence = exposure
      ? await computeDependencyEvidence(userId, exposure.business_entity_type, exposure.business_entity_id)
      : null;
    const materialityComponents = computeMaterialityComponents({ signal, exposure, event, dependencyEvidence });
    // signal.exposure_confidence_component is the real stored value; feed it
    // into exposure_strength if materiality.js couldn't see the exposure row.
    if (materialityComponents.exposure_strength == null && signal.exposure_confidence_component != null) {
      materialityComponents.exposure_strength = signal.exposure_confidence_component;
    }
    entries.push({ signal, materialityComponents });
  }

  const ranked = rankSignals(entries);

  return {
    world_exposure_status: 'signals_present',
    reason: `${materialSignals.length} material external signal(s) currently active for this tenant, ranked by real, documented materiality components.`,
    verified_exposure_count: verifiedExposures.length,
    signals: ranked.map(({ signal, materialityComponents, rankScore }) => ({
      signalId: signal.id,
      status: signal.status,
      impactStatus: signal.impact_status,
      affectedBusinessDimensions: signal.affected_business_dimensions,
      whyExists: signal.why_exists,
      materialityComponents,
      rankScore,
    })),
    intelligence_readiness: intelligenceReadiness,
  };
}

module.exports = { getExternalConditionsSummary, isMaterial, MATERIALITY_CONFIDENCE_FLOOR, getWorldExposureStatus };
