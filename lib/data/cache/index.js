'use strict';
// lib/data/cache — the L1 cache layer.
//
// Every call names the tenant, so a cached value can never be served to a
// different tenant: the stored key is `<namespace>:<tenant>:<key>` and the
// backend also records the tenant for clearTenant().
//
// Backends (STARLANE_CACHE_BACKEND):
//   memory    (default) per-process, what the app effectively has today
//   postgres  shared across replicas, UNLOGGED table from migration 090
// A Redis backend can be added later behind the same five methods.
//
// The cache fails open: if the backend errors, get() is a miss and set() is a
// no-op, logged once per minute. A cache outage must never become an outage.

const { createMemoryBackend } = require('./memoryBackend');
const { createPostgresBackend } = require('./postgresBackend');
const { assertTenantId } = require('../tenantDb');

const KEY = /^[A-Za-z0-9_.:\-/]{1,200}$/;
const MAX_TTL_SECONDS = 24 * 3600;

let logError = (msg, meta) => {
  try { require('../../observability/logger').safeLog('warn', msg, meta); } catch { /* logger optional */ }
};

function createCache({ backend, namespace = 'app', defaultTtlSeconds = 60 } = {}) {
  if (!backend) throw new TypeError('createCache: backend is required');
  if (!KEY.test(namespace) || namespace.includes(':')) throw new TypeError('createCache: invalid namespace');
  const inflight = new Map();
  const stats = { hits: 0, misses: 0, errors: 0, sets: 0 };
  let lastLoggedAt = 0;

  function failed(op, err) {
    stats.errors += 1;
    const t = Date.now();
    if (t - lastLoggedAt > 60000) {
      lastLoggedAt = t;
      logError('[cache] backend error, failing open', { backend: backend.name, op, error: err && err.message });
    }
  }

  function prefixFor(tenant) { return `${namespace}:${tenant}:`; }

  function fullKey(tenantId, key) {
    const tenant = assertTenantId(tenantId);
    if (typeof key !== 'string' || !KEY.test(key)) throw new TypeError(`cache: invalid key "${key}"`);
    return { tenant, k: prefixFor(tenant) + key };
  }

  function ttl(seconds) {
    const n = Number(seconds === undefined ? defaultTtlSeconds : seconds);
    if (!Number.isFinite(n) || n <= 0) return defaultTtlSeconds;
    return Math.min(n, MAX_TTL_SECONDS);
  }

  const cache = {
    backendName: backend.name,
    async get(tenantId, key) {
      const { k } = fullKey(tenantId, key);
      try {
        const r = await backend.get(k);
        if (r.hit) { stats.hits += 1; return r.value; }
      } catch (err) { failed('get', err); }
      stats.misses += 1;
      return undefined;
    },
    async set(tenantId, key, value, ttlSeconds) {
      if (value === undefined) throw new TypeError('cache.set: value must not be undefined');
      const { tenant, k } = fullKey(tenantId, key);
      try { await backend.set(k, tenant, value, ttl(ttlSeconds)); stats.sets += 1; } catch (err) { failed('set', err); }
    },
    async del(tenantId, key) {
      const { k } = fullKey(tenantId, key);
      try { await backend.del(k); } catch (err) { failed('del', err); }
    },
    async clearTenant(tenantId) {
      const tenant = assertTenantId(tenantId);
      try { await backend.clearTenant(tenant, prefixFor(tenant)); } catch (err) { failed('clearTenant', err); }
    },
    // Read-through with single-flight: concurrent misses for the same key in
    // this process share one fetch. A cached null or 0 or false is a hit
    // (the old CacheService.getOrSet refetched every falsy value).
    async getOrSet(tenantId, key, ttlSeconds, fetcher) {
      if (typeof fetcher !== 'function') throw new TypeError('cache.getOrSet: fetcher must be a function');
      const { k } = fullKey(tenantId, key);
      const cached = await cache.get(tenantId, key);
      if (cached !== undefined) return cached;
      if (inflight.has(k)) return inflight.get(k);
      const p = (async () => {
        try {
          const fresh = await fetcher();
          if (fresh !== undefined) await cache.set(tenantId, key, fresh, ttlSeconds);
          return fresh;
        } finally {
          inflight.delete(k);
        }
      })();
      inflight.set(k, p);
      return p;
    },
    async purgeExpired() {
      try { return await backend.purgeExpired(); } catch (err) { failed('purgeExpired', err); return 0; }
    },
    stats: () => ({ backend: backend.name, ...stats }),
  };
  return Object.freeze(cache);
}

// The process-wide cache, chosen by STARLANE_CACHE_BACKEND. Created lazily so
// requiring this module never opens a database connection.
let shared = null;
let purgeTimer = null;

function backendFromEnv(env = process.env) {
  const wanted = String(env.STARLANE_CACHE_BACKEND || 'memory').toLowerCase();
  if (wanted === 'postgres') {
    if (!env.DATABASE_URL) {
      logError('[cache] STARLANE_CACHE_BACKEND=postgres but DATABASE_URL is not set; using memory', {});
      return createMemoryBackend();
    }
    return createPostgresBackend({ pool: require('../../db/pg').getPool() });
  }
  if (wanted !== 'memory') logError('[cache] unknown STARLANE_CACHE_BACKEND; using memory', { wanted });
  return createMemoryBackend();
}

function getCache() {
  if (!shared) {
    shared = createCache({ backend: backendFromEnv(), namespace: 'app' });
    purgeTimer = setInterval(() => { shared.purgeExpired(); }, 10 * 60 * 1000);
    purgeTimer.unref();
  }
  return shared;
}

module.exports = { createCache, getCache, createMemoryBackend, createPostgresBackend, MAX_TTL_SECONDS, _setLogger: (fn) => { logError = fn; } };
