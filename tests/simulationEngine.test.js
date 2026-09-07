// Verifies the fix for simulationEngine.service.js checking guardResult.blocked
// (a field policyGuard.validate() never returns) instead of the real contract:
// guardResult.status === 'system_blocked' (the same check server.js:2854 already
// uses correctly in the live emitBusinessEvent pipeline).
//
// Strategy: policyGuard.validate() is the single source of truth for "blocked".
// We test it directly (an allowed action and a system-blocked action), then
// verify simulationEngine's own guardResult-interpretation logic by injecting a
// stub rules.service into Node's require cache — the two real dependencies
// (rules.service, policyGuard.service) are declared with plain `require()`
// inside simulate(), so pre-populating require.cache is a legitimate,
// no-library way to isolate simulate()'s bug from rules.service's own logic.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const assert = require('assert');
const path = require('path');
const Module = require('module');

const policyGuard = require('../lib/services/orchestrator/policyGuard.service');

async function testPolicyGuardContract() {
  // Allowed action: no blocked phrase, not a forbidden type, no amount mismatch.
  const allowed = await policyGuard.validate({
    action_type: 'SEND_POLITE_REMINDER',
    title: 'Reminder',
  }, 'fake-user-id-not-persisted');
  assert.notStrictEqual(allowed.status, 'system_blocked', 'benign action must not be blocked');
  assert.strictEqual(allowed.blocked, undefined, 'policyGuard never sets a `.blocked` field — confirms the bug\'s root cause');

  // System-blocked action: a forbidden action_type.
  const blocked = await policyGuard.validate({
    action_type: 'MARK_PAID',
    title: 'Mark invoice paid',
  }, 'fake-user-id-not-persisted');
  assert.strictEqual(blocked.status, 'system_blocked', 'forbidden action_type must be blocked');
  assert(blocked.block_reason.includes('MARK_PAID'), 'block_reason must explain why');
  assert.strictEqual(blocked.blocked, undefined, 'still no `.blocked` field on the blocked branch either');

  console.log('[PASS] policyGuard.validate() contract confirmed: status/block_reason, never .blocked');
}

async function testSimulationEngineReportsBlockCorrectly() {
  const rulesPath = path.resolve(__dirname, '../lib/services/orchestrator/rules.service.js');

  // Stub rules.service.evaluate() to return one allowed and one blocked candidate,
  // bypassing the need to seed real overdue invoices to trigger a rule naturally.
  const stubExports = {
    evaluate: async () => [
      { action_type: 'SEND_POLITE_REMINDER', title: 'Allowed candidate' },
      { action_type: 'MARK_PAID', title: 'Blocked candidate' },
    ],
  };
  const stubModule = new Module(rulesPath, null);
  stubModule.exports = stubExports;
  stubModule.loaded = true;
  const previous = require.cache[rulesPath];
  require.cache[rulesPath] = stubModule;

  try {
    delete require.cache[path.resolve(__dirname, '../lib/services/orchestrator/simulationEngine.service.js')];
    const { simulate } = require('../lib/services/orchestrator/simulationEngine.service');

    const result = await simulate('fake-user-id-not-persisted', 'SALE_CREATED', {});

    assert.strictEqual(result.wouldCreate.length, 1, 'exactly one candidate should be reported as would-create');
    assert.strictEqual(result.wouldCreate[0].action_type, 'SEND_POLITE_REMINDER');

    assert.strictEqual(result.wouldBlock.length, 1, 'exactly one candidate should be reported as would-block — this is the bug the fix addresses');
    assert(result.wouldBlock[0].includes('MARK_PAID'), 'wouldBlock entry must name the blocked action');
    assert(result.estimatedImpact.includes('blocked by policy'), 'summary text must mention the block');

    console.log('[PASS] simulationEngine now correctly reports would-block using guardResult.status');
  } finally {
    if (previous) require.cache[rulesPath] = previous;
    else delete require.cache[rulesPath];
  }
}

async function main() {
  await testPolicyGuardContract();
  await testSimulationEngineReportsBlockCorrectly();
}

main().catch(err => { console.error('[FAIL] simulationEngine test:', err.message); process.exit(1); });
