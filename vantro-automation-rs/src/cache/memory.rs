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
