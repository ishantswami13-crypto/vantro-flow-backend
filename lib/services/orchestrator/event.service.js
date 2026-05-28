// FILE: lib/services/orchestrator/event.service.js
// Persists typed business events to the business_events table.
// This is the Cortex event store — the single source of truth for what happened and when.
const { supabase } = require('../../config/supabaseClient');
const { safeLog } = require('../../observability/logger');

// Emit a typed event and persist it to business_events.
// Returns the saved row, or null if persistence fails (never throws — events are fire-and-store).
async function emit(userId, { eventType, entityType = null, entityId = null, actorType = 'user', actorId = null, payload = {} }) {
  if (!userId || !eventType) {
    safeLog('warn', '[EventService] emit called without userId or eventType', { userId, eventType });
    return null;
  }

  try {
    const { data, error } = await supabase.from('business_events').insert([{
      user_id:      userId,
      event_type:   eventType,
      entity_type:  entityType,
      entity_id:    entityId ? String(entityId) : null,
      actor_type:   actorType,
      actor_id:     actorId ? String(actorId) : null,
      payload_json: payload,
    }]).select().single();

    if (error) {
      safeLog('error', '[EventService] Failed to persist business_event', { error: error.message, eventType, userId });
      return null;
    }
    return data;
  } catch (err) {
    safeLog('error', '[EventService] Unexpected error', { error: err.message, eventType, userId });
    return null;
  }
}

// Fetch recent events for a user, optionally filtered by entity.
async function getRecent(userId, { eventType, entityType, entityId, limit = 50 } = {}) {
  let q = supabase.from('business_events').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
  if (eventType)  q = q.eq('event_type',  eventType);
  if (entityType) q = q.eq('entity_type', entityType);
  if (entityId)   q = q.eq('entity_id',   String(entityId));
  const { data, error } = await q;
  if (error) { safeLog('warn', '[EventService] getRecent failed', { error: error.message }); return []; }
  return data || [];
}

// Map legacy dot-notation event names (sale.created) to Cortex uppercase enum (SALE_CREATED)
function normalizeLegacyEventType(legacyType) {
  if (!legacyType) return 'UNKNOWN';
  return legacyType.toUpperCase().replace(/\./g, '_');
}

module.exports = { emit, getRecent, normalizeLegacyEventType };
