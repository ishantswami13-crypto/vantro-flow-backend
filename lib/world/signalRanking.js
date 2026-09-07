// FILE: lib/world/signalRanking.js
// World Intelligence Phase 3, Part B — Phase 16 (Signal Ranking).
//
// Deterministic ranking over a tenant's active signals, using ONLY the
// separate materiality components already computed by materiality.js and
// dependencyEvidence.js. This is the ONE place in the whole World
// Intelligence pipeline that combines components into a single number, and
// it exists solely to ORDER signals for display — it is never stored, never
// shown as a probability/dollar figure, and never replaces the separate
// component fields (materiality.js still returns them all, untouched).
//
// EXACT FORMULA (weights sum to 1.0, chosen so real, concrete business
// dependency dominates a merely large/headline event — this is the
// mission's explicit "small-but-relevant beats big-but-irrelevant" example):
//
//   rankScore = 0.55 * dependencyScore
//             + 0.20 * eventSeverityScore
//             + 0.15 * recencyScore
//             + 0.10 * confidenceScore
//
// dependencyScore (0..1, capped):
//   base from business_dependency: high=0.5, medium=0.3, low=0.15, unknown=0.05
//   + 0.3 if dependencyEvidence.isSoleOrPrimarySupplier === true
//   + 0.3 if dependencyEvidence.productIsLowStock === true
//   + 0.15 if dependencyEvidence.openOrdersCount > 0
//   (capped at 1.0)
//
// eventSeverityScore (0..1): world_events.severity text mapped
//   low=0.2, moderate=0.4, high=0.6, severe=0.8, critical=1.0, null=0.3
//
// recencyScore (0..1): linear decay to 0 over 7 days (168h) since
//   event.observed_at; clipped to [0,1]; null recency_hours -> 0.3
//
// confidenceScore (0..1): exposure_confidence_component if present,
//   else exposureConfidence from materiality components, else 0.5 default
//
// Every weight and default above is fixed and documented here; there is no
// learned/adaptive component anywhere in this formula.
const SEVERITY_SCORE = { low: 0.2, moderate: 0.4, high: 0.6, severe: 0.8, critical: 1.0 };

function dependencyScore(businessDependency, evidence) {
  const base = { high: 0.5, medium: 0.3, low: 0.15, unknown: 0.05 }[businessDependency] ?? 0.05;
  let boost = 0;
  if (evidence) {
    if (evidence.isSoleOrPrimarySupplier === true) boost += 0.3;
    if (evidence.productIsLowStock === true) boost += 0.3;
    if (evidence.openOrdersCount != null && evidence.openOrdersCount > 0) boost += 0.15;
  }
  return Math.min(1, base + boost);
}

function eventSeverityScore(severity) {
  return SEVERITY_SCORE[severity] ?? 0.3;
}

function recencyScore(recencyHours) {
  if (recencyHours == null || Number.isNaN(recencyHours)) return 0.3;
  return Math.max(0, Math.min(1, 1 - recencyHours / 168));
}

function confidenceScore(materialityComponents) {
  const c = materialityComponents.exposure_strength;
  return c != null ? Math.max(0, Math.min(1, Number(c))) : 0.5;
}

/**
 * @param {object} materialityComponents - output of computeMaterialityComponents (must include dependency_evidence)
 * @returns {number} rankScore in [0,1], purely for ordering
 */
function computeRankScore(materialityComponents) {
  const dep = dependencyScore(materialityComponents.business_dependency, materialityComponents.dependency_evidence);
  const sev = eventSeverityScore(materialityComponents.event_severity);
  const rec = recencyScore(materialityComponents.recency_hours);
  const conf = confidenceScore(materialityComponents);
  return Number((0.55 * dep + 0.20 * sev + 0.15 * rec + 0.10 * conf).toFixed(6));
}

/**
 * Rank an array of { signal, materialityComponents } entries. Pure,
 * deterministic — the same input array always produces the same output
 * order (stable sort keyed on rankScore desc, then signal.id asc as a
 * deterministic tiebreaker so equal scores never depend on input order).
 */
function rankSignals(entries) {
  return entries
    .map(e => ({ ...e, rankScore: computeRankScore(e.materialityComponents) }))
    .sort((a, b) => {
      if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
      return String(a.signal.id).localeCompare(String(b.signal.id));
    });
}

module.exports = { computeRankScore, rankSignals, dependencyScore, eventSeverityScore, recencyScore, confidenceScore, SEVERITY_SCORE };
