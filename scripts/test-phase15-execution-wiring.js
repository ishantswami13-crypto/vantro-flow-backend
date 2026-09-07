// Phase C ("Verified Execution Loop V1 — Receivables") integration verification.
// Exercises commandBus's EXECUTE_RECEIVABLES_ACTION handler end-to-end against
// the live local DB (via DATABASE_URL, through the pg-backed supabase shim).
// Seeds synthetic tenants/customers/actions, asserts every invariant from the
// phase brief, and deletes everything it created in a finally block.
//
// Run: node scripts/test-phase15-execution-wiring.js
require('dotenv').config();
const { randomUUID } = require('crypto');
const { supabase } = require('../lib/config/supabaseClient');
const commandBus = require('../lib/services/orchestrator/commandBus.service');
const testAdapter = require('../lib/services/messaging/testMessageAdapter');

let pass = 0, fail = 0;
function check(label, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  cond ? pass++ : fail++;
}

async function seedTenant(userId, label) {
  await supabase.from('users').insert([{ id: userId, email: `phase15-${userId}@test.local`, password_hash: 'x', business_name: `Phase15 ${label}` }]);
}

async function seedCustomer(userId, customerId, phone) {
  await supabase.from('customers').insert([{ id: customerId, user_id: userId, name: 'Phase15 Customer', phone }]);
}

async function seedAction(userId, actionId, customerId, status) {
  await supabase.from('ai_actions').insert([{
    id: actionId,
    user_id: userId,
    action_type: 'CHASE_CUSTOMER',
    title: 'Chase overdue invoice',
    description: 'Test action',
    customer_id: customerId,
    status,
    recommended_message: 'Hi, your invoice is overdue.',
  }]);
}

async function cleanupTenant(userId) {
  await supabase.from('execution_records').delete().eq('user_id', userId);
  await supabase.from('ai_actions').delete().eq('user_id', userId);
  await supabase.from('customers').delete().eq('user_id', userId);
  await supabase.from('users').delete().eq('id', userId);
}

