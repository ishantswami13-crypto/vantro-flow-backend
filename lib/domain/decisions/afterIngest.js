// FILE: lib/domain/decisions/afterIngest.js
// After new ledger data lands (a file import or a Tally sync), look for
// decisions in it, so the Bridge, Prepared and Decisions show them without
// the owner having to open Decisions first. The hourly scheduler is gated
// off by default, so without this a fresh import formed no decisions.
//
// Debounced per tenant: Tally sends a sync as several batches, and only the
// state after the last one matters. Fire-and-forget: a failure is logged and
// never fails the import that triggered it. runDiscovery itself honours kill
// switches and is fully tenant-scoped; it writes only Starlane's own decision
// records and sends nothing.

const { safeLog } = require('../../observability/logger');

const DEBOUNCE_MS = Number(process.env.DECISIONS_AFTER_INGEST_DEBOUNCE_MS || 20000);
const pending = new Map();

function refreshDecisionsAfterIngest(pool, userId, { source = 'ingest', delayMs = DEBOUNCE_MS } = {}) {
  if (!pool || !userId) return;
  clearTimeout(pending.get(userId));
  const timer = setTimeout(async () => {
    pending.delete(userId);
    try {
      const { runDiscovery } = require('./discovery');
      const { isEnabled } = require('../../featureFlags');
      let getSignalImpact = null;
      try { ({ getSignalImpact } = require('../intelligence/supplyChainOrchestrator')); } catch { /* supply-chain signals are optional */ }
      const result = await runDiscovery(pool, userId, {
        correlationId: `${source}:${Date.now()}`,
        externalSendEnabled: isEnabled('external_message_sending_enabled'),
        getSignalImpact,
      });
      safeLog('info', '[decisions] refreshed after ingest', { userId, source, status: result?.status, discovered: result?.discovered });
    } catch (err) {
      safeLog('error', '[decisions] refresh after ingest failed', { userId, source, error: err.message });
    }
  }, delayMs);
  if (timer.unref) timer.unref();
  pending.set(userId, timer);
}

module.exports = { refreshDecisionsAfterIngest };
