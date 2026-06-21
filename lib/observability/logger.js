// FILE: lib/observability/logger.js
function safeLog(level, message, metadata = {}) {
  const logData = {
    level,
    timestamp: new Date().toISOString(),
    message,
    ...metadata
  };
  const redacted = JSON.parse(JSON.stringify(logData));
  // NOTE: key-substring match. Do NOT add the bare token 'message' here — it would
  // redact the structural top-level log message. Compound keys (recommended_message)
  // are safe because the structural 'message' key does not include them.
  const redactKeys = [
    'password', 'token', 'jwt', 'cookie', 'secret', 'apikey', 'databaseurl', 'authorization', 'webhooksecret', 'servicerole',
    // Phase 2C.35-P1: PII + sensitive content + raw identifiers
    'phone', 'mobile', 'otp', 'email', 'gstin', 'transcript',
    'recommended_message', 'messagetext', 'message_body', 'msgbody',
    'customer_name', 'customer_id', 'customerid',
    'tenant_id', 'tenantid', 'tenant', 'workspace_id', 'workspaceid', 'workspace',
    'evidence_id', 'evidenceid', 'evidence_source', 'evidencesource',
    'push_subscription', 'subscription',
  ];
  function redactRecursive(obj) {
    if (!obj) return;
    for (const key in obj) {
      if (typeof obj[key] === 'object' && obj[key] !== null) redactRecursive(obj[key]);
      else if (redactKeys.some(rk => key.toLowerCase().includes(rk))) obj[key] = '[REDACTED]';
    }
  }
  redactRecursive(redacted);
  console.log(JSON.stringify(redacted));
}

module.exports = { safeLog };