async function main() {
  const userA = randomUUID();
  const userB = randomUUID(); // cross-tenant isolation check
  const custA = randomUUID();
  const actionApproved = randomUUID();
  const actionPending  = randomUUID();

  // Spy on the real sender to prove it is never invoked (scenario 5).
  let realSenderCalls = 0;
  const realSenderSpy = async () => { realSenderCalls++; return { success: true, sid: 'REAL-SHOULD-NEVER-HAPPEN' }; };

  // Spy on the test adapter's send() to count invocations (scenario 3).
  const originalSend = testAdapter.send;
  let adapterCalls = 0;
  testAdapter.send = async (...args) => { adapterCalls++; return originalSend(...args); };

  try {
    await seedTenant(userA, 'A');
    await seedTenant(userB, 'B');
    await seedCustomer(userA, custA, '+15550001111');
    await seedAction(userA, actionApproved, custA, 'approved');
    await seedAction(userA, actionPending, custA, 'pending');

    // Confirm flag really is off in this environment.
    check('FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED is unset/off in this env',
      String(process.env.FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED || '').toLowerCase() !== 'true');

    // ── Scenario 1: approved action executes via test adapter ──────────────
    const r1 = await commandBus.dispatch(userA, 'EXECUTE_RECEIVABLES_ACTION', {
      actionId: actionApproved, realSender: realSenderSpy,
    });
    check('Scenario 1: dispatch succeeded', r1.success === true);
    check('Scenario 1: channel is test', r1.result?.executionRecord?.channel === 'test');
    check('Scenario 1: status is sent', r1.result?.executionRecord?.status === 'sent');
    check('Scenario 1: provider_message_id looks fake', String(r1.result?.executionRecord?.provider_message_id || '').startsWith('test-'));

    const { data: execRowsAfter1 } = await supabase.from('execution_records').select('*').eq('user_id', userA).eq('ai_action_id', actionApproved);
    check('Scenario 1: exactly one execution_records row', (execRowsAfter1 || []).length === 1);

    const { data: actionAfter1 } = await supabase.from('ai_actions').select('*').eq('id', actionApproved).single();
    check('Scenario 1: ai_actions.status is done', actionAfter1?.status === 'done');

    // ── Scenario 2: non-approved action rejected, no side effects ──────────
    const r2 = await commandBus.dispatch(userA, 'EXECUTE_RECEIVABLES_ACTION', {
      actionId: actionPending, realSender: realSenderSpy,
    });
    check('Scenario 2: dispatch failed', r2.success === false);
    check('Scenario 2: errorCode NOT_APPROVED', r2.errorCode === 'NOT_APPROVED');
    const { data: execRowsPending } = await supabase.from('execution_records').select('*').eq('user_id', userA).eq('ai_action_id', actionPending);
    check('Scenario 2: no execution_records row created', (execRowsPending || []).length === 0);
    const { data: pendingAfter } = await supabase.from('ai_actions').select('*').eq('id', actionPending).single();
    check('Scenario 2: ai_actions.status unchanged (pending)', pendingAfter?.status === 'pending');

    // ── Scenario 3: duplicate execution of same action/key ─────────────────
    const adapterCallsBefore = adapterCalls;
    const r3 = await commandBus.dispatch(userA, 'EXECUTE_RECEIVABLES_ACTION', {
      actionId: actionApproved, realSender: realSenderSpy,
    });
    check('Scenario 3: dispatch succeeded (returns existing)', r3.success === true);
    check('Scenario 3: marked duplicate', r3.result?.duplicate === true);
    check('Scenario 3: returned same execution record id', r3.result?.executionRecord?.id === r1.result?.executionRecord?.id);
    check('Scenario 3: adapter.send() NOT called again', adapterCalls === adapterCallsBefore);
    const { data: execRowsAfter3 } = await supabase.from('execution_records').select('*').eq('user_id', userA).eq('ai_action_id', actionApproved);
    check('Scenario 3: still exactly one execution_records row', (execRowsAfter3 || []).length === 1);

    // ── Scenario 4: cross-tenant attempt rejected ───────────────────────────
    const r4 = await commandBus.dispatch(userB, 'EXECUTE_RECEIVABLES_ACTION', {
      actionId: actionApproved, realSender: realSenderSpy,
    });
    check('Scenario 4: cross-tenant dispatch failed', r4.success === false);
    check('Scenario 4: errorCode NOT_FOUND (tenant-scoped fetch misses)', r4.errorCode === 'NOT_FOUND');
    const { data: execRowsAfter4 } = await supabase.from('execution_records').select('*').eq('user_id', userA).eq('ai_action_id', actionApproved);
    check('Scenario 4: no extra execution_records row from cross-tenant attempt', (execRowsAfter4 || []).length === 1);

    // ── Scenario 5: real sender genuinely unreachable with flag off ────────
    check('Scenario 5: real sender was NEVER invoked across all calls above', realSenderCalls === 0);

    // ── Scenario 6: execution_records fields sensible for test channel ─────
    const rec1 = r1.result.executionRecord;
    check('Scenario 6: provider_message_id present and prefixed test-', typeof rec1.provider_message_id === 'string' && rec1.provider_message_id.startsWith('test-'));
    check('Scenario 6: idempotency_key equals actionId (default)', rec1.idempotency_key === actionApproved);
    check('Scenario 6: attempt_count is 1', Number(rec1.attempt_count) === 1);
    check('Scenario 6: sent_at populated', !!rec1.sent_at);
    check('Scenario 6: delivered_at NOT populated (test adapter cannot prove delivery)', !rec1.delivered_at);

    // ── Sequential retry with explicit idempotency key (extra duplicate proof) ──
    const actionApproved2 = randomUUID();
    await seedAction(userA, actionApproved2, custA, 'approved');
    const explicitKey = 'explicit-key-' + actionApproved2;
    const r5a = await commandBus.dispatch(userA, 'EXECUTE_RECEIVABLES_ACTION', { actionId: actionApproved2, idempotencyKey: explicitKey, realSender: realSenderSpy });
    const r5b = await commandBus.dispatch(userA, 'EXECUTE_RECEIVABLES_ACTION', { actionId: actionApproved2, idempotencyKey: explicitKey, realSender: realSenderSpy });
    check('Explicit idempotency key: first call succeeds, not duplicate', r5a.success && r5a.result.duplicate === false);
    check('Explicit idempotency key: second call is duplicate', r5b.success && r5b.result.duplicate === true);
    const { data: execRowsAction2 } = await supabase.from('execution_records').select('*').eq('user_id', userA).eq('ai_action_id', actionApproved2);
    check('Explicit idempotency key: exactly one row total', (execRowsAction2 || []).length === 1);

  } finally {
    testAdapter.send = originalSend;
    await cleanupTenant(userA);
    await cleanupTenant(userB);
    // Verify zero residue.
    const { data: leftoverExec } = await supabase.from('execution_records').select('id').eq('user_id', userA);
    const { data: leftoverActions } = await supabase.from('ai_actions').select('id').eq('user_id', userA);
    const { data: leftoverUsers } = await supabase.from('users').select('id').eq('id', userA);
    check('Cleanup: zero residual execution_records', (leftoverExec || []).length === 0);
    check('Cleanup: zero residual ai_actions', (leftoverActions || []).length === 0);
    check('Cleanup: zero residual users', (leftoverUsers || []).length === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
