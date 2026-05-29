// FILE: vantro-automation-rs/src/cortex/action_engine.rs
// Action type classification and whitelist enforcement.

use std::collections::HashSet;

pub fn allowed_action_types() -> HashSet<&'static str> {
    [
        "CHASE_CUSTOMER",
        "SEND_POLITE_REMINDER",
        "SEND_FIRM_REMINDER",
        "CALL_CUSTOMER",
        "ASK_PARTIAL_PAYMENT",
        "ESCALATE_TO_OWNER",
        "STOP_CREDIT_WARNING",
        "RESOLVE_DISPUTE",
        "LOW_STOCK_ALERT",
        "PURCHASE_SUGGESTION",
        "SUPPLIER_PAYMENT_DUE",
        "CASHFLOW_RISK",
        "DAILY_OWNER_BRIEFING",
        "CREDIT_LIMIT_REVIEW",
        "STAFF_TASK_ASSIGNMENT",
        "DATA_QUALITY_FIX",
        "CREDIT_HOLD_SUGGESTED",
    ]
    .iter()
    .copied()
    .collect()
}

pub fn is_allowed(action_type: &str) -> bool {
    allowed_action_types().contains(action_type)
}

pub fn is_forbidden(action_type: &str) -> bool {
    matches!(
        action_type,
        "MARK_PAID" | "CHANGE_AMOUNT" | "OFFER_DISCOUNT" | "DELETE_INVOICE" | "DELETE_CUSTOMER"
    )
}

pub fn always_requires_approval(action_type: &str) -> bool {
    matches!(
        action_type,
        "SEND_FIRM_REMINDER"
            | "CALL_CUSTOMER"
            | "ESCALATE_TO_OWNER"
            | "STOP_CREDIT_WARNING"
            | "CASHFLOW_RISK"
            | "CREDIT_HOLD_SUGGESTED"
            | "ASK_PARTIAL_PAYMENT"
    )
}
