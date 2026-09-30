'use strict';
// ============================================================================
// Phase 2C.35 — External-send policy (single fail-closed choke point)
// ----------------------------------------------------------------------------
// Three distinct send classes, three distinct policies:
//
//  1. BUSINESS / customer-collections sends (WhatsApp, voice, future SMS/webhooks)
//     → gated by FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED. Fail-closed, OFF by
//       default. Provider credentials ALONE never enable a business send.
//
//  2. AUTH OTP delivery (login/verify OTP to the OWNER's own email/phone)
//     → required for the product to function, so it defaults ON, but is an
//       EXPLICIT, documented exception controlled by FEATURE_AUTH_OTP_SENDING_ENABLED.
//       Set that to 'false' to fully silence even auth OTP (e.g. a locked-down
//       staging demo). It is NOT governed by the business kill switch.
//
//  3. WEB-PUSH (owner-device notifications)
//     → fail-closed for launch: OFF unless FEATURE_PUSH_NOTIFICATIONS_ENABLED=true.
//
// Reading any flag fails closed (treated as disabled) on error. No secrets/PII
// are read or returned here.
// ============================================================================

const { isEnabled } = require('../featureFlags');

/** Business/customer external sends. Fail-closed; OFF unless explicitly enabled. */
function externalSendEnabled() {
  try {
    return isEnabled('external_message_sending_enabled') === true;
  } catch (_) {
    return false;
  }
}

/** Auth OTP delivery to the owner. Defaults ON; explicit opt-OUT via env='false'. */
function authOtpSendEnabled() {
  return String(process.env.FEATURE_AUTH_OTP_SENDING_ENABLED || '').toLowerCase() !== 'false';
}

/** Web-push notifications. Fail-closed; OFF unless explicitly enabled. */
function pushSendEnabled() {
  return String(process.env.FEATURE_PUSH_NOTIFICATIONS_ENABLED || '').toLowerCase() === 'true';
}

// ── Global stop ─────────────────────────────────────────────────────────────
// One switch for every business send (WhatsApp, voice, email engine, push):
// STARLANE_GLOBAL_STOP / OUTBOUND_GLOBAL_STOP in the environment, or the
// 'global_stop' row an admin flips from Outreach (no deploy needed). The guards
// below are synchronous, so the DB value is refreshed in the background (every
// 15 s, and at once when an admin flips it); a failed read keeps the last value.
let dbGlobalStop = false;
let watcher = null;
function envStop() {
  return ['STARLANE_GLOBAL_STOP', 'OUTBOUND_GLOBAL_STOP'].some((k) => String(process.env[k] || '').toLowerCase() === 'true');
}
function isGloballyStopped() {
  return envStop() || dbGlobalStop;
}
async function refreshGlobalStop(pool) {
  try {
    const r = await pool.query("SELECT enabled FROM outbound_system_controls WHERE key = 'global_stop'");
    dbGlobalStop = r.rows[0]?.enabled === true;
  } catch (_) {
    // Table missing (migration 062 not applied) means no DB switch exists yet.
  }
  return isGloballyStopped();
}
function startGlobalStopWatcher(pool, intervalMs = 15000) {
  if (!pool || watcher) return;
  refreshGlobalStop(pool);
  watcher = setInterval(() => refreshGlobalStop(pool), intervalMs);
  if (watcher.unref) watcher.unref();
}

/** A safe, audit-friendly "did not send" result (no secrets/PII). */
function blockedResult(channel, extra = {}) {
  return {
    success: false,
    sent: false,
    blocked: true,
    provider: 'blocked',
    reason: 'external_sending_disabled',
    channel: channel || 'unknown',
    ...extra,
  };
}

/**
 * Returns `null` when the send may proceed, or a blocked result when it must be
 * suppressed. `transactional:true` routes through the auth-OTP policy instead of
 * the business kill switch. Usage: `const b = guardExternalSend('whatsapp'); if (b) return b;`
 */
function guardExternalSend(channel, opts = {}) {
  if (opts && opts.transactional === true) {
    return authOtpSendEnabled() ? null : blockedResult(channel, { reason: 'auth_otp_disabled' });
  }
  if (isGloballyStopped()) return blockedResult(channel, { reason: 'global_stop' });
  if (externalSendEnabled()) return null;
  return blockedResult(channel);
}

/** Guard for web-push. Returns null when allowed, blocked result otherwise. */
function guardPush(channel = 'webpush') {
  if (isGloballyStopped()) return blockedResult(channel, { reason: 'global_stop' });
  return pushSendEnabled() ? null : blockedResult(channel, { reason: 'push_disabled' });
}

module.exports = {
  externalSendEnabled,
  authOtpSendEnabled,
  pushSendEnabled,
  guardExternalSend,
  guardPush,
  blockedResult,
  isGloballyStopped,
  refreshGlobalStop,
  startGlobalStopWatcher,
};
