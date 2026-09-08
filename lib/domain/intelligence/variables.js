// FILE: lib/domain/intelligence/variables.js
// STARLANE Day 2 Multidimensional Reality Intelligence — Part 5 (Variable Model)
// and Part 6 (Trajectory/Change Engine guardrails).
//
// getVariable(userId, variableName, entityId) is a thin normalizer over
// EXISTING tables — it creates no new table, computes no new scores. It reads
// customer_score_history (for credit/reliability variables) or
// business_exposure (for exposure variables) and returns one normalized shape:
//   { name, entity, value, unit, timestamp, source, historical_baseline,
//     trend, quality, confidence, freshness }
//
// Honesty discipline (reused, not reinvented, from cashRiskNarrative.js's
// `honestyNote` pattern and creditRiskAgent.classifyScoreTrajectory):
//   - 0 real points  -> trend: 'UNKNOWN', historical_baseline: null
//   - 1 real point   -> trend: 'UNKNOWN' (nothing to compare against),
//                       historical_baseline: null
//   - 2 real points  -> trend: 'DIRECTIONAL_CHANGE_ONLY' — an honest 2-point
//                       comparison, explicitly NOT called a "trend line".
//   - 3+ real points -> trend: 'SIMPLE_TREND' — still just a plain slope
//                       description over real points, never a forecast.
// As of this build (confirmed against the live dev DB on 2026-09-08) no
// customer_score_history series in this tenant base has 3+ rows, so the
// 3+ branch is present but structurally untested against real data — it is
// written so a future data volume increase is handled correctly without code
// changes, not hardcoded to assume 2 points forever.

const { supabase } = require('../../config/supabaseClient');
const { assessUncertainty } = require('./uncertainty');

const CREDIT_HISTORY_VARIABLES = new Set([
  'credit_risk_score',
  'promise_reliability_score',
  'broken_promise_count',
  'collection_priority_score',
]);

const EXPOSURE_VARIABLES = new Set(['business_exposure_raw_value', 'business_exposure_normalized_value']);

function daysBetween(aIso, bIso) {
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.abs(a - b) / 86400000;
}

function classifyTrend(pointsAsc) {
  // pointsAsc: [{value, recorded_at}] real rows, oldest first.
  if (!pointsAsc || pointsAsc.length === 0) {
    return { trend: 'UNKNOWN', historical_baseline: null, note: 'no historical points exist for this variable' };
  }
  if (pointsAsc.length === 1) {
    return { trend: 'UNKNOWN', historical_baseline: null, note: 'only 1 historical point exists — nothing to compare against' };
  }
  if (pointsAsc.length === 2) {
    const [prior, latest] = pointsAsc;
    const delta = Number(latest.value) - Number(prior.value);
    return {
      trend: delta > 0 ? 'DIRECTIONAL_CHANGE_ONLY_UP' : delta < 0 ? 'DIRECTIONAL_CHANGE_ONLY_DOWN' : 'DIRECTIONAL_CHANGE_ONLY_FLAT',
      historical_baseline: prior.value,
      note: '2-point comparison only (latest vs one prior row) — not a multi-point trend, per current data volume.',
    };
  }
  // 3+ points: still an honest plain description, not a forecast.
  const first = pointsAsc[0];
  const last = pointsAsc[pointsAsc.length - 1];
  const delta = Number(last.value) - Number(first.value);
  return {
    trend: delta > 0 ? 'SIMPLE_TREND_UP' : delta < 0 ? 'SIMPLE_TREND_DOWN' : 'SIMPLE_TREND_FLAT',
    historical_baseline: first.value,
    note: `simple trend across ${pointsAsc.length} real points (first vs last) — a plain description of observed change, not a projection.`,
  };
}

async function getVariable(userId, variableName, entityId) {
  if (!userId) throw new Error('getVariable: userId is required');
  if (!variableName) throw new Error('getVariable: variableName is required');
  if (!entityId) throw new Error('getVariable: entityId is required');

  if (CREDIT_HISTORY_VARIABLES.has(variableName)) {
    return getCreditHistoryVariable(userId, variableName, entityId);
  }
  if (EXPOSURE_VARIABLES.has(variableName)) {
    return getExposureVariable(userId, variableName, entityId);
  }
  return {
    name: variableName,
    entity: { type: 'unknown', id: entityId },
    value: null,
    unit: null,
    timestamp: null,
    source: null,
    historical_baseline: null,
    trend: 'UNKNOWN',
    quality: 'INSUFFICIENT',
    confidence: { band: 'INSUFFICIENT', factors: {}, reason: `variables.js does not know how to source variable '${variableName}'` },
    freshness: null,
  };
}

