// FILE: lib/cache/cache.service.js
/**
 * Generic caching abstraction.
 * Currently uses an in-memory Map as a temporary per-process cache 
 * because Redis is not yet provisioned. 
 * WARNING: In-memory LRU is ephemeral and per-process. 
 * When deploying to multiple serverless functions or horizontally scaled containers,
 * cache invalidation will not propagate across nodes.
 */

const CACHE = new Map();

// Helper to clear expired keys to prevent memory leaks
function cleanup() {
  const now = Date.now();
  for (const [key, item] of CACHE.entries()) {
    if (now > item.expiresAt) {
      CACHE.delete(key);
    }
  }
}

// Run cleanup every 5 minutes
setInterval(cleanup, 5 * 60 * 1000).unref();

const CacheService = {
  get: (key) => {
    const item = CACHE.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      CACHE.delete(key);
      return null;
    }
    return item.value;
  },

  set: (key, value, ttlSeconds = 60) => {
    CACHE.set(key, {
      value,
      expiresAt: Date.now() + (ttlSeconds * 1000)
    });
  },

  del: (key) => {
    CACHE.delete(key);
  },

  // Flushes all keys matching a prefix (e.g. `user:${userId}:`)
  delByPrefix: (prefix) => {
    for (const key of CACHE.keys()) {
      if (key.startsWith(prefix)) {
        CACHE.delete(key);
      }
    }
  },

  getOrSet: async (key, ttlSeconds, fetcher) => {
    const cached = CacheService.get(key);
    if (cached) return cached;
    
    const freshData = await fetcher();
    CacheService.set(key, freshData, ttlSeconds);
    return freshData;
  }
};

module.exports = CacheService;
