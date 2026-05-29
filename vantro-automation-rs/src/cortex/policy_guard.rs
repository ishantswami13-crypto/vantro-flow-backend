// FILE: vantro-automation-rs/src/cortex/policy_guard.rs
// Policy guard — pure evaluation, no DB, no I/O.
// Mirrors policyGuard.service.js pure checks exactly.

use serde::{Deserialize, Serialize};

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
const FORBIDDEN_TYPES: &[&str] = &[
    "MARK_PAID",
    "CHANGE_AMOUNT",
    "OFFER_DISCOUNT",
    "DELETE_INVOICE",
];
const ALWAYS_APPROVAL: &[&str] = &[
    "SEND_FIRM_REMINDER",
    "CALL_CUSTOMER",
    "ESCALATE_TO_OWNER",
    "STOP_CREDIT_WARNING",
    "CASHFLOW_RISK",
    "CREDIT_HOLD_SUGGESTED",
    "ASK_PARTIAL_PAYMENT",
];
const HIGH_AMOUNT: f64 = 50_000.0;

#[derive(Debug, Deserialize, Clone)]
pub struct PolicyInput {
    pub action_type: String,
    pub amount: Option<f64>,
    pub risk_level: Option<String>,
    pub recommended_message: Option<String>,
    pub requires_approval: Option<bool>,
    /// Callers can supply ids that were known at context-build time.
    /// Hallucination: if action references an id NOT in known_ids → block.
    pub known_customer_ids: Option<Vec<String>>,
    pub customer_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PolicyDecision {
    pub success: bool,
    pub allowed: bool,
    pub blocked: bool,
    pub requires_approval: bool,
    pub block_reason: Option<String>,
    pub reasons: Vec<String>,
    pub risk_level: String,
}

pub fn evaluate(input: &PolicyInput) -> PolicyDecision {
    let mut reasons: Vec<String> = Vec::new();

    // 1. Forbidden action type
    if FORBIDDEN_TYPES.contains(&input.action_type.as_str()) {
        reasons.push(format!(
            "Action type {} is forbidden for AI/rule suggestions",
            input.action_type
        ));
    }

    // 2. Blocked phrases in message — word-boundary match (NOT raw substring).
    // Raw `contains` would block benign words like "firm" / "confirm" because they
    // contain the literal substring "fir". Word-boundary matching is required so that
    // "send firm reminder" is allowed while "file FIR" is still blocked.
    if let Some(msg) = &input.recommended_message {
        let lower = msg.to_lowercase();
        for phrase in BLOCKED_PHRASES {
            if contains_phrase_as_words(&lower, phrase) {
                reasons.push(format!("Message contains blocked phrase: \"{}\"", phrase));
                break;
            }
        }
    }

    // 3. Hallucination check: customer_id not in known context
    if let (Some(cid), Some(known)) = (&input.customer_id, &input.known_customer_ids) {
        if !known.is_empty() && !known.contains(cid) {
            reasons.push(format!(
                "customer_id {} not in context — possible hallucination",
                cid
            ));
        }
    }

    if !reasons.is_empty() {
        return PolicyDecision {
            success: true,
            allowed: false,
            blocked: true,
            requires_approval: false,
            block_reason: Some(reasons.join("; ")),
            reasons,
            risk_level: "blocked".to_string(),
        };
    }

    // 4. Approval determination
    let amount_over = input.amount.map_or(false, |a| a > HIGH_AMOUNT);
    let high_risk = matches!(input.risk_level.as_deref(), Some("high") | Some("critical"));
    let always_app = ALWAYS_APPROVAL.contains(&input.action_type.as_str());
    let caller_req = input.requires_approval.unwrap_or(false);
    let needs_approval = always_app || amount_over || high_risk || caller_req;

    let risk_str = if needs_approval { "medium" } else { "low" };

    PolicyDecision {
        success: true,
        allowed: true,
        blocked: false,
        requires_approval: needs_approval,
        block_reason: None,
        reasons,
        risk_level: risk_str.to_string(),
    }
}

// ─── Word-boundary phrase matching ───────────────────────────────────────────
// Both inputs are expected to be ASCII-lowercased. Returns true only when the
// phrase appears as a sequence of whole words — i.e. the character immediately
// before the match (if any) and immediately after the match (if any) is a
// non-word character (anything other than ASCII alphanumeric or underscore).
// Multi-byte UTF-8 runs in the haystack are safe because match_indices yields
// byte offsets at valid char boundaries.

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn contains_phrase_as_words(haystack_lower: &str, phrase_lower: &str) -> bool {
    if phrase_lower.is_empty() {
        return false;
    }
    for (start, _) in haystack_lower.match_indices(phrase_lower) {
        let end = start + phrase_lower.len();
        let left_ok = start == 0
            || !haystack_lower[..start]
                .chars()
                .next_back()
                .map(is_word_char)
                .unwrap_or(false);
        let right_ok = end == haystack_lower.len()
            || !haystack_lower[end..]
                .chars()
                .next()
                .map(is_word_char)
                .unwrap_or(false);
        if left_ok && right_ok {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_input(msg: &str) -> PolicyInput {
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

    // ── pure helper coverage ──
    #[test]
    fn word_match_fir_does_not_trigger_on_firm() {
        assert!(!contains_phrase_as_words("send firm reminder today", "fir"));
    }
    #[test]
    fn word_match_fir_triggers_on_isolated_fir() {
        assert!(contains_phrase_as_words(
            "we will file fir against you",
            "fir"
        ));
    }
    #[test]
    fn word_match_fir_does_not_trigger_on_confirm() {
        assert!(!contains_phrase_as_words(
            "please confirm the payment",
            "fir"
        ));
    }
    #[test]
    fn word_match_fir_does_not_trigger_on_firmware_first_or_firmly() {
        assert!(!contains_phrase_as_words("firmware update", "fir"));
        assert!(!contains_phrase_as_words("first reminder", "fir"));
        assert!(!contains_phrase_as_words(
            "we firmly request payment",
            "fir"
        ));
    }
    #[test]
    fn word_match_handles_punctuation_boundaries() {
        assert!(contains_phrase_as_words(
            "we will file (fir) tomorrow",
            "fir"
        ));
        assert!(contains_phrase_as_words("warning: fir.", "fir"));
        assert!(contains_phrase_as_words("fir", "fir"));
    }
    #[test]
    fn word_match_multi_word_phrase() {
        assert!(contains_phrase_as_words(
            "we will take legal action soon",
            "legal action"
        ));
        assert!(!contains_phrase_as_words(
            "an illegal actionable plan",
            "legal action"
        ));
    }
    #[test]
    fn word_match_empty_phrase_is_false() {
        assert!(!contains_phrase_as_words("anything", ""));
    }

    // ── public evaluate() — the contract the rest of the system depends on ──
    #[test]
    fn evaluate_does_not_block_firm_reminder() {
        let decision = evaluate(&make_input(
            "Please send firm reminder for the overdue invoice",
        ));
        assert!(
            !decision.blocked,
            "‘firm reminder’ must not be blocked by the ‘fir’ phrase"
        );
        assert!(decision.allowed);
        assert!(decision.block_reason.is_none());
    }

    #[test]
    fn evaluate_does_not_block_confirm() {
        let decision = evaluate(&make_input("Please confirm receipt of the payment"));
        assert!(!decision.blocked, "‘confirm’ must not be blocked");
    }

    #[test]
    fn evaluate_blocks_file_fir() {
        let decision = evaluate(&make_input("If you don't pay we will file FIR against you"));
        assert!(decision.blocked, "Standalone token ‘FIR’ must be blocked");
        assert!(decision
            .block_reason
            .as_deref()
            .unwrap_or("")
            .contains("fir"));
    }

    #[test]
    fn evaluate_blocks_legal_action() {
        let decision = evaluate(&make_input("We will take legal action if unpaid"));
        assert!(decision.blocked, "‘legal action’ must be blocked");
        assert!(decision
            .block_reason
            .as_deref()
            .unwrap_or("")
            .contains("legal action"));
    }

    #[test]
    fn evaluate_blocks_police_as_word_not_substring() {
        let allowed = evaluate(&make_input("This is our company policy on credit terms"));
        assert!(!allowed.blocked, "‘policy’ must not be blocked by ‘police’");

        let blocked = evaluate(&make_input("I will call the police on you"));
        assert!(blocked.blocked, "Standalone ‘police’ must be blocked");
    }
}
