// FILE: vantro-automation-rs/src/cashops/payment_behavior.rs
// Vantro Payment Behavior Engine — proprietary behavioral analysis.
// Pure deterministic function: inputs are pre-fetched from DB by the caller.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Clone)]
pub struct PaymentBehaviorInput {
    // Delay signals
    pub average_delay_days: f64,
    pub max_delay_days: f64,
    pub payment_consistency: f64, // 0-1: stddev of payment timing (low = consistent)

    // Promise signals
    pub broken_promise_count: u32,
    pub kept_promise_count: u32,
    pub broken_promise_velocity: f64, // broken promises per 30-day window

    // Payment pattern signals
    pub partial_payment_ratio: f64, // 0-1: % payments that were partial
    pub silence_days: u32,          // days since last response/payment

    // Response signals
    pub response_speed_hours: f64, // average hours to respond to followup
    pub dispute_frequency: u32,    // number of disputes raised
    pub owner_call_dependency: f64, // 0-1: % payments that came after owner call
    pub pressure_sensitivity: f64, // 0-1: % payments that came after firm message

    // Sensitivity signals
    pub polite_reminder_sensitivity: f64, // 0-1: % paid after polite reminder
    pub month_end_excuse_pattern: bool,   // always pays at month end / has repeated excuses

    // Risk signals
    pub credit_abuse_risk: f64,  // 0-1: score of misuse pattern
    pub customer_value_inr: f64, // lifetime customer value

    // Relationship
    pub relationship_years: f64,      // years as customer
    pub dispute_resolution_time: f64, // avg days to resolve disputes
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BehaviorProfile {
    Reliable,
    SlowPayer,
    NegotiatorType,
    PromiseBreaker,
    SilentDefaulter,
    OwnerCallDependent,
    MonthEndPayer,
    PressureSensitive,
    DisputeFirstPayer,
    CreditAbuser,
    HighValueAtRisk,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Serialize)]
