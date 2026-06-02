// FILE: cortex-lab/modes/dryRunRunner.js
// Dry-run mode — exercises the rules engine and policy guard against an
// in-memory fake supabase + an in-memory event capturer. No DB writes occur.
// Where DATABASE_URL is configured, the runner additionally verifies the pg
// pool is reachable and that withTransaction wraps + rolls back as advertised.

'use strict';

const assert       = require('../assertions');
const scorecard    = require('../scorecard');
const sandboxGuard = require('../sandboxGuard');

function tryRequire(rel) { try { return require(rel); } catch (err) { return { __err: err }; } }

const rustCore      = tryRequire('../../lib/services/cortexCore/rustCore.service');
const rulesService  = tryRequire('../../lib/services/orchestrator/rules.service');
const policyGuard   = tryRequire('../../lib/services/orchestrator/policyGuard.service');
const simEngine     = tryRequire('../../lib/services/orchestrator/simulationEngine.service');
const pgModule      = tryRequire('../../lib/db/pg');
const supabaseModule = tryRequire('../../lib/config/supabaseClient');

// ── In-memory fake supabase that the rules engine can read from ──────────────
function buildFakeWorld() {
  const world = {
    user_id: 'user-A',
    customers: [
      { id: 'cust-1', user_id: 'user-A', name: 'Rahul Traders', phone: '+919999900001', credit_limit: 50000 },
    ],
    invoices: [
      { id: 'inv-overdue-1', user_id: 'user-A', customer_name: 'Late Mart', invoice_amount: 8000, days_overdue: 2, payment_status: 'Pending' },
      { id: 'inv-firm-1',    user_id: 'user-A', customer_name: 'Slow Co',    invoice_amount: 12000, days_overdue: 12, payment_status: 'Pending' },
    ],
    products: [
      { id: 'prod-1', user_id: 'user-A', name: 'Widget', current_stock: 3, low_stock_alert: 10 },
    ],
    purchases: [],
    customer_scores: [
      { id: 'sc-1', user_id: 'user-A', customer_id: 'cust-1', broken_promise_count: 2, credit_risk_score: 85 },
    ],
    policy_decisions: [],
    business_events: [],
    ai_actions: [],
  };

  // Helper used by the chain to apply filters.
  function applyFilters(rows, filters) {
    return rows.filter(r => Object.entries(filters).every(([k, v]) => {
      if (k.startsWith('__gte:')) { const real = k.slice(6); return Number(r[real]) >= Number(v); }
      if (k.startsWith('__lte:')) { const real = k.slice(6); return Number(r[real]) <= Number(v); }
      if (k.startsWith('__gt:'))  { const real = k.slice(5); return Number(r[real]) >  Number(v); }
      if (k.startsWith('__lt:'))  { const real = k.slice(5); return Number(r[real]) <  Number(v); }
      return r[k] === v;
    }));
  }

  function from(table) {
    const filters = {};
    let _limit = Infinity;
    const chain = {
      select: () => chain,
      eq:  (col, val) => { filters[col] = val; return chain; },
      gte: (col, val) => { filters['__gte:' + col] = val; return chain; },
      lte: (col, val) => { filters['__lte:' + col] = val; return chain; },
      gt:  (col, val) => { filters['__gt:'  + col] = val; return chain; },
      lt:  (col, val) => { filters['__lt:'  + col] = val; return chain; },
      limit: (n) => { _limit = n; return chain; },
      order: () => chain,
      maybeSingle: async () => {
        const rows = applyFilters(world[table] || [], filters);
        return { data: rows[0] || null, error: null };
      },
      single: async () => {
        const rows = applyFilters(world[table] || [], filters);
        return { data: rows[0] || null, error: rows[0] ? null : { message: 'not found' } };
      },
      insert: (rows) => {
        const inserted = rows.map((r, i) => ({ id: r.id || `dry-${table}-${(world[table] || []).length + i}`, ...r }));
        (world[table] = world[table] || []).push(...inserted);
        const final = { data: inserted, error: null };
        const p = Promise.resolve(final);
        p.select = () => ({ single: async () => ({ data: inserted[0], error: null }) });
        p.then = (resolve, reject) => Promise.resolve(final).then(resolve, reject);
        p.catch = () => p;
        return p;
      },
      update: () => chain,
      // execute lazily for non-single reads
      then: (resolve) => {
        const rows = applyFilters(world[table] || [], filters).slice(0, _limit);
        resolve({ data: rows, error: null });
      },
      catch: () => chain,
    };
    return chain;
  }
  return { client: { from }, world };
}

async function withFakeSupabase(fn) {
  if (supabaseModule.__err) return fn(null);
  const stub = buildFakeWorld();
  // Mutate `.from` on the existing client so destructured refs in product
  // services (policyGuard, rules) see the swap. If supabase is null,
  // temporarily install the stub on the module.
  if (!supabaseModule.supabase) {
    supabaseModule.supabase = stub.client;
    try { return await fn(stub); } finally { supabaseModule.supabase = null; }
  }
  const originalFrom = supabaseModule.supabase.from;
  supabaseModule.supabase.from = stub.client.from;
  try { return await fn(stub); } finally { supabaseModule.supabase.from = originalFrom; }
}

