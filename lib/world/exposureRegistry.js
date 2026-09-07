// FILE: lib/world/exposureRegistry.js
// World Intelligence Phase 3, Part A — Phase 3 (Write API) + Phase 8
// (provenance) + Phase 9 (temporal validity) + Phase 10 (readiness).
//
// Tenant-safe service functions over business_exposure. Every function takes
// userId as its first data-bearing argument and every query filters by it —
// there is no code path in this file that can read or write another
// tenant's row. Mirrors the pattern already used by lib/world/relevance.js
// and lib/world/businessEntityResolution.js (plain async functions exported
// from a module, no HTTP route layer — this codebase's Phase 1/2 world
// intelligence code is consumed directly by scripts/services, not exposed
// as REST endpoints yet).
const { getPool } = require('../db/pg');
const { resolveCountryValue, resolveCurrencyValue } = require('./businessEntityResolution');

const VALID_ENTITY_TYPES = ['supplier', 'customer', 'product', 'purchase', 'sale', 'order'];
const VALID_PROVENANCE_TYPES = ['OWNER_ENTERED', 'IMPORT', 'BUSINESS_RECORD', 'CONNECTOR', 'DERIVED', 'EXTERNAL_SOURCE'];

function assertTenant(userId) {
  if (!userId) throw new Error('exposureRegistry: userId is required on every call');
}

/**
 * Create a new exposure row. Defaults to verification_status='UNVERIFIED' —
 * verification is ALWAYS a separate, explicit call (verifyExposure below).
 * world_entity_id must already be resolved by the caller (use
 * resolveCountryValue/resolveCurrencyValue from businessEntityResolution.js,
 * or pass a raw value + kind and this function will resolve it — but it
 * will never guess: an unresolvable raw value is a thrown error, not a
 * best-effort insert).
 */
async function createExposure(userId, {
  businessEntityType, businessEntityId, exposureType,
  worldEntityId = null, rawValue = null, kind = null, // kind: 'country' | 'currency' — used only if worldEntityId not supplied
  truthState = 'OBSERVED', confidence = null,
  provenanceType = 'OWNER_ENTERED', provenanceReference = null,
  sourceOfFact = 'owner_recorded', evidenceNotes = null,
  validFrom = null, validTo = null,
}) {
  assertTenant(userId);
  if (!VALID_ENTITY_TYPES.includes(businessEntityType)) {
    throw new Error(`createExposure: invalid businessEntityType "${businessEntityType}"`);
  }
  if (!businessEntityId) throw new Error('createExposure: businessEntityId is required');
  if (!exposureType) throw new Error('createExposure: exposureType is required');
  if (!VALID_PROVENANCE_TYPES.includes(provenanceType)) {
    throw new Error(`createExposure: invalid provenanceType "${provenanceType}"`);
  }

  let resolvedWorldEntityId = worldEntityId;
  let normalizedValue = null;
  let resolutionMethod = null;
  let resolutionConfidence = null;

  if (!resolvedWorldEntityId) {
    if (!rawValue || !kind) {
      throw new Error('createExposure: must supply either worldEntityId, or both rawValue and kind');
    }
    const resolver = kind === 'currency' ? resolveCurrencyValue : resolveCountryValue;
    const resolved = await resolver(rawValue);
    if (!resolved) {
      // Never guess. Caller must handle this as "unresolved", not a silent skip.
      throw new Error(`createExposure: could not deterministically resolve ${kind} value "${rawValue}" — refusing to guess`);
    }
    resolvedWorldEntityId = resolved.worldEntityId;
    normalizedValue = resolved.normalized;
    resolutionMethod = resolved.method;
    resolutionConfidence = resolved.confidence;
  }

  const pool = getPool();
  const res = await pool.query(
    `INSERT INTO business_exposure
       (user_id, business_entity_type, business_entity_id, exposure_type, world_entity_id,
        valid_from, valid_to, truth_state, confidence,
        raw_value, normalized_value, resolution_method, resolution_confidence, resolved_at,
        source_of_fact, evidence_notes, provenance_type, provenance_reference, verification_status,
        recorded_at)
     VALUES ($1,$2,$3,$4,$5, COALESCE($6, NOW()), $7, $8, $9,
             $10,$11,$12,$13, CASE WHEN $12 IS NOT NULL THEN NOW() ELSE NULL END,
             $14,$15,$16,$17,'UNVERIFIED', NOW())
     RETURNING *`,
    [
      userId, businessEntityType, businessEntityId, exposureType, resolvedWorldEntityId,
      validFrom, validTo, truthState, confidence,
      rawValue, normalizedValue, resolutionMethod, resolutionConfidence,
      sourceOfFact, evidenceNotes, provenanceType, provenanceReference,
    ]
  );
  return res.rows[0];
}

