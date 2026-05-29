// FILE: lib/featureFlags.js
// Env-driven feature flags for Vantro Cortex.
// All flags default OFF — flip individual flags in Railway env without redeploying logic.
//
// Available flags (set to "true" to enable):
//   FEATURE_CORTEX_ENABLED           — master switch; events + audit + actions pipeline
//   FEATURE_AI_ACTION_CENTER         — show AI Action Center on frontend
//   FEATURE_CUSTOMER_SCORING         — compute and persist customer_scores
//   FEATURE_PROMISE_CHECKER          — daily cron that detects broken promises
//   FEATURE_CASHFLOW_FORECAST        — enhanced cashflow_events population
//   FEATURE_LOW_STOCK_ALERTS         — low stock → ai_actions rule
//   FEATURE_CREDIT_RISK_WARNING      — credit risk → ai_actions rule
//   FEATURE_AI_MESSAGE_DRAFTS        — AI-drafted messages on action cards
//   FEATURE_MEMORY_ENABLED           — business_memory + ai_plans + tool_calls persistence

const FLAGS = {
  cortex_enabled:       process.env.FEATURE_CORTEX_ENABLED         === 'true',
  ai_action_center:     process.env.FEATURE_AI_ACTION_CENTER        === 'true',
  customer_scoring:     process.env.FEATURE_CUSTOMER_SCORING        === 'true',
  promise_checker:      process.env.FEATURE_PROMISE_CHECKER         === 'true',
  cashflow_forecast:    process.env.FEATURE_CASHFLOW_FORECAST       === 'true',
  low_stock_alerts:     process.env.FEATURE_LOW_STOCK_ALERTS        === 'true',
  credit_risk_warning:  process.env.FEATURE_CREDIT_RISK_WARNING     === 'true',
  ai_message_drafts:    process.env.FEATURE_AI_MESSAGE_DRAFTS       === 'true',
  memory_enabled:       process.env.FEATURE_MEMORY_ENABLED          === 'true',
};

function isEnabled(flag) {
  return FLAGS[flag] === true;
}

module.exports = { isEnabled, FLAGS };
