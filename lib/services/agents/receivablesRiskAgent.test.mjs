// Real-DB proof for Phase B (Verified Execution Loop V1 — Receivables) of
// receivablesRiskAgent.js. Seeds synthetic tenants against the real local
// DATABASE_URL (pg-backed supabase shim — same client every other agent in
// this codebase uses), exercises assembleReceivablesEvidence() end-to-end,
// and deletes everything it created in a finally block.
//
// Also proves bulk-fetch (one query per relevant table per tenant run, never
// per-invoice) by instrumenting supabase.from() and counting calls per table,
// mirroring scripts/test-outcome-memory-consultation-integration.js's approach.
//
// Run: node lib/services/agents/receivablesRiskAgent.test.mjs
import 'dotenv/config';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { randomUUID } = require('crypto');
const { supabase } = require('../../config/supabaseClient');
const { assembleReceivablesEvidence, riskLevelFromTier, buildEvidenceStrings, REQUIRES_APPROVAL } = require('./receivablesRiskAgent.js');

let pass = 0, fail = 0;
function check(label, cond) {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  cond ? pass++ : fail++;
}

// ── Offline / pure-function checks ──────────────────────────────────────────
check('riskLevelFromTier HIGH_RISK -> high', riskLevelFromTier('HIGH_RISK') === 'high');
check('riskLevelFromTier MEDIUM -> medium', riskLevelFromTier('MEDIUM') === 'medium');
check('riskLevelFromTier LOW -> low', riskLevelFromTier('LOW') === 'low');
check('riskLevelFromTier unknown tier -> unknown', riskLevelFromTier(null) === 'unknown');
check('REQUIRES_APPROVAL mirrors always-approval convention (true)', REQUIRES_APPROVAL === true);

{
  const ev = buildEvidenceStrings({ invoiceAmount: 45000, daysOverdue: 62, customerResolved: true, creditRiskScore: 82, tier: 'HIGH_RISK', brokenPromiseCount: 1, activePromise: null });
  check('evidence string: exact amount+days phrasing', ev[0] === '₹45,000 overdue by 62 days');
  check('evidence string: exact credit risk phrasing', ev.includes('Credit risk HIGH, score 82/100'));
  check('evidence string: exact broken-promise phrasing', ev.includes('1 broken promise on this account'));
}
{
  const ev = buildEvidenceStrings({ invoiceAmount: 1000, daysOverdue: 1, customerResolved: false });
  check('evidence string: singular "day" for 1', ev[0] === '₹1,000 overdue by 1 day');
  check('evidence string: unresolved customer degrades cleanly, no crash', ev.some(e => e.includes('could not be resolved')));
}

// ── Real-DB integration ─────────────────────────────────────────────────────
async function seedTenant(userId, label) {
  await supabase.from('users').insert([{ id: userId, email: `phaseB-${userId}@test.local`, password_hash: 'x', business_name: `PhaseB ${label}` }]);
}

async function cleanupTenant(userId) {
  await supabase.from('promises').delete().eq('user_id', userId);
  await supabase.from('customer_score_history').delete().eq('user_id', userId);
  await supabase.from('customer_scores').delete().eq('user_id', userId);
  await supabase.from('invoices').delete().eq('user_id', userId);
  await supabase.from('customers').delete().eq('user_id', userId);
  await supabase.from('users').delete().eq('id', userId);
}

