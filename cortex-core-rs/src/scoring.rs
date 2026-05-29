// FILE: cortex-core-rs/src/scoring.rs
// Deterministic scoring functions. These mirror scoring.service.js exactly so
// the parity test in cortex-lab can assert JS score ≈ Rust score ±1.
//
// Weights (matches scoring.service.js):
//   overdue amount:   up to 40 pts  (every ₹10k → +5, capped 40)
//   max delay days:   up to 20 pts  (every day → +1, capped 20)
//   broken promises:  up to 20 pts  (every broken → +7, capped 20)
//   low response rate:up to 20 pts  (responseScore contributes up to 20)

use crate::types::{CustomerMetrics, RiskLevel, ScoreResult};

/// Calculate response rate score (0–100). Neutral at 50 when no calls made.
fn response_score(calls_total: u32, calls_picked: u32) -> f64 {
    if calls_total == 0 {
        50.0
    } else {
        (calls_picked as f64 / calls_total as f64) * 100.0
    }
}

/// Promise reliability: (total - broken) / total * 100. 100 when no promises.
pub fn calculate_promise_reliability_score(broken: u32, total: u32) -> u8 {
    if total == 0 {
        return 100;
    }
    let reliability = ((total - broken.min(total)) as f64 / total as f64) * 100.0;
    reliability.round().clamp(0.0, 100.0) as u8
}

/// Recovery probability: inverse of credit risk, adjusted by promise reliability.
pub fn calculate_recovery_probability(credit_risk: u8, promise_reliability: u8) -> u8 {
    let base = 100u8.saturating_sub(credit_risk);
    // Weight: 70% base, 30% promise reliability.
    let p = (base as f64 * 0.70) + (promise_reliability as f64 * 0.30);
    p.round().clamp(0.0, 100.0) as u8
}

/// Core composite credit risk score (0–100, higher = riskier).
/// Mirrors scoring.service.js lines 72-80 exactly.
pub fn calculate_customer_risk_score(m: &CustomerMetrics) -> u8 {
    let rs = response_score(m.calls_total, m.calls_picked);

    let mut score: f64 = 0.0;
    // every ₹10k adds 5pts, capped at 40
    score += (m.total_overdue / 10_000.0 * 5.0).min(40.0);
    // every day adds 1pt, capped at 20
    score += m.max_delay_days.min(20.0);
    // every broken promise adds 7pts, capped at 20
    score += (m.broken_promises as f64 * 7.0).min(20.0);
    // low response rate adds up to 20 pts
    score += (20.0_f64 - rs * 0.2).max(0.0);

    score.round().clamp(0.0, 100.0) as u8
}

/// Collection priority — V1 identical to credit risk. V2 will add customer value weighting.
pub fn calculate_collection_priority_score(m: &CustomerMetrics) -> u8 {
    calculate_customer_risk_score(m)
}

/// Build a human-readable reason list matching scoring.service.js output.
fn build_reasons(m: &CustomerMetrics, score: u8) -> Vec<String> {
    let mut reasons = Vec::new();
    if m.total_overdue > 0.0 {
        reasons.push(format!(
            "₹{:.0} overdue",
            m.total_overdue
        ));
    }
    if m.max_delay_days > 0.0 {
        reasons.push(format!("up to {:.0} days late", m.max_delay_days));
    }
    if m.broken_promises > 0 {
        reasons.push(format!(
            "{} broken promise{}",
            m.broken_promises,
            if m.broken_promises > 1 { "s" } else { "" }
        ));
    }
    let rs = response_score(m.calls_total, m.calls_picked);
    if rs < 40.0 {
        reasons.push("low call pickup rate".to_string());
    }
    if reasons.is_empty() {
        reasons.push(format!("Scored {}/100: no overdue amounts.", score));
    }
    reasons
}

/// Public entrypoint: full ScoreResult for a customer.
pub fn score_customer(m: &CustomerMetrics) -> ScoreResult {
    let credit_risk    = calculate_customer_risk_score(m);
    let priority       = calculate_collection_priority_score(m);
    let promise_rel    = calculate_promise_reliability_score(m.broken_promises, m.broken_promises + m.kept_promises);
    let recovery_prob  = calculate_recovery_probability(credit_risk, promise_rel);
    let risk_level     = RiskLevel::from_score(credit_risk);
    let reasons        = build_reasons(m, credit_risk);
    let score_reason   = if reasons.len() == 1 && reasons[0].starts_with("Scored") {
        reasons[0].clone()
    } else {
        format!("Scored {}/100: {}.", credit_risk, reasons.join(", "))
    };

    ScoreResult {
        success: true,
        credit_risk_score:    credit_risk,
        collection_priority:  priority,
        promise_reliability:  promise_rel,
        recovery_probability: recovery_prob,
        risk_level,
        reasons,
        score_reason,
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn metrics_zero() -> CustomerMetrics {
        CustomerMetrics {
            total_overdue: 0.0, max_delay_days: 0.0, avg_delay_days: 0.0,
            broken_promises: 0, kept_promises: 5,
            calls_total: 10, calls_picked: 10,
        }
    }

    #[test]
    fn test_zero_risk_customer() {
        let m = metrics_zero();
        let s = calculate_customer_risk_score(&m);
        assert_eq!(s, 0, "zero-risk customer should score 0");
    }

    #[test]
    fn test_high_overdue_drives_score() {
        let mut m = metrics_zero();
        m.total_overdue   = 80_000.0; // → 40 pts (capped)
        m.max_delay_days  = 20.0;     // → 20 pts
        m.broken_promises = 2;        // → 14 pts
        // calls fine → 0 pts from response
        let s = calculate_customer_risk_score(&m);
        assert_eq!(s, 74);
    }

    #[test]
    fn test_spec_example_simulate_scenario() {
        // Mirrors the spec example: current_outstanding=72000, broken_promises=3
        let m = CustomerMetrics {
            total_overdue:   40_000.0,
            max_delay_days:  18.0,
            avg_delay_days:  18.0,
            broken_promises: 3,
            kept_promises:   0,
            calls_total:     0,
            calls_picked:    0,
        };
        let s = calculate_customer_risk_score(&m);
        // expected: min(40,20)+min(18,20)+min(21,20)+10 = 20+18+20+10 = 68
        // (response neutral at 50 → 20 - 50*0.2 = 10 pts)
        assert_eq!(s, 68, "spec example should score 68");
        assert!(s >= 61, "should be high risk");
    }

    #[test]
    fn test_promise_reliability_no_promises() {
        assert_eq!(calculate_promise_reliability_score(0, 0), 100);
    }

    #[test]
    fn test_promise_reliability_all_broken() {
        assert_eq!(calculate_promise_reliability_score(5, 5), 0);
    }

    #[test]
    fn test_promise_reliability_half() {
        assert_eq!(calculate_promise_reliability_score(2, 4), 50);
    }

    #[test]
    fn test_recovery_probability_inverse() {
        // High risk → low recovery
        let r = calculate_recovery_probability(90, 0);
        assert!(r < 30, "recovery should be low for high-risk customers");
        // Low risk → high recovery
        let r2 = calculate_recovery_probability(10, 100);
        assert!(r2 > 70, "recovery should be high for low-risk customers");
    }

    #[test]
    fn test_collection_priority_matches_risk_v1() {
        let m = metrics_zero();
        assert_eq!(
            calculate_customer_risk_score(&m),
            calculate_collection_priority_score(&m),
            "V1: collection priority == credit risk"
        );
    }
}
