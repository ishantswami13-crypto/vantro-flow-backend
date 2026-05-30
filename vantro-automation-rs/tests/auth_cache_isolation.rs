// FILE: vantro-automation-rs/tests/auth_cache_isolation.rs
// Integration-level isolation gates. Runs under the PURE (no-feature) CI job
// `verify-pure-rust` via `cargo test --workspace --tests`, so it needs no DB,
// no server feature, and no linker-heavy deps.
//
// Covers:
//   3. Cross-user cache isolation, end to end (keys module + MemoryCache).
//   5. Static query-scoping check: every committed .sqlx query filters by
//      user_id (proves tenant scoping without a live database).

use uuid::Uuid;
use vantro_automation_lib::cache::{keys, memory::MemoryCache};

// Deterministic UUIDs (no `v4` feature needed).
fn uid(n: u128) -> Uuid {
    Uuid::from_u128(n)
}

// ── 3. Cross-user cache isolation ────────────────────────────────────────────

#[test]
fn user_a_dashboard_not_readable_with_user_b_key() {
    let cache = MemoryCache::new();
    let a = uid(1);
    let b = uid(2);

    cache.set(
        &keys::dashboard_bootstrap(a),
        &"A-dashboard".to_string(),
        60,
    );

    // User A reads their own value.
    assert_eq!(
        cache.get::<String>(&keys::dashboard_bootstrap(a)),
        Some("A-dashboard".to_string())
    );
    // User B's key must miss -- no cross-tenant leak.
    assert_eq!(cache.get::<String>(&keys::dashboard_bootstrap(b)), None);
}

#[test]
fn user_a_collections_not_readable_with_user_b_key() {
    let cache = MemoryCache::new();
    let a = uid(1);
    let b = uid(2);

    cache.set(
        &keys::collections_bootstrap(a),
        &"A-collections".to_string(),
        60,
    );

    assert_eq!(
        cache.get::<String>(&keys::collections_bootstrap(a)),
        Some("A-collections".to_string())
    );
    assert_eq!(cache.get::<String>(&keys::collections_bootstrap(b)), None);
}

#[test]
fn user_a_customer_score_not_readable_with_user_b_key() {
    let cache = MemoryCache::new();
    let a = uid(1);
    let b = uid(2);
    let customer = uid(100);

    cache.set(&keys::customer_score(a, customer), &77i32, 60);

    assert_eq!(
        cache.get::<i32>(&keys::customer_score(a, customer)),
        Some(77)
    );
    // Same customer id, different USER -> different key -> miss.
    assert_eq!(cache.get::<i32>(&keys::customer_score(b, customer)), None);
}

#[test]
fn same_route_different_user_produces_different_keys() {
    assert_ne!(
        keys::dashboard_bootstrap(uid(1)),
        keys::dashboard_bootstrap(uid(2))
    );
    assert_ne!(
        keys::collections_bootstrap(uid(1)),
        keys::collections_bootstrap(uid(2))
    );
    assert_ne!(
        keys::customer_score(uid(1), uid(9)),
        keys::customer_score(uid(2), uid(9))
    );
}

// ── 5. Static query-scoping gate ─────────────────────────────────────────────
// Every committed .sqlx query-*.json must reference `user_id` in its SQL, i.e.
// every persisted query the Rust service can run is tenant-scoped. This reads
// the committed offline cache at the workspace root and fails loudly if any
// query is missing the tenant filter. No JSON parser needed -- the SQL text is
// embedded in the file, so a substring check is sufficient and robust.

#[test]
fn every_committed_sqlx_query_is_user_scoped() {
    // CARGO_MANIFEST_DIR = <repo>/vantro-automation-rs ; .sqlx is at <repo>/.sqlx
    let sqlx_dir = format!("{}/../.sqlx", env!("CARGO_MANIFEST_DIR"));
    let dir = std::path::Path::new(&sqlx_dir);

    assert!(
        dir.is_dir(),
        "committed .sqlx offline cache must exist at {} (run the rust-sqlx-validation workflow and commit it)",
        sqlx_dir
    );

    let mut checked = 0usize;
    for entry in std::fs::read_dir(dir).expect("read .sqlx dir") {
        let path = entry.expect("dir entry").path();
        let is_query_json = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with("query-") && n.ends_with(".json"))
            .unwrap_or(false);
        if !is_query_json {
            continue;
        }

        let text = std::fs::read_to_string(&path).expect("read query json");
        assert!(
            text.contains("user_id"),
            "query cache file {:?} has no user_id tenant scope:\n{}",
            path.file_name(),
            text
        );
        checked += 1;
    }

    assert!(
        checked >= 1,
        "expected at least one committed query-*.json in .sqlx/"
    );
}
