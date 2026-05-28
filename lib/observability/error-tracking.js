const crypto = require('crypto');
const { safeLog } = require('./logger');

const ErrorTaxonomy = {
  AUTH_ERROR: 'AUTH_ERROR',
  PERMISSION_ERROR: 'PERMISSION_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMIT_ERROR: 'RATE_LIMIT_ERROR',
  DATABASE_ERROR: 'DATABASE_ERROR',
  CACHE_ERROR: 'CACHE_ERROR',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  WEBHOOK_ERROR: 'WEBHOOK_ERROR',
  PAYMENT_ERROR: 'PAYMENT_ERROR',
  AI_ERROR: 'AI_ERROR',
  FILE_UPLOAD_ERROR: 'FILE_UPLOAD_ERROR',
  OCR_ERROR: 'OCR_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  SERVER_ERROR: 'SERVER_ERROR',
  CLIENT_UI_ERROR: 'CLIENT_UI_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR'
};

function redactSensitiveData(obj) {
  if (!obj) return obj;
  const clone = JSON.parse(JSON.stringify(obj));
  const redactKeys = ['password', 'token', 'jwt', 'cookie', 'secret', 'apikey', 'authorization', 'card', 'cvv'];
  function recurse(o) {
    if (!o) return;
    for (const key in o) {
      if (typeof o[key] === 'object' && o[key] !== null) recurse(o[key]);
      else if (redactKeys.some(rk => key.toLowerCase().includes(rk))) o[key] = '[REDACTED]';
    }
  }
  recurse(clone);
  return clone;
}

function createErrorEvent(params) {
  const {
    req = {},
    err = {},
    source = 'backend',
    type = ErrorTaxonomy.UNKNOWN_ERROR,
    severity = 'error',
    safeMessage = 'An unexpected error occurred.',
    metadata = {}
  } = params;

  const errorId = `ERR_${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  const requestId = req.requestId || crypto.randomUUID();
  const rawStack = err.stack || '';
  const stackHash = rawStack ? crypto.createHash('sha256').update(rawStack).digest('hex').slice(0, 8) : null;
  const userAgent = req.headers ? req.headers['user-agent'] : 'unknown';
  const userAgentHash = userAgent ? crypto.createHash('sha256').update(userAgent).digest('hex').slice(0, 8) : null;

  return {
    error_id: errorId,
    request_id: requestId,
    timestamp: new Date().toISOString(),
    source,
    type,
    severity,
    status_code: params.statusCode || err.statusCode || err.status || 500,
    method: req.method || 'UNKNOWN',
    route: req.originalUrl || req.url || 'UNKNOWN',
    safe_message: safeMessage,
    stack_hash: stackHash,
    user_id: req.user?.userId || req.user?.id || null,
    business_id: req.authContext?.businessId || null,
    user_agent_hash: userAgentHash,
    environment: process.env.NODE_ENV || 'development',
    metadata: redactSensitiveData(metadata)
  };
}

async function logErrorEvent(event, supabase = null) {
  // 1. Emit to JSON logs for Loki / Datadog
  safeLog(event.severity, `[Error Intelligence] ${event.error_id}`, event);

  // 2. Optional: Save to persistent DB for Admin Dashboard
  if (supabase && process.env.ERROR_STORAGE_ENABLED === 'true') {
    try {
      await supabase.from('error_events').insert({
        error_id: event.error_id,
        request_id: event.request_id,
        source: event.source,
        type: event.type,
        severity: event.severity,
        status_code: event.status_code,
        method: event.method,
        route: event.route,
        safe_message: event.safe_message,
        stack_hash: event.stack_hash,
        user_id: event.user_id,
        business_id: event.business_id,
        user_agent_hash: event.user_agent_hash,
        metadata: event.metadata
      });
    } catch (e) {
      safeLog('error', `[Error Intelligence] Failed to save error event to DB: ${e.message}`);
    }
  }

  // 3. Optional: Sentry / OTEL hooks would go here
  if (process.env.SENTRY_DSN) {
    // Sentry.captureException(err, { tags: { error_id: event.error_id }});
  }
}

function safeErrorResponse(res, event) {
  res.status(event.status_code).json({
    success: false,
    error: event.safe_message,
    errorId: event.error_id,
    requestId: event.request_id,
    message: `Something went wrong. Error ID: ${event.error_id}. Please retry.`
  });
}

const SecurityEventTaxonomy = {
  FAILED_LOGIN: 'FAILED_LOGIN',
  INVALID_TOKEN: 'INVALID_TOKEN',
  EXPIRED_TOKEN: 'EXPIRED_TOKEN',
  FORBIDDEN_RESOURCE_ACCESS: 'FORBIDDEN_RESOURCE_ACCESS',
  RATE_LIMIT_HIT: 'RATE_LIMIT_HIT',
  WEBHOOK_SIGNATURE_FAILED: 'WEBHOOK_SIGNATURE_FAILED',
  FILE_UPLOAD_REJECTED: 'FILE_UPLOAD_REJECTED',
  SECRET_SCAN_FAILURE: 'SECRET_SCAN_FAILURE',
  SUSPICIOUS_ROUTE_ACCESS: 'SUSPICIOUS_ROUTE_ACCESS',
  CROSS_USER_ACCESS_ATTEMPT: 'CROSS_USER_ACCESS_ATTEMPT',
  ADMIN_ACTION: 'ADMIN_ACTION'
};

function logSecurityEvent(req, type, details = {}) {
  const event = {
    timestamp: new Date().toISOString(),
    event_type: type,
    request_id: req.requestId || 'unknown',
    user_id: req.user?.userId || null,
    ip_hash: req.ip ? crypto.createHash('sha256').update(req.ip).digest('hex').slice(0, 8) : null,
    route: req.originalUrl,
    details: redactSensitiveData(details)
  };
  safeLog('warn', `[Security Event] ${type}`, event);
}

module.exports = {
  ErrorTaxonomy,
  SecurityEventTaxonomy,
  createErrorEvent,
  logErrorEvent,
  safeErrorResponse,
  logSecurityEvent
};
