// FILE: lib/world/externalSignal.js
// STARLANE Day 4 — Part 2: External signal contract, Part 3: impact modes,
// Part 13: causal-safety vocabulary.
//
// Pure normalization/type-contract module. No DB access, no side effects.
// Every world-signal -> forecast interaction function elsewhere in the
// codebase should import IMPACT_MODES from here and return one of these
// values explicitly rather than inventing ad-hoc status strings.

const SIGNAL_TYPES = Object.freeze({
  FX: 'FX',                         // implemented (seeded path) — fxScenario.js
  NATURAL_HAZARD: 'NATURAL_HAZARD', // implemented (real) — reuses world_events / USGS rows
  WEATHER: 'WEATHER',               // stub — type exists, no ingestion
  COMMODITY: 'COMMODITY',           // stub
  INTEREST_RATE: 'INTEREST_RATE',   // stub
  SHIPPING: 'SHIPPING',             // stub
});

const IMPLEMENTED_SIGNAL_TYPES = Object.freeze(['FX', 'NATURAL_HAZARD']);

/**
 * Normalize any raw external observation into the canonical shape. Does not
 * validate business meaning — only shape/presence. Missing fields are kept
 * as null rather than defaulted, so downstream consumers can detect gaps.
 */
function normalizeExternalSignal(raw = {}) {
  return {
    signal_type: raw.signal_type ?? null,
    subject: raw.subject ?? null,           // e.g. supplier id, currency pair, geography
    geography: raw.geography ?? null,
    value: raw.value ?? null,
    unit: raw.unit ?? null,
    direction: raw.direction ?? null,        // 'UP' | 'DOWN' | 'NEUTRAL'
    magnitude: raw.magnitude ?? null,        // relative size, unitless where possible
    observed_at: raw.observed_at ?? null,
    source: raw.source ?? null,
    freshness: raw.freshness ?? null,        // computed by freshnessOf() below, ms age
    quality: raw.quality ?? null,            // 'HIGH' | 'MEDIUM' | 'LOW' | 'CONFLICTING'
    evidence: raw.evidence ?? [],
    implemented: IMPLEMENTED_SIGNAL_TYPES.includes(raw.signal_type),
  };
}

/** Part 14: signal freshness / expiry. maxAgeMs defaults to 30 days. */
function freshnessOf(signal, { now = Date.now(), maxAgeMs = 30 * 86400000 } = {}) {
  if (!signal || !signal.observed_at) return { fresh: false, ageMs: null, reason: 'no observed_at on signal' };
  const ageMs = now - new Date(signal.observed_at).getTime();
  if (Number.isNaN(ageMs)) return { fresh: false, ageMs: null, reason: 'unparseable observed_at' };
  return { fresh: ageMs >= 0 && ageMs <= maxAgeMs, ageMs, maxAgeMs, reason: ageMs > maxAgeMs ? 'STALE' : (ageMs < 0 ? 'FUTURE_DATED' : 'FRESH') };
}

// Part 3: impact modes. Every world-signal -> forecast function must return
// exactly one of these as `impact_mode`.
const IMPACT_MODES = Object.freeze({
  NO_EFFECT: 'NO_EFFECT',
  INSUFFICIENT_CONTEXT: 'INSUFFICIENT_CONTEXT',
  RANGE_WIDENING: 'RANGE_WIDENING',
  RANGE_NARROWING: 'RANGE_NARROWING',
  RISK_INCREASE: 'RISK_INCREASE',
  RISK_DECREASE: 'RISK_DECREASE',
  SCENARIO_ONLY: 'SCENARIO_ONLY',
  POINT_ESTIMATE_ADJUSTMENT: 'POINT_ESTIMATE_ADJUSTMENT',
});

// Part 13: causal-safety vocabulary. CAUSAL requires strongEvidence() to pass,
// which is deliberately near-impossible with current data — that is the
// intended, honest behavior, not a bug.
const CAUSAL_LABELS = Object.freeze({
  OBSERVED: 'OBSERVED',
  DERIVED: 'DERIVED',
  ASSOCIATED: 'ASSOCIATED',
  EXPOSED: 'EXPOSED',
  POSSIBLY_CONTRIBUTING: 'POSSIBLY_CONTRIBUTING',
  PROJECTED: 'PROJECTED',
  SCENARIO: 'SCENARIO',
  CAUSAL: 'CAUSAL',
});

