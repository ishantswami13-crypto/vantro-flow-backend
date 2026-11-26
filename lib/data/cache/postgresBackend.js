'use strict';
// Shared cache backend on Postgres: an UNLOGGED table (migration
// 090_data_layer_cache.sql). Every server replica reads and writes the same
// rows, so an invalidation on one server is seen by all of them, which the
// per-process Maps in server.js cannot do.
//
// UNLOGGED skips the write-ahead log: writes are cheap and the table is emptied
// after a crash, which is exactly right for a cache. It is never a source of
// truth.

const TABLE = 'starlane_cache';

function createPostgresBackend({ pool }) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('postgres cache backend needs a pg pool');
  return {
    name: 'postgres',
    async get(fullKey) {
      const r = await pool.query(`SELECT value FROM ${TABLE} WHERE cache_key = $1 AND expires_at > now()`, [fullKey]);
      return r.rows.length ? { hit: true, value: r.rows[0].value } : { hit: false };
    },
    async set(fullKey, tenant, value, ttlSeconds) {
      await pool.query(
        `INSERT INTO ${TABLE} (cache_key, tenant_id, value, expires_at)
         VALUES ($1, $2, $3::jsonb, now() + make_interval(secs => $4))
         ON CONFLICT (cache_key) DO UPDATE
           SET tenant_id = EXCLUDED.tenant_id, value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
        [fullKey, tenant, JSON.stringify(value), ttlSeconds]
      );
    },
    async del(fullKey) {
      await pool.query(`DELETE FROM ${TABLE} WHERE cache_key = $1`, [fullKey]);
    },
    async clearTenant(tenant, prefix) {
      await pool.query(`DELETE FROM ${TABLE} WHERE tenant_id = $1 AND starts_with(cache_key, $2)`, [tenant, prefix]);
    },
    async purgeExpired() {
      const r = await pool.query(`DELETE FROM ${TABLE} WHERE expires_at <= now()`);
      return r.rowCount;
    },
  };
}

module.exports = { createPostgresBackend, TABLE };
