//! Vantro ASI -- Agent Mesh.
//!
//! Registry + schema for the 12 specialized agents. This is FOUNDATION ONLY:
//! there is no runtime execution, no orchestration, and no external action
//! here. An agent may only run in the future once (a) its harness scenarios
//! pass and (b) a per-agent runtime feature flag is added. The registry exists
//! so that policy, approval, cost, and audit guarantees are declared and
//! test-enforced BEFORE any agent can act.

pub mod cost_router;
pub mod data_quality;
pub mod owner_briefing;
pub mod policy_guard;
pub mod registry;
pub mod types;

pub use registry::{all, by_id, ALL};
pub use types::{AgentSpec, ApprovalRule, CostBudget, RiskLevel};
