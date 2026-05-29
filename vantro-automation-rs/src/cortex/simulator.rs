// FILE: vantro-automation-rs/src/cortex/simulator.rs
// Simulation engine for credit sale, cashflow, and collection actions.
// Pure math — caller pre-fetches DB inputs.

use crate::cortex::scoring::{credit_risk_score, CustomerMetrics};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Clone)]
pub struct CreditSaleInput {
    pub customer_id: String,
    pub new_sale_amount: f64,
    pub current_outstanding: f64,
    pub overdue_amount: f64,
    pub broken_promises: u32,
    pub average_delay_days: f64,
    pub credit_limit: f64,
}

#[derive(Debug, Serialize)]
pub struct SimulationResult {
    pub success: bool,
    pub risk_level: String,
    pub score: u8,
    pub recommendation: String,
    pub reasons: Vec<String>,
    pub approval_required: bool,
    pub projected_exposure: f64,
    pub limit_headroom: Option<f64>,
}

pub fn simulate_credit_sale(input: &CreditSaleInput) -> SimulationResult {
    let projected_exposure = input.current_outstanding + input.new_sale_amount;
    let limit_headroom = if input.credit_limit > 0.0 {
        Some(input.credit_limit - projected_exposure)
    } else {
        None
    };
    let limit_breached = limit_headroom.map_or(false, |h| h < 0.0);

    let pseudo = CustomerMetrics {
        total_overdue: input.overdue_amount,
        max_delay_days: input.average_delay_days,
        avg_delay_days: input.average_delay_days,
        broken_promises: input.broken_promises,
        kept_promises: 0,
        calls_total: 0,
        calls_picked: 0,
    };
    let mut score = credit_risk_score(&pseudo);
    if limit_breached {
        score = score.saturating_add(15).min(100);
    }
    if projected_exposure > 200_000.0 {
        score = score.saturating_add(10).min(100);
    }

    let risk_level = match score {
        0..=30 => "low",
        31..=60 => "medium",
        61..=80 => "high",
        _ => "critical",
    };

    let approval_required = matches!(risk_level, "high" | "critical")
        || limit_breached
        || input.broken_promises >= 2
        || input.new_sale_amount > 50_000.0;

    let mut reasons = Vec::new();
    if input.current_outstanding > 0.0 {
        reasons.push(format!(
            "Customer already has ₹{:.0} outstanding",
            input.current_outstanding
        ));
    }
    if input.overdue_amount > 0.0 {
        reasons.push(format!("₹{:.0} is overdue", input.overdue_amount));
    }
    if input.broken_promises > 0 {
        reasons.push(format!(
            "{} promise{} broken",
            input.broken_promises,
            if input.broken_promises > 1 {
                "s were"
            } else {
                " was"
            }
        ));
    }
    reasons.push(format!(
        "New exposure will become ₹{:.0}",
        projected_exposure
    ));
    if limit_breached {
        reasons.push(format!(
            "Exceeds credit limit of ₹{:.0} by ₹{:.0}",
            input.credit_limit,
            projected_exposure - input.credit_limit
        ));
    }

    let recommendation = match risk_level {
        "low" => "Safe to proceed with credit sale.",
        "medium" => "Proceed with caution; consider asking for advance payment.",
        "high" => "Require owner approval or take advance before new credit sale.",
        _ => "Do not extend credit — collect outstanding before new sale.",
    };

    SimulationResult {
        success: true,
        risk_level: risk_level.to_string(),
        score,
        recommendation: recommendation.to_string(),
        reasons,
        approval_required,
        projected_exposure,
        limit_headroom,
    }
}
