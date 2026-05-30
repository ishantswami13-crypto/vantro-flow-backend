//! Vantro ASI -- Agent Mesh schema types.
//!
//! Pure compile-time data. There is NO runtime execution here: this module
//! only DESCRIBES agents (mission, inputs, tools, risk, approval, policy,
//! audit, success metric, cost budget, harness scenarios). An agent may only
//! ever run once its harness scenarios pass and its runtime is enabled behind
//! a per-agent feature flag -- neither of which exists yet.

use serde::{Deserialize, Serialize};

/// How dangerous an agent's actions are if it misbehaves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    /// Read-only / internal advisory. Cannot move money or message customers.
    Low,
    /// Internal writes or recommendations that influence decisions.
    Medium,
    /// Touches money, credit, or the customer relationship.
    High,
    /// System guardrail or irreversible-impact class.
    Critical,
}

impl RiskLevel {
    /// High and Critical agents are "risky" and must require approval.
    pub const fn is_risky(&self) -> bool {
        matches!(self, RiskLevel::High | RiskLevel::Critical)
    }
}

/// When owner approval is required before an agent action takes effect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalRule {
    /// Fully autonomous: safe, internal, reversible.
    NoneRequired,
    /// Owner must approve before ANY external send (WhatsApp/SMS/call/email).
    OwnerForExternalAction,
    /// Owner must approve before a credit hold / stop-credit recommendation.
    OwnerForCreditHold,
    /// Owner must approve before reordering / scheduling a payable.
    OwnerForPayment,
    /// Owner must approve any High/Critical-risk action.
    OwnerForHighRisk,
    /// Owner must approve every action this agent proposes.
    OwnerAlways,
}

impl ApprovalRule {
    pub const fn requires_approval(&self) -> bool {
        !matches!(self, ApprovalRule::NoneRequired)
    }
}

/// Per-run cost ceiling and routing preference for the Cortex Cost Engine.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CostBudget {
    /// Hard ceiling for one agent run, in USD. 0.0 == must be rules-only.
    pub max_usd_per_run: f64,
    /// Prefer deterministic rules over an LLM call when both are viable.
    pub prefer_rules_over_llm: bool,
}

/// The full, declarative specification of a single agent.
///
/// All fields are `&'static` so the entire registry is a compile-time constant
/// with zero allocation -- it cannot drift at runtime.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct AgentSpec {
    pub agent_id: &'static str,
    pub name: &'static str,
    pub mission: &'static str,
    pub inputs: &'static [&'static str],
    pub tools: &'static [&'static str],
    pub output_schema: &'static str,
    pub risk_level: RiskLevel,
    /// One or more approval conditions. An empty list is INVALID for any agent
    /// that can execute an external action (enforced by registry tests).
    pub approval_rules: &'static [ApprovalRule],
    pub policy_rules: &'static [&'static str],
    pub audit_events: &'static [&'static str],
    pub success_metric: &'static str,
    pub cost_budget: CostBudget,
    pub harness_scenarios: &'static [&'static str],
    /// True only if the agent can send something OUTSIDE the system (a message,
    /// a call) or move money. Such agents MUST have policy + approval.
    pub can_execute_external: bool,
}

impl AgentSpec {
    /// True if any approval rule on this agent requires owner approval.
    pub fn requires_any_approval(&self) -> bool {
        self.approval_rules.iter().any(|r| r.requires_approval())
    }
}
