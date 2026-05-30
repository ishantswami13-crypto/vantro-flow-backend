// FILE: vantro-automation-rs/src/cache/memory.rs
// L1 in-process cache using DashMap (concurrent, no GC, RwLock-free).
// Entries carry an absolute expiry timestamp; eviction is lazy (checked on get)
// plus a periodic cleanup task kicked off at startup.

use dashmap::DashMap;
use serde::{de::DeserializeOwned, Serialize};
use std::time::{Duration, Instant};

struct Entry {
    bytes: Vec<u8>,
    expires_at: Instant,
}

pub struct MemoryCache {
    store: DashMap<String, Entry>,
}

impl MemoryCache {
    pub fn new() -> Self {
        MemoryCache {
            store: DashMap::new(),
        }
    }

    /// Get a cached value, deserialising from JSON bytes.
    pub fn get<T: DeserializeOwned>(&self, key: &str) -> Option<T> {
        let entry = self.store.get(key)?;
        if entry.expires_at <= Instant::now() {
            drop(entry);
            self.store.remove(key);
            return None;
        }
        serde_json::from_slice(&entry.bytes).ok()
    }

    /// Set a value with a TTL in seconds, serialising to JSON bytes.
    pub fn set<T: Serialize>(&self, key: &str, value: &T, ttl_secs: u64) {
        if let Ok(bytes) = serde_json::to_vec(value) {
            self.store.insert(
                key.to_string(),
                Entry {
                    bytes,
                    expires_at: Instant::now() + Duration::from_secs(ttl_secs),
                },
            );
        }
    }

    pub fn del(&self, key: &str) {
        self.store.remove(key);
    }

    /// Invalidate all keys that start with `prefix`.
    pub fn del_by_prefix(&self, prefix: &str) {
        let keys: Vec<String> = self
            .store
            .iter()
            .filter(|e| e.key().starts_with(prefix))
            .map(|e| e.key().clone())
            .collect();
        for k in keys {
            self.store.remove(&k);
        }
    }

    /// Remove expired entries. Call periodically.
    pub fn evict_expired(&self) {
        let now = Instant::now();
        let dead: Vec<String> = self
            .store
            .iter()
            .filter(|e| e.expires_at <= now)
            .map(|e| e.key().clone())
            .collect();
        for k in dead {
            self.store.remove(&k);
        }
    }

    pub fn len(&self) -> usize {
        self.store.len()
    }

    /// Helper: get-or-set with a fallback async closure.
    pub async fn get_or_set<T, F, Fut>(
        &self,
        key: &str,
        ttl: u64,
        f: F,
    ) -> anyhow::Result<(T, &'static str)>
    where
        T: Serialize + DeserializeOwned + Clone,
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = anyhow::Result<T>>,
    {
        if let Some(cached) = self.get::<T>(key) {
            return Ok((cached, "cache"));
        }
        let value = f().await?;
        self.set(key, &value, ttl);
        Ok((value, "db"))
    }
}

impl Default for MemoryCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── 3. Cross-user cache isolation (the crown-jewel safety test) ──

    #[test]
    fn set_then_get_same_key_roundtrips() {
        let c = MemoryCache::new();
        c.set("user:A:dashboard_bootstrap", &42i32, 60);
        assert_eq!(c.get::<i32>("user:A:dashboard_bootstrap"), Some(42));
    }

    #[test]
    fn user_b_cannot_read_user_a_value() {
        let c = MemoryCache::new();
        c.set("user:A:dashboard_bootstrap", &42i32, 60);
        // Different key (user B) must miss -- no cross-tenant read.
        assert_eq!(c.get::<i32>("user:B:dashboard_bootstrap"), None);
    }

    #[test]
    fn two_users_keep_independent_values() {
        let c = MemoryCache::new();
        c.set("user:A:dashboard_bootstrap", &"A-data".to_string(), 60);
        c.set("user:B:dashboard_bootstrap", &"B-data".to_string(), 60);
        assert_eq!(
            c.get::<String>("user:A:dashboard_bootstrap"),
            Some("A-data".to_string())
        );
        assert_eq!(
            c.get::<String>("user:B:dashboard_bootstrap"),
            Some("B-data".to_string())
        );
    }

    #[test]
    fn ttl_zero_is_treated_as_expired() {
        let c = MemoryCache::new();
        c.set("k", &1i32, 0);
        // expires_at == now-at-set; by the time we read, now >= expires_at -> gone.
        assert_eq!(c.get::<i32>("k"), None);
    }

    #[test]
    fn del_removes_only_that_key() {
        let c = MemoryCache::new();
        c.set("user:A:dashboard_bootstrap", &1i32, 60);
        c.set("user:B:dashboard_bootstrap", &2i32, 60);
        c.del("user:A:dashboard_bootstrap");
        assert_eq!(c.get::<i32>("user:A:dashboard_bootstrap"), None);
        assert_eq!(c.get::<i32>("user:B:dashboard_bootstrap"), Some(2));
    }

    #[test]
    fn del_by_prefix_only_clears_matching_user() {
        let c = MemoryCache::new();
        c.set("user:A:dashboard_bootstrap", &1i32, 60);
        c.set("user:A:collections_bootstrap", &2i32, 60);
        c.set("user:B:dashboard_bootstrap", &3i32, 60);
        c.del_by_prefix("user:A:");
        assert_eq!(c.get::<i32>("user:A:dashboard_bootstrap"), None);
        assert_eq!(c.get::<i32>("user:A:collections_bootstrap"), None);
        // Other tenants untouched.
        assert_eq!(c.get::<i32>("user:B:dashboard_bootstrap"), Some(3));
    }

    #[test]
    fn type_mismatch_get_returns_none_without_panic() {
        let c = MemoryCache::new();
        c.set("k", &"a string".to_string(), 60);
        // Deserialising a String as i32 fails -> None (no panic, no leak).
        assert_eq!(c.get::<i32>("k"), None);
    }
}
