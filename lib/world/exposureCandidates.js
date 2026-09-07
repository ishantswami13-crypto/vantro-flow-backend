// FILE: lib/world/exposureCandidates.js
// World Intelligence Phase 3, Part A — Phase 5/6 (Business-Record Extraction
// Candidates).
//
// Scans existing tenant tables (customers/suppliers/purchases/sales) for
// facts that COULD become exposure candidates. This is deliberately
// conservative: per STARLANE_WORLD_BUSINESS_LINKAGE_AUDIT.md, real tenant
// `address`/`gstin` fields are 100% NULL in sampled data and there is no
// currency column anywhere on purchases/sales — so this generator is
// expected to find few or zero real candidates against real data today.
// That is the correct, honest outcome; this module still implements the
// full extraction logic so that the day a tenant's `gstin` column IS
// populated, candidates start appearing automatically with no code change.
//
// Every potential extraction rule below is labeled with its classification
// in a comment immediately above the function that implements it:
//   DIRECT FACT      — the raw field IS the fact, no interpretation needed.
//   SAFE DERIVATION  — a small, deterministic, well-documented transform of
//                       a raw field that is safe enough to auto-verify.
//   WEAK DERIVATION  — a plausible but not-certain inference; always becomes
//                       a PROPOSED candidate, never auto-verified.
//   UNUSABLE         — no known safe way to extract this fact from current
//                       schema; documented and skipped, never forced.
//
// Only DIRECT FACT or high-confidence SAFE DERIVATION rules may auto-create
// a VERIFIED business_exposure row directly (bypassing the candidate table);
// everything else becomes a row in business_exposure_candidates requiring
// the explicit verify/reject API in this same phase.
const { getPool } = require('../db/pg');
const { resolveCountryValue } = require('./businessEntityResolution');

// GSTIN (Indian Goods & Services Tax Identification Number) format:
// the first two digits are the GST state code. This is a PUBLISHED,
// STABLE government mapping (not inferred from free text), so decoding it
// is a SAFE DERIVATION, not a guess — but we still classify it
// SAFE_DERIVATION rather than DIRECT_FACT because the raw field is a tax ID,
// not a country field, and Indian GSTIN implies country=India by
// construction (every valid GSTIN belongs to an Indian-registered entity) —
// worth stating explicitly rather than silently assumed.
const GSTIN_STATE_CODE_TO_NAME = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '19': 'West Bengal', '27': 'Maharashtra', '29': 'Karnataka',
  '33': 'Tamil Nadu', '36': 'Telangana',
};
const GSTIN_RE = /^\d{2}[A-Z0-9]{13}$/;

// SAFE_DERIVATION: a syntactically valid Indian GSTIN on a supplier/customer
// row -> that entity is LOCATED_IN India. Confidence is high (0.9) because
// GSTIN format is government-enforced, not a text guess.
function extractFromGstin(row, entityType) {
  const gstin = row.gstin;
  if (!gstin || typeof gstin !== 'string' || !GSTIN_RE.test(gstin.trim().toUpperCase())) return null;
  return {
    businessEntityType: entityType,
    businessEntityId: row.id,
    exposureType: 'LOCATED_IN',
    rawValue: gstin,
    sourceTable: entityType === 'supplier' ? 'suppliers' : 'customers',
    sourceColumn: 'gstin',
    sourceRowId: row.id,
    classification: 'SAFE_DERIVATION',
    extractionMethod: 'gstin_implies_india',
    extractionNotes: `Valid-format GSTIN "${gstin}" implies this entity is registered in India (state code ${gstin.slice(0, 2)}${GSTIN_STATE_CODE_TO_NAME[gstin.slice(0, 2)] ? ' = ' + GSTIN_STATE_CODE_TO_NAME[gstin.slice(0, 2)] : ''}).`,
  };
}

