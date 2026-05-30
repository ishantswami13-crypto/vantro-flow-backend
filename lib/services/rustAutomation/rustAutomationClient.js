// FILE: lib/services/rustAutomation/rustAutomationClient.js
// HTTP client for the Vantro Automation RS sidecar service.
//
// Architecture:
//   Node -> fetch(RUST_AUTOMATION_BASE_URL/api/v2/...) -> Axum -> deterministic result
//
// Safety contract (Node fallback matrix — see scripts/test-rust-automation-fallback.js):
//   1. RUST_AUTOMATION_API_ENABLED=false           -> rust_disabled_fallback           -> null
//   2. enabled but RUST_AUTOMATION_BASE_URL missing-> rust_missing_base_url_fallback   -> null
//   3. Connection refused / DNS fail               -> rust_connection_failed_fallback  -> null
//   4. Request timeout (8s)                        -> rust_timeout_fallback            -> null
//   5. HTTP non-2xx                                -> rust_http_error_fallback         -> null
//   6. Body is not valid JSON                      -> rust_invalid_json_fallback       -> null
//   7. JSON does not match expected shape          -> rust_invalid_schema_fallback     -> null
//   8. Valid response                              -> rust_call_success                -> object
//
//   Every failure mode returns null so the caller falls through to the existing Node
//   service. Never throws. Never logs raw payload, token, or JWT. Auth header is
//   forwarded to Rust but never logged (safeLog redacts 'authorization', 'token',
//   'jwt').
//
// Usage pattern in a route handler:
//   const rustResult = await getDashboardBootstrapRust(token);
//   if (rustResult) return res.json(rustResult);
//   // fallback -> existing Node handler logic

'use strict';

const { isEnabled } = require('../../featureFlags');
const { safeLog }   = require('../../observability/logger');

const TIMEOUT_MS = 8_000;

// Log codes — exported for tests and dashboards.
const LOG_CODES = Object.freeze({
  DISABLED:          'rust_disabled_fallback',
  MISSING_BASE_URL:  'rust_missing_base_url_fallback',
  CONNECTION_FAILED: 'rust_connection_failed_fallback',
  TIMEOUT:           'rust_timeout_fallback',
  HTTP_ERROR:        'rust_http_error_fallback',
  INVALID_JSON:      'rust_invalid_json_fallback',
  INVALID_SCHEMA:    'rust_invalid_schema_fallback',
  SUCCESS:           'rust_call_success',
});

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function classifyNetworkError(err) {
  if (err && err.name === 'AbortError') return LOG_CODES.TIMEOUT;
  // undici-style: top-level TypeError 'fetch failed' with err.cause.code
  const cause = err && err.cause;
  const code = (cause && cause.code) || err.code;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'EAI_AGAIN') {
    return LOG_CODES.CONNECTION_FAILED;
  }
  return LOG_CODES.CONNECTION_FAILED;
}

function isRustEnabled() {
  return isEnabled('rust_automation_api_enabled')
      && !!process.env.RUST_AUTOMATION_BASE_URL;
}

/**
 * Internal fetch wrapper. Returns parsed JSON on success, null on any failure mode.
 * @param {string} path
 * @param {object} opts
 * @param {string} [opts.token]
 * @param {string} [opts.method]
 * @param {*}      [opts.body]
 * @param {(json:any)=>(string|null)} [opts.validate] schema validator; return error string or null
 */
async function rustFetch(path, { token, method = 'GET', body, validate } = {}) {
  // ── 1. Flag disabled ────────────────────────────────────────────────────────
  if (!isEnabled('rust_automation_api_enabled')) {
    safeLog('debug', '[RustAutomation] fallback', { code: LOG_CODES.DISABLED, path });
    return null;
  }

  // ── 2. Missing base URL (flag on but no URL configured) ─────────────────────
  const base = process.env.RUST_AUTOMATION_BASE_URL;
  if (!base) {
    safeLog('warn', '[RustAutomation] fallback', { code: LOG_CODES.MISSING_BASE_URL, path });
    return null;
  }

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    const headers = { 'content-type': 'application/json' };
    if (token) headers['authorization'] = `Bearer ${token}`;

    res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    // ── 3 & 4. Connection failed or timeout ───────────────────────────────────
    const code = classifyNetworkError(err);
    safeLog('warn', '[RustAutomation] fallback', {
      code,
      path,
      ...(code === LOG_CODES.TIMEOUT ? { timeout_ms: TIMEOUT_MS } : { error: err.message }),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }

  // ── 5. HTTP error ─────────────────────────────────────────────────────────────
  if (!res.ok) {
    safeLog('warn', '[RustAutomation] fallback', {
      code: LOG_CODES.HTTP_ERROR,
      path,
      status: res.status,
    });
    // Drain body to free the socket; never log the body.
    try { await res.text(); } catch { /* ignore */ }
    return null;
  }

  // ── 6. Invalid JSON ───────────────────────────────────────────────────────────
  let json;
  try {
    json = await res.json();
  } catch (err) {
    safeLog('warn', '[RustAutomation] fallback', {
      code: LOG_CODES.INVALID_JSON,
      path,
      error: err.message,
    });
    return null;
  }

  // ── 7. Invalid schema ─────────────────────────────────────────────────────────
  if (!isPlainObject(json)) {
    safeLog('warn', '[RustAutomation] fallback', {
      code: LOG_CODES.INVALID_SCHEMA,
      path,
      reason: 'response is not a plain object',
    });
    return null;
  }
  if (typeof validate === 'function') {
    const schemaError = validate(json);
    if (schemaError) {
      safeLog('warn', '[RustAutomation] fallback', {
        code: LOG_CODES.INVALID_SCHEMA,
        path,
        reason: schemaError,
      });
      return null;
    }
  }

  // ── 8. Success ────────────────────────────────────────────────────────────────
  safeLog('info', '[RustAutomation] success', { code: LOG_CODES.SUCCESS, path });
  return json;
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
  // Exposed for the fallback test matrix only:
  __test__: { rustFetch, LOG_CODES, TIMEOUT_MS },
};
