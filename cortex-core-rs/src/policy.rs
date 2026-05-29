// FILE: cortex-core-rs/src/policy.rs
// Pure policy guard — no DB, no I/O. Mirrors policyGuard.service.js pure checks:
//   - blocked phrases in recommended_message
//   - forbidden action types
//   - requires_approval determination
//   - high-amount threshold
//
// DB-dependent checks (tenant isolation, invoice amount vs DB) stay in Node.

use crate::types::{PolicyDecision, PolicyInput};

/// Phrases that must never appear in an outgoing message draft (case-insensitive).
/// Mirrors policyGuard.service.js BLOCKED_PHRASES.
const BLOCKED_PHRASES: &[&str] = &[
    "legal action",
    "file case",
    "police",
    "fir",
    "court",
    "arrest",
    "lawyer",
    "criminal",
    "fraud",
    "cheater",
    "threaten",
    "warning letter",
];

/// Action types that are completely forbidden for AI/rule suggestions.
const FORBIDDEN_TYPES: &[&str] = &[
    "MARK_PAID",
    "CHANGE_AMOUNT",
    "OFFER_DISCOUNT",
    "DELETE_INVOICE",
];

/// Action types that always require owner approval.
/// Mirrors policyGuard.service.js ALWAYS_REQUIRES_APPROVAL.
const ALWAYS_REQUIRES_APPROVAL: &[&str] = &[
    "SEND_FIRM_REMINDER",
    "CALL_CUSTOMER",
    "ESCALATE_TO_OWNER",
    "STOP_CREDIT_WARNING",
    "CASHFLOW_RISK",
    "CREDIT_HOLD_SUGGESTED",
    "ASK_PARTIAL_PAYMENT",
];

const HIGH_AMOUNT_THRESHOLD: f64 = 50_000.0;

/// Evaluate a policy action — pure, deterministic, no DB.
pub fn evaluate_action_policy(input: &PolicyInput) -> PolicyDecision {
    let mut reasons: Vec<String> = Vec::new();

    // 1. Forbidden action type
    if FORBIDDEN_TYPES.contains(&input.action_type.as_str()) {
        reasons.push(format!(
            "Action type {} is forbidden for AI/rule suggestions",
            input.action_type
        ));
    }

    // 2. Blocked phrases in message
    if let Some(msg) = &input.recommended_message {
        let lower = msg.to_lowercase();
        for phrase in BLOCKED_PHRASES {
            if lower.contains(phrase) {
                reasons.push(format!("Message contains blocked phrase: \"{}\"", phrase));
                break; // report first hit only (mirrors JS)
            }
        }
    }

    // 3. If blocked — return immediately
    if !reasons.is_empty() {
        return PolicyDecision {
            success: true,
            allowed: false,
            blocked: true,
            requires_approval: false,
            block_reason: Some(reasons.join("; ")),
            reasons,
        };
    }

    // 4. Requires-approval determination
    let amount_over_threshold = input.amount.map_or(false, |a| a > HIGH_AMOUNT_THRESHOLD);
    let high_risk = input.risk_level.as_deref() == Some("high")
        || input.risk_level.as_deref() == Some("critical");
    let always_needs = ALWAYS_REQUIRES_APPROVAL.contains(&input.action_type.as_str());
    let caller_requires = input.requires_approval.unwrap_or(false);

    let requires_approval = always_needs || amount_over_threshold || high_risk || caller_requires;

    PolicyDecision {
        success: true,
        allowed: true,
        blocked: false,
        requires_approval,
        block_reason: None,
        reasons,
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn safe_input(action_type: &str) -> PolicyInput {
        PolicyInput {
            action_type: action_type.to_string(),
            amount: Some(1_000.0),
            risk_level: Some("low".to_string()),
            recommended_message: Some("Kindly clear the payment this week.".to_string()),
            requires_approval: None,
        }
    }

    #[test]
    fn test_forbidden_mark_paid() {
        let i = safe_input("MARK_PAID");
        let d = evaluate_action_policy(&i);
        assert!(d.blocked, "MARK_PAID must be blocked");
        assert!(!d.allowed);
    }

    #[test]
    fn test_forbidden_delete_invoice() {
        let i = safe_input("DELETE_INVOICE");
        let d = evaluate_action_policy(&i);
        assert!(d.blocked);
    }

    #[test]
    fn test_forbidden_offer_discount() {
        let i = safe_input("OFFER_DISCOUNT");
        let d = evaluate_action_policy(&i);
        assert!(d.blocked);
    }

    #[test]
    fn test_legal_threat_blocked() {
        let i = PolicyInput {
            action_type: "SEND_FIRM_REMINDER".to_string(),
            amount: Some(5_000.0),
            risk_level: None,
            recommended_message: Some("We will file a FIR if you don't pay.".to_string()),
            requires_approval: None,
        };
        let d = evaluate_action_policy(&i);
        assert!(d.blocked, "FIR threat must be blocked");
    }

    #[test]
    fn test_court_phrase_blocked() {
        let i = PolicyInput {
            action_type: "SEND_FIRM_REMINDER".to_string(),
            amount: Some(5_000.0),
            risk_level: None,
            recommended_message: Some("We will take you to court.".to_string()),
            requires_approval: None,
        };
        let d = evaluate_action_policy(&i);
        assert!(d.blocked);
    }

    #[test]
    fn test_firm_reminder_always_requires_approval() {
        let i = PolicyInput {
            action_type: "SEND_FIRM_REMINDER".to_string(),
            amount: Some(1_000.0),
            risk_level: Some("low".to_string()),
            recommended_message: Some("Kindly clear the amount.".to_string()),
            requires_approval: None,
        };
        let d = evaluate_action_policy(&i);
        assert!(!d.blocked);
        assert!(
            d.requires_approval,
            "SEND_FIRM_REMINDER must always require approval"
        );
    }

    #[test]
    fn test_high_amount_requires_approval() {
        let i = PolicyInput {
            action_type: "SEND_POLITE_REMINDER".to_string(),
            amount: Some(75_000.0),
            risk_level: Some("low".to_string()),
            recommended_message: Some("Please pay.".to_string()),
            requires_approval: None,
        };
        let d = evaluate_action_policy(&i);
        assert!(!d.blocked);
        assert!(d.requires_approval, "amount > 50k must require approval");
    }

    #[test]
    fn test_low_risk_polite_reminder_auto_safe() {
        let i = PolicyInput {
            action_type: "SEND_POLITE_REMINDER".to_string(),
            amount: Some(1_000.0),
            risk_level: Some("low".to_string()),
            recommended_message: Some("Please pay when convenient.".to_string()),
            requires_approval: None,
        };
        let d = evaluate_action_policy(&i);
        assert!(!d.blocked);
        assert!(!d.requires_approval);
    }

    #[test]
    fn test_fraud_phrase_blocked() {
        let i = PolicyInput {
            action_type: "SEND_FIRM_REMINDER".to_string(),
            amount: None,
            risk_level: None,
            recommended_message: Some("You are a fraud cheater.".to_string()),
            requires_approval: None,
        };
        let d = evaluate_action_policy(&i);
        assert!(d.blocked);
    }
}