// WEAK_DERIVATION: a free-text `address` field that happens to end with a
// recognizable country name. This is explicitly NOT auto-verified — company
// name/address text matching is exactly the kind of "weak text inference"
// the mission invariants forbid treating as fact. It always becomes a
// PROPOSED candidate for a human to confirm.
async function extractFromAddress(row, entityType) {
  const address = row.address;
  if (!address || typeof address !== 'string' || !address.trim()) return null;
  const parts = address.split(',').map(s => s.trim()).filter(Boolean);
  const lastPart = parts[parts.length - 1];
  if (!lastPart) return null;
  const resolved = await resolveCountryValue(lastPart);
  if (!resolved) return null; // never guess — if the last comma-part isn't a known country name/code, this yields nothing
  return {
    businessEntityType: entityType,
    businessEntityId: row.id,
    exposureType: 'LOCATED_IN',
    rawValue: address,
    sourceTable: entityType === 'supplier' ? 'suppliers' : 'customers',
    sourceColumn: 'address',
    sourceRowId: row.id,
    classification: 'WEAK_DERIVATION',
    extractionMethod: 'address_trailing_segment_country_match',
    extractionNotes: `Trailing comma-segment "${lastPart}" of free-text address matched country lookup (resolved code: ${resolved.code}). Free-text address parsing is inherently unreliable (could be a state, city with the same name, or truncated) — always requires human verification, never auto-verified.`,
  };
}

// UNUSABLE, documented honestly rather than forced: purchases/sales have NO
// currency column at all in this schema (confirmed by
// STARLANE_WORLD_BUSINESS_LINKAGE_AUDIT.md) — every amount is implicitly
// INR. There is therefore no way to derive a non-INR CURRENCY_DENOMINATED
// candidate from existing purchase/sale rows; the only currency exposure
// this phase can ever produce for real data is one an owner explicitly
// enters via createExposure, or a bulk import. This function exists to make
// that limitation explicit and testable (it always returns an empty array),
// not to silently omit the attempt.
function extractCurrencyFromPurchases(_purchaseRows) {
  return []; // UNUSABLE with current schema — see comment above.
}

async function generateCandidatesForEntityTable(pool, userId, table, entityType) {
  const found = [];
  const res = await pool.query(`SELECT id, gstin, address FROM ${table} WHERE user_id = $1`, [userId]);
  for (const row of res.rows) {
    const gstinCandidate = extractFromGstin(row, entityType);
    if (gstinCandidate) found.push(gstinCandidate);
    else {
      const addrCandidate = await extractFromAddress(row, entityType);
      if (addrCandidate) found.push(addrCandidate);
    }
  }
  return found;
}

/**
 * Runs all extraction rules against a tenant's real data and persists any
 * findings as PROPOSED rows in business_exposure_candidates (idempotent via
 * the table's UNIQUE(user_id, source_table, source_row_id, source_column,
 * exposure_type) constraint — re-running never duplicates). Returns a
 * summary including counts by classification, honestly reflecting whatever
 * was actually found (likely 0 for most real tenants today).
 */
async function generateExposureCandidates(userId) {
  if (!userId) throw new Error('generateExposureCandidates: userId is required');
  const pool = getPool();

  const [supplierCandidates, customerCandidates, purchaseRows] = await Promise.all([
    generateCandidatesForEntityTable(pool, userId, 'suppliers', 'supplier'),
    generateCandidatesForEntityTable(pool, userId, 'customers', 'customer'),
    pool.query(`SELECT id FROM purchases WHERE user_id = $1`, [userId]).then(r => r.rows),
  ]);
  const purchaseCurrencyCandidates = extractCurrencyFromPurchases(purchaseRows);

  const all = [...supplierCandidates, ...customerCandidates, ...purchaseCurrencyCandidates];
  const inserted = [];
  for (const c of all) {
    const res = await pool.query(
      `INSERT INTO business_exposure_candidates
         (user_id, business_entity_type, business_entity_id, exposure_type, raw_value,
          source_table, source_column, source_row_id, classification, extraction_method, extraction_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (user_id, source_table, source_row_id, source_column, exposure_type) DO NOTHING
       RETURNING *`,
      [userId, c.businessEntityType, c.businessEntityId, c.exposureType, c.rawValue,
        c.sourceTable, c.sourceColumn, c.sourceRowId, c.classification, c.extractionMethod, c.extractionNotes]
    );
    if (res.rows.length) inserted.push(res.rows[0]);
  }

  const byClassification = { DIRECT_FACT: 0, SAFE_DERIVATION: 0, WEAK_DERIVATION: 0, UNUSABLE: 0 };
  for (const c of all) byClassification[c.classification] = (byClassification[c.classification] || 0) + 1;

  return {
    userId,
    scannedTables: ['suppliers', 'customers', 'purchases'],
    totalFound: all.length,
    newlyInserted: inserted.length,
    byClassification,
    candidates: inserted,
    honestNote: all.length === 0
      ? 'No extractable candidates found in real tenant data — expected per STARLANE_WORLD_BUSINESS_LINKAGE_AUDIT.md (address/gstin are 100% NULL in sampled real data, purchases have no currency column at all).'
      : `${all.length} candidate(s) found. Only SAFE_DERIVATION/DIRECT_FACT are eligible for fast-track verification; WEAK_DERIVATION always requires human review.`,
  };
}

