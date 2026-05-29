// FILE: vantro-automation-rs/src/harness/assertions.rs
// Shared assertion helpers used across integration test modules.

/// Assert a CPI result is not missing its explanation.
pub fn assert_cpi_has_reasons(reasons: &[String]) {
    assert!(
        !reasons.is_empty(),
        "CPI result must always include at least one reason"
    );
}

/// Assert credit simulation triggers approval for the spec example.
pub fn assert_simulation_requires_approval(approval_required: bool, score: u8) {
    assert!(
        approval_required,
        "Simulation with broken promises + limit exceeded must require approval (score={})",
        score
    );
}

/// Assert policy blocks an unsafe action type.
pub fn assert_policy_blocks(blocked: bool, action_type: &str) {
    assert!(
        blocked,
        "Policy guard must block action_type={}",
        action_type
    );
}

/// Assert cost routing does not send deterministic tasks to expensive LLMs.
pub fn assert_cost_routes_rules_only_for_scoring(route: &str) {
    assert_eq!(
        route, "rules_only",
        "score_customer must route to rules_only, not LLM (got: {})",
        route
    );
}
