//! Agent `core.data_quality` — pure evaluation logic.
//!
//! Read-only. No LLM. No external calls. No mutations.
//! Phase 2A invariants:
//!   - safe_to_auto_fix = false for every finding.
//!   - approval_required = true for every finding.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

// ─── Input types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvoiceRow {
    pub id: Uuid,
    pub customer_id: Option<Uuid>,
    pub invoice_amount: f64,
    pub total_amount: Option<f64>,
    pub amount_paid: Option<f64>,
    pub payment_status: String,
    pub days_overdue: i32,
    pub due_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomerRow {
    pub id: Uuid,
    pub name: String,
    pub phone: Option<String>,
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromiseRow {
    pub id: Uuid,
    pub customer_id: Option<Uuid>,
    pub promised_amount: Option<f64>,
    pub promised_date: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataQualityInput {
    pub user_id: Uuid,
    pub invoices: Vec<InvoiceRow>,
    pub customers: Vec<CustomerRow>,
    pub promises: Vec<PromiseRow>,
    /// Cap on returned findings. Highest-severity findings kept when cap hit. Defaults to 100.
    pub max_findings: Option<usize>,
    /// When false, Low-severity findings are omitted.
    pub include_low_severity: bool,
}

// ─── Output types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Low,
    Medium,
    High,
    Critical,
}

/// A single data quality issue.
///
/// Phase 2A invariant: safe_to_auto_fix = false, approval_required = true.
/// These are advisory findings — no mutations.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataQualityFinding {
    pub finding_id: String,
    pub issue_type: String,
    pub severity: Severity,
    pub entity_type: String,
    pub entity_id: String,
    pub title: String,
    pub explanation: String,
    pub suggested_fix: String,
    pub safe_to_auto_fix: bool,
    pub approval_required: bool,
    pub confidence: f64,
    pub source_tables: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataQualityOutput {
    pub agent_id: String,
    pub status: String,
    pub user_id: Uuid,
    pub total_findings: usize,
    pub findings: Vec<DataQualityFinding>,
    pub summary: String,
    pub duration_ms: u64,
    pub audit_event: String,
    pub next_recommended_action: String,
    pub checks_run: Vec<String>,
    pub warnings: Vec<String>,
}

// ─── Evaluation ───────────────────────────────────────────────────────────────

const CHECKS: &[&str] = &[
    "missing_due_date",
    "missing_customer_id",
    "amount_paid_exceeds_total",
    "zero_or_negative_amount",
    "missing_name",
    "duplicate_name",
    "promise_missing_due_date",
    "promise_missing_amount",
];

const COLLECTION_CAP: usize = 1000;

fn finding(
    issue_type: &str,
    severity: Severity,
    entity_type: &str,
    entity_id: Uuid,
    title: String,
    explanation: String,
    suggested_fix: &str,
    confidence: f64,
    source_tables: &[&str],
) -> DataQualityFinding {
    DataQualityFinding {
        finding_id: format!("{}:{}", issue_type, entity_id),
        issue_type: issue_type.to_string(),
        severity,
        entity_type: entity_type.to_string(),
        entity_id: entity_id.to_string(),
        title,
        explanation,
        suggested_fix: suggested_fix.to_string(),
        safe_to_auto_fix: false,
        approval_required: true,
        confidence,
        source_tables: source_tables.iter().map(|s| s.to_string()).collect(),
    }
}

/// Evaluate data quality for the given user's records.
///
/// Always read-only. Never returns `safe_to_auto_fix = true`.
/// Highest-severity findings are retained when `max_findings` is hit.
pub fn evaluate(input: &DataQualityInput, duration_ms: u64) -> DataQualityOutput {
    let max = input.max_findings.unwrap_or(100);
    let mut all_findings: Vec<DataQualityFinding> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    // ── Check 1: invoice missing due date ─────────────────────────────────────
    for inv in &input.invoices {
        if all_findings.len() >= COLLECTION_CAP {
            break;
        }
        let missing = inv
            .due_date
            .as_deref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true);
        if missing {
            all_findings.push(finding(
                "missing_due_date",
                Severity::Medium,
                "invoice",
                inv.id,
                "Invoice missing due date".to_string(),
                format!(
                    "Invoice {} has no due date. Overdue tracking and \
                     collection scheduling are impaired without it.",
                    inv.id
                ),
                "Set a due date on this invoice.",
                1.0,
                &["invoices"],
            ));
        }
    }

    // ── Check 2: invoice not linked to a customer ─────────────────────────────
    if input.include_low_severity {
        for inv in &input.invoices {
            if all_findings.len() >= COLLECTION_CAP {
                break;
            }
            if inv.customer_id.is_none() {
                all_findings.push(finding(
                    "missing_customer_id",
                    Severity::Low,
                    "invoice",
                    inv.id,
                    "Invoice not linked to a customer".to_string(),
                    format!(
                        "Invoice {} has no customer_id. Collections, scoring, \
                         and briefings depend on this link.",
                        inv.id
                    ),
                    "Link this invoice to an existing customer record.",
                    1.0,
                    &["invoices"],
                ));
            }
        }
    }

    // ── Check 3: amount paid exceeds invoice total ────────────────────────────
    for inv in &input.invoices {
        if all_findings.len() >= COLLECTION_CAP {
            break;
        }
        if let (Some(paid), Some(total)) = (inv.amount_paid, inv.total_amount) {
            if paid > total + 0.01 {
                all_findings.push(finding(
                    "amount_paid_exceeds_total",
                    Severity::High,
                    "invoice",
                    inv.id,
                    "Amount paid exceeds invoice total".to_string(),
                    format!(
                        "Invoice {} shows paid {:.2} against total {:.2}. \
                         Possible duplicate payment or data entry error.",
                        inv.id, paid, total
                    ),
                    "Review for duplicate payments or data entry errors.",
                    0.99,
                    &["invoices"],
                ));
            }
        }
    }

    // ── Check 4: zero or negative invoice amount ──────────────────────────────
    for inv in &input.invoices {
        if all_findings.len() >= COLLECTION_CAP {
            break;
        }
        if inv.invoice_amount <= 0.0 {
            all_findings.push(finding(
                "zero_or_negative_amount",
                Severity::Medium,
                "invoice",
                inv.id,
                "Invoice has zero or negative amount".to_string(),
                format!(
                    "Invoice {} has amount {:.2}, indicating a data entry problem.",
                    inv.id, inv.invoice_amount
                ),
                "Set a valid positive amount on this invoice.",
                1.0,
                &["invoices"],
            ));
        }
    }

    // ── Check 5: customer with blank name ─────────────────────────────────────
    for cust in &input.customers {
        if all_findings.len() >= COLLECTION_CAP {
            break;
        }
        if cust.name.trim().is_empty() {
            all_findings.push(finding(
                "missing_name",
                Severity::High,
                "customer",
                cust.id,
                "Customer has no name".to_string(),
                format!(
                    "Customer {} has a blank name. Owner briefings and \
                     collection messages depend on customer names.",
                    cust.id
                ),
                "Set a name on this customer record.",
                1.0,
                &["customers"],
            ));
        }
    }

    // ── Check 6: duplicate customer names ────────────────────────────────────
    {
        let mut name_map: HashMap<String, Vec<Uuid>> = HashMap::new();
        for cust in &input.customers {
            let key = cust.name.trim().to_lowercase();
            if !key.is_empty() {
                name_map.entry(key).or_default().push(cust.id);
            }
        }
        for (name_key, ids) in &name_map {
            if ids.len() < 2 {
                continue;
            }
            for id in ids {
                if all_findings.len() >= COLLECTION_CAP {
                    break;
                }
                all_findings.push(finding(
                    "duplicate_name",
                    Severity::Medium,
                    "customer",
                    *id,
                    format!("Duplicate customer name \"{}\"", name_key),
                    format!(
                        "Customer {} shares a name with {} other record(s). \
                         May indicate duplicate entries that distort scoring.",
                        id,
                        ids.len() - 1
                    ),
                    "Review for duplicate customer records and merge if appropriate.",
                    0.85,
                    &["customers"],
                ));
            }
        }
    }

    // ── Check 7: promise missing due date ─────────────────────────────────────
    for promise in &input.promises {
        if all_findings.len() >= COLLECTION_CAP {
            break;
        }
        let missing = promise
            .promised_date
            .as_deref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true);
        if missing {
            all_findings.push(finding(
                "promise_missing_due_date",
                Severity::Medium,
                "promise",
                promise.id,
                "Payment promise has no due date".to_string(),
                format!(
                    "Promise {} has no promised date. The system cannot \
                     detect broken promises without it.",
                    promise.id
                ),
                "Set a promised payment date on this record.",
                1.0,
                &["promises"],
            ));
        }
    }

    // ── Check 8: promise missing amount ──────────────────────────────────────
    if input.include_low_severity {
        for promise in &input.promises {
            if all_findings.len() >= COLLECTION_CAP {
                break;
            }
            let missing = promise.promised_amount.map(|a| a <= 0.0).unwrap_or(true);
            if missing {
                all_findings.push(finding(
                    "promise_missing_amount",
                    Severity::Low,
                    "promise",
                    promise.id,
                    "Payment promise has no amount".to_string(),
                    format!(
                        "Promise {} has no promised amount. \
                         Cash projection accuracy is reduced.",
                        promise.id
                    ),
                    "Set the promised payment amount on this record.",
                    1.0,
                    &["promises"],
                ));
            }
        }
    }

    // ── Sort: highest severity first, then stable by finding_id ──────────────
    all_findings.sort_by(|a, b| {
        b.severity
            .cmp(&a.severity)
            .then_with(|| a.finding_id.cmp(&b.finding_id))
    });

    // ── Apply max_findings cap ────────────────────────────────────────────────
    if all_findings.len() > max {
        warnings.push(format!(
            "{} findings found but output capped at {}. \
             Only the highest-severity findings are shown.",
            all_findings.len(),
            max
        ));
        all_findings.truncate(max);
    }

    let total = all_findings.len();

    let summary = if total == 0 {
        "No data quality issues found.".to_string()
    } else {
        let critical = all_findings
            .iter()
            .filter(|f| f.severity == Severity::Critical)
            .count();
        let high = all_findings
            .iter()
            .filter(|f| f.severity == Severity::High)
            .count();
        let med = all_findings
            .iter()
            .filter(|f| f.severity == Severity::Medium)
            .count();
        let low = all_findings
            .iter()
            .filter(|f| f.severity == Severity::Low)
            .count();
        let parts: Vec<String> = [
            (critical, "critical"),
            (high, "high"),
            (med, "medium"),
            (low, "low"),
        ]
        .iter()
        .filter(|(n, _)| *n > 0)
        .map(|(n, label)| format!("{} {}", n, label))
        .collect();
        format!("{} data quality issue(s): {}.", total, parts.join(", "))
    };

    let next_action = if total == 0 {
        "No action required. Data quality is good.".to_string()
    } else {
        "Review findings in the owner dashboard. \
         Owner approval required before any data corrections."
            .to_string()
    };

    DataQualityOutput {
        agent_id: "core.data_quality".to_string(),
        status: "ok".to_string(),
        user_id: input.user_id,
        total_findings: total,
        findings: all_findings,
        summary,
        duration_ms,
        audit_event: "data_quality.evaluated".to_string(),
        next_recommended_action: next_action,
        checks_run: CHECKS.iter().map(|s| s.to_string()).collect(),
        warnings,
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn uid() -> Uuid {
        Uuid::from_u128(0xAAAA_0000)
    }

    fn base_input() -> DataQualityInput {
        DataQualityInput {
            user_id: uid(),
            invoices: vec![],
            customers: vec![],
            promises: vec![],
            max_findings: None,
            include_low_severity: true,
        }
    }

    fn inv(id: u128, due_date: Option<&str>, amount: f64) -> InvoiceRow {
        InvoiceRow {
            id: Uuid::from_u128(id),
            customer_id: Some(Uuid::from_u128(0x1)),
            invoice_amount: amount,
            total_amount: Some(amount),
            amount_paid: Some(0.0),
            payment_status: "Pending".to_string(),
            days_overdue: 0,
            due_date: due_date.map(str::to_string),
        }
    }

    fn cust(id: u128, name: &str) -> CustomerRow {
        CustomerRow {
            id: Uuid::from_u128(id),
            name: name.to_string(),
            phone: None,
            email: None,
        }
    }

    fn promise(id: u128, amount: Option<f64>, date: Option<&str>) -> PromiseRow {
        PromiseRow {
            id: Uuid::from_u128(id),
            customer_id: Some(Uuid::from_u128(0x1)),
            promised_amount: amount,
            promised_date: date.map(str::to_string),
            status: Some("active".to_string()),
        }
    }

    #[test]
    fn test_agent_id_correct() {
        let out = evaluate(&base_input(), 0);
        assert_eq!(out.agent_id, "core.data_quality");
        assert_eq!(out.status, "ok");
        assert_eq!(out.user_id, uid());
    }

    #[test]
    fn test_checks_run_list() {
        let out = evaluate(&base_input(), 0);
        assert_eq!(out.checks_run.len(), 8);
        assert!(out.checks_run.contains(&"missing_due_date".to_string()));
        assert!(out.checks_run.contains(&"duplicate_name".to_string()));
        assert!(out
            .checks_run
            .contains(&"promise_missing_amount".to_string()));
    }

    #[test]
    fn test_clean_data_zero_findings() {
        let mut input = base_input();
        input.invoices = vec![inv(1, Some("2026-07-01"), 5000.0)];
        input.customers = vec![cust(1, "Rahul Sharma")];
        input.promises = vec![promise(1, Some(1000.0), Some("2026-06-15"))];
        let out = evaluate(&input, 10);
        assert_eq!(out.total_findings, 0);
        assert!(out.findings.is_empty());
        assert!(out.warnings.is_empty());
    }

    #[test]
    fn test_missing_due_date() {
        let mut input = base_input();
        input.invoices = vec![inv(1, None, 5000.0)];
        let out = evaluate(&input, 0);
        let f = out
            .findings
            .iter()
            .find(|f| f.issue_type == "missing_due_date")
            .unwrap();
        assert_eq!(f.severity, Severity::Medium);
        assert_eq!(f.entity_type, "invoice");
        assert!(!f.safe_to_auto_fix);
        assert!(f.approval_required);
    }

    #[test]
    fn test_missing_due_date_empty_string() {
        let mut input = base_input();
        input.invoices = vec![inv(1, Some("  "), 5000.0)];
        let out = evaluate(&input, 0);
        assert!(out
            .findings
            .iter()
            .any(|f| f.issue_type == "missing_due_date"));
    }

    #[test]
    fn test_missing_customer_id_when_low_severity_on() {
        let mut input = base_input();
        input.include_low_severity = true;
        input.invoices = vec![InvoiceRow {
            id: Uuid::from_u128(1),
            customer_id: None,
            invoice_amount: 1000.0,
            total_amount: Some(1000.0),
            amount_paid: Some(0.0),
            payment_status: "Pending".to_string(),
            days_overdue: 0,
            due_date: Some("2026-07-01".to_string()),
        }];
        let out = evaluate(&input, 0);
        let f = out
            .findings
            .iter()
            .find(|f| f.issue_type == "missing_customer_id")
            .unwrap();
        assert_eq!(f.severity, Severity::Low);
        assert!(!f.safe_to_auto_fix);
        assert!(f.approval_required);
    }

    #[test]
    fn test_missing_customer_id_excluded_when_low_severity_off() {
        let mut input = base_input();
        input.include_low_severity = false;
        input.invoices = vec![InvoiceRow {
            id: Uuid::from_u128(1),
            customer_id: None,
            invoice_amount: 1000.0,
            total_amount: Some(1000.0),
            amount_paid: Some(0.0),
            payment_status: "Pending".to_string(),
            days_overdue: 0,
            due_date: Some("2026-07-01".to_string()),
        }];
        let out = evaluate(&input, 0);
        assert!(!out
            .findings
            .iter()
            .any(|f| f.issue_type == "missing_customer_id"));
    }

    #[test]
    fn test_amount_paid_exceeds_total() {
        let mut input = base_input();
        input.invoices = vec![InvoiceRow {
            id: Uuid::from_u128(1),
            customer_id: Some(Uuid::from_u128(1)),
            invoice_amount: 5000.0,
            total_amount: Some(5000.0),
            amount_paid: Some(6000.0),
            payment_status: "Paid".to_string(),
            days_overdue: 0,
            due_date: Some("2026-06-01".to_string()),
        }];
        let out = evaluate(&input, 0);
        let f = out
            .findings
            .iter()
            .find(|f| f.issue_type == "amount_paid_exceeds_total")
            .unwrap();
        assert_eq!(f.severity, Severity::High);
        assert!(!f.safe_to_auto_fix);
        assert!(f.approval_required);
    }

    #[test]
    fn test_amount_paid_equals_total_no_finding() {
        let mut input = base_input();
        input.invoices = vec![InvoiceRow {
            id: Uuid::from_u128(1),
            customer_id: Some(Uuid::from_u128(1)),
            invoice_amount: 5000.0,
            total_amount: Some(5000.0),
            amount_paid: Some(5000.0),
            payment_status: "Paid".to_string(),
            days_overdue: 0,
            due_date: Some("2026-06-01".to_string()),
        }];
        let out = evaluate(&input, 0);
        assert!(!out
            .findings
            .iter()
            .any(|f| f.issue_type == "amount_paid_exceeds_total"));
    }

    #[test]
    fn test_zero_or_negative_amount() {
        let mut input = base_input();
        input.invoices = vec![inv(1, Some("2026-07-01"), 0.0)];
        let out = evaluate(&input, 0);
        let f = out
            .findings
            .iter()
            .find(|f| f.issue_type == "zero_or_negative_amount")
            .unwrap();
        assert_eq!(f.severity, Severity::Medium);
        assert!(!f.safe_to_auto_fix);
        assert!(f.approval_required);
    }

    #[test]
    fn test_missing_name() {
        let mut input = base_input();
        input.customers = vec![cust(1, "")];
        let out = evaluate(&input, 0);
        let f = out
            .findings
            .iter()
            .find(|f| f.issue_type == "missing_name")
            .unwrap();
        assert_eq!(f.severity, Severity::High);
        assert!(!f.safe_to_auto_fix);
        assert!(f.approval_required);
    }

    #[test]
    fn test_missing_name_whitespace_only() {
        let mut input = base_input();
        input.customers = vec![cust(1, "   ")];
        let out = evaluate(&input, 0);
        assert!(out.findings.iter().any(|f| f.issue_type == "missing_name"));
    }

    #[test]
    fn test_duplicate_name() {
        let mut input = base_input();
        input.customers = vec![
            cust(1, "Rahul Sharma"),
            cust(2, "rahul sharma"), // same name, different case
        ];
        let out = evaluate(&input, 0);
        let dups: Vec<_> = out
            .findings
            .iter()
            .filter(|f| f.issue_type == "duplicate_name")
            .collect();
        assert_eq!(dups.len(), 2);
        for f in dups {
            assert_eq!(f.severity, Severity::Medium);
            assert!(!f.safe_to_auto_fix);
            assert!(f.approval_required);
        }
    }

    #[test]
    fn test_no_duplicate_with_unique_names() {
        let mut input = base_input();
        input.customers = vec![cust(1, "Rahul Sharma"), cust(2, "Priya Patel")];
        let out = evaluate(&input, 0);
        assert!(!out
            .findings
            .iter()
            .any(|f| f.issue_type == "duplicate_name"));
    }

    #[test]
    fn test_promise_missing_due_date() {
        let mut input = base_input();
        input.promises = vec![promise(1, Some(1000.0), None)];
        let out = evaluate(&input, 0);
        let f = out
            .findings
            .iter()
            .find(|f| f.issue_type == "promise_missing_due_date")
            .unwrap();
        assert_eq!(f.severity, Severity::Medium);
        assert_eq!(f.entity_type, "promise");
        assert!(!f.safe_to_auto_fix);
        assert!(f.approval_required);
    }

    #[test]
    fn test_promise_missing_amount_included() {
        let mut input = base_input();
        input.include_low_severity = true;
        input.promises = vec![promise(1, None, Some("2026-06-15"))];
        let out = evaluate(&input, 0);
        let f = out
            .findings
            .iter()
            .find(|f| f.issue_type == "promise_missing_amount")
            .unwrap();
        assert_eq!(f.severity, Severity::Low);
        assert!(!f.safe_to_auto_fix);
        assert!(f.approval_required);
    }

    #[test]
    fn test_promise_missing_amount_excluded_when_low_severity_off() {
        let mut input = base_input();
        input.include_low_severity = false;
        input.promises = vec![promise(1, None, Some("2026-06-15"))];
        let out = evaluate(&input, 0);
        assert!(!out
            .findings
            .iter()
            .any(|f| f.issue_type == "promise_missing_amount"));
    }

    #[test]
    fn test_max_findings_cap() {
        let mut input = base_input();
        input.invoices = (1u128..=5).map(|i| inv(i, None, 1000.0)).collect();
        input.max_findings = Some(2);
        let out = evaluate(&input, 0);
        assert_eq!(out.total_findings, 2);
        assert_eq!(out.findings.len(), 2);
        assert!(!out.warnings.is_empty());
    }

    #[test]
    fn test_all_findings_have_phase2a_invariants() {
        let mut input = base_input();
        input.invoices = vec![
            inv(1, None, 0.0),
            InvoiceRow {
                id: Uuid::from_u128(2),
                customer_id: None,
                invoice_amount: 100.0,
                total_amount: Some(100.0),
                amount_paid: Some(200.0),
                payment_status: "Paid".to_string(),
                days_overdue: 0,
                due_date: Some("2026-01-01".to_string()),
            },
        ];
        input.customers = vec![cust(1, ""), cust(2, "same"), cust(3, "same")];
        input.promises = vec![promise(1, None, None)];
        let out = evaluate(&input, 0);
        assert!(out.total_findings > 0, "expected at least one finding");
        for f in &out.findings {
            assert!(
                !f.safe_to_auto_fix,
                "Phase 2A invariant violated: {} has safe_to_auto_fix=true",
                f.issue_type
            );
            assert!(
                f.approval_required,
                "Phase 2A invariant violated: {} has approval_required=false",
                f.issue_type
            );
        }
    }
}
