// FILE: vantro-automation-rs/src/api/simulate.rs

use axum::{extract::State, routing::post, Json, Router};
use serde_json::{json, Value};
use std::time::Instant;

use crate::{
    auth::AuthUser,
    cashops::credit_control::{self, CreditControlInput, DisputeStatus},
    cortex::simulator::{self, CreditSaleInput},
    error::AppResult,
    AppState,
};

pub fn routes() -> Router<AppState> {
    Router::new().route(
        "/api/v2/cortex/simulate-credit-sale",
        post(simulate_credit_sale),
    )
}

async fn simulate_credit_sale(
    State(_state): State<AppState>,
    _user: AuthUser,
    Json(req): Json<CreditSaleInput>,
) -> AppResult<Json<Value>> {
    let t0 = Instant::now();
    let sim = simulator::simulate_credit_sale(&req);

    // Also run credit control engine for a second opinion
    let credit = credit_control::evaluate(&CreditControlInput {
        current_outstanding: req.current_outstanding,
        overdue_amount: req.overdue_amount,
        new_sale_amount: req.new_sale_amount,
        credit_limit: req.credit_limit,
        broken_promises: req.broken_promises,
        average_delay_days: req.average_delay_days,
        last_payment_days_ago: None,
        customer_value_inr: 0.0,
        dispute_status: DisputeStatus::None,
        business_cash_pressure: 0.3,
        advance_required: false,
    });

    let elapsed = t0.elapsed().as_millis();
    tracing::info!(customer_id = %req.customer_id, duration_ms = elapsed, "simulate_credit_sale");

    Ok(Json(json!({
        "success":    true,
        "simulation": sim,
        "credit":     credit,
        "durationMs": elapsed,
    })))
}
