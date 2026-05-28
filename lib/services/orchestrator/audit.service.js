// FILE: lib/services/orchestrator/audit.service.js
// Typed, immutable audit trail for every financial data change.
// audit_logs answers WHO changed WHAT (vs business_events which answers WHAT happened).
// Never throws — audit failures are logged but never crash the request.
const { supabase } = require('../../config/supabaseClient');
const { safeLog } = require('../../observability/logger');

async function log(userId, {
  action,
  entityType = null,
  entityId   = null,
  oldValue   = null,
  newValue   = null,
  ipAddress  = null,
  userAgent  = null,
}) {
  if (!userId || !action) {
    safeLog('warn', '[AuditService] log called without userId or action', { userId, action });
    return;
  }

  try {
    const { error } = await supabase.from('audit_logs').insert([{
      user_id:        userId,
      action,
      entity_type:    entityType,
      entity_id:      entityId ? String(entityId) : null,
      old_value_json: oldValue,
      new_value_json: newValue,
      ip_address:     ipAddress,
      user_agent:     userAgent,
    }]);

    if (error) {
      safeLog('warn', '[AuditService] Failed to write audit log', { error: error.message, action, userId });
    }
  } catch (err) {
    safeLog('error', '[AuditService] Unexpected error', { error: err.message, action, userId });
  }
}

// Convenience: extract ip + ua from an Express request object
function fromRequest(req) {
  return {
    ipAddress: req?.ip || req?.headers?.['x-forwarded-for'] || null,
    userAgent: req?.headers?.['user-agent'] || null,
  };
}

module.exports = { log, fromRequest };
