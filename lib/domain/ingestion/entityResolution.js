// FILE: lib/domain/ingestion/entityResolution.js
// STARLANE — Reality Acquisition. Part 5: Entity Resolution v2.
//
// Conservative supplier/product matcher used by the CSV importer. Rule,
// non-negotiable per the mission: never auto-merge on name similarity
// alone. A real identifier match (GSTIN/tax id, exact normalized-name
// match) is required for CONFIRMED_MATCH. Anything weaker is labeled
// PROBABLE_MATCH or POSSIBLE_MATCH and the caller (csvImport.js) must
// treat those as "needs a new candidate row, do not merge" — this module
// never writes to the DB itself, it only classifies.

function normalizeName(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/\b(pvt\.?|private|ltd\.?|limited|llp|inc\.?|co\.?|corp\.?|company)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

function similarity(a, b) {
  const na = normalizeName(a), nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return 1 - dist / maxLen;
}

/**
 * Classify a candidate row (from an import) against one existing DB
 * candidate. Returns { verdict, reason, score } where verdict is one of
 * CONFIRMED_MATCH | PROBABLE_MATCH | POSSIBLE_MATCH | NO_MATCH.
 *
 * candidate/existing shape: { name, taxId (GSTIN etc), email, phone }
 */
function resolveEntity(candidate, existing) {
  const candTax = (candidate.taxId || '').trim().toUpperCase();
  const exTax = (existing.taxId || '').trim().toUpperCase();
  if (candTax && exTax && candTax === exTax) {
    return { verdict: 'CONFIRMED_MATCH', reason: 'exact tax/GSTIN identifier match', score: 1 };
  }

  const candEmail = (candidate.email || '').trim().toLowerCase();
  const exEmail = (existing.email || '').trim().toLowerCase();
  if (candEmail && exEmail && candEmail === exEmail) {
    return { verdict: 'CONFIRMED_MATCH', reason: 'exact email identifier match', score: 1 };
  }

  const candPhone = (candidate.phone || '').replace(/\D/g, '');
  const exPhone = (existing.phone || '').replace(/\D/g, '');
  if (candPhone && exPhone && candPhone.length >= 7 && candPhone === exPhone) {
    return { verdict: 'CONFIRMED_MATCH', reason: 'exact phone identifier match', score: 1 };
  }

  const normCand = normalizeName(candidate.name);
  const normEx = normalizeName(existing.name);
  if (normCand && normEx && normCand === normEx) {
    // Exact normalized-name match, but with NO corroborating hard identifier
    // present on the existing record to cross-check against. Per the
    // mission's rule this is still name-similarity-only evidence, so it is
    // capped at PROBABLE_MATCH, never auto-merged as CONFIRMED.
    return { verdict: 'PROBABLE_MATCH', reason: 'exact normalized-name match with no independent identifier to corroborate', score: 0.9 };
  }

  const sim = similarity(candidate.name, existing.name);
  if (sim >= 0.8) {
    return { verdict: 'PROBABLE_MATCH', reason: `fuzzy name similarity ${sim.toFixed(2)}`, score: sim };
  }
  if (sim >= 0.55) {
    return { verdict: 'POSSIBLE_MATCH', reason: `weak fuzzy name similarity ${sim.toFixed(2)}`, score: sim };
  }
  return { verdict: 'NO_MATCH', reason: 'no identifier or meaningful name similarity', score: sim };
}

/**
 * Resolve a candidate against a list of existing entities, returning the
 * best-ranked match (or null if none qualifies above NO_MATCH). Never
 * returns an instruction to merge — verdict CONFIRMED_MATCH still requires
 * the caller to decide to reuse the existing id; PROBABLE/POSSIBLE must
 * never be auto-merged by any caller in this codebase.
 */
function resolveBestMatch(candidate, existingList) {
  let best = null;
  for (const existing of existingList) {
    const result = resolveEntity(candidate, existing);
    if (result.verdict === 'NO_MATCH') continue;
    if (!best || result.score > best.score) {
      best = { ...result, existingId: existing.id };
    }
  }
  return best;
}

module.exports = { normalizeName, similarity, resolveEntity, resolveBestMatch };
