'use strict';
// ============================================================================
// Phase 2C.35-P1 — Global external-send kill switch (single fail-closed choke)
// ----------------------------------------------------------------------------
// Every outbound customer/collections channel (WhatsApp, voice/Twilio, future
// SMS/webhooks) MUST route through guardExternalSend() at its lowest boundary.
// When FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED is missing or not 'true', the
// guard returns a blocked/safe result and the caller must NOT contact any
// provider. Fail-closed: any error reading the flag is treated as "disabled".
//
// Transactional auth delivery (owner login OTP via email/WhatsApp to the
// owner's OWN contact) is explicitly exempt — it is required for the product to
// function and is addressed to the authenticated owner, not a customer. It is
// passed { transactional: true } and is NOT gated by this flag. It is still
// subject to the absence of provider credentials (no creds => dev mock).
// ============================================================================

const { isEnabled } = require('../featureFlags');

/** True only when external sending is explicitly enabled. Fail-closed on error. */
function externalSendEnabled() {
  try {
    return isEnabled('external_message_sending_enabled') === true;
  } catch (_) {
    return false;
  }
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
 * Returns `null` when the send may proceed, or a blocked result object when the
 * send MUST be suppressed. Callers: `const b = guardExternalSend('whatsapp'); if (b) return b;`
 * @param {string} channel  e.g. 'whatsapp' | 'voice' | 'sms' | 'webhook'
 * @param {{transactional?: boolean}} [opts]  transactional=true exempts owner-auth OTP delivery
 */
function guardExternalSend(channel, opts = {}) {
  if (opts && opts.transactional === true) return null; // auth OTP to the owner — required, not gated
  if (externalSendEnabled()) return null;
  return blockedResult(channel);
}

module.exports = { externalSendEnabled, guardExternalSend, blockedResult };