async function main() {
  const userA = randomUUID(); // tenant under test
  const userB = randomUUID(); // isolation-check tenant

  const custLinked   = randomUUID(); // A: real link, real score, broken promises, active promise
  const custPromise  = randomUUID(); // A: active unfulfilled promise
  const custBOther   = randomUUID(); // B: isolation check

  let invUnresolvableId = null;

  try {
    // ── Scenario setup ──
    await seedTenant(userA, 'TenantA');
    await seedTenant(userB, 'TenantB');

    await supabase.from('customers').insert([
      { id: custLinked,  user_id: userA, name: 'Linked Customer' },
      { id: custPromise, user_id: userA, name: 'Promise Customer' },
      { id: custBOther,  user_id: userB, name: 'TenantB Customer' },
    ]);

    await supabase.from('customer_scores').insert([
      { user_id: userA, customer_id: custLinked,  credit_risk_score: 82, broken_promise_count: 2, promise_reliability_score: 40, collection_priority_score: 90 },
      { user_id: userA, customer_id: custPromise, credit_risk_score: 55, broken_promise_count: 0, promise_reliability_score: 80, collection_priority_score: 50 },
      { user_id: userB, customer_id: custBOther,  credit_risk_score: 95, broken_promise_count: 5, promise_reliability_score: 10, collection_priority_score: 99 },
    ]);

    // Trajectory history for custLinked: deteriorating (latest > previous).
    // Explicit, distinct recorded_at values (rather than relying on DB defaults,
    // which can land in the same millisecond for two inserts in one batch and
    // make "latest" ambiguous) so classifyScoreTrajectory()'s DESC ordering is
    // deterministic in this test.
    await supabase.from('customer_score_history').insert([
      { user_id: userA, customer_id: custLinked, credit_risk_score: 60, promise_reliability_score: 50, broken_promise_count: 1, collection_priority_score: 70, recorded_at: '2026-08-01T00:00:00.000Z' },
      { user_id: userA, customer_id: custLinked, credit_risk_score: 82, promise_reliability_score: 40, broken_promise_count: 2, collection_priority_score: 90, recorded_at: '2026-09-01T00:00:00.000Z' },
    ]);

    // Invoice 1: full real link (scenario 1).
    const { data: invLinked } = await supabase.from('invoices').insert([{
      user_id: userA, customer_id: custLinked, customer_name: 'Linked Customer',
      invoice_amount: 45000, payment_status: 'Pending', days_overdue: 62,
      due_date: '2026-07-01',
    }]).select().single();

    // Invoice 2: null customer_id AND unresolvable name (scenario 2 — degrades gracefully).
    const { data: invUnresolvable } = await supabase.from('invoices').insert([{
      user_id: userA, customer_id: null, customer_name: 'No Such Customer Anywhere XYZ123',
      invoice_amount: 3000, payment_status: 'Pending', days_overdue: 15,
    }]).select().single();
    invUnresolvableId = invUnresolvable.id;

    // Invoice 3: linked to custPromise, with a currently-active unfulfilled promise (scenario 3).
    const { data: invPromise } = await supabase.from('invoices').insert([{
      user_id: userA, customer_id: custPromise, customer_name: 'Promise Customer',
      invoice_amount: 12000, payment_status: 'Pending', days_overdue: 10,
    }]).select().single();

    await supabase.from('promises').insert([{
      user_id: userA, customer_id: custPromise, receivable_id: invPromise.id,
      promised_amount: 12000, promised_date: '2026-09-20', status: 'active',
    }]);

    // Tenant B invoice — must never leak into tenant A's results (scenario 4).
    await supabase.from('invoices').insert([{
      user_id: userB, customer_id: custBOther, customer_name: 'TenantB Customer',
      invoice_amount: 99999, payment_status: 'Pending', days_overdue: 99,
    }]);

    // ── Scenario 5: bulk-fetch instrumentation ──
    const callCounts = {};
    const originalFrom = supabase.from.bind(supabase);
    supabase.from = (table) => {
      callCounts[table] = (callCounts[table] || 0) + 1;
      return originalFrom(table);
    };

    const bundlesA = await assembleReceivablesEvidence(userA);

    supabase.from = originalFrom; // restore immediately after the call under test

    // 3 invoices for tenant A, all with distinct customer_ids/none — if any table
    // were queried per-invoice, invoices/customer_scores/customer_score_history/
    // promises would show 3+ calls instead of exactly 1 each (invoices is exactly
    // 1 because it's the initial bulk select; the others are exactly 1 because
    // they're each a single `.in(...)` bulk call regardless of invoice count).
    check('bulk-fetch: invoices queried exactly once per tenant run', callCounts.invoices === 1);
    check('bulk-fetch: customer_scores queried exactly once per tenant run (not per-invoice)', callCounts.customer_scores === 1);
    check('bulk-fetch: customer_score_history queried exactly once per tenant run (not per-invoice)', callCounts.customer_score_history === 1);
    check('bulk-fetch: promises queried exactly once per tenant run (not per-invoice)', callCounts.promises === 1);

    check('assembleReceivablesEvidence returns one bundle per overdue invoice for tenant A', bundlesA.length === 3);

    // ── Scenario 1: real link, real score, real broken_promise_count ──
    const b1 = bundlesA.find(b => b.invoice_id === invLinked.id);
    check('scenario1: bundle found for linked invoice', !!b1);
    check('scenario1: customer_id resolved correctly', b1.customer_id === custLinked);
    check('scenario1: outstanding_amount matches', Number(b1.outstanding_amount) === 45000);
    check('scenario1: days_overdue matches', b1.days_overdue === 62);
    check('scenario1: credit_risk_score matches real stored value', Number(b1.credit_risk_score) === 82);
    check('scenario1: risk_tier reuses creditRiskAgent.deriveTier (82 -> HIGH_RISK)', b1.risk_tier === 'HIGH_RISK');
    check('scenario1: broken_promise_count matches real stored value', b1.broken_promise_count === 2);
    check('scenario1: trajectory correctly DETERIORATING from real history rows', b1.trajectory === 'DETERIORATING');
    check('scenario1: evidence[0] exact amount+days string', b1.evidence[0] === '₹45,000 overdue by 62 days');
    check('scenario1: evidence contains exact credit-risk string', b1.evidence.includes('Credit risk HIGH, score 82/100'));
    check('scenario1: evidence contains exact broken-promise string', b1.evidence.includes('2 broken promises on this account'));
    check('scenario1: evidence contains deteriorating-trajectory string', b1.evidence.includes('Credit risk trajectory is DETERIORATING across recent snapshots.'));
    check('scenario1: risk_level derived from tier (high)', b1.risk_level === 'high');
    check('scenario1: requires_approval mirrors always-approval convention', b1.requires_approval === true);
    check('scenario1: active_promise false (no promise row for this invoice)', b1.active_promise === false);

    // ── Scenario 2: unresolvable customer_id degrades gracefully ──
    const b2 = bundlesA.find(b => b.invoice_id === invUnresolvableId);
    check('scenario2: bundle still produced for unresolvable customer (no crash)', !!b2);
    check('scenario2: customer_id is null, not fabricated', b2.customer_id === null);
    check('scenario2: credit_risk_score absent (null), not fabricated', b2.credit_risk_score === null);
    check('scenario2: risk_tier absent (null)', b2.risk_tier === null);
    check('scenario2: risk_level is "unknown", not a guessed level', b2.risk_level === 'unknown');
    check('scenario2: evidence explains the degraded state', b2.evidence.some(e => e.includes('could not be resolved')));
    check('scenario2: outstanding_amount/days_overdue still populated from the invoice row itself', Number(b2.outstanding_amount) === 3000 && b2.days_overdue === 15);

    // ── Scenario 3: active unfulfilled promise reflected ──
    const b3 = bundlesA.find(b => b.invoice_id === invPromise.id);
    check('scenario3: bundle found for promise invoice', !!b3);
    check('scenario3: active_promise is true', b3.active_promise === true);
    check('scenario3: active_promise_details carries the real promised_date', b3.active_promise_details && b3.active_promise_details.promised_date === '2026-09-20');
    check('scenario3: evidence contains the active-promise string', b3.evidence.some(e => e.includes('Active promise-to-pay on this invoice')));

    // ── Scenario 4: tenant isolation ──
    const leaked = bundlesA.some(b => b.invoice_id && String(b.outstanding_amount) === '99999');
    check('scenario4: tenant A evidence never includes tenant B\'s invoice', !leaked);
    const bundlesB = await assembleReceivablesEvidence(userB);
    check('scenario4: tenant B sees only its own invoice', bundlesB.length === 1 && Number(bundlesB[0].outstanding_amount) === 99999);
    check('scenario4: tenant B\'s customer_id is its own, never tenant A\'s', bundlesB[0].customer_id === custBOther);

    // ── Scenario 6: zero-data tenant ──
    const emptyTenant = randomUUID();
    await seedTenant(emptyTenant, 'EmptyTenant');
    const bundlesEmpty = await assembleReceivablesEvidence(emptyTenant);
    check('scenario6: zero-overdue-invoice tenant returns empty array, no crash', Array.isArray(bundlesEmpty) && bundlesEmpty.length === 0);
    await cleanupTenant(emptyTenant);

    // ── Scenario 7: static check ──
    const { execSync } = require('child_process');
    execSync('node --check "' + require.resolve('./receivablesRiskAgent.js') + '"');
    check('scenario7: node --check passes on receivablesRiskAgent.js', true);

  } finally {
    await cleanupTenant(userA);
    await cleanupTenant(userB);

    // Verify zero residue.
    const { data: leftoverInvoicesA } = await supabase.from('invoices').select('id').eq('user_id', userA);
    const { data: leftoverInvoicesB } = await supabase.from('invoices').select('id').eq('user_id', userB);
    const { data: leftoverUsersA } = await supabase.from('users').select('id').eq('id', userA);
    check('cleanup: tenant A invoices fully removed', !leftoverInvoicesA || leftoverInvoicesA.length === 0);
    check('cleanup: tenant B invoices fully removed', !leftoverInvoicesB || leftoverInvoicesB.length === 0);
    check('cleanup: tenant A user row fully removed', !leftoverUsersA || leftoverUsersA.length === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
