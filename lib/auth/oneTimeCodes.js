// Short-lived, single-use codes held in memory: phone sign-in codes and the
// browser-to-desktop sign-in handoff. Codes are compared as SHA-256 hashes, and
// each key allows a few wrong guesses before it is burned. A restart drops
// every open code, which only means asking for a new one.
'use strict';
const crypto = require('crypto');

const store = new Map(); // key -> { hash, data, expiresAt, attempts }
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function sweep(now = Date.now()) {
  for (const [k, v] of store) if (v.expiresAt <= now) store.delete(k);
}

function issue(key, code, data, ttlMs) {
  sweep();
  store.set(key, { hash: sha(code), data, expiresAt: Date.now() + ttlMs, attempts: 0 });
}

/** Returns the stored data once, or null. maxAttempts wrong codes burn the key. */
function consume(key, code, { maxAttempts = 5 } = {}) {
  const e = store.get(key);
  if (!e) return null;
  if (e.expiresAt <= Date.now()) { store.delete(key); return null; }
  const a = Buffer.from(sha(code)), b = Buffer.from(e.hash);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) { store.delete(key); return e.data; }
  e.attempts += 1;
  if (e.attempts >= maxAttempts) store.delete(key);
  return null;
}

module.exports = { issue, consume, _store: store };
