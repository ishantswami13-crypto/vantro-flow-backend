// FILE: lib/world/entities.js
// Deterministic upsert helpers for world_entities. No LLM involvement —
// entity identity is resolved purely by (entity_type, slug) or
// (entity_type, code), matching migration 015's unique indexes.
const { getPool } = require('../db/pg');

function slugify(str) {
  return String(str).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// Upsert a world_entities row keyed on (entity_type, slug). Returns the row id.
async function upsertEntity({ entityType, code, name, attributes }) {
  const pool = getPool();
  const slug = slugify(code || name);
  const res = await pool.query(
    `INSERT INTO world_entities (entity_type, code, slug, name, attributes)
     VALUES ($1, $2, $3, $4, COALESCE($5, '{}'::jsonb))
     ON CONFLICT (entity_type, slug) DO UPDATE SET
       name = EXCLUDED.name,
       attributes = world_entities.attributes || EXCLUDED.attributes,
       updated_at = NOW()
     RETURNING id`,
    [entityType, code || null, slug, name, attributes ? JSON.stringify(attributes) : null]
  );
  return res.rows[0].id;
}

// Convenience: ISO-3166 alpha-2 country entity.
async function upsertCountry(countryCode, name) {
  return upsertEntity({ entityType: 'COUNTRY', code: countryCode, name: name || countryCode, attributes: { iso2: countryCode } });
}

async function upsertCurrency(currencyCode, name) {
  return upsertEntity({ entityType: 'CURRENCY', code: currencyCode, name: name || currencyCode, attributes: { iso4217: currencyCode } });
}

async function linkEventEntity(eventId, entityId, relationshipType) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO world_event_entities (event_id, entity_id, relationship_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (event_id, entity_id, relationship_type) DO NOTHING`,
    [eventId, entityId, relationshipType]
  );
}

module.exports = { slugify, upsertEntity, upsertCountry, upsertCurrency, linkEventEntity };
