// FILE: lib/services/messaging/testMessageAdapter.js
// ============================================================================
// Phase C — Verified Execution Loop V1 (Receivables): TEST messaging adapter.
// ----------------------------------------------------------------------------
// THIS ADAPTER NEVER CONTACTS ANY REAL SERVICE. It performs no network call,
// no Twilio API request, and no WhatsApp send of any kind. It exists purely
// so the approval → execution pipeline can be exercised end-to-end (locally
// and in this environment, where FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED is
// off and Twilio credentials are absent) without ever claiming a real message
// went out.
//
// Interface symmetry: mirrors the real `sendWhatsAppMessage(phone, message)`
// call shape used in server.js so callers (commandBus's execution handler)
// can swap between the real sender and this fake one without branching logic
// beyond the channel choice itself.
//
// Honesty guarantee: the result this returns can only ever claim `sent`, NEVER
// `delivered` — a fake adapter has no way to know whether a message reached a
// real device, so it must not assert delivery. `channel` is always the literal
// string 'test', which must be propagated verbatim into execution_records so a
// test-channel row can never be mistaken for a real WhatsApp send in any
// report, log line, or UI surface.
// ============================================================================
'use strict';

const { randomUUID } = require('crypto');

/**
 * Fake send — always "succeeds" deterministically, never touches the network.
 * @param {string} userId - tenant id (accepted for interface symmetry / future
 *   per-tenant fake-behavior hooks; not used to contact anything real).
 * @param {{customerPhone: string, message: string}} payload
 * @returns {{success: boolean, sent: boolean, delivered: boolean, provider: string,
 *   providerMessageId: string, channel: 'test', sid: string, raw: object}}
 */
function send(userId, { customerPhone, message } = {}) {
  // Deliberately synchronous-shaped but returned as a Promise to match the
  // real adapter's async contract (sendWhatsAppMessage is `async`).
  const providerMessageId = 'test-' + randomUUID();
  return Promise.resolve({
    success: true,
    sent: true,
    // Never claim delivery — only a real provider callback could know that.
    delivered: false,
    provider: 'test-fake-adapter',
    providerMessageId,
    // Kept for symmetry with sendWhatsAppMessage's result shape (server.js
    // reads `sendResult.sid`); clearly fake and prefixed so it cannot be
    // confused with a real Twilio SID.
    sid: providerMessageId,
    channel: 'test',
    raw: {
      note: 'FAKE SEND — testMessageAdapter never contacts a real provider.',
      userId: userId || null,
      customerPhone: customerPhone || null,
      messagePreviewLength: typeof message === 'string' ? message.length : 0,
    },
  });
}

module.exports = { send };
