// FILE: lib/domain/decisions/rawReceivablesCache.js
// Short-lived, per-tenant cache of loadRawReceivables() for read-only screens.
//
// One page load asks for several summaries (decisions today, data profile,
// ...) and each used to read every invoice, customer, dispute, promise and
// allocation of the tenant. At 10,000 invoices that read and its parsing
// dominated the request. This keeps one copy per tenant for a few seconds and
// shares a read that is already in flight.
//
// Only GET routes use it. Anything that writes, decides or verifies reads
// fresh through loadRawReceivables(). A successful write request by the
// tenant drops its entry (see invalidateBusinessCache in server.js), so the
// only staleness is from background writers, bounded by the TTL.
//
// Callers must treat the returned object as read-only: it is shared.

const { loadRawReceivables } = require('./discovery');

const TTL_MS = Math.max(0, Number(process.env.RAW_RECEIVABLES_CACHE_MS ?? 10000));
const MAX_TENANTS = 500;
const entries = new Map(); // userId -> { at, promise }

function loadRawReceivablesCached(pool, userId) {
  if (!TTL_MS) return loadRawReceivables(pool, userId);
  const key = String(userId);
  const hit = entries.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const entry = { at: Date.now(), promise: null };
  entry.promise = loadRawReceivables(pool, userId).catch((err) => {
    if (entries.get(key) === entry) entries.delete(key);
    throw err;
  });
  entries.delete(key);
  entries.set(key, entry);
  if (entries.size > MAX_TENANTS) entries.delete(entries.keys().next().value);
  return entry.promise;
}

function invalidateRawReceivables(userId) {
  if (userId != null) entries.delete(String(userId));
}

module.exports = { loadRawReceivablesCached, invalidateRawReceivables };
