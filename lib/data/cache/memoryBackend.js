'use strict';
// In-process cache backend. Values are stored as JSON text so a caller can
// never mutate a cached object in place, and so behaviour matches the Postgres
// backend exactly (only JSON-serialisable values survive a round trip).
// Bounded: the least recently used entry is evicted past maxEntries.

function createMemoryBackend({ maxEntries = 5000, now = () => Date.now() } = {}) {
  const store = new Map(); // fullKey -> { tenant, json, expiresAt }

  function live(fullKey) {
    const e = store.get(fullKey);
    if (!e) return null;
    if (now() >= e.expiresAt) { store.delete(fullKey); return null; }
    // refresh recency
    store.delete(fullKey);
    store.set(fullKey, e);
    return e;
  }

  return {
    name: 'memory',
    async get(fullKey) {
      const e = live(fullKey);
      return e ? { hit: true, value: JSON.parse(e.json) } : { hit: false };
    },
    async set(fullKey, tenant, value, ttlSeconds) {
      store.delete(fullKey);
      store.set(fullKey, { tenant, json: JSON.stringify(value), expiresAt: now() + ttlSeconds * 1000 });
      while (store.size > maxEntries) store.delete(store.keys().next().value);
    },
    async del(fullKey) {
      store.delete(fullKey);
    },
    async clearTenant(tenant, prefix) {
      for (const [k, e] of store) if (e.tenant === tenant && k.startsWith(prefix)) store.delete(k);
    },
    async purgeExpired() {
      const t = now();
      let n = 0;
      for (const [k, e] of store) if (t >= e.expiresAt) { store.delete(k); n += 1; }
      return n;
    },
    size: () => store.size,
  };
}

module.exports = { createMemoryBackend };