async function getCreditHistoryVariable(userId, variableName, customerId) {
  const { data: rows, error } = await supabase
    .from('customer_score_history')
    .select(`id, ${variableName}, recorded_at`)
    .eq('customer_id', customerId)
    .eq('user_id', userId)
    .order('recorded_at', { ascending: false })
    .limit(10);
  if (error) throw error;

  const real = (rows || []).filter(r => r[variableName] != null);
  const asc = [...real].reverse().map(r => ({ value: Number(r[variableName]), recorded_at: r.recorded_at }));
  const { trend, historical_baseline, note } = classifyTrend(asc);
  const latest = real[0] || null;
  const freshnessDays = latest ? daysBetween(latest.recorded_at, new Date().toISOString()) : null;

  const confidence = assessUncertainty({
    sourceReliability: latest ? 'VERIFIED' : null, // customer_score_history rows are first-party computed, not third-party claims
    recencyDays: freshnessDays,
    sampleSize: real.length,
    relationshipCertainty: latest ? 'VERIFIED' : null, // entity identity (customer_id) is a direct FK, not inferred
    missingContextCount: real.length === 0 ? 1 : 0,
  });

  return {
    name: variableName,
    entity: { type: 'customer', id: customerId },
    value: latest ? Number(latest[variableName]) : null,
    unit: 'score',
    timestamp: latest ? latest.recorded_at : null,
    source: 'customer_score_history',
    historical_baseline,
    trend,
    trendNote: note,
    quality: real.length >= 2 ? 'REAL_MULTI_POINT' : real.length === 1 ? 'REAL_SINGLE_POINT' : 'NO_DATA',
    confidence,
    freshness: freshnessDays == null ? null : { days: Math.round(freshnessDays), isFresh: freshnessDays <= 30 },
  };
}

async function getExposureVariable(userId, variableName, exposureId) {
  const field = variableName === 'business_exposure_raw_value' ? 'raw_value' : 'normalized_value';
  const { data: row, error } = await supabase
    .from('business_exposure')
    .select(`id, ${field}, confidence, verification_status, valid_from, valid_to, business_entity_type, business_entity_id`)
    .eq('id', exposureId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;

  if (!row) {
    return {
      name: variableName,
      entity: { type: 'business_exposure', id: exposureId },
      value: null,
      unit: null,
      timestamp: null,
      source: 'business_exposure',
      historical_baseline: null,
      trend: 'UNKNOWN',
      quality: 'NO_DATA',
      confidence: assessUncertainty({ sampleSize: 0 }),
      freshness: null,
    };
  }

  // business_exposure has no history table of its own (a new row/valid_from
  // supersedes the old one) — per the mission, "2+ real points" does not apply
  // here in the same way it does for customer_score_history; a single current
  // value is all that is honestly available, so trend is UNKNOWN by design,
  // not a bug.
  const freshnessDays = daysBetween(row.valid_from, new Date().toISOString());
  const confidence = assessUncertainty({
    sourceReliability: row.verification_status,
    recencyDays: freshnessDays,
    sampleSize: 1,
    relationshipCertainty: row.verification_status === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED',
    missingContextCount: 0,
  });

  return {
    name: variableName,
    entity: { type: row.business_entity_type, id: row.business_entity_id },
    value: row[field] != null ? Number(row[field]) : null,
    unit: field === 'raw_value' ? 'raw' : 'normalized',
    timestamp: row.valid_from,
    source: 'business_exposure',
    historical_baseline: null,
    trend: 'UNKNOWN',
    trendNote: 'business_exposure carries only its current valid state, not a time series — a single-point trend is not honestly computable.',
    quality: 'REAL_SINGLE_POINT',
    confidence,
    freshness: freshnessDays == null ? null : { days: Math.round(freshnessDays), isFresh: freshnessDays <= 30 },
  };
}

module.exports = { getVariable, classifyTrend, CREDIT_HISTORY_VARIABLES, EXPOSURE_VARIABLES };
