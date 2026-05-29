// FILE: lib/services/rustAutomation/rustAutomationClient.js
// HTTP client for the Vantro Automation RS sidecar service.
//
// Architecture:
//   Node → fetch(RUST_AUTOMATION_BASE_URL/api/v2/...) → Axum → deterministic result
//
// Safety contract:
//   - Feature flag RUST_AUTOMATION_API_ENABLED must be true (default false).
//   - If Rust service is down or flag is off → every function returns null → caller
//     falls through to the existing Node service.
//   - Never throws. Always returns null on any failure.
//   - Auth: forwards the caller's JWT token to Rust.
//   - Timeout: 8s per request (Rust should respond in <500ms, budget for cold start).
//
// Usage pattern in a route handler:
//   const rustResult = await getDashboardBootstrapRust(token);
//   if (rustResult) return res.json(rustResult);
//   // fallback → existing Node handler logic

'use strict';

const { isEnabled } = require('../../featureFlags');
const { safeLog }   = require('../../observability/logger');

const BASE = process.env.RUST_AUTOMATION_BASE_URL || 'http://localhost:3002';
const TIMEOUT_MS = 8_000;

function isRustEnabled() {
  return isEnabled('rust_automation_api_enabled')
      && !!process.env.RUST_AUTOMATION_BASE_URL;
}

async function rustFetch(path, { token, method = 'GET', body } = {}) {
  if (!isRustEnabled()) return null;

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers = { 'content-type': 'application/json' };
    if (token) headers['authorization'] = `Bearer ${token}`;

    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      safeLog('warn', '[RustAutomation] Non-ok response', { path, status: res.status, body: text.slice(0, 200) });
      return null;
    }

    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      safeLog('warn', '[RustAutomation] Request timed out', { path, timeout: TIMEOUT_MS });
    } else {
      safeLog('warn', '[RustAutomation] Request failed', { path, error: err.message });
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * GET /api/v2/dashboard/bootstrap
 * Returns pre-aggregated dashboard KPIs. Served from Rust L1 cache (30s TTL).
 * Falls back to Node's /api/v1/dashboard/bootstrap on null.
 */
async function getDashboardBootstrapRust(token) {
  return rustFetch('/api/v2/dashboard/bootstrap', { token });
}

/**
 * GET /api/v2/collections/bootstrap
 * Returns collections summary. Cached 30s.
 */
async function getCollectionsBootstrapRust(token) {
  return rustFetch('/api/v2/collections/bootstrap', { token });
}

/**
 * POST /api/v2/cortex/score-customer
 * Score a customer using Rust scoring engine.
 * @param {{ customerId: string }} data
 */
async function scoreCustomerRust(token, data) {
  return rustFetch('/api/v2/cortex/score-customer', {
    token, method: 'POST',
    body: { customer_id: data.customerId || data.customer_id },
  });
}

/**
 * POST /api/v2/cortex/calculate-cpi
 * Calculate Collection Priority Index for a customer.
 * @param {{ customerId: string, businessCashPressure?: number }} data
 */
async function calculateCpiRust(token, data) {
  return rustFetch('/api/v2/cortex/calculate-cpi', {
    token, method: 'POST',
    body: {
      customer_id:             data.customerId            || data.customer_id,
      business_cash_pressure:  data.businessCashPressure  ?? data.business_cash_pressure ?? 0.3,
    },
  });
}

/**
 * POST /api/v2/cortex/simulate-credit-sale
 * Simulate credit sale risk. Returns simulation + credit control decisions.
 */
async function simulateCreditSaleRust(token, data) {
  return rustFetch('/api/v2/cortex/simulate-credit-sale', {
    token, method: 'POST',
    body: {
      customer_id:          data.customerId         || data.customer_id         || 'unknown',
      new_sale_amount:      data.newSaleAmount       ?? data.new_sale_amount     ?? 0,
      current_outstanding:  data.currentOutstanding  ?? data.current_outstanding ?? 0,
      overdue_amount:       data.overdueAmount       ?? data.overdue_amount      ?? 0,
      broken_promises:      data.brokenPromises      ?? data.broken_promises     ?? 0,
      average_delay_days:   data.averageDelayDays    ?? data.average_delay_days  ?? 0,
      credit_limit:         data.creditLimit         ?? data.credit_limit        ?? 0,
    },
  });
}

/**
 * POST /api/v2/cortex/evaluate-policy
 * Evaluate whether an action is allowed/blocked/requires approval.
 */
async function evaluatePolicyRust(token, data) {
  return rustFetch('/api/v2/cortex/evaluate-policy', {
    token, method: 'POST',
    body: {
      action_type:          data.actionType         || data.action_type         || '',
      amount:               data.amount             ?? null,
      risk_level:           data.riskLevel          || data.risk_level          || null,
      recommended_message:  data.recommendedMessage || data.recommended_message || null,
      requires_approval:    data.requiresApproval   ?? data.requires_approval   ?? null,
      known_customer_ids:   data.knownCustomerIds   || data.known_customer_ids  || null,
      customer_id:          data.customerId         || data.customer_id         || null,
    },
  });
}

/**
 * POST /api/v2/cortex/cost-route
 * Get AI cost routing recommendation.
 */
async function routeAiTaskRust(token, data) {
  return rustFetch('/api/v2/cortex/cost-route', {
    token, method: 'POST',
    body: {
      task_type:               data.taskType            || data.task_type              || 'rule_evaluation',
      input_tokens_estimate:   data.inputTokensEstimate ?? data.input_tokens_estimate  ?? 100,
      output_tokens_estimate:  data.outputTokensEstimate?? data.output_tokens_estimate ?? 100,
      latency_budget_ms:       data.latencyBudgetMs     ?? data.latency_budget_ms      ?? null,
      accuracy_required:       data.accuracyRequired    || data.accuracy_required      || 'medium',
      is_cacheable:            data.isCacheable         ?? data.is_cacheable           ?? false,
      batch_eligible:          data.batchEligible       ?? data.batch_eligible         ?? false,
    },
  });
}

/**
 * GET /health — verify Rust sidecar is reachable.
 * Returns { ok: true } or null.
 */
async function checkRustHealth() {
  return rustFetch('/health');
}

module.exports = {
  getDashboardBootstrapRust,
  getCollectionsBootstrapRust,
  scoreCustomerRust,
  calculateCpiRust,
  simulateCreditSaleRust,
  evaluatePolicyRust,
  routeAiTaskRust,
  checkRustHealth,
  isRustEnabled,
};
