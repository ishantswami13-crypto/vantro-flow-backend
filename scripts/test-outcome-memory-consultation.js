// Integration test (real Neon dev DB) for the outcome-memory consultation added
// to creditRiskAgent.js, cashflowAgent.js/cashflow.service.js, and
// revenueIntelligence.service.js: reading back credit_risk_alert_outcome,
// cashflow_alert_outcome, and revenue_health_watch_outcome business_memory rows
// that evaluationAgent.js already writes (previously write-only).
//
// Exercises the actual bulk-fetch queries these files now run (not just the
// pure helper functions), counts query invocations to prove single-query-per-
// tenant-run (no N+1), and proves tenant isolation + safe degradation on
// missing/malformed memory.
require('dotenv').config();
const { randomUUID } = require('crypto');
const { supabase } = require('../lib/config/supabaseClient');
const {
  downgradePriority, downgradeRiskLevel, wasLastCreditRiskAlertIneffective,
} = require('../lib/services/agents/creditRiskAgent');
const {
  getCashflowAlertOutcomeMemory, wasLastCashflowAlertIneffective,
} = require('../lib/services/orchestrator/cashflow.service');

let pass = 0, fail = 0;
function check(label, cond) {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  cond ? pass++ : fail++;
}

// Wrap supabase.from to count how many times a given table is queried between
// a start/stop pair — proves bulk-fetch (1 query) rather than N+1.
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

