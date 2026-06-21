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
  if (externalSendEnabled()) return null;
  return blockedResult(channel);
}

/** Guard for web-push. Returns null when allowed, blocked result otherwise. */
function guardPush(channel = 'webpush') {
  return pushSendEnabled() ? null : blockedResult(channel, { reason: 'push_disabled' });
}

module.exports = {
  externalSendEnabled,
  authOtpSendEnabled,
  pushSendEnabled,
  guardExternalSend,
  guardPush,
  blockedResult,
};
