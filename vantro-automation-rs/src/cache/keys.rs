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

#[cfg(test)]
mod tests {
    use super::*;

    // Deterministic UUIDs without the `v4` feature (no getrandom on Windows).
    fn uid(n: u128) -> Uuid {
        Uuid::from_u128(n)
    }

    // ── 2. Cache key safety: every user-data key includes the user_id ──

    #[test]
    fn dashboard_key_is_user_scoped() {
        let u = uid(1);
        let k = dashboard_bootstrap(u);
        assert!(k.starts_with("user:"), "{}", k);
        assert!(k.contains(&u.to_string()), "{}", k);
    }

    #[test]
    fn collections_key_is_user_scoped() {
        let u = uid(1);
        let k = collections_bootstrap(u);
        assert!(k.starts_with("user:"), "{}", k);
        assert!(k.contains(&u.to_string()), "{}", k);
    }

    #[test]
    fn action_feed_key_is_user_scoped() {
        let u = uid(1);
        let k = action_feed(u);
        assert!(k.starts_with("user:"), "{}", k);
        assert!(k.contains(&u.to_string()), "{}", k);
    }

    #[test]
    fn customer_score_key_includes_user_and_customer() {
        let u = uid(1);
        let c = uid(2);
        let k = customer_score(u, c);
        assert!(k.contains(&u.to_string()), "missing user_id: {}", k);
        assert!(k.contains(&c.to_string()), "missing customer_id: {}", k);
    }

    #[test]
    fn customer_cpi_key_includes_user_and_customer() {
        let u = uid(1);
        let c = uid(2);
        let k = customer_cpi(u, c);
        assert!(k.contains(&u.to_string()), "missing user_id: {}", k);
        assert!(k.contains(&c.to_string()), "missing customer_id: {}", k);
    }

    // ── 3. Cross-user: same route, different user → different key ──

    #[test]
    fn different_users_get_different_dashboard_keys() {
        assert_ne!(dashboard_bootstrap(uid(1)), dashboard_bootstrap(uid(2)));
    }

    #[test]
    fn different_users_get_different_collections_keys() {
        assert_ne!(collections_bootstrap(uid(1)), collections_bootstrap(uid(2)));
    }

    #[test]
    fn same_customer_different_user_yields_different_score_key() {
        let c = uid(99);
        assert_ne!(customer_score(uid(1), c), customer_score(uid(2), c));
    }

    #[test]
    fn same_user_different_customer_yields_different_score_key() {
        let u = uid(1);
        assert_ne!(customer_score(u, uid(10)), customer_score(u, uid(20)));
    }

    // ── Prefix invalidation is user-scoped ────────────────────────

    #[test]
    fn user_prefix_is_a_prefix_of_that_users_keys() {
        let u = uid(7);
        let p = user_prefix(u);
        assert!(dashboard_bootstrap(u).starts_with(&p));
        assert!(collections_bootstrap(u).starts_with(&p));
        assert!(action_feed(u).starts_with(&p));
        assert!(customer_score(u, uid(5)).starts_with(&p));
        assert!(customer_cpi(u, uid(5)).starts_with(&p));
    }

    #[test]
    fn user_prefix_differs_per_user() {
        assert_ne!(user_prefix(uid(1)), user_prefix(uid(2)));
        // And user A's prefix must NOT match user B's keys.
        let pa = user_prefix(uid(1));
        assert!(!dashboard_bootstrap(uid(2)).starts_with(&pa));
    }

    // ── The single global key is config, NOT user data ────────────

    #[test]
    fn policy_config_is_global_config_only_not_user_data() {
        let k = policy_config();
        assert!(k.starts_with("global:"), "{}", k);
        // Must not masquerade as a user-data key.
        assert!(!k.starts_with("user:"), "{}", k);
    }

    // ── Structural invariant across ALL user-data key builders ────

    #[test]
    fn all_user_data_keys_are_user_scoped() {
        let u = uid(424242);
        let c = uid(777);
        let user_data_keys = [
            dashboard_bootstrap(u),
            collections_bootstrap(u),
            action_feed(u),
            customer_score(u, c),
            customer_cpi(u, c),
        ];
        for k in user_data_keys {
            assert!(
                k.starts_with("user:"),
                "user-data key must start with 'user:' -> {}",
                k
            );
            assert!(
                k.contains(&u.to_string()),
                "user-data key must contain the user_id -> {}",
                k
            );
        }
    }
}
