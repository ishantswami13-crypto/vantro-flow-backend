'use strict';
// lib/data/search — L5: fuzzy name search and duplicate detection over the
// tenant's customers, suppliers and products (migration 094, pg_trgm).
//
//   search(userId, q, { types, limit })     ranked, typo-tolerant matches
//   duplicates(userId, { type, minScore })  pairs of names that are probably
//                                           the same party
//
// search_entities is rebuilt per tenant when its sources change, by the same
// fingerprint rule as the read models, so results are never stale.

const { withTenant, readTenant } = require('../tenantDb');

const TYPES = ['customer', 'supplier', 'product'];
const SOURCES = ['customers', 'suppliers', 'products', 'invoices'];
const MODEL = 'search_entities';

let trgmSchemaPromise = null;
function trgmSchema(db) {
  if (!trgmSchemaPromise) {
    trgmSchemaPromise = db.query(
      "SELECT n.nspname AS s FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm'"
    ).then((r) => {
      if (!r.rows.length) throw new Error('pg_trgm is not installed (migration 094)');
      const s = r.rows[0].s;
      if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error('unexpected pg_trgm schema name');
      return s;
    }).catch((err) => { trgmSchemaPromise = null; throw err; });
  }
  return trgmSchemaPromise;
}

function requireTenant(db) {
  if (!db || typeof db.query !== 'function' || !db.userId) throw new TypeError('search: pass the tenant handle from withTenant()');
  return db.userId;
}

// One fingerprint over every source table: changes on any insert, update or
// delete in any of them (see readModels/receivables.js).
async function sourcesFingerprint(db) {
  const tenant = requireTenant(db);
  // One client runs one query at a time, so these go in sequence.
  const parts = [];
  for (const t of SOURCES) {
    parts.push(await db.query(
      `SELECT count(*)::text AS n,
              COALESCE(sum(('x' || substr(md5(id::text || ':' || xmin::text), 1, 8))::bit(32)::bigint), 0)::text AS fp
         FROM ${t} WHERE user_id = $1`, [tenant]
    ));
  }
  return {
    rows: String(parts.reduce((s, p) => s + Number(p.rows[0].n), 0)),
    fingerprint: parts.map((p) => `${p.rows[0].n}:${p.rows[0].fp}`).join('|'),
  };
}

async function rebuildSearch(db) {
  const tenant = requireTenant(db);
  await db.query("SELECT pg_advisory_xact_lock(hashtext('search:entities'), hashtext($1))", [tenant]);
  const mark = await sourcesFingerprint(db);
  await db.query('DELETE FROM search_entities WHERE user_id = $1', [tenant]);
  await db.query(
    `INSERT INTO search_entities (user_id, entity_type, entity_id, name, norm, detail)
     SELECT $1, 'customer', id::text, btrim(name), starlane_norm_name(name), COALESCE(NULLIF(gstin, ''), NULLIF(phone, ''))
       FROM customers WHERE user_id = $1 AND COALESCE(btrim(name), '') <> ''
     UNION ALL
     SELECT $1, 'supplier', id::text, btrim(name), starlane_norm_name(name), COALESCE(NULLIF(gstin, ''), NULLIF(phone, ''))
       FROM suppliers WHERE user_id = $1 AND COALESCE(btrim(name), '') <> ''
     UNION ALL
     SELECT $1, 'product', id::text, btrim(name), starlane_norm_name(name || ' ' || COALESCE(sku, '')), NULLIF(sku, '')
       FROM products WHERE user_id = $1 AND COALESCE(btrim(name), '') <> ''
     ON CONFLICT DO NOTHING`,
    [tenant]
  );
  // Customers that only exist as a name on invoices (imports without a
  // customer record). Their id matches the read models' customer_key.
  await db.query(
    `INSERT INTO search_entities (user_id, entity_type, entity_id, name, norm)
     SELECT $1, 'customer', 'name:' || lower(btrim(customer_name)), min(btrim(customer_name)), starlane_norm_name(min(customer_name))
       FROM invoices i
      WHERE user_id = $1 AND customer_id IS NULL AND COALESCE(btrim(customer_name), '') <> ''
        AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.user_id = $1 AND lower(btrim(c.name)) = lower(btrim(i.customer_name)))
      GROUP BY lower(btrim(customer_name))
     ON CONFLICT DO NOTHING`,
    [tenant]
  );
  await db.query(
    `INSERT INTO rm_refresh_state (user_id, model, source_fingerprint, source_rows, as_of, refreshed_at)
     VALUES ($1, $2, $3, $4, CURRENT_DATE, now())
     ON CONFLICT (user_id, model) DO UPDATE SET source_fingerprint = EXCLUDED.source_fingerprint,
       source_rows = EXCLUDED.source_rows, refreshed_at = EXCLUDED.refreshed_at`,
    [tenant, MODEL, mark.fingerprint, mark.rows]
  );
}

