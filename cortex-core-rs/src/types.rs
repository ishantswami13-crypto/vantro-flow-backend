// FILE: cortex-core-rs/src/types.rs
// All serde-deserializable input types and serializable output types.
// Every field uses f64 for amounts (INR can be fractional paise) and u32 for counts.

use serde::{Deserialize, Serialize};

// ─── Shared output ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

impl RiskLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            RiskLevel::Low      => "low",
            RiskLevel::Medium   => "medium",
            RiskLevel::High     => "high",
            RiskLevel::Critical => "critical",
        }
    }
    pub fn from_score(score: u8) -> Self {
        match score {
            0..=30   => RiskLevel::Low,
            31..=60  => RiskLevel::Medium,
            61..=80  => RiskLevel::High,
            _        => RiskLevel::Critical,
        }
    }
}

// ─── Scoring inputs ─────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CustomerMetrics {
    /// Total amount currently overdue (INR)
    pub total_overdue:          f64,
    /// Maximum single invoice overdue days
    pub max_delay_days:         f64,
    /// Average overdue days across all overdue invoices
    pub avg_delay_days:         f64,
    /// Number of broken promises
    pub broken_promises:        u32,
    /// Number of kept promises
    pub kept_promises:          u32,
    /// Total number of calls made to customer
    pub calls_total:            u32,
    /// Number of calls the customer picked up
    pub calls_picked:           u32,
}

#[derive(Debug, Serialize)]
pub struct ScoreResult {
    pub success:                bool,
    pub credit_risk_score:      u8,
    pub collection_priority:    u8,
    pub promise_reliability:    u8,
    pub recovery_probability:   u8,
    pub risk_level:             RiskLevel,
    pub reasons:                Vec<String>,
    pub score_reason:           String,
}

// ─── Credit-sale simulation ─────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreditSaleSimulationInput {
    pub customer_id:            String,
    /// Amount of the new proposed credit sale
    pub new_sale_amount:        f64,
    /// Current total outstanding (before this sale)
    pub current_outstanding:    f64,
    /// Portion of outstanding that is currently overdue
    pub overdue_amount:         f64,
    /// Number of broken promises historically
    pub broken_promises:        u32,
    /// Average days delay on payments
    pub average_delay_days:     f64,
    /// Customer credit limit set by owner (0 = no limit)
    pub credit_limit:           f64,
}

#[derive(Debug, Serialize)]
pub struct SimulationResult {
    pub success:            bool,
    pub risk_level:         RiskLevel,
    pub score:              u8,
    pub recommendation:     String,
    pub reasons:            Vec<String>,
    pub approval_required:  bool,
    pub projected_exposure: f64,
    pub limit_headroom:     Option<f64>,
}

// ─── Cashflow simulation ────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CashflowSimulationInput {
    pub expected_inflow_7d:     f64,
    pub expected_outflow_7d:    f64,
    pub current_balance:        f64,
}

#[derive(Debug, Serialize)]
pub struct CashflowSimulationResult {
    pub success:            bool,
    pub gap:                f64,
    pub risk_level:         RiskLevel,
    pub recommendation:     String,
    pub approval_required:  bool,
    pub reasons:            Vec<String>,
}

// ─── Policy evaluation ──────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct PolicyInput {
    pub action_type:            String,
    pub amount:                 Option<f64>,
    pub risk_level:             Option<String>,
    pub recommended_message:    Option<String>,
    /// Whether the caller is already requiring approval
    pub requires_approval:      Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct PolicyDecision {
    pub success:            bool,
    pub allowed:            bool,
    pub blocked:            bool,
    pub requires_approval:  bool,
    pub block_reason:       Option<String>,
    pub reasons:            Vec<String>,
}

// ─── Top-level dispatch ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(tag = "command", content = "payload", rename_all = "snake_case")]
pub enum DispatchInput {
    ScoreCustomer(CustomerMetrics),
    SimulateCreditSale(CreditSaleSimulationInput),
    SimulateCashflowRisk(CashflowSimulationInput),
    EvaluatePolicy(PolicyInput),
    CollectionPriority(CustomerMetrics),
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum DispatchOutput {
    Score(ScoreResult),
    Simulation(SimulationResult),
    CashflowSim(CashflowSimulationResult),
    Policy(PolicyDecision),
    Error(ErrorOutput),
}

#[derive(Debug, Serialize)]
pub struct ErrorOutput {
    pub success:    bool,
    pub error:      String,
}
