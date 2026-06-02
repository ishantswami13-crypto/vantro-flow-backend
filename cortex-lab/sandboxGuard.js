// FILE: cortex-lab/sandboxGuard.js
// Triple-gate safety check. Refuses to run write tests against anything
// that looks like production. Never trusts a single signal.

'use strict';

function looksLikeProdHost(url, denylist) {
  if (!url) return false;
  const lower = String(url).toLowerCase();
  return denylist.some(p => lower.includes(p.toLowerCase()));
}

/**
 * Validate that a write-capable mode is safe to run.
 * Returns { ok, reasons[], warnings[] } — never throws.
 *
 * Mandatory gates for WRITE (live mode or dry-run with real DB):
 *   1. NODE_ENV !== 'production'
 *   2. CORTEX_TEST_DB_ALLOW_WRITE=true
 *   3. CORTEX_TEST_REQUIRE_NON_PROD=true (default) AND no prod hostname match
 *      — unless CORTEX_TEST_ALLOW_PROD=I-UNDERSTAND (founder override; loud warning)
 *   4. Test base URL must differ from product SUPABASE_URL host (no
 *      accidental "same db, just different user" mistake)
 *   5. External message sending must be OFF
 */
function assertSafeForWrite(cfg) {
  const reasons  = [];
  const warnings = [];

  if (cfg.env.nodeEnv === 'production' && !cfg.env.allowProd) {
    reasons.push('NODE_ENV=production — refusing write tests. Set CORTEX_TEST_ALLOW_PROD=I-UNDERSTAND only if you truly mean it.');
  }
  if (!cfg.env.allowWrite) {
    reasons.push('CORTEX_TEST_DB_ALLOW_WRITE is not "true". Write tests blocked by default.');
  }

  // Hostname gates
  const hits = [];
  if (looksLikeProdHost(cfg.env.testBaseUrl,     cfg.prodHostDenylist)) hits.push(`CORTEX_TEST_BASE_URL (${cfg.env.testBaseUrl})`);
  if (looksLikeProdHost(cfg.env.testSupabaseUrl, cfg.prodHostDenylist)) hits.push(`CORTEX_TEST_SUPABASE_URL`);
  if (looksLikeProdHost(cfg.env.supabaseUrl,     cfg.prodHostDenylist)) hits.push(`SUPABASE_URL (product) — refusing to reuse`);

  if (cfg.env.requireNonProd && hits.length && !cfg.env.allowProd) {
    reasons.push(`Production-shaped host(s) detected: ${hits.join(', ')}. Refusing.`);
  }
  if (cfg.env.allowProd) {
    warnings.push('CORTEX_TEST_ALLOW_PROD=I-UNDERSTAND is set. Founder override active. Every safety reason above is being downgraded to a warning.');
  }

  // Reuse-of-prod-db check
  if (cfg.env.testSupabaseUrl && cfg.env.supabaseUrl && cfg.env.testSupabaseUrl === cfg.env.supabaseUrl) {
    reasons.push('CORTEX_TEST_SUPABASE_URL equals SUPABASE_URL — test must use a separate Supabase project.');
  }

  // External sending
  if (cfg.env.externalSendEnabled) {
    reasons.push('FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED=true on the target environment. Tests must run with external sending OFF.');
  }

  // No tokens → blocked
  if (!cfg.env.ownerAToken || !cfg.env.ownerBToken) {
    reasons.push('Missing CORTEX_TEST_TOKEN_OWNER_A and/or CORTEX_TEST_TOKEN_OWNER_B. Live mode requires both.');
  }

  // If founder override is on, every reason becomes a warning instead.
  if (cfg.env.allowProd) {
    return { ok: true, reasons: [], warnings: warnings.concat(reasons.map(r => `[OVERRIDE] ${r}`)) };
  }

  return { ok: reasons.length === 0, reasons, warnings };
}

/**
 * Lighter gate for dry-run mode against the *test* database only.
 * Reuses the same prod-host checks but does not demand tokens.
 */
function assertSafeForDryRun(cfg) {
  const reasons  = [];
  const warnings = [];
  if (cfg.env.nodeEnv === 'production' && !cfg.env.allowProd) {
    reasons.push('NODE_ENV=production — refusing dry-run writes.');
  }
  if (cfg.env.requireNonProd && !cfg.env.allowProd) {
    if (looksLikeProdHost(cfg.env.databaseUrl, cfg.prodHostDenylist)) {
      reasons.push('DATABASE_URL looks like production. Refusing.');
    }
  }
  if (!cfg.env.databaseUrl) {
    warnings.push('DATABASE_URL not set — dry-run will fall back to in-memory mocks only (no pg transactions).');
  }
  return { ok: reasons.length === 0, reasons, warnings };
}

module.exports = { assertSafeForWrite, assertSafeForDryRun, looksLikeProdHost };
