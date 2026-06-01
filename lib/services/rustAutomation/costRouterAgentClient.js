// FILE: lib/services/rustAutomation/costRouterAgentClient.js
// HTTP client for the core.cost_router agent endpoint on the Rust sidecar.
//
// Architecture:
//   Node POST /api/agents/core.cost_router/evaluate
//     -> POST RUST_AUTOMATION_BASE_URL/api/v2/agents/core.cost_router/evaluate
//     -> pure routing decision (read-only, no DB queries, no mutations, no LLM)
//
// CONSERVATIVE FALLBACK CONTRACT:
//   If the Rust sidecar is unavailable for ANY reason, this client returns
//   route='require_approval' — conservative but not a hard block. The caller
//   still sees approval_required=true and safe_to_execute=false so no action
//   auto-executes.
//
// Fallback codes (9 total):
//   1. FEATURE_COST_ROUTER_AGENT_ENABLED=false  -> disabled_fallback          -> require_approval
//   2. RUST_AUTOMATION_BASE_URL missing          -> missing_base_url_fallback  -> require_approval
//   3. Connection refused / DNS fail             -> connection_failed_fallback -> require_approval
//   4. Request timeout (8s)                      -> timeout_fallback           -> require_approval
//   5. HTTP non-2xx                              -> http_error_fallback        -> require_approval
//   6. Body is not valid JSON                    -> invalid_json_fallback      -> require_approval
//   7. JSON does not match expected shape        -> invalid_schema_fallback    -> require_approval
//   8. Valid response — route is block           -> success_block              -> block (from Rust)
//   9. Valid response — any other route          -> success_route              -> route from Rust
//
// Never throws. Never logs raw payload, token, or JWT.

'use strict';

const { isEnabled } = require('../../featureFlags');
const { safeLog }   = require('../../observability/logger');

const TIMEOUT_MS = 8_000;
const PATH       = '/api/v2/agents/core.cost_router/evaluate';

const LOG = Object.freeze({
  DISABLED:          'cost_router_disabled_fallback',
  MISSING_BASE_URL:  'cost_router_missing_base_url_fallback',
  CONNECTION_FAILED: 'cost_router_connection_failed_fallback',
  TIMEOUT:           'cost_router_timeout_fallback',
  HTTP_ERROR:        'cost_router_http_error_fallback',
  INVALID_JSON:      'cost_router_invalid_json_fallback',
  INVALID_SCHEMA:    'cost_router_invalid_schema_fallback',
  SUCCESS_BLOCK:     'cost_router_success_block',
  SUCCESS_ROUTE:     'cost_router_success_route',
});

// Returned whenever the router cannot be consulted — conservative fallback.
// require_approval keeps the human in the loop without hard-blocking.
const UNAVAILABLE_DECISION = Object.freeze({
  success:          false,
  agentId:          'core.cost_router',
  status:           'unavailable',
  route:            'require_approval',
  modelTier:        'none',
  reasonCodes:      ['COST_ROUTER_UNAVAILABLE'],
  estimatedCostUsd: 0,
  maxTokenBudget:   0,
  approvalRequired: true,
  policyRequired:   true,
  safeToExecute:    false,
  checksRun:        0,
  durationMs:       0,
  auditEvent:       'cost_router_evaluate',
});

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function classifyNetworkError(err) {
  if (err && err.name === 'AbortError') return LOG.TIMEOUT;
  const code = (err && err.cause && err.cause.code) || (err && err.code);
  if (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND'    ||
    code === 'ECONNRESET'   ||
    code === 'EAI_AGAIN'
  ) {
    return LOG.CONNECTION_FAILED;
  }
  return LOG.CONNECTION_FAILED;
}

function validateShape(json) {
  const agentId = json.agent_id ?? json.agentId;
  const status  = json.status;
  const route   = json.route;
  if (typeof agentId !== 'string') return 'missing agent_id / agentId';
  if (typeof status  !== 'string') return 'missing status';
  if (typeof route   !== 'string') return 'missing route';
  const approval = json.approvalRequired ?? json.approval_required;
  if (typeof approval !== 'boolean') return 'approvalRequired must be boolean';
  return null;
}

/**
 * POST /api/v2/agents/core.cost_router/evaluate on the Rust sidecar.
 *
 * Returns the parsed JSON decision on success.
 * Returns UNAVAILABLE_DECISION on ANY failure — conservative require_approval.
 *
 * @param {object} body    CostRouterInput fields (task_type, risk_level, etc.)
 * @param {string} token   JWT bearer token (forwarded to Rust for auth)
 * @returns {Promise<object>}  Always returns an object — never null, never throws.
 */
async function evaluateCostRouterRust(body, token) {
  // ── 1. Flag disabled ────────────────────────────────────────────────────────
  if (!isEnabled('cost_router_agent_enabled')) {
    safeLog('debug', '[CostRouterAgent] fallback', { code: LOG.DISABLED });
    return UNAVAILABLE_DECISION;
  }

  // ── 2. Missing base URL ──────────────────────────────────────────────────────
  const base = process.env.RUST_AUTOMATION_BASE_URL;
  if (!base) {
    safeLog('warn', '[CostRouterAgent] fallback', { code: LOG.MISSING_BASE_URL });
    return UNAVAILABLE_DECISION;
  }

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${base}${PATH}`, {
      method:  'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'authorization': `Bearer ${token}` } : {}),
      },
      body:   JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
  } catch (err) {
    // ── 3 & 4. Connection failed or timeout ────────────────────────────────────
    const code = classifyNetworkError(err);
    safeLog('warn', '[CostRouterAgent] fallback', {
      code,
      ...(code === LOG.TIMEOUT
        ? { timeout_ms: TIMEOUT_MS }
        : { error: err.message }),
    });
    return UNAVAILABLE_DECISION;
  } finally {
    clearTimeout(timer);
  }

  // ── 5. HTTP error ────────────────────────────────────────────────────────────
  if (!res.ok) {
    safeLog('warn', '[CostRouterAgent] fallback', {
      code:   LOG.HTTP_ERROR,
      status: res.status,
    });
    try { await res.text(); } catch { /* drain */ }
    return UNAVAILABLE_DECISION;
  }

  // ── 6. Invalid JSON ──────────────────────────────────────────────────────────
  let json;
  try {
    json = await res.json();
  } catch (err) {
    safeLog('warn', '[CostRouterAgent] fallback', {
      code:  LOG.INVALID_JSON,
      error: err.message,
    });
    return UNAVAILABLE_DECISION;
  }

  // ── 7. Invalid schema ────────────────────────────────────────────────────────
  if (!isObject(json)) {
    safeLog('warn', '[CostRouterAgent] fallback', {
      code:   LOG.INVALID_SCHEMA,
      reason: 'response is not a plain object',
    });
    return UNAVAILABLE_DECISION;
  }
  const schemaError = validateShape(json);
  if (schemaError) {
    safeLog('warn', '[CostRouterAgent] fallback', {
      code:   LOG.INVALID_SCHEMA,
      reason: schemaError,
    });
    return UNAVAILABLE_DECISION;
  }

  // ── 8 & 9. Success ───────────────────────────────────────────────────────────
  const route = json.route ?? 'require_approval';
  safeLog('info', '[CostRouterAgent] success', {
    code:  route === 'block' ? LOG.SUCCESS_BLOCK : LOG.SUCCESS_ROUTE,
    route,
  });
  return json;
}

module.exports = { evaluateCostRouterRust, UNAVAILABLE_DECISION };
