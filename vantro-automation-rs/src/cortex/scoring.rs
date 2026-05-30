// FILE: vantro-automation-rs/src/cortex/scoring.rs
// Customer risk scoring — upgraded inline version of cortex-core-rs/scoring.rs.
// Formulas are identical so JS / CLI / HTTP paths produce the same numbers.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Clone)]
pub struct CustomerMetrics {
    pub total_overdue: f64,
    pub max_delay_days: f64,
    pub avg_delay_days: f64,
    pub broken_promises: u32,
    pub kept_promises: u32,
    pub calls_total: u32,
    pub calls_picked: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScoreResult {
    pub success: bool,
    pub credit_risk_score: u8,
    pub collection_priority: u8,
    pub promise_reliability: u8,
    pub recovery_probability: u8,
    pub risk_level: String,
    pub reasons: Vec<String>,
    pub score_reason: String,
}

fn response_score(calls_total: u32, calls_picked: u32) -> f64 {
    if calls_total == 0 {
        50.0
    } else {
        calls_picked as f64 / calls_total as f64 * 100.0
    }
}

pub fn promise_reliability(broken: u32, total: u32) -> u8 {
    if total == 0 {
        return 100;
    }
    ((total - broken.min(total)) as f64 / total as f64 * 100.0)
        .round()
        .clamp(0.0, 100.0) as u8
}

pub fn recovery_probability(credit_risk: u8, promise_rel: u8) -> u8 {
    let p = (100u8.saturating_sub(credit_risk)) as f64 * 0.70 + promise_rel as f64 * 0.30;
    p.round().clamp(0.0, 100.0) as u8
}

pub fn credit_risk_score(m: &CustomerMetrics) -> u8 {
    let rs = response_score(m.calls_total, m.calls_picked);
    let mut score: f64 = 0.0;
    score += (m.total_overdue / 10_000.0 * 5.0).min(40.0);
    score += m.max_delay_days.min(20.0);
    score += (m.broken_promises as f64 * 7.0).min(20.0);
    score += (20.0_f64 - rs * 0.2).max(0.0);
    score.round().clamp(0.0, 100.0) as u8
}

pub fn score_customer(m: &CustomerMetrics) -> ScoreResult {
    let credit_risk = credit_risk_score(m);
    let priority = credit_risk;
    let total_prom = m.broken_promises + m.kept_promises;
    let prom_rel = promise_reliability(m.broken_promises, total_prom);
    let recovery = recovery_probability(credit_risk, prom_rel);
    let risk_level = match credit_risk {
        0..=30 => "low",
        31..=60 => "medium",
        61..=80 => "high",
        _ => "critical",
    };

    let mut reasons = Vec::new();
    if m.total_overdue > 0.0 {
        reasons.push(format!("₹{:.0} overdue", m.total_overdue));
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

    let score_reason = if reasons.is_empty() {
        format!("Scored {}/100: no overdue amounts.", credit_risk)
    } else {
        format!("Scored {}/100: {}.", credit_risk, reasons.join(", "))
    };

    ScoreResult {
        success: true,
        credit_risk_score: credit_risk,
        collection_priority: priority,
        promise_reliability: prom_rel,
        recovery_probability: recovery,
        risk_level: risk_level.to_string(),
        reasons,
        score_reason,
    }
}
