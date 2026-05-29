// FILE: vantro-automation-rs/tests/policy_guard_fir_regression.rs
//
// Regression test for the pre-existing policy_guard substring bug:
//   BLOCKED_PHRASES included the literal "fir" and was matched with
//   `lower.contains(phrase)`, which wrongly blocked benign messages like
//   "send firm reminder" or "please confirm".
//
// This integration test guards the contract from outside the crate: if a
// future change drops back to substring matching, these cases will fail loud.

use vantro_automation_lib::cortex::policy_guard::{evaluate, PolicyInput};

fn input(msg: &str) -> PolicyInput {
    PolicyInput {
        action_type: "SEND_FIRM_REMINDER".to_string(),
        amount: None,
        risk_level: None,
        recommended_message: Some(msg.to_string()),
        requires_approval: None,
        known_customer_ids: None,
        customer_id: None,
    }
}

#[test]
fn firm_reminder_is_allowed() {
    let d = evaluate(&input(
        "Hi Raj, please send firm reminder for invoice #1042.",
    ));
    assert!(
        !d.blocked,
        "expected allowed but got blocked: {:?}",
        d.block_reason
    );
    assert!(d.allowed);
}

#[test]
fn confirm_is_allowed() {
    let d = evaluate(&input("Kindly confirm if the payment has been initiated."));
    assert!(!d.blocked);
}

#[test]
fn first_is_allowed() {
    let d = evaluate(&input(
        "This is the first follow-up on the overdue invoice.",
    ));
    assert!(!d.blocked);
}

#[test]
fn firmware_is_allowed() {
    let d = evaluate(&input(
        "Reminder: firmware update is unrelated to this invoice.",
    ));
    assert!(!d.blocked);
}

#[test]
fn policy_is_allowed_even_though_substring_of_police() {
    let d = evaluate(&input(
        "As per our company policy, payment is due in 7 days.",
    ));
    assert!(!d.blocked);
}

#[test]
fn standalone_fir_is_blocked() {
    let d = evaluate(&input("If you do not pay, we will file FIR against you."));
    assert!(
        d.blocked,
        "standalone token ‘FIR’ must trigger the policy guard"
    );
}

#[test]
fn legal_action_is_blocked() {
    let d = evaluate(&input("We will take legal action if dues are not cleared."));
    assert!(d.blocked);
}

#[test]
fn police_threat_is_blocked() {
    let d = evaluate(&input(
        "I will call the police on you if payment is not made.",
    ));
    assert!(d.blocked);
}
