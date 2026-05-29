// FILE: lib/featureFlags.js
// Env-driven feature flags for Vantro Cortex.
// Dangerous flags default OFF — flip individual flags in Railway env without redeploying logic.
//
// Available flags (set to "true" to enable; PROMPT_GUARD_ENABLED defaults true):
//   FEATURE_CORTEX_ENABLED                — master switch; events + audit + actions pipeline
//   FEATURE_AI_ACTION_CENTER              — show AI Action Center on frontend
//   FEATURE_CUSTOMER_SCORING              — compute and persist customer_scores
//   FEATURE_PROMISE_CHECKER               — daily cron that detects broken promises
//   FEATURE_CASHFLOW_FORECAST             — enhanced cashflow_events population
//   FEATURE_LOW_STOCK_ALERTS              — low stock → ai_actions rule
//   FEATURE_CREDIT_RISK_WARNING           — credit risk → ai_actions rule
//   FEATURE_AI_MESSAGE_DRAFTS             — AI-drafted messages on action cards
//   FEATURE_MEMORY_ENABLED                — business_memory + ai_plans + tool_calls persistence
//   FEATURE_AGENT_PLANNER_ENABLED         — use real LLM planner (Claude) for plan generation
//   FEATURE_SIMULATION_ENGINE_ENABLED     — run simulation automatically on risky events
//   FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED — gate ALL external (Twilio/WhatsApp) sends. OFF = drafts only.
//   FEATURE_CORTEX_LAB_ENABLED            — expose cortex-lab test scenarios at runtime
//   FEATURE_PROMPT_GUARD_ENABLED          — sanitize all untrusted text before LLM (DEFAULTS ON)
//   FEATURE_LEARNING_LOOP_ENABLED         — evaluationAgent outcomes write back to business_memory
//   FEATURE_WORKFLOW_RUNNER_ENABLED       — workflow_runs durable tracking around scheduled jobs
//   RUST_CORTEX_CORE_ENABLED              — use Rust CLI binary for scoring/simulation/policy (DEFAULTS OFF)
//   RUST_AUTOMATION_API_ENABLED           — use Rust Axum sidecar for bootstrap/CPI/credit-control (DEFAULTS OFF)

const FLAGS = {
  // existing
  cortex_enabled:                  process.env.FEATURE_CORTEX_ENABLED                     === 'true',
  ai_action_center:                process.env.FEATURE_AI_ACTION_CENTER                   === 'true',
  customer_scoring:                process.env.FEATURE_CUSTOMER_SCORING                   === 'true',
  promise_checker:                 process.env.FEATURE_PROMISE_CHECKER                    === 'true',
  cashflow_forecast:               process.env.FEATURE_CASHFLOW_FORECAST                  === 'true',
  low_stock_alerts:                process.env.FEATURE_LOW_STOCK_ALERTS                   === 'true',
  credit_risk_warning:             process.env.FEATURE_CREDIT_RISK_WARNING                === 'true',
  ai_message_drafts:               process.env.FEATURE_AI_MESSAGE_DRAFTS                  === 'true',
  memory_enabled:                  process.env.FEATURE_MEMORY_ENABLED                     === 'true',

  // Cortex X — new, all default OFF except prompt_guard
  agent_planner_enabled:           process.env.FEATURE_AGENT_PLANNER_ENABLED              === 'true',
  simulation_engine_enabled:       process.env.FEATURE_SIMULATION_ENGINE_ENABLED          === 'true',
  external_message_sending_enabled:process.env.FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED   === 'true',
  cortex_lab_enabled:              process.env.FEATURE_CORTEX_LAB_ENABLED                 === 'true',
  // prompt_guard defaults ON — only disable explicitly via "false"
  prompt_guard_enabled:            process.env.FEATURE_PROMPT_GUARD_ENABLED !== 'false',
  learning_loop_enabled:           process.env.FEATURE_LEARNING_LOOP_ENABLED              === 'true',
  workflow_runner_enabled:         process.env.FEATURE_WORKFLOW_RUNNER_ENABLED            === 'true',

  // Rust Cortex Core — deterministic scoring/simulation/policy via CLI binary.
  // MUST stay false until: cargo test passes, parity test passes, harness passes.
  rust_cortex_core_enabled:        process.env.RUST_CORTEX_CORE_ENABLED                   === 'true',

  // Rust Automation RS — Axum HTTP sidecar (port 3002).
  // MUST stay false until: cargo test passes, bootstrap <500ms verified, harness passes.
  rust_automation_api_enabled:     process.env.RUST_AUTOMATION_API_ENABLED                === 'true',
};

function isEnabled(flag) {
  return FLAGS[flag] === true;
}

module.exports = { isEnabled, FLAGS };
