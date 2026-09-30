// FILE: lib/domain/decisions/definitions.js
// Versioned semantic contract for the decision engine.
//
// Every threshold the engine uses to decide "this is overdue", "this is
// material", "this source is stale" lives here, under one version string.
// A tenant can override individual keys (tenant_semantic_definitions,
// migrations/060_decision_core.sql); the effective set, and the version it
// came from, is stamped on every decision so a historical decision stays
// explainable after the defaults change. No intelligence module may use a
// private copy of these numbers.

const ENGINE_VERSION = 'decision-engine@2026.09.28-1';
const DEFINITIONS_VERSION = 'starlane-default@1';

const DEFAULT_DEFINITIONS = Object.freeze({
  // An invoice is overdue when the as-of date is strictly after its due date.
  overdue_after_days: 0,
  // Aging bucket at which a receivable is treated as a probable bad debt.
  bad_debt_threshold_days: 90,
  // A receivables decision is material when the expected uncollected amount
  // at 90 days is at least this many currency units...
  material_amount_min: 25000,
  // ...or this share of the tenant's total open receivables, whichever is larger.
  material_share_min: 0.02,
  // A customer is "concentrated" when its open receivables exceed this share.
  concentration_share: 0.2,
  // A customer's payment delay "deteriorated" when the recent median delay
  // exceeds the prior median by at least this many days.
  deterioration_days: 7,
  // Minimum paid invoices in each window before a trend is claimed.
  trend_min_samples: 3,
  // Receivables data freshness (hours since last import/sync/edit).
  receivables_fresh_hours: 48,
  receivables_stale_hours: 168,
  // Process degradation: collection cycle (invoice -> payment) worsening.
  cycle_recent_days: 60,
  cycle_prior_days: 180,
  cycle_min_samples: 8,
  cycle_worsen_ratio: 0.2,
  cycle_worsen_days: 5,
  // Gross margin used to value lost sales. null = unknown (engine then
  // samples an explicit, labelled assumption range and reports it as an unknown).
  gross_margin_pct: null,
  // Tenant base currency. Invoices with no currency are treated as this and
  // the assumption is recorded on every decision that relies on it.
  base_currency: 'INR',
  // Presentation timezone for deadlines.
  timezone: 'Asia/Kolkata',
  // Objective weights (rupee components are summed with these weights).
  objective_weights: { cash: 1, credit_risk: 1, margin: 1 },
  // Monte Carlo iterations (fixed so results are reproducible and bounded).
  simulation_iterations: 2000,
});

function effectiveDefinitions(overrides = {}) {
  const merged = { ...DEFAULT_DEFINITIONS };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_DEFINITIONS, key)) continue;
    if (value === undefined) continue;
    merged[key] = value;
  }
  return merged;
}

// Validates a tenant override payload. Returns { ok, errors, value }.
function validateOverrides(input) {
  const errors = [];
  const value = {};
  if (!input || typeof input !== 'object') return { ok: false, errors: ['definitions must be an object'], value };
  for (const [key, raw] of Object.entries(input)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_DEFINITIONS, key)) { errors.push(`unknown definition: ${key}`); continue; }
    const def = DEFAULT_DEFINITIONS[key];
    if (key === 'objective_weights') {
      if (!raw || typeof raw !== 'object') { errors.push('objective_weights must be an object'); continue; }
      const w = {};
      for (const k of ['cash', 'credit_risk', 'margin']) {
        const n = raw[k] == null ? def[k] : Number(raw[k]);
        if (!Number.isFinite(n) || n < 0 || n > 10) { errors.push(`objective_weights.${k} must be between 0 and 10`); continue; }
        w[k] = n;
      }
      value[key] = w;
    } else if (key === 'base_currency') {
      if (typeof raw !== 'string' || !/^[A-Z]{3}$/.test(raw)) { errors.push('base_currency must be an ISO 4217 code'); continue; }
      value[key] = raw;
    } else if (key === 'timezone') {
      try { new Intl.DateTimeFormat('en-US', { timeZone: raw }); value[key] = raw; } catch { errors.push('timezone must be an IANA zone'); }
    } else if (key === 'gross_margin_pct') {
      if (raw === null) { value[key] = null; continue; }
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0 || n >= 1) { errors.push('gross_margin_pct must be a fraction between 0 and 1'); continue; }
      value[key] = n;
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) { errors.push(`${key} must be a non-negative number`); continue; }
      if (key === 'simulation_iterations' && (n < 200 || n > 20000)) { errors.push('simulation_iterations must be 200..20000'); continue; }
      value[key] = n;
    }
  }
  return { ok: errors.length === 0, errors, value };
}

module.exports = { ENGINE_VERSION, DEFINITIONS_VERSION, DEFAULT_DEFINITIONS, effectiveDefinitions, validateOverrides };