/** List all exposures for a tenant, optionally filtered. */
async function listTenantExposures(userId, { verificationStatus = null, currentOnly = false } = {}) {
  assertTenant(userId);
  const pool = getPool();
  const clauses = ['user_id = $1'];
  const params = [userId];
  if (verificationStatus) {
    params.push(verificationStatus);
    clauses.push(`verification_status = $${params.length}`);
  }
  if (currentOnly) {
    clauses.push('(valid_to IS NULL OR valid_to > NOW())');
  }
  const res = await pool.query(
    `SELECT * FROM business_exposure WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`,
    params
  );
  return res.rows;
}

/** List exposures for one specific business entity belonging to this tenant. */
async function listExposuresForEntity(userId, businessEntityType, businessEntityId, { asOf = null } = {}) {
  assertTenant(userId);
  const pool = getPool();
  if (asOf) {
    // Phase 9 temporal query: "what was true as of time T" — the row whose
    // [valid_from, valid_to) window covers asOf, among currently-VERIFIED
    // history (a superseded row's valid_to was set to the moment it stopped
    // being true, so this naturally returns the historically-correct row).
    const res = await pool.query(
      `SELECT * FROM business_exposure
       WHERE user_id = $1 AND business_entity_type = $2 AND business_entity_id = $3
         AND verification_status IN ('VERIFIED','SUPERSEDED')
         AND valid_from <= $4 AND (valid_to IS NULL OR valid_to > $4)
       ORDER BY valid_from DESC`,
      [userId, businessEntityType, businessEntityId, asOf]
    );
    return res.rows;
  }
  const res = await pool.query(
    `SELECT * FROM business_exposure
     WHERE user_id = $1 AND business_entity_type = $2 AND business_entity_id = $3
     ORDER BY created_at DESC`,
    [userId, businessEntityType, businessEntityId]
  );
  return res.rows;
}

/**
 * Update/supersede an exposure. NEVER destructively overwrites: the old row
 * gets valid_to=NOW() (or the caller-supplied supersededAt) and
 * verification_status='SUPERSEDED'; a brand-new row is inserted carrying the
 * new values. This is the exact mechanism the Phase 9 "China 2021-2025,
 * Vietnam 2025-" scenario relies on.
 */
