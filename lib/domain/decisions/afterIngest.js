// FILE: lib/domain/decisions/afterIngest.js
// After new ledger data lands (a file import, a Tally sync or a recorded
// payment), look for decisions in it, raise Watch events from it and check
// open decision outcomes against it, so the Bridge, Watch, Prepared and
// Decisions show them without the owner having to open a page first. The hourly scheduler is gated
// off by default, so without this a fresh import formed no decisions.
//
// Debounced per tenant: Tally sends a sync as several batches, and only the
// state after the last one matters. Fire-and-forget: a failure is logged and
// never fails the import that triggered it. runDiscovery itself honours kill
// switches and is fully tenant-scoped; it writes only Starlane's own decision
// records and sends nothing.

const { safeLog } = require('../../observability/logger');

// A Tally sync arrives as several batches, so it waits for the last one. A
// file import or a recorded payment is one request, so it runs almost at once.
const DEBOUNCE_MS = Number(process.env.DECISIONS_AFTER_INGEST_DEBOUNCE_MS || 20000);
const SINGLE_REQUEST_MS = Math.min(DEBOUNCE_MS, 2000);
const BATCHED_SOURCES = new Set(['tally_sync']);
const pending = new Map();

function refreshDecisionsAfterIngest(pool, userId, { source = 'ingest', delayMs = BATCHED_SOURCES.has(source) ? DEBOUNCE_MS : SINGLE_REQUEST_MS } = {}) {
  if (!pool || !userId) return;
  clearTimeout(pending.get(userId));
  const timer = setTimeout(async () => {
    pending.delete(userId);
    try {
      // Watch reads the same ledger, so its overdue bands are raised first
      // (it is quick), instead of on the next Bridge visit after its refresh
      // interval.
      const watch = require('../../features/watch');
      const watched = await watch.refresh(pool, userId).catch((e) => { safeLog('error', '[decisions] watch refresh after ingest failed', { userId, source, error: e.message }); return null; });
      const { runDiscovery } = require('./discovery');
      const { isEnabled } = require('../../featureFlags');
      let getSignalImpact = null;
      try { ({ getSignalImpact } = require('../intelligence/supplyChainOrchestrator')); } catch { /* supply-chain signals are optional */ }
      const result = await runDiscovery(pool, userId, {
        correlationId: `${source}:${Date.now()}`,
        externalSendEnabled: isEnabled('external_message_sending_enabled'),
        getSignalImpact,
      });
      // New ledger data is also what moves an outcome, so open decision
      // contracts are checked against it here too (the daily check sits
      // behind the same default-off scheduler flag). Final contracts return
      // early, so re-checking is safe.
      const { verifyDueContracts } = require('./verification');
      const verified = await verifyDueContracts(pool, userId, { correlationId: `${source}:${Date.now()}` });
      safeLog('info', '[decisions] refreshed after ingest', { userId, source, status: result?.status, discovered: result?.discovered, contractsChecked: verified.length, watchRefreshed: watched !== null });
    } catch (err) {
      safeLog('error', '[decisions] refresh after ingest failed', { userId, source, error: err.message });
    }
  }, delayMs);
  if (timer.unref) timer.unref();
  pending.set(userId, timer);
}

module.exports = { refreshDecisionsAfterIngest };