async function ensureFresh(userId, { pool } = {}) {
  const stale = await readTenant(userId, async (db) => {
    const state = await db.query('SELECT source_fingerprint FROM rm_refresh_state WHERE user_id = $1 AND model = $2', [db.userId, MODEL]);
    const mark = await sourcesFingerprint(db);
    return !state.rows.length || state.rows[0].source_fingerprint !== mark.fingerprint;
  }, { pool });
  if (stale) await withTenant(userId, rebuildSearch, { pool, timeoutMs: 60000 });
  return stale;
}

function parseTypes(types) {
  const list = (Array.isArray(types) ? types : String(types || '').split(',')).map((t) => t.trim()).filter(Boolean);
  if (!list.length) return TYPES;
  for (const t of list) if (!TYPES.includes(t)) throw new RangeError(`search: type must be one of ${TYPES.join(', ')}`);
  return list;
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

async function search(userId, q, { types, limit = 20, pool } = {}) {
  const query = String(q || '').trim();
  if (query.length < 2) throw new RangeError('search: query must be at least 2 characters');
  if (query.length > 200) throw new RangeError('search: query is too long');
  const kinds = parseTypes(types);
  const n = Math.min(Math.max(1, Math.floor(Number(limit)) || 20), 100);
  await ensureFresh(userId, { pool });
  return readTenant(userId, async (db) => {
    const s = await trgmSchema(db);
    await db.query("SELECT set_config('pg_trgm.word_similarity_threshold', '0.35', true)");
    const r = await db.query(
      `WITH q AS (SELECT starlane_norm_name($2) AS norm)
       SELECT entity_type AS type, entity_id AS id, name, detail,
              round(GREATEST(${s}.word_similarity(q.norm, e.norm), ${s}.similarity(q.norm, e.norm),
                             CASE WHEN lower(e.detail) LIKE lower($4) ESCAPE '\\' THEN 1 ELSE 0 END)::numeric, 3) AS score
         FROM search_entities e, q
        WHERE e.user_id = $1 AND e.entity_type = ANY($3)
          AND (q.norm OPERATOR(${s}.<%) e.norm OR lower(e.detail) LIKE lower($4) ESCAPE '\\')
        ORDER BY score DESC, (e.entity_id LIKE 'name:%'), length(e.name), e.name
        LIMIT $5`,
      [db.userId, query, kinds, `${escapeLike(query)}%`, n]
    );
    return r.rows.map((row) => ({ ...row, score: Number(row.score) }));
  }, { pool });
}

async function duplicates(userId, { type = 'customer', minScore = 0.6, limit = 100, pool } = {}) {
  const [kind] = parseTypes(type);
  const threshold = Math.min(Math.max(Number(minScore) || 0.6, 0.3), 1);
  const n = Math.min(Math.max(1, Math.floor(Number(limit)) || 100), 500);
  await ensureFresh(userId, { pool });
  return readTenant(userId, async (db) => {
    const s = await trgmSchema(db);
    await db.query("SELECT set_config('pg_trgm.similarity_threshold', $1, true)", [String(threshold)]);
    const r = await db.query(
      `SELECT a.entity_id AS a_id, a.name AS a_name, b.entity_id AS b_id, b.name AS b_name,
              round(${s}.similarity(a.norm, b.norm)::numeric, 3) AS score
         FROM search_entities a
         JOIN search_entities b
           ON b.user_id = a.user_id AND b.entity_type = a.entity_type
          AND a.entity_id < b.entity_id AND a.norm OPERATOR(${s}.%) b.norm
        WHERE a.user_id = $1 AND a.entity_type = $2 AND a.norm <> ''
        ORDER BY score DESC, a.name
        LIMIT $3`,
      [db.userId, kind, n]
    );
    return r.rows.map((row) => ({
      a: { id: row.a_id, name: row.a_name }, b: { id: row.b_id, name: row.b_name }, score: Number(row.score),
    }));
  }, { pool });
}

module.exports = { search, duplicates, ensureFresh, rebuildSearch, TYPES };
