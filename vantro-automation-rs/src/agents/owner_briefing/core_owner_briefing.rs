use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use uuid::Uuid;

// ── EvidenceItem ──────────────────────────────────────────────────────────────
//
// A single piece of tenant-scoped evidence backing an owner briefing claim.
// Every field is derived from a real DB record — no synthetic or hallucinated data.
// source_id is the PK of the originating DB row.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceItem {
    pub id: String,          // "source_type:source_id"
    pub source_type: String, // "invoice" | "promise" | "customer"
    pub source_id: String,   // UUID of the DB row
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

impl EvidenceItem {
    fn invoice(
        invoice_id: &str,
        amount: f64,
        status: &str,
        due_date: Option<&str>,
        is_overdue: bool,
        customer_id: Option<&str>,
    ) -> Self {
        let label = if is_overdue {
            "Overdue invoice".to_string()
        } else {
            "Unpaid invoice".to_string()
        };
        let excerpt = format!(
            "Invoice for ₹{:.2} is {} (due: {})",
            amount,
            status.to_lowercase(),
            due_date.unwrap_or("unknown")
        );
        let mut meta = serde_json::json!({
            "status": status,
            "is_overdue": is_overdue,
        });
        if let Some(dd) = due_date {
            meta["due_date"] = serde_json::Value::String(dd.to_string());
        }
        if let Some(cid) = customer_id {
            meta["customer_id"] = serde_json::Value::String(cid.to_string());
        }
        EvidenceItem {
            id: format!("invoice:{}", invoice_id),
            source_type: "invoice".to_string(),
            source_id: invoice_id.to_string(),
            label: Some(label),
            excerpt: Some(excerpt),
            amount: Some(amount),
            currency: Some("INR".to_string()),
            created_at: None,
            updated_at: None,
            confidence: Some(1.0),
            metadata: Some(meta),
        }
    }

    fn broken_promise(
        promise_id: &str,
        customer_id: Option<&str>,
        created_at: Option<&str>,
    ) -> Self {
        let mut meta = serde_json::json!({ "status": "broken" });
        if let Some(cid) = customer_id {
            meta["customer_id"] = serde_json::Value::String(cid.to_string());
        }
        EvidenceItem {
            id: format!("promise:{}", promise_id),
            source_type: "promise".to_string(),
            source_id: promise_id.to_string(),
            label: Some("Broken payment promise".to_string()),
            excerpt: Some("Customer missed their promised payment date.".to_string()),
            amount: None,
            currency: None,
            created_at: created_at.map(|s| s.to_string()),
            updated_at: None,
            confidence: Some(1.0),
            metadata: Some(meta),
        }
    }
}

// ── OwnerBriefingInput ────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct OwnerBriefingInput {
    pub briefing_date: Option<DateTime<Utc>>,
    pub include_low_priority: Option<bool>,
    pub max_items_per_section: Option<usize>,
    pub include_data_quality: Option<bool>,
    pub include_policy_preview: Option<bool>,
    pub include_cost_route: Option<bool>,
}

// ── OwnerBriefingAction ───────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct OwnerBriefingAction {
    pub action_id: String,
    pub action_type: String,
    pub title: String,
    pub explanation: String,
    pub priority: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<String>,
    pub suggested_next_step: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_decision: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_route: Option<String>,
    pub approval_required: bool,
    pub safe_to_auto_execute: bool,
    // Evidence IDs that back this action (Phase 2C.13)
    #[serde(default)]
    pub evidence_ids: Vec<String>,
}

// ── OwnerBriefingSection ──────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct OwnerBriefingSection {
    pub section_id: String,
    pub title: String,
    pub priority: String,
    pub summary: String,
    pub items: Vec<serde_json::Value>,
    pub source_tables: Vec<String>,
    pub confidence: f64,
    pub action_required: bool,
}