/**
 * A label may only be CAUSAL if strong evidence is present. "Strong evidence"
 * here means: a controlled/matched real-world natural experiment or a
 * documented mechanism with quantified real historical effect size for THIS
 * tenant — something this codebase has no data source for today. This
 * function therefore always returns false for CAUSAL upgrades unless an
 * explicit, fully-populated evidence object with `mechanism`, `effect_size`,
 * and `sample_size >= 30` real historical matched cases is supplied.
 */
function canUpgradeToCausal(evidence = {}) {
  const ok = !!(evidence.mechanism && typeof evidence.effect_size === 'number' && Number.isFinite(evidence.sample_size) && evidence.sample_size >= 30);
  return { allowed: ok, reason: ok ? 'strong evidence threshold met' : 'strong-evidence threshold (mechanism + quantified effect_size + sample_size>=30 real matched cases) not met — label capped below CAUSAL' };
}

/** Safe label picker: clamps any requested label to at most the evidence supports. */
function safeCausalLabel(requested, evidence) {
  if (requested === CAUSAL_LABELS.CAUSAL) {
    const check = canUpgradeToCausal(evidence);
    if (!check.allowed) return { label: CAUSAL_LABELS.POSSIBLY_CONTRIBUTING, downgraded: true, reason: check.reason };
    return { label: CAUSAL_LABELS.CAUSAL, downgraded: false };
  }
  return { label: requested, downgraded: false };
}

// --- Registry v2 additions (WORLD INTELLIGENCE EXPANSION, Part 2) ---
// Additive only: normalizeExternalSignal's existing return shape is untouched
// for any caller not supplying the new fields (they default to null/derived,
// same convention as the Day 4 fields above).

const SOURCE_RELIABILITY = Object.freeze({
  PRIMARY_OFFICIAL: 'PRIMARY_OFFICIAL',   // e.g. USGS itself
  HIGH_RELIABILITY: 'HIGH_RELIABILITY',
  MODERATE: 'MODERATE',
  LOW: 'LOW',
  UNVERIFIED: 'UNVERIFIED',
});

const SIGNAL_LIFECYCLE = Object.freeze({
  ACTIVE: 'ACTIVE',
  STALE: 'STALE',
  EXPIRED: 'EXPIRED',
  RESOLVED: 'RESOLVED',
});

/**
 * v2 normalizer. Wraps normalizeExternalSignal (v1 contract untouched) and
 * adds source_reliability, effective_from/effective_to, and a derived
 * lifecycle status. Callers on the old contract keep working unchanged;
 * only callers that want the new fields need to call this instead.
 */
function normalizeExternalSignalV2(raw = {}, { now = Date.now() } = {}) {
  const base = normalizeExternalSignal(raw);
  const source_reliability = Object.values(SOURCE_RELIABILITY).includes(raw.source_reliability)
    ? raw.source_reliability
    : SOURCE_RELIABILITY.UNVERIFIED;
  const effective_from = raw.effective_from ?? raw.observed_at ?? null;
  const effective_to = raw.effective_to ?? null;
  return {
    ...base,
    source_reliability,
    effective_from,
    effective_to,
    lifecycle: lifecycleOf({ ...base, effective_from, effective_to }, { now }),
  };
}

/** Part 2: lifecycle status, built on top of freshnessOf() — does not duplicate its logic. */
function lifecycleOf(signal, { now = Date.now(), maxAgeMs = 30 * 86400000 } = {}) {
  if (signal?.effective_to && new Date(signal.effective_to).getTime() <= now) {
    return SIGNAL_LIFECYCLE.RESOLVED;
  }
  const fresh = freshnessOf(signal, { now, maxAgeMs });
  if (!fresh.ageMs && fresh.ageMs !== 0) return SIGNAL_LIFECYCLE.EXPIRED; // no observed_at / unparseable
  if (fresh.reason === 'STALE') return SIGNAL_LIFECYCLE.EXPIRED;
  if (!fresh.fresh) return SIGNAL_LIFECYCLE.STALE;
  return SIGNAL_LIFECYCLE.ACTIVE;
}

module.exports = {
  SIGNAL_TYPES,
  IMPLEMENTED_SIGNAL_TYPES,
  normalizeExternalSignal,
  freshnessOf,
  IMPACT_MODES,
  CAUSAL_LABELS,
  canUpgradeToCausal,
  safeCausalLabel,
  SOURCE_RELIABILITY,
  SIGNAL_LIFECYCLE,
  normalizeExternalSignalV2,
  lifecycleOf,
};