// ── Scenarios ────────────────────────────────────────────────────────────────
async function scenarioRulesProduceActionsForOverdue(record) {
  if (rulesService.__err) {
    scorecard.add(record, 'orchestration', { ok: false, reason: 'rules_not_loadable' }, 'dry:rules_load');
    return;
  }
  await withFakeSupabase(async (stub) => {
    const event = { event_type: 'SALE_CREATED', user_id: 'user-A', entity_id: 'inv-overdue-1', payload_json: {} };
    const actions = await rulesService.evaluate('user-A', event);
    const hasPolite = actions.some(a => a.action_type === 'SEND_POLITE_REMINDER');
    const hasFirm   = actions.some(a => a.action_type === 'SEND_FIRM_REMINDER');
    scorecard.add(record, 'orchestration',
      hasPolite ? { ok: true } : { ok: false, reason: 'polite_reminder_not_produced', detail: { count: actions.length } },
      'dry:polite_reminder_for_1to3_overdue', 'polite-reminder-success');
    scorecard.add(record, 'orchestration',
      hasFirm ? { ok: true } : { ok: false, reason: 'firm_reminder_not_produced' },
      'dry:firm_reminder_for_over_7_overdue', 'firm-reminder-needed');
  });
}

async function scenarioPolicyGuardWrapsActions(record) {
  if (policyGuard.__err) return;
  await withFakeSupabase(async () => {
    const action = { action_type: 'SEND_FIRM_REMINDER', customer_id: 'cust-1', amount: 12000, recommended_message: 'Kindly clear ₹12,000 by tomorrow.' };
    const out = await policyGuard.validate(action, 'user-A');
    scorecard.add(record, 'approval_gate_safety', assert.assertRequiresApproval(out), 'dry:firm_reminder_requires_approval', 'firm-reminder-needed');
  });
}

async function scenarioSimulationEngine(record) {
  if (simEngine.__err) return;
  await withFakeSupabase(async () => {
    const out = await simEngine.simulate('user-A', 'SALE_CREATED', { customer_id: 'cust-1' });
    const looksOK = out && Array.isArray(out.wouldCreate) && Array.isArray(out.wouldBlock);
    scorecard.add(record, 'orchestration',
      looksOK ? { ok: true } : { ok: false, reason: 'simulation_shape_invalid', detail: out },
      'dry:simulation_engine_runs', 'risky-credit-sale');
  });
}

async function scenarioPgTransactionRollback(record) {
  if (pgModule.__err)             { scorecard.add(record, 'event_audit_completeness', 'na', 'dry:pg_unavailable'); return; }
  if (!pgModule.isAvailable())    { scorecard.add(record, 'event_audit_completeness', 'na', 'dry:pg_no_DATABASE_URL'); return; }

  // Sandbox gate before we even attempt a connection.
  const cfg = { env: { nodeEnv: process.env.NODE_ENV || 'development', databaseUrl: process.env.DATABASE_URL, requireNonProd: true, allowProd: process.env.CORTEX_TEST_ALLOW_PROD === 'I-UNDERSTAND' }, prodHostDenylist: ['prod', 'production'] };
  const gate = sandboxGuard.assertSafeForDryRun(cfg);
  if (!gate.ok) {
    // Sandbox correctly blocked pg writes — mark as N/A, not a failure.
    scorecard.add(record, 'event_audit_completeness', 'na', 'dry:pg_blocked_by_sandbox');
    record.warnings.push({ message: `pg rollback test skipped by sandbox guard: ${gate.reasons.join('; ')}` });
    return;
  }
  try {
    let visible = null;
    await pgModule.withTransaction(async (client) => {
      const { rows } = await client.query("SELECT 1 as ok");
      visible = rows && rows[0] && rows[0].ok;
      throw new Error('intentional-rollback');
    }).catch(err => {
      if (err.message !== 'intentional-rollback') throw err;
    });
    const res = visible === 1 ? { ok: true } : { ok: false, reason: 'pg_query_did_not_run' };
    scorecard.add(record, 'event_audit_completeness', res, 'dry:pg_rollback_works', 'pg-rollback');
  } catch (err) {
    scorecard.add(record, 'event_audit_completeness', { ok: false, reason: 'pg_unreachable', detail: { error: err.message } }, 'dry:pg_rollback_works', 'pg-rollback');
  }
}