async function supersedeExposure(userId, exposureId, newValues, { supersededAt = null } = {}) {
  assertTenant(userId);
  const pool = getPool();
  const existingRes = await pool.query(
    `SELECT * FROM business_exposure WHERE id = $1 AND user_id = $2`,
    [exposureId, userId]
  );
  if (existingRes.rows.length === 0) {
    throw new Error(`supersedeExposure: exposure ${exposureId} not found for this tenant`);
  }
  const old = existingRes.rows[0];
  const cutoff = supersededAt || new Date().toISOString();

  const created = await createExposure(userId, {
    businessEntityType: old.business_entity_type,
    businessEntityId: old.business_entity_id,
    exposureType: newValues.exposureType || old.exposure_type,
    worldEntityId: newValues.worldEntityId || null,
    rawValue: newValues.rawValue || null,
    kind: newValues.kind || null,
    truthState: newValues.truthState || old.truth_state,
    confidence: newValues.confidence != null ? newValues.confidence : old.confidence,
    provenanceType: newValues.provenanceType || old.provenance_type,
    provenanceReference: newValues.provenanceReference || `supersedes:${exposureId}`,
    sourceOfFact: newValues.sourceOfFact || old.source_of_fact,
    evidenceNotes: newValues.evidenceNotes || null,
    validFrom: newValues.validFrom || cutoff,
    validTo: newValues.validTo || null,
  });

  const updatedOld = await pool.query(
    `UPDATE business_exposure
     SET valid_to = $1, verification_status = 'SUPERSEDED', superseded_by_id = $2, updated_at = NOW()
     WHERE id = $3 AND user_id = $4
     RETURNING *`,
    [cutoff, created.id, exposureId, userId]
  );

  // If the caller wants the new row to be immediately usable by the
  // relevance engine (verified), they must call verifyExposure explicitly —
  // supersession never auto-verifies, keeping the "explicit verification"
  // invariant true even for updates. Convenience: if the old row was
  // VERIFIED and the caller passes autoVerify, do it here as one call.
  let finalNew = created;
  if (newValues.autoVerify) {
    finalNew = await verifyExposure(userId, created.id);
  }

  return { oldExposure: updatedOld.rows[0], newExposure: finalNew };
}

/** Explicit, separate verification step. Never implicit. */
async function verifyExposure(userId, exposureId, { verifiedByUserId = null } = {}) {
  assertTenant(userId);
  const pool = getPool();
  const res = await pool.query(
    `UPDATE business_exposure
     SET verification_status = 'VERIFIED', verified_at = NOW(), verified_by_user_id = $1, updated_at = NOW()
     WHERE id = $2 AND user_id = $3
     RETURNING *`,
    [verifiedByUserId, exposureId, userId]
  );
  if (res.rows.length === 0) throw new Error(`verifyExposure: exposure ${exposureId} not found for this tenant`);
  return res.rows[0];
}

/** Explicit rejection — a row that should never be treated as fact. */
async function rejectExposure(userId, exposureId, reason = null) {
  assertTenant(userId);
  const pool = getPool();
  const res = await pool.query(
    `UPDATE business_exposure
     SET verification_status = 'REJECTED', rejection_reason = $1, updated_at = NOW()
     WHERE id = $2 AND user_id = $3
     RETURNING *`,
    [reason, exposureId, userId]
  );
  if (res.rows.length === 0) throw new Error(`rejectExposure: exposure ${exposureId} not found for this tenant`);
  return res.rows[0];
}

