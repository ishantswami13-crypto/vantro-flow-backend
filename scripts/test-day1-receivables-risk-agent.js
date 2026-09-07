// Day 1 sprint (2026-09-07) verification: receivablesRiskAgent.js wiring
// into orchestrator.service.js's runAllAgents, end to end against the real
// local dev DB (DATABASE_URL). Creates one synthetic tenant + customer +
// score + invoice with a genuine HIGH_RISK/DETERIORATING signal, runs the
// agent through the real orchestrator path (policyGuard.validate() +
// actionService.create()), asserts a real ai_actions row lands and reaches
// businessState.js's receivablesRisk, then asserts a healthy tenant with no
// qualifying risk produces zero rows (no false positive). Cleans up all
// synthetic rows it creates, verifies zero residue.
//
// Run: node scripts/test-day1-receivables-risk-agent.js
process.env.FEATURE_CORTEX_ENABLED = 'true';
const { randomUUID } = require('crypto');
const { supabase } = require('../lib/config/supabaseClient');
const { runAllAgents } = require('../lib/services/orchestrator/orchestrator.service');
const { loadBusinessState } = require('../lib/domain/intelligence/businessState');
const { qualifiesForAlert } = require('../lib/services/agents/receivablesRiskAgent');

let pass = 0, fail = 0;
function check(label, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  cond ? pass++ : fail++;
}

const cleanup = [];

async function seedTenant({ tag, riskScore, brokenPromiseCount, daysOverdue, amount }) {
  const userId = randomUUID();
  const customerId = randomUUID();
  const invoiceId = randomUUID();

  // invoices/customers/customer_scores all FK to `users` — a real tenant row
  // is required first (this is the actual live schema, not a shortcut).
  await supabase.from('users').insert([{
    id: userId, email: `day1test-${tag}-${userId}@example.invalid`, phone: `9${String(Date.now()).slice(-9)}`,
    business_name: `Day1Test-${tag}`, password_hash: 'x', plan: 'free',
  }]);
  cleanup.push(['users', userId]);

  await supabase.from('customers').insert([{ id: customerId, user_id: userId, name: `Day1Test-${tag}`, phone: '9000000000' }]);
  cleanup.push(['customers', customerId]);

  if (riskScore !== null) {
    await supabase.from('customer_scores').insert([{
      user_id: userId, customer_id: customerId, credit_risk_score: riskScore,
      broken_promise_count: brokenPromiseCount || 0,
    }]);
    cleanup.push(['customer_scores', customerId, userId]);
  }

  await supabase.from('invoices').insert([{
    id: invoiceId, user_id: userId, customer_id: customerId, customer_name: `Day1Test-${tag}`,
    invoice_amount: amount, payment_status: 'Pending', days_overdue: daysOverdue,
    due_date: new Date(Date.now() - daysOverdue * 86400000).toISOString().slice(0, 10),
  }]);
  cleanup.push(['invoices', invoiceId]);

  return { userId, customerId, invoiceId };
}

async function main() {
  // ── Case 1: genuine HIGH_RISK receivable — must produce a real ai_actions row ──
  const risky = await seedTenant({ tag: 'risky', riskScore: 82, brokenPromiseCount: 2, daysOverdue: 40, amount: 75000 });
  const result1 = await runAllAgents(risky.userId, ['receivables_risk']);
  check('risky tenant: runAllAgents reports created >= 1', result1.created >= 1);

  const { data: rows1 } = await supabase.from('ai_actions').select('*').eq('user_id', risky.userId).eq('action_type', 'RECEIVABLES_RISK_ALERT');
  check('risky tenant: exactly one real ai_actions row persisted', (rows1 || []).length === 1);
  if (rows1 && rows1[0]) {
    cleanup.push(['ai_actions', rows1[0].id]);
    check('risky tenant: row has real evidence (not fabricated)', rows1[0].reason_json && rows1[0].reason_json.credit_risk_score === 82);
    check('risky tenant: risk_level is high', rows1[0].risk_level === 'high');
    check('risky tenant: requires_approval is true', rows1[0].requires_approval === true);
  }

  const state1 = await loadBusinessState(supabase, risky.userId);
  check('risky tenant: reaches businessState.receivablesRisk', state1.receivablesRisk.some(a => a.action_type === 'RECEIVABLES_RISK_ALERT'));

  // ── Case 2: healthy tenant (LOW tier, no broken promises, no deterioration)
  // — must produce ZERO alerts, no false positive ──
  const healthy = await seedTenant({ tag: 'healthy', riskScore: 15, brokenPromiseCount: 0, daysOverdue: 3, amount: 5000 });
  const result2 = await runAllAgents(healthy.userId, ['receivables_risk']);
  check('healthy tenant: runAllAgents reports created === 0 (no false positive)', result2.created === 0);
  const { data: rows2 } = await supabase.from('ai_actions').select('id').eq('user_id', healthy.userId).eq('action_type', 'RECEIVABLES_RISK_ALERT');
  check('healthy tenant: zero ai_actions rows persisted', (rows2 || []).length === 0);

  // ── Case 3: overdue invoice with NO customer_scores row at all (thin-history
  // case) — must degrade honestly (unresolved/no-score), never fabricate risk ──
  const noScore = await seedTenant({ tag: 'noscore', riskScore: null, daysOverdue: 10, amount: 8000 });
  const result3 = await runAllAgents(noScore.userId, ['receivables_risk']);
  check('no-score tenant: runAllAgents reports created === 0 (honest degradation, not fabricated risk)', result3.created === 0);

  // ── Pure function unit checks ──
  check('qualifiesForAlert: HIGH_RISK tier qualifies', qualifiesForAlert({ risk_tier: 'HIGH_RISK', trajectory: 'STABLE', broken_promise_count: 0 }) === true);
  check('qualifiesForAlert: DETERIORATING trajectory qualifies', qualifiesForAlert({ risk_tier: 'LOW', trajectory: 'DETERIORATING', broken_promise_count: 0 }) === true);
  check('qualifiesForAlert: broken promises qualify', qualifiesForAlert({ risk_tier: 'LOW', trajectory: 'STABLE', broken_promise_count: 1 }) === true);
  check('qualifiesForAlert: plain LOW/STABLE/no-broken-promise does NOT qualify', qualifiesForAlert({ risk_tier: 'LOW', trajectory: 'STABLE', broken_promise_count: 0 }) === false);
  check('qualifiesForAlert: null bundle does NOT qualify', qualifiesForAlert(null) === false);

  // ── Cleanup ──
  for (const [table, id, extraUserId] of cleanup.reverse()) {
    if (table === 'customer_scores') {
      await supabase.from('customer_scores').delete().eq('customer_id', id).eq('user_id', extraUserId);
    } else if (table === 'ai_actions') {
      await supabase.from('ai_actions').delete().eq('id', id);
    } else if (table === 'users') {
      // deleted last (reverse insertion order handles FK dependents first)
      await supabase.from('users').delete().eq('id', id);
    } else {
      await supabase.from(table).delete().eq('id', id);
    }
  }
  // Verify zero residue for all three synthetic tenants
  let residue = 0;
  for (const u of [risky.userId, healthy.userId, noScore.userId]) {
    for (const table of ['users', 'customers', 'customer_scores', 'invoices', 'ai_actions']) {
      const { data } = await supabase.from(table).select('*').eq(table === 'users' ? 'id' : 'user_id', u);
      residue += (data || []).length;
    }
  }
  check('cleanup: zero synthetic-data residue across all seeded tenants', residue === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('FATAL', err); process.exit(1); });