pub struct PaymentBehaviorResult {
    pub behavior_profile: BehaviorProfile,
    pub secondary_traits: Vec<String>,
    pub risk_level: RiskLevel,
    pub risk_score: u8,
    pub reasons: Vec<String>,
    pub recommended_collection_strategy: CollectionStrategy,
    pub owner_attention_required: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub enum CollectionStrategy {
    PoliteReminder,
    FirmReminder,
    OwnerCall,
    PartialPaymentRequest,
    DisputeResolutionFirst,
    CreditHold,
    EscalateToOwner,
    WriteOff,
}

pub fn analyze(input: &PaymentBehaviorInput) -> PaymentBehaviorResult {
    let total_promises = input.broken_promise_count + input.kept_promise_count;
    let promise_reliability = if total_promises > 0 {
        input.kept_promise_count as f64 / total_promises as f64
    } else {
        1.0
    };

    // ─── Weighted risk score (0–100) ───────────────────────────
    let mut score: f64 = 0.0;
    score += (input.average_delay_days / 30.0 * 20.0).min(20.0);
    score += ((1.0 - promise_reliability) * 25.0).min(25.0);
    score += (input.broken_promise_velocity * 10.0).min(10.0);
    score += ((input.silence_days as f64 / 30.0) * 10.0).min(10.0);
    score += (input.credit_abuse_risk * 15.0).min(15.0);
    score += (input.dispute_frequency as f64 * 2.0).min(10.0);
    score += ((1.0 - input.polite_reminder_sensitivity) * 10.0).min(10.0);
    let score = score.round().clamp(0.0, 100.0) as u8;

    let risk_level = match score {
        0..=25 => RiskLevel::Low,
        26..=50 => RiskLevel::Medium,
        51..=75 => RiskLevel::High,
        _ => RiskLevel::Critical,
    };

    // ─── Primary behavior profile ─────────────────────────────
    let profile = if input.dispute_frequency >= 2 && input.dispute_resolution_time > 14.0 {
        BehaviorProfile::DisputeFirstPayer
    } else if input.credit_abuse_risk > 0.7 {
        BehaviorProfile::CreditAbuser
    } else if promise_reliability < 0.4 && input.broken_promise_count >= 2 {
        BehaviorProfile::PromiseBreaker
    } else if input.silence_days > 30 && score > 60 {
        BehaviorProfile::SilentDefaulter
    } else if input.owner_call_dependency > 0.6 {
        BehaviorProfile::OwnerCallDependent
    } else if input.month_end_excuse_pattern {
        BehaviorProfile::MonthEndPayer
    } else if input.pressure_sensitivity > 0.7 {
        BehaviorProfile::PressureSensitive
    } else if input.average_delay_days > 15.0 && promise_reliability > 0.7 {
        BehaviorProfile::SlowPayer
    } else if input.customer_value_inr > 200_000.0 && score > 50 {
        BehaviorProfile::HighValueAtRisk
    } else if score < 25 {
        BehaviorProfile::Reliable
    } else {
        BehaviorProfile::NegotiatorType
    };

    // ─── Secondary traits ─────────────────────────────────────
    let mut traits = Vec::new();
    if input.partial_payment_ratio > 0.5 {
        traits.push("prefers_partial_payments".to_string());
    }
    if input.polite_reminder_sensitivity > 0.7 {
        traits.push("responds_to_polite_tone".to_string());
    }
    if input.response_speed_hours < 4.0 {
        traits.push("fast_responder".to_string());
    }
    if input.relationship_years > 2.0 {
        traits.push("long_term_customer".to_string());
    }

    // ─── Reasons ─────────────────────────────────────────────
    let mut reasons = Vec::new();
    if input.average_delay_days > 10.0 {
        reasons.push(format!(
            "Average payment delay: {:.0} days",
            input.average_delay_days
        ));
    }
    if input.broken_promise_count > 0 {
        reasons.push(format!(
            "{} broken promise{}",
            input.broken_promise_count,
            if input.broken_promise_count > 1 {
                "s"
            } else {
                ""
            }
        ));
    }
    if input.silence_days > 14 {
        reasons.push(format!("No response for {} days", input.silence_days));
    }
    if input.credit_abuse_risk > 0.5 {
        reasons.push(format!(
            "Credit abuse risk score: {:.0}%",
            input.credit_abuse_risk * 100.0
        ));
    }

    // ─── Strategy ────────────────────────────────────────────
    let strategy = match &profile {
        BehaviorProfile::Reliable => CollectionStrategy::PoliteReminder,
        BehaviorProfile::SlowPayer => CollectionStrategy::PoliteReminder,
        BehaviorProfile::NegotiatorType => CollectionStrategy::PartialPaymentRequest,
        BehaviorProfile::PromiseBreaker => CollectionStrategy::FirmReminder,
        BehaviorProfile::SilentDefaulter => CollectionStrategy::EscalateToOwner,
        BehaviorProfile::OwnerCallDependent => CollectionStrategy::OwnerCall,
        BehaviorProfile::MonthEndPayer => CollectionStrategy::FirmReminder,
        BehaviorProfile::PressureSensitive => CollectionStrategy::FirmReminder,
        BehaviorProfile::DisputeFirstPayer => CollectionStrategy::DisputeResolutionFirst,
        BehaviorProfile::CreditAbuser => CollectionStrategy::CreditHold,
        BehaviorProfile::HighValueAtRisk => CollectionStrategy::OwnerCall,
    };

    let owner_attention = matches!(risk_level, RiskLevel::High | RiskLevel::Critical)
        || matches!(
            profile,
            BehaviorProfile::CreditAbuser
                | BehaviorProfile::SilentDefaulter
                | BehaviorProfile::HighValueAtRisk
        );

    PaymentBehaviorResult {
        behavior_profile: profile,
        secondary_traits: traits,
        risk_level,
        risk_score: score,
        reasons,
        recommended_collection_strategy: strategy,
        owner_attention_required: owner_attention,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_input() -> PaymentBehaviorInput {
        PaymentBehaviorInput {
            average_delay_days: 5.0,
            max_delay_days: 10.0,
            payment_consistency: 0.8,
            broken_promise_count: 0,
            kept_promise_count: 3,
            broken_promise_velocity: 0.0,
            partial_payment_ratio: 0.1,
            silence_days: 2,
            response_speed_hours: 3.0,
            dispute_frequency: 0,
            owner_call_dependency: 0.1,
            pressure_sensitivity: 0.2,
            polite_reminder_sensitivity: 0.8,
            month_end_excuse_pattern: false,
            credit_abuse_risk: 0.0,
            customer_value_inr: 50_000.0,
            relationship_years: 1.5,
            dispute_resolution_time: 0.0,
        }
    }

    #[test]
    fn reliable_customer_low_risk() {
        let r = analyze(&base_input());
        assert_eq!(r.behavior_profile, BehaviorProfile::Reliable);
        assert_eq!(r.risk_level, RiskLevel::Low);
    }

    #[test]
    fn promise_breaker_detected() {
        let mut input = base_input();
        input.broken_promise_count = 3;
        input.kept_promise_count = 1;
        input.broken_promise_velocity = 1.5;
        let r = analyze(&input);
        assert_eq!(r.behavior_profile, BehaviorProfile::PromiseBreaker);
        assert!(matches!(
            r.risk_level,
            RiskLevel::High | RiskLevel::Critical
        ));
    }

    #[test]
    fn credit_abuser_gets_hold_strategy() {
        let mut input = base_input();
        input.credit_abuse_risk = 0.9;
        let r = analyze(&input);
        assert_eq!(r.behavior_profile, BehaviorProfile::CreditAbuser);
        assert_eq!(
            r.recommended_collection_strategy,
            CollectionStrategy::CreditHold
        );
    }

    #[test]
    fn silent_defaulter_escalates() {
        let mut input = base_input();
        input.silence_days = 45;
        input.broken_promise_count = 2;
        input.kept_promise_count = 0;
        input.average_delay_days = 25.0;
        let r = analyze(&input);
        assert_eq!(
            r.recommended_collection_strategy,
            CollectionStrategy::EscalateToOwner
        );
    }
}
