// Integration test (real Neon dev DB) for the outcome-memory consultation added
// to creditRiskAgent.js's run(), cashflowAgent.js's run(), and
// revenueIntelligence.service.js's runRevenueHealthWatchRule() (commits
// 06a1042 and 1f4f40c).
//
// Gap this fills vs. test-outcome-memory-consultation.js: that test only
// instruments a hand-copied re-implementation of the bulk business_memory
// query — it never calls the real run()/runRevenueHealthWatchRule() entry
// points, so it would NOT catch a future regression where someone
// accidentally moves the outcome-memory fetch inside a per-customer loop
// inside the real function body.
//
// This test calls the three REAL exported entry points directly, with a spy
// wrapped around the shared supabase client's .from() counting calls to
// .from('business_memory'), and seeds multiple customers/scenarios per
// tenant so a per-row (N+1) regression would visibly multiply the count.
//
// IMPORTANT: two of the three entry points are gated behind feature flags
// that read process.env at module-load time (lib/featureFlags.js computes
// its FLAGS object once, at first require). Both flags must be set BEFORE
// anything requires featureFlags.js (directly or transitively) — hence they
// are set as the very first lines below, ahead of every other require.
process.env.FEATURE_CUSTOMER_SCORING = 'true';
process.env.FEATURE_CUSTOMER_REVENUE_INTELLIGENCE = 'true';
// FEATURE_MEMORY_ENABLED intentionally left unset (false): with it off,
// creditRiskAgent.run() skips its business_memory tier-memory UPSERT,
// keeping this test's business_memory call-count assertions deterministic
// (see NOTE in Test 1 below for the exact breakdown of calls that remain).

require('dotenv').config();
const { randomUUID } = require('crypto');
const { supabase } = require('../lib/config/supabaseClient');

const creditRiskAgent = require('../lib/services/agents/creditRiskAgent');
const cashflowAgent = require('../lib/services/agents/cashflowAgent');
const { runRevenueHealthWatchRule } = require('../lib/services/orchestrator/revenueIntelligence.service');

let pass = 0, fail = 0;
function check(label, cond) {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  cond ? pass++ : fail++;
}

// Wrap supabase.from to count calls to a given table across a real run() /
// runRevenueHealthWatchRule() invocation — proves the actual entry point
// bulk-fetches (not N+1), not just a hand-copied re-implementation of the
// query. Restored in a finally block by the caller.
function countCallsTo(tableName) {
  const orig = supabase.from.bind(supabase);
  let count = 0;
  supabase.from = (name) => {
    if (name === tableName) count++;
    return orig(name);
  };
  return {
    stop() { supabase.from = orig; return count; },
  };
}

// Local-dev-only compensating shim, scoped to THIS test file — does not touch
// lib/config/pgSupabaseShim.js or lib/services/agents/creditRiskAgent.js
// (both out of scope / forbidden to modify).
//
// creditRiskAgent.run()'s pre-existing (pre-phase, unrelated to the
// outcome-memory consultation under test) customer_scores query uses
// supabase-js embedded-relation select syntax: '..., customers(name)'. The
// local pg-backed shim (lib/config/pgSupabaseShim.js) is a minimal
// query-builder that only supports flat column lists — it has no join/embed
// support at all — so it quotes the whole string as one bogus identifier and
// the query errors out, short-circuiting run() before it ever reaches the
// business_memory outcome-fetch under test.
//
// To exercise the REAL run() end-to-end against local dev Postgres despite
// this pre-existing, unrelated environment gap, this wraps supabase.from()
// for just the 'customer_scores' table and strips the unsupported
// ', customers(name)' suffix before the shim sees it. This does not change
// what is being tested: the outcome-memory bulk-fetch (the only thing this
// file asserts on) is untouched, still runs for real, and 'customers(name)'
// only ever fed row.customers?.name into an alert title/description string
// that no assertion here depends on.
function patchCustomerScoresEmbedForLocalShim() {
  const orig = supabase.from.bind(supabase);
  supabase.from = (name) => {
    const qb = orig(name);
    if (name === 'customer_scores') {
      const origSelect = qb.select.bind(qb);
      qb.select = (cols, opts) => {
        if (typeof cols === 'string' && cols.includes('customers(name)')) {
          cols = cols.replace(/,\s*customers\(name\)/, '').replace(/customers\(name\)\s*,?\s*/, '');
        }
        return origSelect(cols, opts);
      };
    }
    return qb;
  };
  return { stop() { supabase.from = orig; } };
}

