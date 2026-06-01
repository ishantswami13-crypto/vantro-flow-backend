// FILE: vantro-automation-rs/src/agents/policy_guard/mod.rs
// Agent-layer wrapper for the core.policy_guard agent.
//
// Delegates evaluation to the pure cortex::policy_guard engine —
// no duplication of phrase lists, forbidden types, or approval logic.
//
// Phase 2B invariants (tested):
//   - safe_to_auto_execute = false for every response
//   - approval_required    = true  for every response
//
// Extra agent-layer checks beyond cortex::policy_guard:
//   - Channel gate: "whatsapp" / "external" channels → force requires_approval
//   - External message gate: requires_external_message=true → force requires_approval

use crate::cortex::policy_guard::{evaluate as cortex_evaluate, PolicyInput};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Clone)]
pub struct PolicyGuardInput {
    pub proposed_action_type: String,
    /// Text the agent wants to send or surface (checked for blocked phrases).
    pub proposed_text: Option<String>,
    pub entity_type: Option<String>,
    /// "whatsapp" | "internal" | "external" | etc. External channels force approval.
    pub channel: Option<String>,
    /// "low" | "medium" | "high" | "critical"
    pub risk_context: Option<String>,
    pub amount: Option<f64>,
    /// True when the action would send a message to a customer via external channel.
    pub requires_external_message: Option<bool>,
    pub known_customer_ids: Option<Vec<String>>,
    pub customer_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PolicyGuardDecision {
    pub allowed: bool,
    pub blocked: bool,
    /// Phase 2B invariant: always true (no agent auto-executes without owner action).
    pub approval_required: bool,
    /// Phase 2B invariant: always false.
    pub safe_to_auto_execute: bool,
    pub block_reason: Option<String>,
    pub reasons: Vec<String>,
    pub risk_level: String,
}

#[derive(Debug, Serialize)]
pub struct PolicyGuardOutput {
    pub agent_id: String,
    pub status: String,
    pub decision: PolicyGuardDecision,
    /// Number of independent checks run (forbidden_types, blocked_phrases,
    /// hallucination_check, approval_determination, channel_gate).
    pub checks_run: u32,
    pub duration_ms: u64,
    pub audit_event: String,
}

pub fn evaluate(input: &PolicyGuardInput, duration_ms: u64) -> PolicyGuardOutput {
    let channel_requires_approval = input
        .channel
        .as_deref()
        .map(|c| c == "whatsapp" || c == "external")
        .unwrap_or(false);

    let ext_msg_requires_approval = input.requires_external_message.unwrap_or(false);
    let caller_requires_approval = channel_requires_approval || ext_msg_requires_approval;

    let cortex_input = PolicyInput {
        action_type: input.proposed_action_type.clone(),
        amount: input.amount,
        risk_level: input.risk_context.clone(),
        recommended_message: input.proposed_text.clone(),
        requires_approval: Some(caller_requires_approval),
        known_customer_ids: input.known_customer_ids.clone(),
        customer_id: input.customer_id.clone(),
    };

    let cortex = cortex_evaluate(&cortex_input);

    let decision = PolicyGuardDecision {
        allowed: cortex.allowed,
        blocked: cortex.blocked,
        // Phase 2B invariants — overrides whatever cortex returns.
        approval_required: true,
        safe_to_auto_execute: false,
        block_reason: cortex.block_reason,
        reasons: cortex.reasons,
        risk_level: cortex.risk_level,
    };

    PolicyGuardOutput {
        agent_id: "core.policy_guard".to_string(),
        status: if cortex.success {
            "ok".to_string()
        } else {
            "error".to_string()
        },
        decision,
        checks_run: 5, // forbidden_types, blocked_phrases, hallucination, approval, channel_gate
        duration_ms,
        audit_event: "policy_guard_evaluate".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(action: &str) -> PolicyGuardInput {
        PolicyGuardInput {
            proposed_action_type: action.to_string(),
            proposed_text: None,
            entity_type: None,
            channel: None,
            risk_context: None,
            amount: None,
            requires_external_message: None,
            known_customer_ids: None,
            customer_id: None,
        }
    }

    // ── Phase 2B invariants ───────────────────────────────────────────────────

    #[test]
    fn safe_action_has_phase_2b_invariants() {
        // Even a safe low-risk action must have safe_to_auto_execute=false, approval_required=true.
        let out = evaluate(
            &PolicyGuardInput {
                proposed_action_type: "SEND_GENTLE_REMINDER".to_string(),
                proposed_text: Some("Kindly settle your invoice at your earliest.".to_string()),
                ..input("SEND_GENTLE_REMINDER")
            },
            0,
        );
        assert!(
            !out.decision.safe_to_auto_execute,
            "Phase 2B: safe_to_auto_execute must always be false"
        );
        assert!(
            out.decision.approval_required,
            "Phase 2B: approval_required must always be true"
        );
        assert_eq!(out.agent_id, "core.policy_guard");
        assert_eq!(out.checks_run, 5);
    }

    // ── Blocked cases ─────────────────────────────────────────────────────────

    #[test]
    fn forbidden_action_type_is_blocked() {
        let out = evaluate(&input("MARK_PAID"), 0);
        assert!(out.decision.blocked);
        assert!(!out.decision.allowed);
        assert!(
            out.decision
                .block_reason
                .as_deref()
                .unwrap_or("")
                .contains("forbidden"),
            "block_reason must mention forbidden"
        );
    }

    #[test]
    fn legal_threat_in_text_is_blocked() {
        let out = evaluate(
            &PolicyGuardInput {
                proposed_text: Some("We will take legal action if unpaid.".to_string()),
                ..input("SEND_FIRM_REMINDER")
            },
            0,
        );
        assert!(out.decision.blocked, "legal action phrase must be blocked");
    }

    #[test]
    fn standalone_fir_in_text_is_blocked() {
        let out = evaluate(
            &PolicyGuardInput {
                proposed_text: Some("File FIR against this customer.".to_string()),
                ..input("SEND_FIRM_REMINDER")
            },
            0,
        );
        assert!(out.decision.blocked, "standalone FIR must be blocked");
    }

    #[test]
    fn firm_reminder_text_not_blocked_by_fir_substring() {
        let out = evaluate(
            &PolicyGuardInput {
                proposed_text: Some("Send firm reminder about the overdue amount.".to_string()),
                ..input("SEND_FIRM_REMINDER")
            },
            0,
        );
        assert!(
            !out.decision.blocked,
            "'firm' must not trigger the 'fir' block"
        );
    }

    #[test]
    fn hallucinated_customer_id_is_blocked() {
        let out = evaluate(
            &PolicyGuardInput {
                known_customer_ids: Some(vec!["uuid-aaa".to_string(), "uuid-bbb".to_string()]),
                customer_id: Some("uuid-zzz".to_string()),
                ..input("CALL_CUSTOMER")
            },
            0,
        );
        assert!(
            out.decision.blocked,
            "hallucinated customer_id must be blocked"
        );
    }

    // ── Approval cases ────────────────────────────────────────────────────────

    #[test]
    fn always_approval_action_is_allowed_but_needs_approval() {
        let out = evaluate(&input("SEND_FIRM_REMINDER"), 0);
        assert!(!out.decision.blocked);
        assert!(out.decision.allowed);
        assert!(out.decision.approval_required); // Phase 2B + always-approval list
    }

    #[test]
    fn high_amount_allowed_but_needs_approval() {
        let out = evaluate(
            &PolicyGuardInput {
                amount: Some(75_000.0),
                proposed_action_type: "SEND_GENTLE_REMINDER".to_string(),
                ..input("SEND_GENTLE_REMINDER")
            },
            0,
        );
        assert!(!out.decision.blocked);
        assert!(out.decision.allowed);
        assert!(out.decision.approval_required);
    }

    #[test]
    fn whatsapp_channel_forces_approval() {
        let out = evaluate(
            &PolicyGuardInput {
                channel: Some("whatsapp".to_string()),
                proposed_text: Some("Reminder about invoice #123.".to_string()),
                ..input("SEND_GENTLE_REMINDER")
            },
            0,
        );
        assert!(!out.decision.blocked);
        assert!(out.decision.allowed);
        assert!(out.decision.approval_required);
    }

    #[test]
    fn external_channel_forces_approval() {
        let out = evaluate(
            &PolicyGuardInput {
                channel: Some("external".to_string()),
                ..input("SEND_GENTLE_REMINDER")
            },
            0,
        );
        assert!(!out.decision.blocked);
        assert!(out.decision.approval_required);
    }

    #[test]
    fn internal_channel_no_extra_approval_beyond_phase2b() {
        let out = evaluate(
            &PolicyGuardInput {
                channel: Some("internal".to_string()),
                proposed_text: Some("Reminder on invoice.".to_string()),
                ..input("SEND_GENTLE_REMINDER")
            },
            0,
        );
        assert!(!out.decision.blocked);
        assert!(out.decision.approval_required); // Phase 2B invariant still applies
    }

    #[test]
    fn delete_invoice_is_blocked() {
        let out = evaluate(&input("DELETE_INVOICE"), 0);
        assert!(out.decision.blocked);
        assert!(!out.decision.allowed);
    }

    #[test]
    fn audit_event_is_correct() {
        let out = evaluate(&input("CALL_CUSTOMER"), 0);
        assert_eq!(out.audit_event, "policy_guard_evaluate");
    }
}