// ── Parity test: Rust score vs JS fallback for the same input ────────────────
// Runs only when the binary exists; otherwise N/A (never fail on missing binary).
async function scenarioRustJsScoreParity(record) {
  if (rustCore.__err) { scorecard.add(record, 'orchestration', 'na', 'dry:rustcore_not_loadable'); return; }

  // Detect binary — resolveBinary() returns false when not found.
  rustCore.clearBinaryCache();
  const binaryFound = rustCore.resolveBinary();
  if (!binaryFound) {
    scorecard.add(record, 'orchestration', 'na', 'dry:rust_binary_not_built_yet');
    record.warnings.push({ message: 'Rust parity test skipped — binary not built. Run: npm run cortex:rust:build' });
    return;
  }

  // Temporarily enable the flag for this test only.
  const origEnv = process.env.RUST_CORTEX_CORE_ENABLED;
  process.env.RUST_CORTEX_CORE_ENABLED = 'true';
  const { FLAGS } = require('../../lib/featureFlags');
  FLAGS.rust_cortex_core_enabled = true;

  try {
    const input = {
      totalOverdue: 40000, maxDelayDays: 18, avgDelayDays: 18,
      brokenPromises: 3, keptPromises: 0, callsTotal: 0, callsPicked: 0,
    };
    const [rustResult, jsFallbackResult] = await Promise.all([
      rustCore.scoreCustomerWithRust(input).catch(e => ({ _err: e.message })),
      Promise.resolve(rustCore._jsFallbackScore(input)),
    ]);

    if (rustResult._err) {
      scorecard.add(record, 'orchestration', { ok: false, reason: 'rust_call_failed', detail: { error: rustResult._err } }, 'dry:rust_js_parity', 'risky-credit-sale');
      return;
    }

    const rustScore = rustResult.credit_risk_score;
    const jsScore   = jsFallbackResult.credit_risk_score;
    const delta     = Math.abs(rustScore - jsScore);
    const ok        = delta <= 1; // tolerance: ±1 for floating-point rounding

    scorecard.add(record, 'orchestration',
      ok ? { ok: true } : { ok: false, reason: 'rust_js_score_diverged', detail: { rustScore, jsScore, delta } },
      `dry:rust_js_parity (rust=${rustScore} js=${jsScore} Δ=${delta})`, 'risky-credit-sale');

    // Parity test for simulate_credit_sale.
    const simInput = {
      customerId: 'cus-test', newSaleAmount: 50000, currentOutstanding: 72000,
      overdueAmount: 40000, brokenPromises: 3, averageDelayDays: 18, creditLimit: 100000,
    };
    const [rustSim, jsSim] = await Promise.all([
      rustCore.simulateCreditSaleWithRust(simInput).catch(e => ({ _err: e.message })),
      Promise.resolve(rustCore._jsFallbackSimulate(simInput)),
    ]);
    const simOk = !rustSim._err && rustSim.approval_required === jsSim.approval_required && Math.abs(rustSim.score - jsSim.score) <= 2;
    scorecard.add(record, 'orchestration',
      simOk ? { ok: true } : { ok: false, reason: 'rust_js_sim_diverged', detail: { rust: rustSim, js: jsSim } },
      'dry:rust_js_simulate_credit_sale_parity', 'risky-credit-sale');

    // Parity test for evaluate_policy.
    const policyInput = { actionType: 'SEND_FIRM_REMINDER', amount: 5000, riskLevel: 'low', recommendedMessage: 'Please pay.' };
    const [rustPol, jsPol] = await Promise.all([
      rustCore.evaluatePolicyWithRust(policyInput).catch(e => ({ _err: e.message })),
      Promise.resolve(rustCore._jsFallbackPolicy(policyInput)),
    ]);
    const polOk = !rustPol._err && rustPol.blocked === jsPol.blocked && rustPol.requires_approval === jsPol.requires_approval;
    scorecard.add(record, 'orchestration',
      polOk ? { ok: true } : { ok: false, reason: 'rust_js_policy_diverged', detail: { rust: rustPol, js: jsPol } },
      'dry:rust_js_policy_parity', 'risky-credit-sale');

  } finally {
    FLAGS.rust_cortex_core_enabled = origEnv === 'true';
    process.env.RUST_CORTEX_CORE_ENABLED = origEnv || '';
  }
}

// ── Entrypoint ───────────────────────────────────────────────────────────────
async function run({ cfg, record, scenarios }) {
  const tests = [
    ['rules-produce-actions-overdue',   scenarioRulesProduceActionsForOverdue],
    ['policy-guard-wraps-firm-reminder',scenarioPolicyGuardWrapsActions],
    ['simulation-engine-runs',          scenarioSimulationEngine],
    ['pg-transaction-rollback',         scenarioPgTransactionRollback],
    ['rust-js-parity',                  scenarioRustJsScoreParity],
  ];
  for (const [id, fn] of tests) {
    const fBefore = record.totals.failed;
    try { await fn(record); }
    catch (err) { scorecard.add(record, 'orchestration', { ok: false, reason: 'dry_scenario_crash', detail: { id, error: err.message } }, `dry:${id}_crash`, id); }
    const failed = record.totals.failed - fBefore;
    scenarios.push({ id, mode: 'dry-run', passed: failed === 0 ? 1 : 0, failed: failed > 0 ? 1 : 0 });
  }

  // Categories that dry-run cannot prove without live writes → N/A.
  scorecard.add(record, 'business_isolation',       'na', 'dry_mode_na');
  scorecard.add(record, 'financial_data_integrity', 'na', 'dry_mode_na');
  scorecard.add(record, 'learning_loop_quality',    'na', 'dry_mode_na');
  scorecard.add(record, 'action_quality',           'na', 'dry_mode_na');
  scorecard.add(record, 'ai_hallucination_block',   'na', 'dry_mode_na');
}

module.exports = { run };