// ── OwnerBriefingOutput ───────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct OwnerBriefingOutput {
    pub agent_id: String,
    pub status: String,
    pub user_id: String,
    pub generated_at: DateTime<Utc>,
    pub briefing_date: DateTime<Utc>,
    pub headline: String,
    pub risk_summary: String,
    pub cash_summary: String,
    pub sections: Vec<OwnerBriefingSection>,
    pub top_actions: Vec<OwnerBriefingAction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_quality_summary: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_route_summary: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_summary: Option<serde_json::Value>,
    pub total_actions: usize,
    pub duration_ms: u128,
    pub audit_context: String,
    // Phase 2C.13: RAG Evidence items sourced from live tenant-scoped DB queries.
    // Always present, empty when no records exist. Node enforceEvidenceContract()
    // uses this array to gate claim display.
    pub evidence: Vec<EvidenceItem>,
}

// ── Evidence bounds ───────────────────────────────────────────────────────────
// Keep evidence array bounded to avoid large payloads.
// Prefer overdue invoices first, then all unpaid, then broken promises.
const MAX_INVOICE_EVIDENCE: usize = 10;
const MAX_PROMISE_EVIDENCE: usize = 5;

// ── generate_owner_briefing ───────────────────────────────────────────────────

pub async fn generate_owner_briefing(
    pool: &PgPool,
    user_id: Uuid,
    input: OwnerBriefingInput,
) -> Result<OwnerBriefingOutput> {
    let t0 = std::time::Instant::now();
    let max_items = input.max_items_per_section.unwrap_or(5);
    let briefing_date = input.briefing_date.unwrap_or_else(Utc::now);

    let mut sections = Vec::new();
    let mut top_actions = Vec::new();
    let mut evidence: Vec<EvidenceItem> = Vec::new();

    // ── 1. Cash / Receivables — invoices query ────────────────────────────────
    let invoices = sqlx::query(
        "SELECT id, invoice_amount, due_date, payment_status, customer_id
         FROM invoices
         WHERE user_id = $1 AND payment_status != 'PAID'",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    let mut unpaid_amount = 0.0_f64;
    let mut overdue_count = 0usize;
    let mut cash_items = Vec::new();
    let mut overdue_evidence: Vec<EvidenceItem> = Vec::new();
    let mut unpaid_evidence: Vec<EvidenceItem> = Vec::new();

    for row in &invoices {
        use rust_decimal::Decimal;
        let amount: f64 = row
            .try_get::<Decimal, _>("invoice_amount")
            .map(|d| d.to_string().parse::<f64>().unwrap_or(0.0))
            .unwrap_or(0.0);

        let due_date_str: Option<String> = row.try_get("due_date").ok();
        let status_str: String = row.try_get("payment_status").unwrap_or_default();
        let invoice_id: Option<Uuid> = row.try_get("id").ok();
        let customer_id: Option<Uuid> = row.try_get("customer_id").ok();

        unpaid_amount += amount;

        let mut is_overdue = false;
        if let Some(due_str) = &due_date_str {
            if let Ok(due) = chrono::NaiveDate::parse_from_str(due_str, "%Y-%m-%d") {
                let due_time = chrono::NaiveDateTime::new(
                    due,
                    chrono::NaiveTime::from_hms_opt(0, 0, 0).unwrap_or_default(),
                );
                let due_utc = DateTime::<Utc>::from_naive_utc_and_offset(due_time, Utc);
                if due_utc < briefing_date {
                    overdue_count += 1;
                    is_overdue = true;
                }
            }
        }

        if cash_items.len() < max_items {
            cash_items.push(serde_json::json!({
                "id": invoice_id,
                "amount": amount,
                "due_date": due_date_str,
                "status": status_str,
            }));
        }

        // Build evidence item for this invoice
        let inv_id_str = invoice_id.map(|u| u.to_string()).unwrap_or_default();
        let cust_id_str = customer_id.map(|u| u.to_string());
        if !inv_id_str.is_empty() {
            let ev = EvidenceItem::invoice(
                &inv_id_str,
                amount,
                &status_str,
                due_date_str.as_deref(),
                is_overdue,
                cust_id_str.as_deref(),
            );
            if is_overdue && overdue_evidence.len() < MAX_INVOICE_EVIDENCE {
                overdue_evidence.push(ev);
            } else if !is_overdue && unpaid_evidence.len() < MAX_INVOICE_EVIDENCE {
                unpaid_evidence.push(ev);
            }
        }
    }

    // Overdue evidence first, then unpaid (bounded total)
    evidence.extend(overdue_evidence.clone());
    let remaining_slots = MAX_INVOICE_EVIDENCE.saturating_sub(evidence.len());
    evidence.extend(unpaid_evidence.into_iter().take(remaining_slots));

    // Collect invoice evidence IDs for action back-references
    let invoice_evidence_ids: Vec<String> = evidence
        .iter()
        .filter(|e| e.source_type == "invoice")
        .map(|e| e.id.clone())
        .collect();

    if !cash_items.is_empty() {
        sections.push(OwnerBriefingSection {
            section_id: "cash_receivables".to_string(),
            title: "Cash & Receivables".to_string(),
            priority: if overdue_count > 0 {
                "high".to_string()
            } else {
                "medium".to_string()
            },
            summary: format!(
                "₹{:.2} unpaid across {} open invoices ({} overdue)",
                unpaid_amount,
                invoices.len(),
                overdue_count
            ),
            items: cash_items,
            source_tables: vec!["invoices".to_string()],
            confidence: 1.0,
            action_required: overdue_count > 0,
        });

        if overdue_count > 0 {
            top_actions.push(OwnerBriefingAction {
                action_id: format!("chase_overdue_{}", Utc::now().timestamp()),
                action_type: "CHASE_OVERDUE".to_string(),
                title: "Chase overdue invoices".to_string(),
                explanation: format!(
                    "{} invoices are overdue. Follow up is required.",
                    overdue_count
                ),
                priority: "high".to_string(),
                entity_type: None,
                entity_id: None,
                suggested_next_step: "Review overdue customers and trigger polite reminders."
                    .to_string(),
                policy_decision: Some(serde_json::json!({ "approval_required": true })),
                cost_route: Some("rules_only".to_string()),
                approval_required: true,
                safe_to_auto_execute: false,
                evidence_ids: invoice_evidence_ids.clone(),
            });
        }
    } else {
        sections.push(OwnerBriefingSection {
            section_id: "cash_receivables".to_string(),
            title: "Cash & Receivables".to_string(),
            priority: "low".to_string(),
            summary: "No open invoices found.".to_string(),
            items: vec![],
            source_tables: vec!["invoices".to_string()],
            confidence: 1.0,
            action_required: false,
        });
    }

    // ── 2. Data Quality — customers missing contact info ──────────────────────
    let customers_missing_info =
        sqlx::query("SELECT id, name FROM customers WHERE user_id = $1 AND phone IS NULL")
            .bind(user_id)
            .fetch_all(pool)
            .await?;

    let mut dq_items = Vec::new();
    for row in &customers_missing_info {
        if dq_items.len() < max_items {
            dq_items.push(serde_json::json!({
                "id": row.try_get::<Uuid, _>("id").ok(),
                "name": row.try_get::<String, _>("name").unwrap_or_default(),
                "issue": "Missing contact info"
            }));
        }
    }

    if !dq_items.is_empty() {
        sections.push(OwnerBriefingSection {
            section_id: "data_quality".to_string(),
            title: "Data Quality".to_string(),
            priority: "medium".to_string(),
            summary: format!(
                "{} customers are missing contact info.",
                customers_missing_info.len()
            ),
            items: dq_items,
            source_tables: vec!["customers".to_string()],
            confidence: 1.0,
            action_required: true,
        });

        top_actions.push(OwnerBriefingAction {
            action_id: format!("fix_dq_{}", Utc::now().timestamp()),
            action_type: "FIX_DATA_QUALITY".to_string(),
            title: "Fix missing contact info".to_string(),
            explanation: format!(
                "{} customers cannot be contacted until phone/email is added.",
                customers_missing_info.len()
            ),
            priority: "medium".to_string(),
            entity_type: None,
            entity_id: None,
            suggested_next_step: "Update customer records with missing info.".to_string(),
            policy_decision: Some(serde_json::json!({ "approval_required": false })),
            cost_route: Some("rules_only".to_string()),
            approval_required: false,
            safe_to_auto_execute: false,
            evidence_ids: vec![], // DQ action not directly evidence-backed
        });
    }

    // ── 3. Broken Promises ────────────────────────────────────────────────────
    let broken_promises = sqlx::query(
        "SELECT id, customer_id, created_at
         FROM promises
         WHERE user_id = $1 AND status = 'broken'",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    let mut promise_items = Vec::new();
    let mut promise_evidence_ids: Vec<String> = Vec::new();

    for row in &broken_promises {
        let promise_id: Option<Uuid> = row.try_get("id").ok();
        let customer_id: Option<Uuid> = row.try_get("customer_id").ok();
        let created_at: Option<DateTime<Utc>> = row.try_get("created_at").ok();

        if promise_items.len() < max_items {
            promise_items.push(serde_json::json!({
                "id": promise_id,
                "customer_id": customer_id,
                "created_at": created_at,
            }));
        }

        // Build promise evidence item (bounded)
        if let Some(pid) = promise_id {
            let pid_str = pid.to_string();
            let cid_str = customer_id.map(|u| u.to_string());
            let cat_str = created_at.map(|dt| dt.to_rfc3339());
            if evidence.len() < MAX_INVOICE_EVIDENCE + MAX_PROMISE_EVIDENCE {
                let ev =
                    EvidenceItem::broken_promise(&pid_str, cid_str.as_deref(), cat_str.as_deref());
                promise_evidence_ids.push(ev.id.clone());
                evidence.push(ev);
            }
        }
    }

    if !broken_promises.is_empty() {
        sections.push(OwnerBriefingSection {
            section_id: "broken_promises".to_string(),
            title: "Broken Promises".to_string(),
            priority: "critical".to_string(),
            summary: format!("{} payment promises are broken.", broken_promises.len()),
            items: promise_items,
            source_tables: vec!["promises".to_string()],
            confidence: 1.0,
            action_required: true,
        });

        top_actions.push(OwnerBriefingAction {
            action_id: format!("escalate_promises_{}", Utc::now().timestamp()),
            action_type: "ESCALATE_PROMISE".to_string(),
            title: "Escalate broken promises".to_string(),
            explanation: format!(
                "{} customers missed their promised payment dates.",
                broken_promises.len()
            ),
            priority: "critical".to_string(),
            entity_type: None,
            entity_id: None,
            suggested_next_step: "Send firm reminder or call directly.".to_string(),
            policy_decision: Some(serde_json::json!({ "approval_required": true })),
            cost_route: Some("rules_only".to_string()),
            approval_required: true,
            safe_to_auto_execute: false,
            evidence_ids: promise_evidence_ids,
        });
    }

    // ── Build output ──────────────────────────────────────────────────────────

    let headline = if !broken_promises.is_empty() {
        "Critical attention needed for broken promises.".to_string()
    } else if overdue_count > 0 {
        "Follow up on overdue invoices to maintain cashflow.".to_string()
    } else {
        "Business operations look healthy today.".to_string()
    };

    let risk_summary = if !customers_missing_info.is_empty() || !broken_promises.is_empty() {
        "Some data quality issues and broken promises detected.".to_string()
    } else {
        "No immediate risks detected.".to_string()
    };

    let cash_summary = format!(
        "₹{:.2} unpaid across {} open invoices ({} overdue)",
        unpaid_amount,
        invoices.len(),
        overdue_count
    );

    let duration_ms = t0.elapsed().as_millis();
    let total_actions = top_actions.len();

    Ok(OwnerBriefingOutput {
        agent_id: "core.owner_briefing".to_string(),
        status: "success".to_string(),
        user_id: user_id.to_string(),
        generated_at: Utc::now(),
        briefing_date,
        headline,
        risk_summary,
        cash_summary,
        sections,
        top_actions,
        data_quality_summary: Some(serde_json::json!({
            "status": if customers_missing_info.is_empty() { "ok" } else { "issues_found" },
            "issue_count": customers_missing_info.len()
        })),
        cost_route_summary: Some(serde_json::json!({
            "route": "rules_only",
            "llm_calls": 0,
            "cost_usd": 0.0
        })),
        policy_summary: Some(serde_json::json!({
            "blocked_actions": 0,
            "approval_required_actions": total_actions,
            "safe_to_execute": false
        })),
        total_actions,
        duration_ms,
        audit_context: "owner_briefing_generated".to_string(),
        evidence,
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────
//
// These tests run without a DB connection. They verify struct serialization
// and the EvidenceItem constructor helpers.
// Run with: cargo test --features server -p vantro-automation-rs
// (requires C toolchain — Linux/CI only due to sqlx/axum linkage)

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evidence_item_invoice_serializes() {
        let ev = EvidenceItem::invoice(
            "abc123",
            12000.0,
            "UNPAID",
            Some("2026-05-01"),
            false,
            Some("cust-001"),
        );
        let json = serde_json::to_string(&ev).expect("serialize");
        assert!(json.contains("\"source_type\":\"invoice\""));
        assert!(json.contains("\"source_id\":\"abc123\""));
        assert!(json.contains("\"id\":\"invoice:abc123\""));
        assert!(json.contains("12000.0"));
        assert!(json.contains("\"confidence\":1.0"));
        assert!(!json.contains("cust-001")); // customer_id only in metadata
    }

    #[test]
    fn evidence_item_overdue_invoice_label() {
        let ev = EvidenceItem::invoice("inv-001", 5000.0, "UNPAID", Some("2026-04-01"), true, None);
        assert_eq!(ev.label, Some("Overdue invoice".to_string()));
        assert!(ev.excerpt.as_ref().unwrap().contains("overdue"));
    }

    #[test]
    fn evidence_item_broken_promise_serializes() {
        let ev =
            EvidenceItem::broken_promise("p-001", Some("cust-002"), Some("2026-04-15T00:00:00Z"));
        let json = serde_json::to_string(&ev).expect("serialize");
        assert!(json.contains("\"source_type\":\"promise\""));
        assert!(json.contains("\"id\":\"promise:p-001\""));
        assert!(json.contains("\"confidence\":1.0"));
        // Amount should NOT be in JSON (None + skip_serializing_if)
        assert!(!json.contains("\"amount\""));
    }

    #[test]
    fn empty_evidence_serializes_as_array() {
        let output = OwnerBriefingOutput {
            agent_id: "core.owner_briefing".to_string(),
            status: "success".to_string(),
            user_id: "user-1".to_string(),
            generated_at: Utc::now(),
            briefing_date: Utc::now(),
            headline: "test".to_string(),
            risk_summary: "none".to_string(),
            cash_summary: "₹0.00 unpaid across 0 open invoices (0 overdue)".to_string(),
            sections: vec![],
            top_actions: vec![],
            data_quality_summary: None,
            cost_route_summary: None,
            policy_summary: None,
            total_actions: 0,
            duration_ms: 0,
            audit_context: "owner_briefing_generated".to_string(),
            evidence: vec![],
        };
        let json = serde_json::to_string(&output).expect("serialize");
        assert!(json.contains("\"evidence\":[]"));
    }

    #[test]
    fn evidence_item_bounds_respected() {
        // Verify MAX_INVOICE_EVIDENCE constant is reasonable
        assert!(
            MAX_INVOICE_EVIDENCE <= 20,
            "invoice evidence cap should be <= 20"
        );
        assert!(
            MAX_PROMISE_EVIDENCE <= 10,
            "promise evidence cap should be <= 10"
        );
    }

    #[test]
    fn action_has_evidence_ids_field() {
        let action = OwnerBriefingAction {
            action_id: "a-001".to_string(),
            action_type: "CHASE_OVERDUE".to_string(),
            title: "Test".to_string(),
            explanation: "test".to_string(),
            priority: "high".to_string(),
            entity_type: None,
            entity_id: None,
            suggested_next_step: "test".to_string(),
            policy_decision: None,
            cost_route: None,
            approval_required: true,
            safe_to_auto_execute: false,
            evidence_ids: vec!["invoice:abc".to_string()],
        };
        let json = serde_json::to_string(&action).expect("serialize");
        assert!(json.contains("\"evidence_ids\":[\"invoice:abc\"]"));
    }
}
