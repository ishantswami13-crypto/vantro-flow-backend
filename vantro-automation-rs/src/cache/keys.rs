// FILE: vantro-automation-rs/src/cache/keys.rs
// All cache keys MUST be scoped to user_id. Never use global unscoped keys.
// Key format mirrors Node: user:{user_id}:{scope}

use uuid::Uuid;

/// Dashboard bootstrap — 30s TTL.
pub fn dashboard_bootstrap(user_id: Uuid) -> String {
    format!("user:{}:dashboard_bootstrap", user_id)
}

/// Collections bootstrap — 30s TTL.
pub fn collections_bootstrap(user_id: Uuid) -> String {
    format!("user:{}:collections_bootstrap", user_id)
}

/// Per-customer score — 60s TTL.
pub fn customer_score(user_id: Uuid, customer_id: Uuid) -> String {
    format!("user:{}:customer_score:{}", user_id, customer_id)
}

/// Per-customer CPI — 60s TTL.
pub fn customer_cpi(user_id: Uuid, customer_id: Uuid) -> String {
    format!("user:{}:customer_cpi:{}", user_id, customer_id)
}

/// Action feed — 30s TTL.
pub fn action_feed(user_id: Uuid) -> String {
    format!("user:{}:action_feed", user_id)
}

/// Policy config — 5 min TTL.
pub fn policy_config() -> &'static str {
    "global:policy_config"
}

/// All keys matching a user prefix for invalidation.
pub fn user_prefix(user_id: Uuid) -> String {
    format!("user:{}:", user_id)
}

// TTLs in seconds.
pub const TTL_DASHBOARD: u64 = 30;
pub const TTL_COLLECTIONS: u64 = 30;
pub const TTL_SCORE: u64 = 60;
pub const TTL_ACTION_FEED: u64 = 30;
pub const TTL_POLICY_CFG: u64 = 300;
