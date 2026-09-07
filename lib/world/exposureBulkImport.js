// FILE: lib/world/exposureBulkImport.js
// World Intelligence Phase 3, Part A — Phase 4 (Bulk Import).
//
// Accepts an array of records shaped like what a CSV/JSON upload would parse
// into: { entity_type, entity_identifier, exposure_type, value }. Resolves
// entity_identifier against the tenant's real suppliers/customers/products
// table (by UUID id or by exact case-insensitive name match), resolves
// `value` via deterministic country/currency normalization
// (businessEntityResolution.js), and either writes new UNVERIFIED
// business_exposure rows (dryRun=false) or only validates (dryRun=true).
//
// NEVER guesses: any record whose entity or value cannot be deterministically
// resolved goes into `unresolved`, never into `accepted`.
const { getPool } = require('../db/pg');
const { resolveCountryValue, resolveCurrencyValue } = require('./businessEntityResolution');
const { createExposure } = require('./exposureRegistry');

const ENTITY_TABLE = { supplier: 'suppliers', customer: 'customers', product: 'products' };

// Which exposure_type families resolve via which normalizer. Anything not
// listed here is UNUSABLE for bulk import today (documented, not silently
// dropped) — purchase/order/sale aren't in ENTITY_TABLE because there is no
// stable human-readable "identifier" for them (no name column); bulk import
// targets master-data entities (supplier/customer/product) by design, and
// records for other entity types are rejected with a clear reason rather
// than accepted with a guessed id.
const GEO_EXPOSURE_TYPES = new Set(['LOCATED_IN', 'OPERATES_IN', 'MANUFACTURES_IN', 'SOURCES_FROM', 'SELLS_IN']);
const CURRENCY_EXPOSURE_TYPES = new Set(['CURRENCY_DENOMINATED', 'BILLS_IN', 'PAYS_IN', 'DENOMINATED_IN', 'RECEIVES_IN']);

function kindForExposureType(exposureType) {
  if (GEO_EXPOSURE_TYPES.has(exposureType)) return 'country';
  if (CURRENCY_EXPOSURE_TYPES.has(exposureType)) return 'currency';
  return null;
}

async function resolveEntity(pool, userId, entityType, entityIdentifier) {
  const table = ENTITY_TABLE[entityType];
  if (!table) return { ok: false, reason: `unsupported entity_type "${entityType}" for bulk import` };
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(entityIdentifier));
  if (isUuid) {
    const res = await pool.query(`SELECT id, name FROM ${table} WHERE id = $1 AND user_id = $2`, [entityIdentifier, userId]);
    if (res.rows.length === 1) return { ok: true, id: res.rows[0].id, name: res.rows[0].name };
    return { ok: false, reason: `no ${entityType} with id "${entityIdentifier}" for this tenant` };
  }
  const res = await pool.query(
    `SELECT id, name FROM ${table} WHERE user_id = $1 AND lower(name) = lower($2)`,
    [userId, entityIdentifier]
  );
  if (res.rows.length === 1) return { ok: true, id: res.rows[0].id, name: res.rows[0].name };
  if (res.rows.length > 1) return { ok: false, reason: `ambiguous ${entityType} name "${entityIdentifier}" — ${res.rows.length} matches` };
  return { ok: false, reason: `no ${entityType} named "${entityIdentifier}" for this tenant` };
}

/**
 * @param {string} userId
 * @param {Array<{entity_type, entity_identifier, exposure_type, value}>} records
 * @param {{dryRun?: boolean, provenanceReference?: string}} opts
 */
