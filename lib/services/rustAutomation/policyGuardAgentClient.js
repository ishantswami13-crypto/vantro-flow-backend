// FILE: lib/services/rustAutomation/policyGuardAgentClient.js
// HTTP client for the core.policy_guard agent endpoint on the Rust sidecar.
//
// Architecture:
//   Node POST /api/agents/core.policy_guard/evaluate
//     -> POST RUST_AUTOMATION_BASE_URL/api/v2/agents/core.policy_guard/evaluate
//     -> pure policy evaluation (read-only, no DB queries, no mutations)
//
// FAIL-CLOSED CONTRACT (opposite of data_quality which returns null on failure):
//   If the Rust sidecar is unavailable for ANY reason, this client returns a
//   BLOCKED decision with block_reason='POLICY_GUARD_UNAVAILABLE'. Never returns
//   allowed=true when the guard cannot be consulted.
//
// Fallback codes (9 total):
//   1. FEATURE_POLICY_GUARD_AGENT_ENABLED=false  -> disabled_fallback          -> blocked (POLICY_GUARD_UNAVAILABLE)
//   2. RUST_AUTOMATION_BASE_URL missing           -> missing_base_url_fallback  -> blocked
//   3. Connection refused / DNS fail              -> connection_failed_fallback -> blocked
//   4. Request timeout (8s)                       -> timeout_fallback           -> blocked
//   5. HTTP non-2xx                               -> http_error_fallback        -> blocked
//   6. Body is not valid JSON                     -> invalid_json_fallback      -> blocked
//   7. JSON does not match expected shape         -> invalid_schema_fallback    -> blocked
//   8. Valid response — decision is blocked       -> success_blocked            -> blocked (from Rust)
//   9. Valid response — decision is allowed       -> success_allowed            -> allowed (approval_required enforced)
//
// Never throws. Never logs raw payload, token, or JWT.

'use strict';

const { isEnabled } = require('../../featureFlags');
const { safeLog }   = require('../../observability/logger');

const TIMEOUT_MS = 8_000;
const PATH       = '/api/v2/agents/core.policy_guard/evaluate';

const LOG = Object.freeze({
  DISABLED:          'policy_guard_disabled_fallback',
  MISSING_BASE_URL:  'policy_guard_missing_base_url_fallback',
  CONNECTION_FAILED: 'policy_guard_connection_failed_fallback',
  TIMEOUT:           'policy_guard_timeout_fallback',
  HTTP_ERROR:        'policy_guard_http_error_fallback',
  INVALID_JSON:      'policy_guard_invalid_json_fallback',
  INVALID_SCHEMA:    'policy_guard_invalid_schema_fallback',
  SUCCESS_BLOCKED:   'policy_guard_success_blocked',
  SUCCESS_ALLOWED:   'policy_guard_success_allowed',
});

// Returned whenever the guard cannot be consulted — fail closed.
const UNAVAILABLE_DECISION = Object.freeze({
  success:            false,
  agentId:            'core.policy_guard',
  status:             'unavailable',
  decision: Object.freeze({
    allowed:           false,
    blocked:           true,
    approvalRequired:  true,
    safeToAutoExecute: false,
    blockReason:       'POLICY_GUARD_UNAVAILABLE',
    reasons:           ['Policy guard sidecar could not be reached'],
    riskLevel:         'blocked',
  }),
  checksRun:          0,
  durationMs:         0,
  auditEvent:         'policy_guard_evaluate',
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
  // Accept both snake_case and camelCase per Rust API convention.
  const agentId = json.agent_id ?? json.agentId;
  const status  = json.status;
  if (typeof agentId !== 'string')     return 'missing agent_id / agentId';
  if (typeof status  !== 'string')     return 'missing status';
  if (!isObject(json.decision))        return 'missing decision object';
  const d = json.decision;
  // decision fields — Rust returns camelCase
  const allowed  = d.allowed  ?? d.allowed;
  const blocked  = d.blocked  ?? d.blocked;
  const approval = d.approvalRequired ?? d.approval_required;
  if (typeof allowed  !== 'boolean') return 'decision.allowed must be boolean';
  if (typeof blocked  !== 'boolean') return 'decision.blocked must be boolean';
  if (typeof approval !== 'boolean') return 'decision.approvalRequired must be boolean';
  return null;
}

/**
 * POST /api/v2/agents/core.policy_guard/evaluate on the Rust sidecar.
 *
 * Returns the parsed JSON decision on success.
 * Returns UNAVAILABLE_DECISION on ANY failure — fail-closed, never allowed=true.
 *
 * @param {object} body    PolicyGuardInput fields (proposed_action_type, proposed_text, etc.)
 * @param {string} token   JWT bearer token (forwarded to Rust for auth)
 * @returns {Promise<object>}  Always returns an object — never null, never throws.
 */
async function evaluatePolicyGuardRust(body, token) {
  // ── 1. Flag disabled ────────────────────────────────────────────────────────
  if (!isEnabled('policy_guard_agent_enabled')) {
    safeLog('debug', '[PolicyGuardAgent] fallback', { code: LOG.DISABLED });
    return UNAVAILABLE_DECISION;
  }

  // ── 2. Missing base URL ──────────────────────────────────────────────────────
  const base = process.env.RUST_AUTOMATION_BASE_URL;
  if (!base) {
    safeLog('warn', '[PolicyGuardAgent] fallback', { code: LOG.MISSING_BASE_URL });
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
    safeLog('warn', '[PolicyGuardAgent] fallback', {
      code,
      ...(code === LOG.TIMEOUT
        ? { timeout_ms: TIMEOUT_MS }
        : { error: err.message }),
    });
    return UNAVAILABLE_DECISION;
  } finally {
    clearTimeout(timer);
  }

  // ── 5. HTTP error ──────────────────────────────────────────────────────────────
  if (!res.ok) {
    safeLog('warn', '[PolicyGuardAgent] fallback', {
      code:   LOG.HTTP_ERROR,
      status: res.status,
    });
    try { await res.text(); } catch { /* drain */ }
    return UNAVAILABLE_DECISION;
  }

  // ── 6. Invalid JSON ────────────────────────────────────────────────────────────
  let json;
  try {
    json = await res.json();
  } catch (err) {
    safeLog('warn', '[PolicyGuardAgent] fallback', {
      code:  LOG.INVALID_JSON,
      error: err.message,
    });
    return UNAVAILABLE_DECISION;
  }

  // ── 7. Invalid schema ──────────────────────────────────────────────────────────
  if (!isObject(json)) {
    safeLog('warn', '[PolicyGuardAgent] fallback', {
      code:   LOG.INVALID_SCHEMA,
      reason: 'response is not a plain object',
    });
    return UNAVAILABLE_DECISION;
  }
  const schemaError = validateShape(json);
  if (schemaError) {
    safeLog('warn', '[PolicyGuardAgent] fallback', {
      code:   LOG.INVALID_SCHEMA,
      reason: schemaError,
    });
    return UNAVAILABLE_DECISION;
  }

  // ── 8 & 9. Success ─────────────────────────────────────────────────────────────
  const isBlocked = json.decision?.blocked === true;
  safeLog('info', '[PolicyGuardAgent] success', {
    code:    isBlocked ? LOG.SUCCESS_BLOCKED : LOG.SUCCESS_ALLOWED,
    blocked: isBlocked,
  });
  return json;
}

module.exports = { evaluatePolicyGuardRust, UNAVAILABLE_DECISION };
