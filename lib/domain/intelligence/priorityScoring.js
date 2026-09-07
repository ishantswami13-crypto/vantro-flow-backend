// FILE: lib/domain/intelligence/priorityScoring.js
// Day 7 Intelligence Acceleration — Part 6: Priority Engine V2.
//
// A small, explainable, ADDITIVE scoring function. Does not replace
// businessState.js's existing priority/risk_level sort — it computes an
// optional extra `priorityScoreV2` field that callers MAY use to re-sort,
// while the existing sort remains the fallback for any signal this score
// isn't populated for (mission requirement: "must not break existing sort
// behavior if this new score isn't populated for older action types").
//
// Formula (simple weighted sum, each component named/stored separately,
// nothing opaque):
//   priorityScoreV2 =
//       0.35 * monetaryExposureNorm
//     + 0.25 * urgencyNorm
//     + 0.20 * deteriorationNorm
//     + 0.10 * concentrationNorm
//     + 0.10 * confidenceNorm
//
// All components are normalized to [0, 1]. Missing/unavailable components
// are treated as neutral (0.5) rather than 0 or 1, so an action with no
// trajectory data isn't penalized or boosted relative to one that
// genuinely has neutral/STABLE data — the confidence component is what
// captures "how much of this score is real vs neutral filler".
const PRIORITY_TO_URGENCY = { urgent: 1, high: 0.75, medium: 0.5, low: 0.25 };
const RISK_TO_URGENCY = { high: 1, medium: 0.6, low: 0.3 };

const WEIGHTS = {
  monetaryExposure: 0.35,
  urgency: 0.25,
  deterioration: 0.20,
  concentration: 0.10,
  confidence: 0.10,
};

function normalizeMonetary(amount, capForNorm = 500000) {
  if (amount == null || !Number.isFinite(Number(amount))) return { value: 0.5, known: false };
  const n = Math.max(0, Number(amount));
  return { value: Math.min(1, n / capForNorm), known: true };
}

function urgencyFromSignal(signal) {
  const fromPriority = signal.priority ? PRIORITY_TO_URGENCY[signal.priority] : undefined;
  const fromRisk = signal.risk_level ? RISK_TO_URGENCY[signal.risk_level] : undefined;
  if (fromPriority != null && fromRisk != null) return { value: (fromPriority + fromRisk) / 2, known: true };
  if (fromPriority != null) return { value: fromPriority, known: true };
  if (fromRisk != null) return { value: fromRisk, known: true };
  return { value: 0.5, known: false };
}

function deteriorationFromTrajectory(trajectory) {
  if (trajectory === 'DETERIORATING') return { value: 1, known: true };
  if (trajectory === 'STABLE') return { value: 0.4, known: true };
  if (trajectory === 'IMPROVING') return { value: 0.1, known: true };
  return { value: 0.5, known: false }; // UNKNOWN / not populated
}

function concentrationFromSharePct(sharePct) {
  if (sharePct == null || !Number.isFinite(Number(sharePct))) return { value: 0.5, known: false };
  return { value: Math.min(1, Number(sharePct) / 100), known: true };
}

function confidenceFromComponents(confidenceComponents) {
  if (!confidenceComponents || typeof confidenceComponents !== 'object') return { value: 0.5, known: false };
  const vals = Object.values(confidenceComponents).filter(v => typeof v === 'number' && Number.isFinite(v));
  if (!vals.length) return { value: 0.5, known: false };
  return { value: vals.reduce((a, b) => a + b, 0) / vals.length, known: true };
}

/**
 * @param {object} signal - a rankedAction-shaped object, optionally enriched
 *   with { monetaryExposure, trajectory, concentrationSharePct, confidenceComponents }
 *   by contextAssembly/cashRiskNarrative. All enrichment fields are optional.
 * @returns {object} { priorityScoreV2, components: {...}, weights: {...} }
 */
function computePriorityScore(signal) {
  if (!signal || typeof signal !== 'object') {
    return null; // additive/optional — caller falls back to existing sort
  }

  const monetary = normalizeMonetary(signal.monetaryExposure);
  const urgency = urgencyFromSignal(signal);
  const deterioration = deteriorationFromTrajectory(signal.trajectory);
  const concentration = concentrationFromSharePct(signal.concentrationSharePct);
  const confidence = confidenceFromComponents(signal.confidenceComponents);

  const priorityScoreV2 =
    WEIGHTS.monetaryExposure * monetary.value +
    WEIGHTS.urgency * urgency.value +
    WEIGHTS.deterioration * deterioration.value +
    WEIGHTS.concentration * concentration.value +
    WEIGHTS.confidence * confidence.value;

  return {
    priorityScoreV2: Math.round(priorityScoreV2 * 1000) / 1000,
    components: {
      monetaryExposure: monetary,
      urgency,
      deterioration,
      concentration,
      confidence,
    },
    weights: { ...WEIGHTS },
  };
}

module.exports = { computePriorityScore, WEIGHTS };
