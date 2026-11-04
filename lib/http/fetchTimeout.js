// FILE: lib/http/fetchTimeout.js
// A default time limit for every outgoing fetch() in this process.
//
// server.js calls Groq, Gemini, OpenRouter, Hugging Face, OCR.space, Resend,
// Interakt, WATI and Razorpay with plain fetch(), and none of them passed a
// signal. One slow provider then held the request, its memory and (for jobs)
// the whole cron run for as long as the provider liked. A call that already
// passes its own signal keeps it; everything else is aborted after
// OUTBOUND_FETCH_TIMEOUT_MS (default 60s) with a TimeoutError.

function installFetchTimeout({ timeoutMs = Number(process.env.OUTBOUND_FETCH_TIMEOUT_MS || 60000) } = {}) {
  const original = globalThis.fetch;
  if (typeof original !== 'function' || original.__hasDefaultTimeout || !(timeoutMs > 0)) return original;
  const withTimeout = function fetchWithDefaultTimeout(input, init) {
    if (init && init.signal) return original(input, init);
    if (input && typeof input === 'object' && input.signal && !(init && 'signal' in init)) return original(input, init);
    return original(input, { ...(init || {}), signal: AbortSignal.timeout(timeoutMs) });
  };
  withTimeout.__hasDefaultTimeout = true;
  globalThis.fetch = withTimeout;
  return withTimeout;
}

module.exports = { installFetchTimeout };