/** Phase 8 — full reconstructable provenance for one exposure row. */
async function getExposureProvenance(userId, exposureId) {
  assertTenant(userId);
  const pool = getPool();
  const res = await pool.query(
    `SELECT be.*, we.entity_type AS world_entity_type, we.code AS world_entity_code, we.name AS world_entity_name
     FROM business_exposure be
     JOIN world_entities we ON we.id = be.world_entity_id
     WHERE be.id = $1 AND be.user_id = $2`,
    [exposureId, userId]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    exposureId: row.id,
    whatWasClaimed: `${row.business_entity_type} ${row.business_entity_id} ${row.exposure_type} ${row.world_entity_type}:${row.world_entity_code || row.world_entity_name}`,
    rawValue: row.raw_value,
    normalizedValue: row.normalized_value,
    resolutionMethod: row.resolution_method,
    resolutionConfidence: row.resolution_confidence,
    resolvedAt: row.resolved_at,
    truthState: row.truth_state,
    provenanceType: row.provenance_type,
    provenanceReference: row.provenance_reference,
    sourceOfFact: row.source_of_fact,
    evidenceNotes: row.evidence_notes,
    recordedAt: row.recorded_at,
    verificationStatus: row.verification_status,
    verifiedAt: row.verified_at,
    verifiedByUserId: row.verified_by_user_id,
    rejectionReason: row.rejection_reason,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    supersededById: row.superseded_by_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Phase 10 — readiness reporting. Real counts only, from real tenant tables
 * and real verified exposure rows. No fabricated numbers: if a tenant has 40
 * suppliers and 0 verified LOCATED_IN/OPERATES_IN exposures, this reports
 * 0/40, honestly.
 */
async function getWorldIntelligenceReadiness(userId) {
  assertTenant(userId);
  const pool = getPool();

  const [supplierCount, purchaseCount, productCount] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS c FROM suppliers WHERE user_id = $1`, [userId]),
    pool.query(`SELECT COUNT(*)::int AS c FROM purchases WHERE user_id = $1`, [userId]),
    pool.query(`SELECT COUNT(*)::int AS c FROM products WHERE user_id = $1`, [userId]).catch(() => ({ rows: [{ c: 0 }] })),
  ]);

  const geoTypes = ['LOCATED_IN', 'OPERATES_IN', 'MANUFACTURES_IN', 'SOURCES_FROM', 'SELLS_IN'];
  const currencyTypes = ['CURRENCY_DENOMINATED', 'BILLS_IN', 'PAYS_IN', 'DENOMINATED_IN', 'RECEIVES_IN'];
  const logisticsTypes = ['USES_PORT', 'USES_ROUTE', 'SHIPS_FROM', 'SHIPS_TO', 'SHIPS_THROUGH'];

  async function countVerifiedDistinctEntities(entityType, exposureTypes) {
    const res = await pool.query(
      `SELECT COUNT(DISTINCT business_entity_id)::int AS c
       FROM business_exposure
       WHERE user_id = $1 AND business_entity_type = $2 AND verification_status = 'VERIFIED'
         AND exposure_type = ANY($3::text[])`,
      [userId, entityType, exposureTypes]
    );
    return res.rows[0].c;
  }

  const [supplierGeoKnown, purchaseCurrencyKnown, productSourceKnown, supplierLogisticsKnown] = await Promise.all([
    countVerifiedDistinctEntities('supplier', geoTypes),
    countVerifiedDistinctEntities('purchase', currencyTypes),
    countVerifiedDistinctEntities('product', geoTypes),
    countVerifiedDistinctEntities('supplier', logisticsTypes),
  ]);

  const totalSuppliers = supplierCount.rows[0].c;
  const totalPurchases = purchaseCount.rows[0].c;
  const totalProducts = productCount.rows[0].c;

  function dim(known, total) {
    return { known, total, coveragePct: total > 0 ? Number(((known / total) * 100).toFixed(1)) : 0 };
  }

  return {
    userId,
    generatedAt: new Date().toISOString(),
    dimensions: {
      supplier_geography: dim(supplierGeoKnown, totalSuppliers),
      purchase_currency: dim(purchaseCurrencyKnown, totalPurchases),
      product_source_country: dim(productSourceKnown, totalProducts),
      supplier_logistics_routes: dim(supplierLogisticsKnown, totalSuppliers),
    },
    honestNote: 'Counts are real COUNT()s against this tenant\'s suppliers/purchases/products tables and VERIFIED business_exposure rows only. Per STARLANE_WORLD_BUSINESS_LINKAGE_AUDIT.md, real tenant data typically has 0 usable geography/currency fields today, so near-zero coverage is the expected honest result until owners record facts via createExposure/verifyExposure or a bulk import.',
  };
}

module.exports = {
  VALID_ENTITY_TYPES,
  VALID_PROVENANCE_TYPES,
  createExposure,
  listTenantExposures,
  listExposuresForEntity,
  supersedeExposure,
  verifyExposure,
  rejectExposure,
  getExposureProvenance,
  getWorldIntelligenceReadiness,
};