async function listCandidates(userId, { status = 'PROPOSED' } = {}) {
  if (!userId) throw new Error('listCandidates: userId is required');
  const pool = getPool();
  const res = await pool.query(
    `SELECT * FROM business_exposure_candidates WHERE user_id = $1 AND candidate_status = $2 ORDER BY created_at DESC`,
    [userId, status]
  );
  return res.rows;
}

// Promotes a candidate to a real business_exposure row. Still requires an
// explicit kind (country/currency) to resolve rawValue -> world_entity_id —
// never silently invented. This is the ONLY path from candidate ->
// verified exposure, and it always goes through createExposure +
// verifyExposure (two explicit steps), matching the write API's invariant
// that verification is never implicit.
async function verifyCandidate(userId, candidateId, { kind = 'country', reviewedByUserId = null, reviewNotes = null } = {}) {
  if (!userId) throw new Error('verifyCandidate: userId is required');
  const pool = getPool();
  const { createExposure, verifyExposure } = require('./exposureRegistry');

  const candRes = await pool.query(
    `SELECT * FROM business_exposure_candidates WHERE id = $1 AND user_id = $2`,
    [candidateId, userId]
  );
  if (candRes.rows.length === 0) throw new Error(`verifyCandidate: candidate ${candidateId} not found for this tenant`);
  const candidate = candRes.rows[0];
  if (candidate.candidate_status !== 'PROPOSED') {
    throw new Error(`verifyCandidate: candidate ${candidateId} is already ${candidate.candidate_status}`);
  }

  const exposure = await createExposure(userId, {
    businessEntityType: candidate.business_entity_type,
    businessEntityId: candidate.business_entity_id,
    exposureType: candidate.exposure_type,
    rawValue: candidate.raw_value,
    kind,
    provenanceType: 'BUSINESS_RECORD',
    provenanceReference: `candidate:${candidateId}`,
    sourceOfFact: candidate.classification === 'SAFE_DERIVATION' || candidate.classification === 'DIRECT_FACT' ? 'derived_from_gstin' : 'manual_reference',
    evidenceNotes: candidate.extraction_notes,
  });
  const verified = await verifyExposure(userId, exposure.id, { verifiedByUserId: reviewedByUserId });

  await pool.query(
    `UPDATE business_exposure_candidates
     SET candidate_status = 'VERIFIED', promoted_exposure_id = $1, reviewed_at = NOW(), reviewed_by_user_id = $2, review_notes = $3, updated_at = NOW()
     WHERE id = $4 AND user_id = $5`,
    [verified.id, reviewedByUserId, reviewNotes, candidateId, userId]
  );

  return verified;
}

async function rejectCandidate(userId, candidateId, { reviewedByUserId = null, reviewNotes = null } = {}) {
  if (!userId) throw new Error('rejectCandidate: userId is required');
  const pool = getPool();
  const res = await pool.query(
    `UPDATE business_exposure_candidates
     SET candidate_status = 'REJECTED', reviewed_at = NOW(), reviewed_by_user_id = $1, review_notes = $2, updated_at = NOW()
     WHERE id = $3 AND user_id = $4
     RETURNING *`,
    [reviewedByUserId, reviewNotes, candidateId, userId]
  );
  if (res.rows.length === 0) throw new Error(`rejectCandidate: candidate ${candidateId} not found for this tenant`);
  return res.rows[0];
}

module.exports = {
  generateExposureCandidates,
  listCandidates,
  verifyCandidate,
  rejectCandidate,
  extractFromGstin,
  extractFromAddress,
  extractCurrencyFromPurchases,
  GSTIN_STATE_CODE_TO_NAME,
};