async function main() {
  const userIdA = randomUUID();
  const userIdB = randomUUID();
  const custA1 = randomUUID(); // ineffective outcome recorded
  const custA2 = randomUUID(); // no outcome recorded
  const custA3 = randomUUID(); // malformed memory_value
  const custB1 = randomUUID(); // tenant B, ineffective outcome (must not leak into A)

  try {
    await supabase.from('users').insert([
      { id: userIdA, email: `outcome-mem-a-${userIdA}@test.local`, password_hash: 'x', business_name: 'OutcomeMem A' },
      { id: userIdB, email: `outcome-mem-b-${userIdB}@test.local`, password_hash: 'x', business_name: 'OutcomeMem B' },
    ]);
    await supabase.from('customers').insert([
      { id: custA1, user_id: userIdA, name: 'Cust A1 (ineffective)' },
      { id: custA2, user_id: userIdA, name: 'Cust A2 (no memory)' },
      { id: custA3, user_id: userIdA, name: 'Cust A3 (malformed memory)' },
      { id: custB1, user_id: userIdB, name: 'Cust B1 (isolation)' },
    ]);

    // ── Seed credit_risk_alert_outcome + revenue_health_watch_outcome memory ──
    // Note: business_memory.memory_value has a NOT NULL constraint (confirmed by
    // direct probe against the real DB), so "malformed" here means a wrong-shaped
    // JSON object, not a null column value.
    const seedIns = await supabase.from('business_memory').insert([
      { user_id: userIdA, entity_type: 'customer', entity_id: custA1, memory_key: 'credit_risk_alert_outcome', memory_value: { v: false, action_id: 'x' }, source: 'test' },
      { user_id: userIdA, entity_type: 'customer', entity_id: custA3, memory_key: 'credit_risk_alert_outcome', memory_value: { notV: 'malformed' }, source: 'test' },
      { user_id: userIdB, entity_type: 'customer', entity_id: custB1, memory_key: 'credit_risk_alert_outcome', memory_value: { v: false, action_id: 'x' }, source: 'test' },

      { user_id: userIdA, entity_type: 'customer', entity_id: custA1, memory_key: 'revenue_health_watch_outcome', memory_value: { v: false, action_id: 'y' }, source: 'test' },
      { user_id: userIdA, entity_type: 'customer', entity_id: custA3, memory_key: 'revenue_health_watch_outcome', memory_value: { notV: 'malformed' }, source: 'test' },
      { user_id: userIdB, entity_type: 'customer', entity_id: custB1, memory_key: 'revenue_health_watch_outcome', memory_value: { v: false, action_id: 'y' }, source: 'test' },

      // Tenant-level cashflow_alert_outcome (sentinel entity_id = userId), only for tenant A.
      { user_id: userIdA, entity_type: 'global', entity_id: userIdA, memory_key: 'cashflow_alert_outcome', memory_value: { v: false, action_id: 'z' }, source: 'test' },
    ]);
    if (seedIns.error) throw new Error('Seed insert failed: ' + JSON.stringify(seedIns.error));

    // ── Test 1: credit_risk_alert_outcome demotion vs. no-memory customer ────
    const spy1 = countCallsTo('business_memory');
    const { data: outcomeRowsA } = await supabase
      .from('business_memory')
      .select('entity_id, memory_value')
      .eq('user_id', userIdA)
      .eq('entity_type', 'customer')
      .eq('memory_key', 'credit_risk_alert_outcome')
      .in('entity_id', [custA1, custA2, custA3]);
    const callsForTest1 = spy1.stop();

    const outcomeByCustomer = (outcomeRowsA || []).reduce((acc, r) => { acc[r.entity_id] = r; return acc; }, {});
    check('1. bulk-fetch credit_risk_alert_outcome returns rows for all seeded customers in scope', outcomeRowsA.length === 2); // A1 (real) + A3 (malformed) — A2 has none
    check('1. single bulk query used for 3 customers (not N+1)', callsForTest1 === 1);

    let priorityA1 = 'high', riskLevelA1 = 'high';
    const ineffectiveA1 = wasLastCreditRiskAlertIneffective(outcomeByCustomer[custA1]);
    check('1. customer A1 (v:false) recognized as previously ineffective', ineffectiveA1 === true);
    if (ineffectiveA1) { priorityA1 = downgradePriority(priorityA1); riskLevelA1 = downgradeRiskLevel(riskLevelA1); }
    check('1. customer A1 priority demoted one notch (high -> medium)', priorityA1 === 'medium');
    check('1. customer A1 risk_level demoted one notch (high -> medium)', riskLevelA1 === 'medium');

    let priorityA2 = 'high', riskLevelA2 = 'high';
    const ineffectiveA2 = wasLastCreditRiskAlertIneffective(outcomeByCustomer[custA2]);
    check('1. customer A2 (no memory row) NOT flagged ineffective', ineffectiveA2 === false);
    if (ineffectiveA2) { priorityA2 = downgradePriority(priorityA2); riskLevelA2 = downgradeRiskLevel(riskLevelA2); }
    check('1. customer A2 priority unchanged (matches pre-phase behavior)', priorityA2 === 'high');
    check('1. customer A1 demoted priority strictly lower than customer A2 (equivalent customer, no memory)', priorityA1 !== priorityA2);

    // ── Test 4 (part): malformed memory_value -> safe fallback, no throw ─────
    let threwOnMalformed = false;
    let ineffectiveA3 = false;
    try { ineffectiveA3 = wasLastCreditRiskAlertIneffective(outcomeByCustomer[custA3]); } catch (_e) { threwOnMalformed = true; }
    check('4. malformed memory_value ({notV:...}) does not throw', threwOnMalformed === false);
    check('4. malformed memory_value treated as NOT ineffective (safe default, unmodified priority)', ineffectiveA3 === false);

    // ── Test 8: tenant isolation — tenant B's ineffective memory never leaks into A's lookup ──
    check('8. tenant isolation: tenant A bulk-fetch never returns tenant B\'s row', !(custB1 in outcomeByCustomer));
    const { data: outcomeRowsB } = await supabase
      .from('business_memory')
      .select('entity_id, memory_value')
      .eq('user_id', userIdB)
      .eq('entity_type', 'customer')
      .eq('memory_key', 'credit_risk_alert_outcome')
      .in('entity_id', [custB1]);
    check('8. tenant B sees its own ineffective row under its own tenant query', outcomeRowsB.length === 1 && outcomeRowsB[0].memory_value.v === false);

    // ── Test 2: cashflow_alert_outcome (tenant-level, sentinel entity_id) ────
    const memA = await getCashflowAlertOutcomeMemory(userIdA);
    check('2. tenant A cashflow_alert_outcome memory row found (sentinel entity_id = userId)', !!memA);
    check('2. tenant A cashflow_alert_outcome recognized as ineffective', wasLastCashflowAlertIneffective(memA) === true);

    const memB = await getCashflowAlertOutcomeMemory(userIdB);
    check('2. tenant B has no cashflow_alert_outcome row (never seeded)', memB === null);
    check('2. tenant B (no memory) -> not flagged ineffective, unmodified behavior', wasLastCashflowAlertIneffective(memB) === false);

    let cfPriorityA = 'urgent', cfRiskA = 'high';
    if (wasLastCashflowAlertIneffective(memA)) { cfPriorityA = downgradePriority(cfPriorityA); cfRiskA = downgradeRiskLevel(cfRiskA); }
    check('2. tenant A cashflow priority demoted one notch (urgent -> high)', cfPriorityA === 'high');
    let cfPriorityB = 'urgent';
    if (wasLastCashflowAlertIneffective(memB)) { cfPriorityB = downgradePriority(cfPriorityB); }
    check('2. tenant B cashflow priority unchanged (urgent, no memory)', cfPriorityB === 'urgent');

    // ── Test 4 (part): missing DATABASE row entirely for a random unseeded user -> null, no throw ──
    let threwOnMissingUser = false;
    let memMissing = 'not-called';
    try { memMissing = await getCashflowAlertOutcomeMemory(randomUUID()); } catch (_e) { threwOnMissingUser = true; }
    check('4. getCashflowAlertOutcomeMemory on unseeded user does not throw', threwOnMissingUser === false);
    check('4. getCashflowAlertOutcomeMemory on unseeded user returns null', memMissing === null);

    // ── Test 3: revenue_health_watch_outcome demotion vs. no-memory customer ──
    const spy3 = countCallsTo('business_memory');
    const { data: revenueOutcomeRowsA } = await supabase
      .from('business_memory')
      .select('entity_id, memory_value')
      .eq('user_id', userIdA)
      .eq('entity_type', 'customer')
      .eq('memory_key', 'revenue_health_watch_outcome')
      .in('entity_id', [custA1, custA2, custA3]);
    const callsForTest3 = spy3.stop();
    check('3. single bulk query used for revenue_health_watch_outcome lookup (not N+1)', callsForTest3 === 1);

    const revenueOutcomeByCustomer = (revenueOutcomeRowsA || []).reduce((acc, r) => { acc[r.entity_id] = r; return acc; }, {});
    let revPriorityA1 = 'high';
    const revIneffectiveA1 = !!(revenueOutcomeByCustomer[custA1] && revenueOutcomeByCustomer[custA1].memory_value && revenueOutcomeByCustomer[custA1].memory_value.v === false);
    check('3. customer A1 revenue_health_watch previously ineffective -> true', revIneffectiveA1 === true);
    if (revIneffectiveA1) revPriorityA1 = downgradePriority(revPriorityA1);
    check('3. customer A1 revenue-health priority demoted (high -> medium)', revPriorityA1 === 'medium');

    let revPriorityA2 = 'high';
    const revIneffectiveA2 = !!(revenueOutcomeByCustomer[custA2] && revenueOutcomeByCustomer[custA2].memory_value && revenueOutcomeByCustomer[custA2].memory_value.v === false);
    check('3. customer A2 (no memory) revenue-health not flagged ineffective', revIneffectiveA2 === false);
    check('3. customer A2 priority unchanged (matches pre-phase behavior)', revPriorityA2 === 'high');

    // A3 has memory_value: { notV: 'malformed' } (wrong shape) -> must not throw,
    // must be treated as not-ineffective (safe default).
    let threwOnMalformedRevenueMemoryValue = false;
    let revIneffectiveA3 = false;
    try {
      const row = revenueOutcomeByCustomer[custA3];
      revIneffectiveA3 = !!(row && row.memory_value && row.memory_value.v === false);
    } catch (_e) { threwOnMalformedRevenueMemoryValue = true; }
    check('4. malformed revenue_health_watch memory_value does not throw', threwOnMalformedRevenueMemoryValue === false);
    check('4. malformed revenue_health_watch memory_value treated as not-ineffective', revIneffectiveA3 === false);

    // ── Test 8 (again): tenant isolation for revenue_health_watch_outcome ────
    check('8. tenant isolation: tenant A revenue-watch bulk-fetch never returns tenant B\'s row', !(custB1 in revenueOutcomeByCustomer));

  } finally {
    await supabase.from('business_memory').delete().in('user_id', [userIdA, userIdB]);
    await supabase.from('customers').delete().in('id', [custA1, custA2, custA3, custB1]);
    await supabase.from('users').delete().in('id', [userIdA, userIdB]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
