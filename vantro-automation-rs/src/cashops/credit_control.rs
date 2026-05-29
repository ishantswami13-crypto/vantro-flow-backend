// FILE: vantro-automation-rs/src/cashops/credit_control.rs
// Credit Control Engine — evaluates risk before new credit sale.
// Does not hard-block the owner. Returns a recommendation with approval gate.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Clone)]
pub struct CreditControlInput {
    pub current_outstanding: f64,
    pub overdue_amount: f64,
    pub new_sale_amount: f64,
    pub credit_limit: f64, // 0 = no limit set
    pub broken_promises: u32,
    pub average_delay_days: f64,
    pub last_payment_days_ago: Option<u32>,
    pub customer_value_inr: f64,
    pub dispute_status: DisputeStatus,
    pub business_cash_pressure: f64, // 0-1
    pub advance_required: bool,      // Owner-set flag
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DisputeStatus {
    None,
    Minor,
    Major,
    Unresolved,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CreditDecision {
    Safe,
    CautionProceed,
    RequireOwnerApproval,
    TakeAdvanceFirst,
    BlockRecommendation,
}

#[derive(Debug, Serialize)]
pub struct CreditControlResult {
    pub decision: CreditDecision,
    pub new_exposure: f64,
    pub limit_headroom: Option<f64>,
    pub risk_score: u8,
    pub approval_required: bool,
    pub reasons: Vec<String>,
    pub recommended_terms: Vec<String>,
}

pub fn evaluate(input: &CreditControlInput) -> CreditControlResult {
    let new_exposure = input.current_outstanding + input.new_sale_amount;
    let limit_headroom = if input.credit_limit > 0.0 {
        Some(input.credit_limit - new_exposure)
    } else {
        None
    };
    let limit_breached = limit_headroom.map_or(false, |h| h < 0.0);

    let mut score: f64 = 0.0;
    let mut reasons: Vec<String> = Vec::new();
    let mut terms: Vec<String> = Vec::new();

    // Overdue as % of credit limit → score
    if input.credit_limit > 0.0 {
        score += (input.overdue_amount / input.credit_limit * 40.0).min(40.0);
    } else if input.overdue_amount > 0.0 {
        score += (input.overdue_amount / 50_000.0 * 30.0).min(30.0);
    }

    // Broken promise penalty
    score += (input.broken_promises as f64 * 8.0).min(20.0);

    // Delay penalty
    score += (input.average_delay_days / 30.0 * 15.0).min(15.0);

    // Limit breach bonus
    if limit_breached {
        score += 15.0;
    }

    // Cash pressure amplifier
    score += input.business_cash_pressure * 10.0;

    let risk_score = score.round().clamp(0.0, 100.0) as u8;

    // ─── Decision logic ─────────────────────────────────────
    let decision = if input.dispute_status == DisputeStatus::Unresolved {
        reasons.push("Unresolved dispute — do not extend credit until resolved".to_string());
        CreditDecision::BlockRecommendation
    } else if risk_score >= 80 || (limit_breached && input.broken_promises >= 2) {
        reasons.push(format!("Risk score {}/100 is critical", risk_score));
        if limit_breached {
            reasons.push(format!(
                "New exposure ₹{:.0} exceeds limit ₹{:.0}",
                new_exposure, input.credit_limit
            ));
        }
        CreditDecision::BlockRecommendation
    } else if input.advance_required {
        reasons.push("Owner has set advance_required for this customer".to_string());
        terms.push("Collect advance payment before proceeding".to_string());
        CreditDecision::TakeAdvanceFirst
    } else if risk_score >= 55 || limit_breached {
        if limit_breached {
            reasons.push(format!(
                "New exposure ₹{:.0} exceeds credit limit of ₹{:.0}",
                new_exposure, input.credit_limit
            ));
        }
        if input.broken_promises > 0 {
            reasons.push(format!("{} broken promises", input.broken_promises));
        }
        terms.push("Consider requesting partial advance".to_string());
        terms.push(format!(
            "Reduce credit limit to ₹{:.0}",
            input.current_outstanding + input.new_sale_amount * 0.5
        ));
        CreditDecision::RequireOwnerApproval
    } else if risk_score >= 35 {
        reasons.push(format!(
            "Moderate risk — proceed with caution (score {}/100)",
            risk_score
        ));
        terms.push("Consider shorter payment terms".to_string());
        CreditDecision::CautionProceed
    } else {
        CreditDecision::Safe
    };

    // Additional reasons
    if input.overdue_amount > 0.0 {
        reasons.push(format!("₹{:.0} currently overdue", input.overdue_amount));
    }
    if new_exposure > 0.0 {
        reasons.push(format!("New total exposure will be ₹{:.0}", new_exposure));
    }
    if let Some(days) = input.last_payment_days_ago {
        if days > 30 {
            reasons.push(format!("Last payment was {} days ago", days));
        }
    }

    let approval_required = matches!(
        decision,
        CreditDecision::RequireOwnerApproval
            | CreditDecision::TakeAdvanceFirst
            | CreditDecision::BlockRecommendation
    );

    CreditControlResult {
        decision,
        new_exposure,
        limit_headroom,
        risk_score,
        approval_required,
        reasons,
        recommended_terms: terms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_new_customer() {
        let input = CreditControlInput {
            current_outstanding: 0.0,
            overdue_amount: 0.0,
            new_sale_amount: 5000.0,
            credit_limit: 50_000.0,
            broken_promises: 0,
            average_delay_days: 0.0,
            last_payment_days_ago: None,
            customer_value_inr: 20_000.0,
            dispute_status: DisputeStatus::None,
            business_cash_pressure: 0.2,
            advance_required: false,
        };
        let r = evaluate(&input);
        assert_eq!(r.decision, CreditDecision::Safe);
        assert!(!r.approval_required);
    }

    #[test]
    fn spec_example_requires_approval() {
        let input = CreditControlInput {
            current_outstanding: 72_000.0,
            overdue_amount: 40_000.0,
            new_sale_amount: 50_000.0,
            credit_limit: 100_000.0,
            broken_promises: 3,
            average_delay_days: 18.0,
            last_payment_days_ago: Some(35),
            customer_value_inr: 300_000.0,
            dispute_status: DisputeStatus::None,
            business_cash_pressure: 0.5,
            advance_required: false,
        };
        let r = evaluate(&input);
        assert!(r.approval_required, "spec example must require approval");
        assert_eq!(r.new_exposure, 122_000.0);
    }

    #[test]
    fn unresolved_dispute_blocks() {
        let input = CreditControlInput {
            current_outstanding: 10_000.0,
            overdue_amount: 5_000.0,
            new_sale_amount: 2_000.0,
            credit_limit: 50_000.0,
            broken_promises: 0,
            average_delay_days: 5.0,
            last_payment_days_ago: Some(10),
            customer_value_inr: 50_000.0,
            dispute_status: DisputeStatus::Unresolved,
            business_cash_pressure: 0.1,
            advance_required: false,
        };
        let r = evaluate(&input);
        assert_eq!(r.decision, CreditDecision::BlockRecommendation);
    }
}
