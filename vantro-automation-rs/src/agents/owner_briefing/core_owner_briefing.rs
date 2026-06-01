use crate::error::AppResult;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
pub struct OwnerBriefingInput {
    pub briefing_date: Option<DateTime<Utc>>,
    pub include_low_priority: Option<bool>,
    pub max_items_per_section: Option<usize>,
    pub include_data_quality: Option<bool>,
    pub include_policy_preview: Option<bool>,
    pub include_cost_route: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OwnerBriefingAction {
    pub action_id: String,
    pub action_type: String,
    pub title: String,
    pub explanation: String,
    pub priority: String, // "low" | "medium" | "high" | "critical"
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
    pub safe_to_auto_execute: bool, // Hardcoded to false for this phase
}

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
}

pub async fn generate_owner_briefing(
    pool: &PgPool,
    user_id: Uuid,
    input: OwnerBriefingInput,
) -> AppResult<OwnerBriefingOutput> {
    let t0 = std::time::Instant::now();
    let max_items = input.max_items_per_section.unwrap_or(5);
    let briefing_date = input.briefing_date.unwrap_or_else(Utc::now);

    let mut sections = Vec::new();
    let mut top_actions = Vec::new();

    // 1. Cash / Receivables Section
    // Using dynamic sqlx::query to avoid .sqlx cache requirements
    let invoices = sqlx::query(
        "SELECT id, amount, due_date, status, customer_id 
         FROM invoices 
         WHERE user_id = $1 AND status != 'PAID'"
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    let mut unpaid_amount = 0.0;
    let mut overdue_count = 0;
    let mut cash_items = Vec::new();

    for row in &invoices {
        let amount: f64 = row.try_get("amount").unwrap_or(0.0);
        let due_date: Option<DateTime<Utc>> = row.try_get("due_date").ok();
        
        unpaid_amount += amount;
        
        if let Some(due) = due_date {
            if due < briefing_date {
                overdue_count += 1;
            }
        }

        if cash_items.len() < max_items {
            cash_items.push(serde_json::json!({
                "id": row.try_get::<Uuid, _>("id").ok(),
                "amount": amount,
                "due_date": due_date,
                "status": row.try_get::<String, _>("status").unwrap_or_default(),
            }));
        }
    }

    if !cash_items.is_empty() {
        sections.push(OwnerBriefingSection {
            section_id: "cash_receivables".to_string(),
            title: "Cash & Receivables".to_string(),
            priority: if overdue_count > 0 { "high".to_string() } else { "medium".to_string() },
            summary: format!("₹{:.2} unpaid across {} open invoices ({} overdue)", unpaid_amount, invoices.len(), overdue_count),
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
                explanation: format!("{} invoices are overdue. Follow up is required.", overdue_count),
                priority: "high".to_string(),
                entity_type: None,
                entity_id: None,
                suggested_next_step: "Review overdue customers and trigger polite reminders.".to_string(),
                policy_decision: Some(serde_json::json!({ "approval_required": true })),
                cost_route: Some("rules_only".to_string()),
                approval_required: true,
                safe_to_auto_execute: false,
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

    // 2. Data Quality Section
    let customers_missing_info = sqlx::query(
        "SELECT id, name FROM customers WHERE user_id = $1 AND (phone IS NULL OR email IS NULL)"
    )
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
            summary: format!("{} customers are missing contact info.", customers_missing_info.len()),
            items: dq_items,
            source_tables: vec!["customers".to_string()],
            confidence: 1.0,
            action_required: true,
        });

        top_actions.push(OwnerBriefingAction {
            action_id: format!("fix_dq_{}", Utc::now().timestamp()),
            action_type: "FIX_DATA_QUALITY".to_string(),
            title: "Fix missing contact info".to_string(),
            explanation: format!("{} customers cannot be contacted until phone/email is added.", customers_missing_info.len()),
            priority: "medium".to_string(),
            entity_type: None,
            entity_id: None,
            suggested_next_step: "Update customer records with missing info.".to_string(),
            policy_decision: Some(serde_json::json!({ "approval_required": false })),
            cost_route: Some("rules_only".to_string()),
            approval_required: false,
            safe_to_auto_execute: false,
        });
    }

    // 3. Promises Section
    let broken_promises = sqlx::query(
        "SELECT id, customer_id, amount, expected_date 
         FROM promises 
         WHERE user_id = $1 AND expected_date < $2 AND status != 'KEPT'"
    )
    .bind(user_id)
    .bind(briefing_date)
    .fetch_all(pool)
    .await?;

    let mut promise_items = Vec::new();
    for row in &broken_promises {
        if promise_items.len() < max_items {
            promise_items.push(serde_json::json!({
                "id": row.try_get::<Uuid, _>("id").ok(),
                "amount": row.try_get::<f64, _>("amount").unwrap_or(0.0),
                "expected_date": row.try_get::<DateTime<Utc>, _>("expected_date").ok(),
            }));
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
            explanation: format!("{} customers missed their promised payment dates.", broken_promises.len()),
            priority: "critical".to_string(),
            entity_type: None,
            entity_id: None,
            suggested_next_step: "Send firm reminder or call directly.".to_string(),
            policy_decision: Some(serde_json::json!({ "approval_required": true })),
            cost_route: Some("rules_only".to_string()),
            approval_required: true,
            safe_to_auto_execute: false,
        });
    }

    let headline = if broken_promises.len() > 0 {
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

    let cash_summary = format!("₹{:.2} unpaid across {} open invoices ({} overdue)", unpaid_amount, invoices.len(), overdue_count);

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
    })
}
