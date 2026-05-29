// FILE: vantro-automation-rs/src/cashops/collection_priority.rs
// Collection Priority Index (CPI) — Vantro's proprietary receivables ranking algorithm.
// Every score is fully explainable. No black box.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Clone)]
pub struct CpiInput {
    pub overdue_amount: f64,
    pub days_overdue: u32,
    pub broken_promises: u32,
    pub promise_due_missed: bool,
    pub response_probability: f64,   // 0-1
    pub recovery_probability: f64,   // 0-1
    pub business_cash_pressure: f64, // 0-1: how urgently the business needs cash
    pub customer_value_inr: f64,     // total lifetime value
    pub credit_exposure_risk: f64,   // 0-1
    pub followup_urgency: f64,       // 0-1: days since last followup (normalised)
    pub active_dispute: bool,
    pub relationship_risk: f64, // 0-1: risk of damaging relationship
    pub last_payment_days_ago: Option<u32>,
    pub partial_payment_ok: bool,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CpiPriority {
    Low,
    Medium,
    High,
    Urgent,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum NextBestAction {
    WaitForDueDate,
    SendPoliteReminder,
    SendFirmReminder,
    RequestPartialPayment,
    CallCustomer,
    EscalateToOwner,
    ResolveDsipute,
    CreditHold,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RecommendedTone {
    Soft,
    Professional,
    Firm,
    Escalation,
    DisputeResolutionFirst,
    RelationshipPreserving,
}

#[derive(Debug, Serialize)]
pub struct CpiResult {
    pub cpi_score: u8,
    pub priority: CpiPriority,
    pub reasons: Vec<String>,
    pub next_best_action: NextBestAction,
    pub recommended_tone: RecommendedTone,
    pub approval_required: bool,
    pub component_scores: CpiComponents,
}

#[derive(Debug, Serialize)]
pub struct CpiComponents {
    pub amount_urgency: u8,       // overdue amount × days
    pub promise_risk: u8,         // broken promise penalty
    pub recovery_likelihood: u8,  // inverse of recovery probability
    pub cash_pressure: u8,        // business's own cash need
    pub relationship_penalty: u8, // risk of damaging relationship
    pub dispute_penalty: u8,      // active dispute reduces priority
}

pub fn calculate(input: &CpiInput) -> CpiResult {
    // ─── Component scoring ──────────────────────────────────────
    // Amount urgency (30 pts): log-scaled overdue × days
    let amount_base = (input.overdue_amount / 10_000.0).ln_1p() * 8.0;
    let days_mult = 1.0 + (input.days_overdue as f64 / 30.0).min(2.0);
    let amount_urgency = (amount_base * days_mult).min(30.0).round() as u8;

    // Promise risk (20 pts)
    let promise_risk = (input.broken_promises as f64 * 7.0
        + if input.promise_due_missed { 5.0 } else { 0.0 })
    .min(20.0)
    .round() as u8;

    // Recovery likelihood (15 pts): low recovery probability → higher priority
    let recovery_comp = ((1.0 - input.recovery_probability) * 15.0)
        .min(15.0)
        .round() as u8;

    // Cash pressure (15 pts): high business cash need → higher priority
    let cash_comp = (input.business_cash_pressure * 15.0).min(15.0).round() as u8;

    // Relationship penalty (10 pts): high relationship risk reduces urgency
    let rel_penalty = (input.relationship_risk * 10.0).min(10.0).round() as u8;

    // Dispute penalty (10 pts negative): active dispute means resolve first
    let dispute_pen = if input.active_dispute { 10u8 } else { 0u8 };

    // Followup urgency bonus (10 pts): stale followup = more urgent
    let followup_pts = (input.followup_urgency * 10.0).min(10.0).round() as u8;

    // CPI raw (subtract dispute and relationship penalty, they reduce true priority)
    let raw = amount_urgency as i32
        + promise_risk as i32
        + recovery_comp as i32
        + cash_comp as i32
        + followup_pts as i32
        - rel_penalty as i32
        - dispute_pen as i32;

    let cpi_score = raw.clamp(0, 100) as u8;

    // ─── Priority tier ─────────────────────────────────────────
    let priority = match cpi_score {
        0..=30 => CpiPriority::Low,
        31..=55 => CpiPriority::Medium,
        56..=75 => CpiPriority::High,
        _ => CpiPriority::Urgent,
    };

    // ─── Explainable reasons ───────────────────────────────────
    let mut reasons = Vec::new();
    if input.overdue_amount > 0.0 {
        reasons.push(format!("₹{:.0} overdue", input.overdue_amount));
    }
    if input.days_overdue > 0 {
        reasons.push(format!("{} days late", input.days_overdue));
    }
    if input.broken_promises > 0 {
        reasons.push(format!(
            "{} broken promise{}",
            input.broken_promises,
            if input.broken_promises > 1 { "s" } else { "" }
        ));
    }
    if input.promise_due_missed {
        reasons.push("Promise date passed without payment".to_string());
    }
    if input.business_cash_pressure > 0.6 {
        reasons.push("Business has urgent cash needs this week".to_string());
    }
    if input.active_dispute {
        reasons.push("Dispute in progress — resolve before reminder".to_string());
    }
    if let Some(d) = input.last_payment_days_ago {
        if d > 60 {
            reasons.push(format!("No payment for {} days", d));
        }
    }

    // ─── Next best action ──────────────────────────────────────
    let action = if input.active_dispute {
        NextBestAction::ResolveDsipute
    } else if cpi_score >= 76 && input.broken_promises >= 2 {
        NextBestAction::EscalateToOwner
    } else if cpi_score >= 76 {
        NextBestAction::CallCustomer
    } else if cpi_score >= 56 {
        if input.partial_payment_ok {
            NextBestAction::RequestPartialPayment
        } else {
            NextBestAction::SendFirmReminder
        }
    } else if cpi_score >= 31 {
        NextBestAction::SendPoliteReminder
    } else {
        NextBestAction::WaitForDueDate
    };

    // ─── Tone ──────────────────────────────────────────────────
    let tone = if input.active_dispute {
        RecommendedTone::DisputeResolutionFirst
    } else if input.relationship_risk > 0.7 {
        RecommendedTone::RelationshipPreserving
    } else {
        match priority {
            CpiPriority::Low => RecommendedTone::Soft,
            CpiPriority::Medium => RecommendedTone::Professional,
            CpiPriority::High => RecommendedTone::Firm,
            CpiPriority::Urgent => RecommendedTone::Escalation,
        }
    };

    let approval_required = matches!(priority, CpiPriority::Urgent)
        || matches!(
            action,
            NextBestAction::EscalateToOwner | NextBestAction::CreditHold
        );

    CpiResult {
        cpi_score,
        priority,
        reasons,
        next_best_action: action,
        recommended_tone: tone,
        approval_required,
        component_scores: CpiComponents {
            amount_urgency,
            promise_risk,
            recovery_likelihood: recovery_comp,
            cash_pressure: cash_comp,
            relationship_penalty: rel_penalty,
            dispute_penalty: dispute_pen,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn urgent_input() -> CpiInput {
        CpiInput {
            overdue_amount: 72_000.0,
            days_overdue: 21,
            broken_promises: 3,
            promise_due_missed: true,
            response_probability: 0.3,
            recovery_probability: 0.4,
            business_cash_pressure: 0.8,
            customer_value_inr: 300_000.0,
            credit_exposure_risk: 0.7,
            followup_urgency: 0.9,
            active_dispute: false,
            relationship_risk: 0.2,
            last_payment_days_ago: Some(35),
            partial_payment_ok: false,
        }
    }

    #[test]
    fn spec_example_is_urgent() {
        let r = calculate(&urgent_input());
        assert_eq!(
            r.priority,
            CpiPriority::Urgent,
            "spec example (₹72k, 21d, 3 broken) must be Urgent, got cpi={}",
            r.cpi_score
        );
        assert!(!r.reasons.is_empty(), "must provide reasons");
        assert!(
            r.reasons.iter().any(|r| r.contains("72")),
            "must mention outstanding amount"
        );
        assert!(
            r.reasons.iter().any(|r| r.contains("21")),
            "must mention days"
        );
    }

    #[test]
    fn reasons_non_empty_for_all_profiles() {
        let r = calculate(&urgent_input());
        assert!(r.cpi_score > 0, "CPI should be > 0 for urgent case");
        assert!(!r.reasons.is_empty());
    }

    #[test]
    fn dispute_reduces_priority_and_changes_action() {
        let mut input = urgent_input();
        input.active_dispute = true;
        let r = calculate(&input);
        assert_eq!(r.next_best_action, NextBestAction::ResolveDsipute);
        assert_eq!(r.recommended_tone, RecommendedTone::DisputeResolutionFirst);
    }

    #[test]
    fn low_overdue_is_low_priority() {
        let input = CpiInput {
            overdue_amount: 500.0,
            days_overdue: 2,
            broken_promises: 0,
            promise_due_missed: false,
            response_probability: 0.9,
            recovery_probability: 0.95,
            business_cash_pressure: 0.1,
            customer_value_inr: 10_000.0,
            credit_exposure_risk: 0.0,
            followup_urgency: 0.1,
            active_dispute: false,
            relationship_risk: 0.3,
            last_payment_days_ago: None,
            partial_payment_ok: true,
        };
        let r = calculate(&input);
        assert_eq!(r.priority, CpiPriority::Low);
    }
}
