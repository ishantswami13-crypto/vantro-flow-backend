// FILE: vantro-automation-rs/src/events/types.rs

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EventType {
    SaleCreated,
    PaymentReceived,
    PromiseBroken,
    LowStockDetected,
    CustomerRiskUpdated,
    AiActionApproved,
    CashflowUpdated,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BusinessEvent {
    pub event_type: EventType,
    pub user_id: Uuid,
    pub entity_type: Option<String>,
    pub entity_id: Option<String>,
    pub payload: serde_json::Value,
    pub occurred_at: DateTime<Utc>,
}
