// FILE: lib/domain/intelligence/uncertainty.js
// STARLANE Day 2 Multidimensional Reality Intelligence — Part 11: Uncertainty Model.
//
// Formalizes the qualitative evidence-quality bands already used informally in
// cashRiskNarrative.js (its `confidence_components` 0..1 numbers were always a
// proxy for a qualitative judgment, never a statistically meaningful
// probability). This module makes that judgment explicit and reusable, and
// NEVER produces an arbitrary percentage — only one of five bands, each
// derived from real, named factors.
//
// Bands (highest to lowest):
//   VERIFIED     - the underlying fact has an explicit VERIFIED verification
//                   state (e.g. business_exposure.verification_status) AND is
//                   fresh AND has no missing-context gaps for the claim being made.
//   STRONG       - multiple independent real data points/sources agree, or a
//                   single VERIFIED source with only minor freshness/sample-size
//                   softening.
//   MODERATE     - real data exists and supports the claim, but only from a
//                   single source, or with a small sample (e.g. exactly 2
//                   history points), or with some (non-fatal) missing context.
//   WEAK         - real data exists but is thin (1 data point), stale, from an
//                   UNVERIFIED source, or has material missing context.
//   INSUFFICIENT - not enough real evidence to support any claim at all; the
//                   caller must not assert anything qualitative and should
//                   return an explicit insufficientEvidence marker instead.
//
// Factors considered (all real, all named in the returned `factors` object so
// the band is always auditable, never a black-box label):
//   - sourceReliability: 'VERIFIED' | 'UNVERIFIED' | 'REJECTED' | 'SUPERSEDED' | null
//   - recencyDays: number|null - age of the freshest supporting data point
//   - sampleSize: number - count of real supporting data points/rows
//   - relationshipCertainty: 'VERIFIED' | 'UNVERIFIED' | 'INFERRED' | null
//   - missingContextCount: number - count of honestly-declared gaps affecting this claim

const BANDS = ['INSUFFICIENT', 'WEAK', 'MODERATE', 'STRONG', 'VERIFIED'];

const RECENCY_FRESH_DAYS = 30;
const RECENCY_STALE_DAYS = 180;

/**
 * Pure function: given real, named factors, returns one qualitative band plus
 * the factor values that drove it. No hidden state, no randomness, no LLM.
 */
function assessUncertainty({
  sourceReliability = null,
  recencyDays = null,
  sampleSize = 0,
  relationshipCertainty = null,
  missingContextCount = 0,
} = {}) {
  const factors = { sourceReliability, recencyDays, sampleSize, relationshipCertainty, missingContextCount };

  if (sampleSize <= 0) {
    return { band: 'INSUFFICIENT', factors, reason: 'no real supporting data points exist for this claim' };
  }
  if (sourceReliability === 'REJECTED' || sourceReliability === 'SUPERSEDED') {
    return { band: 'INSUFFICIENT', factors, reason: `underlying source is in ${sourceReliability} state and must not be used to support a claim` };
  }

  const isStale = recencyDays != null && recencyDays > RECENCY_STALE_DAYS;
  const isFresh = recencyDays == null || recencyDays <= RECENCY_FRESH_DAYS;
  const isVerifiedSource = sourceReliability === 'VERIFIED';
  const isVerifiedRelationship = relationshipCertainty === 'VERIFIED';

  if (isVerifiedSource && isVerifiedRelationship && isFresh && missingContextCount === 0) {
    return { band: 'VERIFIED', factors, reason: 'verified source, verified relationship, fresh, no missing context' };
  }

  if (isVerifiedSource && (isVerifiedRelationship || relationshipCertainty == null) && sampleSize >= 2 && !isStale) {
    return { band: 'STRONG', factors, reason: 'verified source with multiple supporting data points and acceptable recency' };
  }

  if (sampleSize >= 2 && !isStale && sourceReliability !== 'UNVERIFIED') {
    return { band: 'MODERATE', factors, reason: 'real data supports the claim but from a single source or with limited sample size' };
  }
  if (isVerifiedSource && sampleSize >= 1) {
    return { band: 'MODERATE', factors, reason: 'verified source but thin sample or missing context softens confidence' };
  }

  if (sampleSize >= 1) {
    return { band: 'WEAK', factors, reason: 'thin, stale, or unverified evidence — real but not strong enough for a firm claim' };
  }

  return { band: 'INSUFFICIENT', factors, reason: 'no real supporting data points exist for this claim' };
}

function bandAtLeast(band, minBand) {
  return BANDS.indexOf(band) >= BANDS.indexOf(minBand);
}

module.exports = { assessUncertainty, BANDS, RECENCY_FRESH_DAYS, RECENCY_STALE_DAYS, bandAtLeast };
