// FILE: vantro-automation-rs/src/api/data_quality.rs
// POST /api/v2/agents/core.data_quality/evaluate
// Read-only data quality scan for the authenticated user.
//
// Uses dynamic sqlx::query() (non-macro) — SQLX_OFFLINE=true compatible.
// No macros = no .sqlx/ cache update required for Phase 2A.
// All queries are user-scoped (WHERE user_id = $1). No UPDATE/INSERT/DELETE.

use axum::{extract::State, routing::post, Json, Router};
use serde_json::{json, Value};
use sqlx::Row;
use std::time::Instant;
use uuid::Uuid;
use vantro_automation_lib::agents::data_quality::{
    CustomerRow, DataQualityInput, InvoiceRow, PromiseRow, evaluate,
};

use crate::{auth::AuthUser, error::AppResult, AppState};

pub fn routes() -> Router<AppState> {
    Router::new().route(
        "/api/v2/agents/core.data_quality/evaluate",
        post(data_quality_evaluate),
    )
}

async fn data_quality_evaluate(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Value>> {
    let t0 = Instant::now();
    let user_id: Uuid = user.user_id;

    // ── Query invoices — dynamic sqlx (no macro, SQLX_OFFLINE compatible) ─────
    let invoice_rows = sqlx::query(
        "SELECT id, customer_id, \
                invoice_amount::float8 AS invoice_amount, \
                total_amount::float8   AS total_amount, \
                amount_paid::float8    AS amount_paid, \
                payment_status, days_overdue, due_date \
         FROM invoices \
         WHERE user_id = $1 \
         LIMIT 500",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    let invoices: Vec<InvoiceRow> = invoice_rows
        .iter()
        .filter_map(|row| -> Option<InvoiceRow> {
            let id: Uuid = row.try_get("id").ok()?;
            let customer_id: Option<Uuid> = row.try_get("customer_id").unwrap_or(None);
            let invoice_amount: f64 = row.try_get("invoice_amount").unwrap_or(0.0);
            let total_amount: Option<f64> = row.try_get("total_amount").unwrap_or(None);
            let amount_paid: Option<f64> = row.try_get("amount_paid").unwrap_or(None);
            let payment_status: String = row
                .try_get("payment_status")
                .unwrap_or_else(|_| "Unknown".to_string());
            let days_overdue: i32 = row.try_get("days_overdue").unwrap_or(0);
            let due_date: Option<String> = row.try_get("due_date").unwrap_or(None);
            Some(InvoiceRow {
                id,
                customer_id,
                invoice_amount,
                total_amount,
                amount_paid,
                payment_status,
                days_overdue,
                due_date,
            })
        })
        .collect();

    // ── Query customers ────────────────────────────────────────────────────────
    let customer_rows = sqlx::query(
        "SELECT id, name, phone, email \
         FROM customers \
         WHERE user_id = $1 \
         LIMIT 500",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    let customers: Vec<CustomerRow> = customer_rows
        .iter()
        .filter_map(|row| -> Option<CustomerRow> {
            let id: Uuid = row.try_get("id").ok()?;
            let name: String = row.try_get("name").unwrap_or_default();
            let phone: Option<String> = row.try_get("phone").unwrap_or(None);
            let email: Option<String> = row.try_get("email").unwrap_or(None);
            Some(CustomerRow {
                id,
                name,
                phone,
                email,
            })
        })
        .collect();

    // ── Query promises ─────────────────────────────────────────────────────────
    let promise_rows = sqlx::query(
        "SELECT id, customer_id, \
                promised_amount::float8 AS promised_amount, \
                promised_date::text     AS promised_date, \
                status \
         FROM promises \
         WHERE user_id = $1 \
         LIMIT 500",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    let promises: Vec<PromiseRow> = promise_rows
        .iter()
        .filter_map(|row| -> Option<PromiseRow> {
            let id: Uuid = row.try_get("id").ok()?;
            let customer_id: Option<Uuid> = row.try_get("customer_id").unwrap_or(None);
            let promised_amount: Option<f64> = row.try_get("promised_amount").unwrap_or(None);
            let promised_date: Option<String> = row.try_get("promised_date").unwrap_or(None);
            let status: Option<String> = row.try_get("status").unwrap_or(None);
            Some(PromiseRow {
                id,
                customer_id,
                promised_amount,
                promised_date,
                status,
            })
        })
        .collect();

    // ── Evaluate (pure, no DB calls) ───────────────────────────────────────────
    let db_duration_ms = t0.elapsed().as_millis() as u64;
    let result = evaluate(
        &DataQualityInput {
            user_id,
            invoices,
            customers,
            promises,
            max_findings: None,
            include_low_severity: true,
        },
        db_duration_ms,
    );

    tracing::info!(
        user_id = %user_id,
        total_findings = result.total_findings,
        duration_ms = db_duration_ms,
        "data_quality_evaluate"
    );

    Ok(Json(json!({
        "success":               true,
        "agentId":               result.agent_id,
        "status":                result.status,
        "totalFindings":         result.total_findings,
        "findings":              result.findings,
        "summary":               result.summary,
        "durationMs":            result.duration_ms,
        "auditEvent":            result.audit_event,
        "nextRecommendedAction": result.next_recommended_action,
        "checksRun":             result.checks_run,
        "warnings":              result.warnings,
    })))
}
