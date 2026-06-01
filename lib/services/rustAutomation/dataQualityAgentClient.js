// FILE: lib/services/rustAutomation/dataQualityAgentClient.js
// HTTP client for the core.data_quality agent endpoint on the Rust sidecar.
//
// Architecture:
//   Node GET /api/agents/core.data_quality/preview
//     -> POST RUST_AUTOMATION_BASE_URL/api/v2/agents/core.data_quality/evaluate
//     -> pure evaluation (read-only, no DB mutations)
//
// Safety contract (8 fallback codes):
//   1. FEATURE_DATA_QUALITY_AGENT_ENABLED=false     -> disabled_fallback              -> null
//   2. enabled but RUST_AUTOMATION_BASE_URL missing  -> missing_base_url_fallback      -> null
//   3. Connection refused / DNS fail                 -> connection_failed_fallback     -> null
//   4. Request timeout (8s)                          -> timeout_fallback               -> null
//   5. HTTP non-2xx                                  -> http_error_fallback            -> null
//   6. Body is not valid JSON                        -> invalid_json_fallback          -> null
//   7. JSON does not match expected shape            -> invalid_schema_fallback        -> null
//   8. Valid response                                -> success                        -> object
//
// Never throws. Never logs raw payload, token, or JWT.

'use strict';

const { isEnabled } = require('../../featureFlags');
const { safeLog }   = require('../../observability/logger');

const TIMEOUT_MS = 8_000;
const PATH       = '/api/v2/agents/core.data_quality/evaluate';

const LOG = Object.freeze({
  DISABLED:          'data_quality_disabled_fallback',
  MISSING_BASE_URL:  'data_quality_missing_base_url_fallback',
  CONNECTION_FAILED: 'data_quality_connection_failed_fallback',
  TIMEOUT:           'data_quality_timeout_fallback',
  HTTP_ERROR:        'data_quality_http_error_fallback',
  INVALID_JSON:      'data_quality_invalid_json_fallback',
  INVALID_SCHEMA:    'data_quality_invalid_schema_fallback',
  SUCCESS:           'data_quality_success',
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
  if (typeof json.agent_id !== 'string')    return 'missing agent_id';
  if (typeof json.total_findings !== 'number') return 'missing total_findings';
  if (!Array.isArray(json.findings))        return 'missing findings array';
  if (typeof json.status !== 'string')      return 'missing status';
  return null;
}

/**
 * POST /api/v2/agents/core.data_quality/evaluate on the Rust sidecar.
 * Returns the parsed JSON on success, null on any failure mode.
 *
 * @param {string} token  JWT bearer token (forwarded to Rust for auth)
 * @returns {Promise<object|null>}
 */
async function evaluateDataQualityRust(token) {
  // ── 1. Flag disabled ────────────────────────────────────────────────────────
  if (!isEnabled('data_quality_agent_enabled')) {
    safeLog('debug', '[DataQualityAgent] fallback', { code: LOG.DISABLED });
    return null;
  }

  // ── 2. Missing base URL ──────────────────────────────────────────────────────
  const base = process.env.RUST_AUTOMATION_BASE_URL;
  if (!base) {
    safeLog('warn', '[DataQualityAgent] fallback', { code: LOG.MISSING_BASE_URL });
    return null;
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
      body:   '{}',
      signal: ctrl.signal,
    });
  } catch (err) {
    // ── 3 & 4. Connection failed or timeout ────────────────────────────────────
    const code = classifyNetworkError(err);
    safeLog('warn', '[DataQualityAgent] fallback', {
      code,
      ...(code === LOG.TIMEOUT
        ? { timeout_ms: TIMEOUT_MS }
        : { error: err.message }),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }

  // ── 5. HTTP error ──────────────────────────────────────────────────────────────
  if (!res.ok) {
    safeLog('warn', '[DataQualityAgent] fallback', {
      code:   LOG.HTTP_ERROR,
      status: res.status,
    });
    try { await res.text(); } catch { /* drain */ }
    return null;
  }

  // ── 6. Invalid JSON ────────────────────────────────────────────────────────────
  let json;
  try {
    json = await res.json();
  } catch (err) {
    safeLog('warn', '[DataQualityAgent] fallback', {
      code:  LOG.INVALID_JSON,
      error: err.message,
    });
    return null;
  }

  // ── 7. Invalid schema ──────────────────────────────────────────────────────────
  if (!isObject(json)) {
    safeLog('warn', '[DataQualityAgent] fallback', {
      code:   LOG.INVALID_SCHEMA,
      reason: 'response is not a plain object',
    });
    return null;
  }
  const schemaError = validateShape(json);
  if (schemaError) {
    safeLog('warn', '[DataQualityAgent] fallback', {
      code:   LOG.INVALID_SCHEMA,
      reason: schemaError,
    });
    return null;
  }

  // ── 8. Success ─────────────────────────────────────────────────────────────────
  safeLog('info', '[DataQualityAgent] success', { code: LOG.SUCCESS });
  return json;
}

module.exports = { evaluateDataQualityRust };