async function bulkImportExposures(userId, records, { dryRun = false, provenanceReference = null } = {}) {
  if (!userId) throw new Error('bulkImportExposures: userId is required');
  if (!Array.isArray(records)) throw new Error('bulkImportExposures: records must be an array');

  const pool = getPool();
  const accepted = [];
  const rejected = [];
  const unresolved = [];
  const duplicate = [];
  const conflicting = [];

  // Track (entityType, entityId, exposureType) already seen IN THIS BATCH to
  // catch intra-batch duplicates/conflicts even before hitting the DB.
  const seenInBatch = new Map(); // key -> { value, index }

  // Pre-load existing UNVERIFIED/VERIFIED exposures for conflict detection
  // (same entity + exposure_type already resolved to a DIFFERENT world
  // entity is a conflict, not a duplicate).
  const existingRes = await pool.query(
    `SELECT business_entity_type, business_entity_id, exposure_type, world_entity_id, normalized_value
     FROM business_exposure
     WHERE user_id = $1 AND verification_status IN ('VERIFIED','UNVERIFIED') AND (valid_to IS NULL OR valid_to > NOW())`,
    [userId]
  );
  const existingByKey = new Map();
  for (const row of existingRes.rows) {
    const key = `${row.business_entity_type}:${row.business_entity_id}:${row.exposure_type}`;
    existingByKey.set(key, row);
  }

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const { entity_type, entity_identifier, exposure_type, value } = record || {};
    const base = { index: i, record };

    if (!entity_type || !entity_identifier || !exposure_type || value === undefined || value === null || value === '') {
      rejected.push({ ...base, reason: 'missing required field (entity_type, entity_identifier, exposure_type, value)' });
      continue;
    }

    const kind = kindForExposureType(exposure_type);
    if (!kind) {
      rejected.push({ ...base, reason: `exposure_type "${exposure_type}" is not supported by bulk import's normalizer (no deterministic resolver registered) — classify UNUSABLE` });
      continue;
    }

    const entityRes = await resolveEntity(pool, userId, entity_type, entity_identifier);
    if (!entityRes.ok) {
      unresolved.push({ ...base, stage: 'entity', reason: entityRes.reason });
      continue;
    }

    const resolver = kind === 'currency' ? resolveCurrencyValue : resolveCountryValue;
    const valueRes = await resolver(value);
    if (!valueRes) {
      unresolved.push({ ...base, stage: 'value', reason: `could not deterministically resolve ${kind} value "${value}"`, entityId: entityRes.id });
      continue;
    }

    const dedupKey = `${entity_type}:${entityRes.id}:${exposure_type}`;

    // Intra-batch duplicate/conflict check
    if (seenInBatch.has(dedupKey)) {
      const prior = seenInBatch.get(dedupKey);
      if (prior.worldEntityId === valueRes.worldEntityId) {
        duplicate.push({ ...base, reason: `duplicate of record #${prior.index} in this batch (same entity + exposure_type + resolved value)` });
      } else {
        conflicting.push({ ...base, reason: `conflicts with record #${prior.index} in this batch: resolved to a different value ("${prior.value}" vs "${value}") for the same entity + exposure_type` });
      }
      continue;
    }

    // Cross-check against already-persisted exposures
    const existing = existingByKey.get(dedupKey);
    if (existing) {
      if (existing.world_entity_id === valueRes.worldEntityId) {
        duplicate.push({ ...base, reason: 'an exposure for this entity + exposure_type already exists with the same resolved value', entityId: entityRes.id });
        continue;
      }
      conflicting.push({ ...base, reason: `an existing exposure for this entity + exposure_type resolves to a different value ("${existing.normalized_value}" vs "${valueRes.normalized}") — resolve manually via supersedeExposure`, entityId: entityRes.id });
      continue;
    }

    seenInBatch.set(dedupKey, { worldEntityId: valueRes.worldEntityId, value, index: i });

    if (dryRun) {
      accepted.push({ ...base, wouldCreate: { businessEntityType: entity_type, businessEntityId: entityRes.id, exposureType: exposure_type, worldEntityId: valueRes.worldEntityId, normalizedValue: valueRes.normalized } });
      continue;
    }

    const created = await createExposure(userId, {
      businessEntityType: entity_type,
      businessEntityId: entityRes.id,
      exposureType: exposure_type,
      worldEntityId: valueRes.worldEntityId,
      rawValue: String(value),
      provenanceType: 'IMPORT',
      provenanceReference: provenanceReference || `bulk_import:${new Date().toISOString()}:row-${i}`,
      sourceOfFact: 'imported',
      evidenceNotes: `Bulk import row ${i}: entity_identifier="${entity_identifier}" resolved via ${valueRes.method}`,
    });
    accepted.push({ ...base, exposure: created });
  }

  return {
    dryRun,
    totalRecords: records.length,
    accepted,
    rejected,
    unresolved,
    duplicate,
    conflicting,
    counts: {
      accepted: accepted.length,
      rejected: rejected.length,
      unresolved: unresolved.length,
      duplicate: duplicate.length,
      conflicting: conflicting.length,
    },
  };
}

module.exports = { bulkImportExposures, kindForExposureType, resolveEntity };