async function main() {
  const userIdA = randomUUID(); // creditRiskAgent tenant (3 customers)
  const userIdB = randomUUID(); // cashflowAgent tenant
  const userIdC = randomUUID(); // revenueIntelligence tenant (3 customers)

  const custA1 = randomUUID();
  const custA2 = randomUUID();
  const custA3 = randomUUID();

  const custC1 = randomUUID();
  const custC2 = randomUUID();
  const custC3 = randomUUID();

  const saleIds = [];
  const cashflowEventIds = [];
  const purchaseIds = [];

  try {
    // ── Shared setup: users + customers ────────────────────────────────────
    await supabase.from('users').insert([
      { id: userIdA, email: `outcome-mem-int-a-${userIdA}@test.local`, password_hash: 'x', business_name: 'Integration A (credit risk)' },
      { id: userIdB, email: `outcome-mem-int-b-${userIdB}@test.local`, password_hash: 'x', business_name: 'Integration B (cashflow)' },
      { id: userIdC, email: `outcome-mem-int-c-${userIdC}@test.local`, password_hash: 'x', business_name: 'Integration C (revenue intel)' },
    ]);
    await supabase.from('customers').insert([
      { id: custA1, user_id: userIdA, name: 'Credit Risk Cust A1' },
      { id: custA2, user_id: userIdA, name: 'Credit Risk Cust A2' },
      { id: custA3, user_id: userIdA, name: 'Credit Risk Cust A3' },
      { id: custC1, user_id: userIdC, name: 'Revenue Intel Cust C1' },
      { id: custC2, user_id: userIdC, name: 'Revenue Intel Cust C2' },
      { id: custC3, user_id: userIdC, name: 'Revenue Intel Cust C3' },
    ]);

    // ══════════════════════════════════════════════════════════════════════
    // Test A: creditRiskAgent.run(userId) — real entry point
    // ══════════════════════════════════════════════════════════════════════
    // 3 scored customers -> creditRiskCustomerIds has 3 entries -> the
    // business_memory outcome-fetch must still be ONE .in([...]) query, not 3.
    await supabase.from('customer_scores').insert([
      { user_id: userIdA, customer_id: custA1, credit_risk_score: 85 }, // HIGH_RISK
      { user_id: userIdA, customer_id: custA2, credit_risk_score: 55 }, // MEDIUM
      { user_id: userIdA, customer_id: custA3, credit_risk_score: 20 }, // LOW
    ]);
    // Seed a credit_risk_alert_outcome memory row for one of the three, so the
    // bulk-fetch has real matching rows to return (not just an empty result).
    await supabase.from('business_memory').insert([
      { user_id: userIdA, entity_type: 'customer', entity_id: custA1, memory_key: 'credit_risk_alert_outcome', memory_value: { v: false, action_id: 'x' }, source: 'test' },
    ]);

    const shimPatchA3 = patchCustomerScoresEmbedForLocalShim();
    const spyA3 = countCallsTo('business_memory');
    const specsA3 = await creditRiskAgent.run(userIdA);
    const totalCallsA_3customers = spyA3.stop();
    shimPatchA3.stop();

    // Add 2 more scored customers (5 total) and re-run — if the outcome-fetch
    // ever regresses to a per-customer loop, this call count would grow
    // (e.g. 2 -> 4, or 2 -> 6); a real bulk-fetch keeps it flat.
    const custA4 = randomUUID();
    const custA5 = randomUUID();
    await supabase.from('customers').insert([
      { id: custA4, user_id: userIdA, name: 'Credit Risk Cust A4' },
      { id: custA5, user_id: userIdA, name: 'Credit Risk Cust A5' },
    ]);
    await supabase.from('customer_scores').insert([
      { user_id: userIdA, customer_id: custA4, credit_risk_score: 75 },
      { user_id: userIdA, customer_id: custA5, credit_risk_score: 30 },
    ]);

    const shimPatchA5 = patchCustomerScoresEmbedForLocalShim();
    const spyA5 = countCallsTo('business_memory');
    const specsA5 = await creditRiskAgent.run(userIdA);
    const totalCallsA_5customers = spyA5.stop();
    shimPatchA5.stop();

    check('A. creditRiskAgent.run() executes without throwing (3 customers)', Array.isArray(specsA3));
    check('A. creditRiskAgent.run() executes without throwing (5 customers)', Array.isArray(specsA5));
    // NOTE: creditRiskAgent.run() makes business_memory calls unrelated to the
    // outcome-consultation phase too — an unconditional pre-existing
    // credit_tier_last bulk-fetch (line ~134) that has always been there.
    // With FEATURE_MEMORY_ENABLED unset, the tier-memory UPSERT (gated on
    // that flag) does not fire, so exactly 2 business_memory calls are
    // expected per run: [1] credit_tier_last bulk-fetch, [2] the
    // credit_risk_alert_outcome bulk-fetch under test. The real regression
    // signal is that this total does NOT grow with customer count.
    check('A. exactly 2 business_memory calls per run with 3 customers (1 pre-existing tier-fetch + 1 outcome bulk-fetch, not per-customer)', totalCallsA_3customers === 2);
    check('A. business_memory call count UNCHANGED when customer count grows 3 -> 5 (proves outcome-fetch is bulk, not N+1)', totalCallsA_5customers === totalCallsA_3customers);

    // ══════════════════════════════════════════════════════════════════════
    // Test B: cashflowAgent.run(userId) — real entry point
    // ══════════════════════════════════════════════════════════════════════
    // Force a cashflow gap (>=20%) so the CASHFLOW_GAP_ALERT branch — the only
    // branch that touches business_memory — actually executes. Multiple
    // overdue-payable "scenarios" are added too (a realistic multi-row tenant)
    // even though that loop never touches business_memory, to prove the
    // business_memory call count stays at 1 regardless of unrelated row counts.
    const cfIn = await supabase.from('cashflow_events').insert([
      { user_id: userIdB, event_type: 'expected_inflow', amount: 10000, expected_date: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10), status: 'expected' },
      { user_id: userIdB, event_type: 'expected_outflow', amount: 30000, expected_date: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10), status: 'expected' },
    ]).select('id');
    if (cfIn.data) cashflowEventIds.push(...cfIn.data.map(r => r.id));

    const purchIn = await supabase.from('purchases').insert([
      { user_id: userIdB, supplier_name: 'Supplier One', amount: 5000, paid_amount: 0, status: 'unpaid', purchase_date: '2025-01-01', due_date: '2025-01-10' },
      { user_id: userIdB, supplier_name: 'Supplier Two', amount: 7000, paid_amount: 0, status: 'unpaid', purchase_date: '2025-01-01', due_date: '2025-01-15' },
      { user_id: userIdB, supplier_name: 'Supplier Three', amount: 3000, paid_amount: 0, status: 'unpaid', purchase_date: '2025-01-01', due_date: '2025-01-20' },
    ]).select('id');
    if (purchIn.data) purchaseIds.push(...purchIn.data.map(r => r.id));

    const spyB = countCallsTo('business_memory');
    const specsB = await cashflowAgent.run(userIdB);
    const totalCallsB = spyB.stop();

    check('B. cashflowAgent.run() executes without throwing', Array.isArray(specsB));
    check('B. cashflowAgent.run() actually detected the gap and produced a CASHFLOW_GAP_ALERT spec', specsB.some(s => s.action_type === 'CASHFLOW_GAP_ALERT'));
    check('B. exactly 1 business_memory call per run (tenant-level cashflow_alert_outcome bulk read, unaffected by 3 unrelated overdue-payable rows)', totalCallsB === 1);

    // ══════════════════════════════════════════════════════════════════════
    // Test C: runRevenueHealthWatchRule(userId) — real entry point
    // ══════════════════════════════════════════════════════════════════════
    // 3 customers, each concentrated (~33% share) and HIGH_RISK (score >= 70)
    // -> all 3 qualify as AT_RISK + concentration-risk candidates. The
    // business_memory outcome-fetch must still be ONE .in([...]) query for
    // all 3, not 3 separate per-customer queries.
    const recentDate = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const salesIns = await supabase.from('sales').insert([
      { user_id: userIdC, customer_id: custC1, customer_name: 'Revenue Intel Cust C1', amount: 100000, paid_amount: 100000, status: 'paid', sale_date: recentDate },
      { user_id: userIdC, customer_id: custC2, customer_name: 'Revenue Intel Cust C2', amount: 100000, paid_amount: 100000, status: 'paid', sale_date: recentDate },
      { user_id: userIdC, customer_id: custC3, customer_name: 'Revenue Intel Cust C3', amount: 100000, paid_amount: 100000, status: 'paid', sale_date: recentDate },
    ]).select('id');
    if (salesIns.data) saleIds.push(...salesIns.data.map(r => r.id));

    await supabase.from('customer_scores').insert([
      { user_id: userIdC, customer_id: custC1, credit_risk_score: 90 },
      { user_id: userIdC, customer_id: custC2, credit_risk_score: 80 },
      { user_id: userIdC, customer_id: custC3, credit_risk_score: 75 },
    ]);
    // Seed a revenue_health_watch_outcome row for one candidate so the
    // bulk-fetch has a real matching row (proves it's actually querying real
    // data, not vacuously returning empty).
    await supabase.from('business_memory').insert([
      { user_id: userIdC, entity_type: 'customer', entity_id: custC1, memory_key: 'revenue_health_watch_outcome', memory_value: { v: false, action_id: 'y' }, source: 'test' },
    ]);

    const spyC = countCallsTo('business_memory');
    const specsC = await runRevenueHealthWatchRule(userIdC);
    const totalCallsC = spyC.stop();

    check('C. runRevenueHealthWatchRule() executes without throwing', Array.isArray(specsC));
    check('C. runRevenueHealthWatchRule() actually flagged all 3 concentrated/at-risk customers', specsC.length === 3);
    check('C. exactly 1 business_memory call per run for 3 qualifying candidates (bulk-fetch, not per-candidate)', totalCallsC === 1);

  } finally {
    // ── Cleanup, most-dependent rows first ─────────────────────────────────
    if (saleIds.length) await supabase.from('sales').delete().in('id', saleIds);
    if (purchaseIds.length) await supabase.from('purchases').delete().in('id', purchaseIds);
    if (cashflowEventIds.length) await supabase.from('cashflow_events').delete().in('id', cashflowEventIds);
    await supabase.from('business_memory').delete().in('user_id', [userIdA, userIdB, userIdC]);
    await supabase.from('customer_scores').delete().in('user_id', [userIdA, userIdC]);
    await supabase.from('customers').delete().in('user_id', [userIdA, userIdB, userIdC]);
    await supabase.from('users').delete().in('id', [userIdA, userIdB, userIdC]);

    // Verify zero residue.
    const [{ data: leftoverUsers }, { data: leftoverCustomers }, { data: leftoverMemory }] = await Promise.all([
      supabase.from('users').select('id').in('id', [userIdA, userIdB, userIdC]),
      supabase.from('customers').select('id').in('user_id', [userIdA, userIdB, userIdC]),
      supabase.from('business_memory').select('id').in('user_id', [userIdA, userIdB, userIdC]),
    ]);
    check('cleanup. zero leftover synthetic users', (leftoverUsers || []).length === 0);
    check('cleanup. zero leftover synthetic customers', (leftoverCustomers || []).length === 0);
    check('cleanup. zero leftover synthetic business_memory rows', (leftoverMemory || []).length === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
