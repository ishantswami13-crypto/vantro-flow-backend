// FILE: lib/services/orchestrator/idempotency.service.js
// Prevents duplicate creates when a client retries a request (mobile network drops, etc.).
// Callers send: Idempotency-Key: <uuid> header on POST requests.
// Keys expire after 24 hours (enforced at query time, not by DB trigger).
const { supabase } = require('../../config/supabaseClient');
const { safeLog } = require('../../observability/logger');

const TTL_HOURS = 24;

// Returns the cached response if key was seen within TTL, null otherwise.
async function check(userId, key) {
  if (!userId || !key) return null;
  try {
    const cutoff = new Date(Date.now() - TTL_HOURS * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from('idempotency_keys')
      .select('response_json, created_at')
      .eq('user_id', userId)
      .eq('idem_key', key)
      .gte('created_at', cutoff)
      .maybeSingle();

    if (data?.response_json) {
      safeLog('info', '[Idempotency] Cache hit — returning stored response', { userId, key });
      return data.response_json;
    }
    return null;
  } catch (err) {
    safeLog('warn', '[Idempotency] check failed', { error: err.message, userId });
    return null; // Always fail open — never block a real request
  }
}

// Store the response for this key. Silently ignores duplicate-key conflicts (upsert).
async function set(userId, key, response) {
  if (!userId || !key) return;
  try {
    await supabase
      .from('idempotency_keys')
      .upsert([{ user_id: userId, idem_key: key, response_json: response }], {
        onConflict: 'user_id,idem_key',
        ignoreDuplicates: false,
      });
  } catch (err) {
    safeLog('warn', '[Idempotency] set failed', { error: err.message, userId });
    // Never throw — idempotency failure should not kill the response
  }
}

module.exports = { check, set };
