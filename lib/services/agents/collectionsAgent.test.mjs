// Offline proof for the Phase 3A Learning-loop fix in collectionsAgent.js.
// No DB, no network — exercises the pure functions extracted for this purpose.
// Run: node lib/services/agents/collectionsAgent.test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  getStage, applyMemoryTonePreference, buildToneMemory, STAGE_CONFIG,
} = require('./collectionsAgent.js');

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✅' : '❌'} ${label}: ${JSON.stringify(got)}${ok ? '' : ' (expected ' + JSON.stringify(want) + ')'}`);
  ok ? pass++ : fail++;
}

const politeStage = STAGE_CONFIG.find(s => s.type === 'SEND_POLITE_REMINDER');
const firmStage   = STAGE_CONFIG.find(s => s.type === 'SEND_FIRM_REMINDER');
const escalateStage = STAGE_CONFIG.find(s => s.type === 'ESCALATE_COLLECTION');
const badDebtStage  = STAGE_CONFIG.find(s => s.type === 'FLAG_BAD_DEBT');

// -- No memory: unchanged behavior ------------------------------------------
check(
  'no memory -> polite stage unchanged',
  applyMemoryTonePreference(politeStage, {}).type,
  'SEND_POLITE_REMINDER'
);
check(
  'no memory -> firm stage unchanged',
  applyMemoryTonePreference(firmStage, undefined).type,
  'SEND_FIRM_REMINDER'
);

// -- Positive learned response -----------------------------------------------
check(
  'polite worked before, currently on firm -> de-escalate to polite',
  applyMemoryTonePreference(firmStage, { polite: { v: true } }).type,
  'SEND_POLITE_REMINDER'
);
check(
  'polite worked before AND firm also worked -> stay on firm (no clear signal to de-escalate)',
  applyMemoryTonePreference(firmStage, { polite: { v: true }, firm: { v: true } }).type,
  'SEND_FIRM_REMINDER'
);

// -- Negative learned response ------------------------------------------------
check(
  'polite failed before, firm worked, currently on polite -> escalate early to firm',
  applyMemoryTonePreference(politeStage, { polite: { v: false }, firm: { v: true } }).type,
  'SEND_FIRM_REMINDER'
);
check(
  'polite failed before but firm has no recorded outcome -> stay on polite (no evidence firm works)',
  applyMemoryTonePreference(politeStage, { polite: { v: false } }).type,
  'SEND_POLITE_REMINDER'
);

// -- Malformed / missing memory -> safe fallback ------------------------------
check(
  'malformed memory value (string instead of object) -> safe fallback, no throw',
  applyMemoryTonePreference(politeStage, { polite: 'not-an-object' }).type,
  'SEND_POLITE_REMINDER'
);
check(
  'null memory -> safe fallback',
  applyMemoryTonePreference(politeStage, null).type,
  'SEND_POLITE_REMINDER'
);
check(
  'undefined stage -> safe fallback (returns undefined, does not throw)',
  applyMemoryTonePreference(undefined, { polite: { v: true } }),
  undefined
);

// -- Escalation/bad-debt stages are never touched by memory -------------------
check(
  'ESCALATE_COLLECTION stage is never nudged by reminder-tone memory',
  applyMemoryTonePreference(escalateStage, { polite: { v: true }, firm: { v: false } }).type,
  'ESCALATE_COLLECTION'
);
check(
  'FLAG_BAD_DEBT stage is never nudged by reminder-tone memory',
  applyMemoryTonePreference(badDebtStage, { polite: { v: false }, firm: { v: false } }).type,
  'FLAG_BAD_DEBT'
);

// -- buildToneMemory: tenant isolation is structural (caller must filter by user_id/entity_id
//    before calling this — this proves the parser itself does not cross tones/keys) -----------
check(
  'buildToneMemory maps memory_key rows to {polite, firm}',
  buildToneMemory([
    { memory_key: 'responds_to_polite_reminder', memory_value: { v: true } },
    { memory_key: 'responds_to_firm_reminder',   memory_value: { v: false } },
  ]),
  { polite: { v: true }, firm: { v: false } }
);
check(
  'buildToneMemory ignores unrelated memory_key rows (e.g. another customer/tenant\'s credit_tier_last leaking in would be ignored, not misread as tone)',
  buildToneMemory([
    { memory_key: 'credit_tier_last', memory_value: { tier: 'HIGH_RISK' } },
  ]),
  {}
);
check(
  'buildToneMemory handles empty/undefined rows -> {}',
  buildToneMemory(undefined),
  {}
);

// -- Regression: existing threshold-only decision (getStage) is unmodified ---
check(
  'getStage(5) still SEND_POLITE_REMINDER (regression, no memory involved at all)',
  getStage(5).type,
  'SEND_POLITE_REMINDER'
);
check(
  'getStage(15) still SEND_FIRM_REMINDER (regression)',
  getStage(15).type,
  'SEND_FIRM_REMINDER'
);
check(
  'getStage(45) still ESCALATE_COLLECTION (regression)',
  getStage(45).type,
  'ESCALATE_COLLECTION'
);
check(
  'getStage(120) still FLAG_BAD_DEBT (regression)',
  getStage(120).type,
  'FLAG_BAD_DEBT'
);

// ============================================================================
// Regression: collectionsAgent must check the REAL policyGuard.validate()
// contract (status === 'system_blocked'), not a non-existent `.blocked` field.
//
// policyGuard.service.js::validate() never sets `.blocked` on its return value
// (confirmed by reading the file: on block it returns
// { ...action, status: 'system_blocked', block_reason, requires_approval:false }).
// So the old collectionsAgent.js line `if (guard.blocked) continue;` was dead
// code — guard.blocked is always undefined for every possible return value,
// meaning it NEVER filtered out a blocked spec.
// ============================================================================

// Part 1: prove the old predicate was structurally broken against the real
// contract, using the actual, real policyGuard.validate() (no mocking) with a
// spec that genuinely trips the BLOCKED_PHRASES rule (step 3 in validate()).
{
  const { validate: realPolicyValidate } = require('../orchestrator/policyGuard.service.js');
  const blockedSpec = {
    action_type: 'SEND_POLITE_REMINDER',
    recommended_message: 'Please pay or we will involve the police.',
    // No customer_id / amount fields -> validate() never touches the DB for
    // this spec, so this runs safely offline.
  };
  const guard = await realPolicyValidate(blockedSpec, 'test-user-regression');

  check('policyGuard.validate() genuinely blocks a message containing a forbidden phrase',
    guard.status, 'system_blocked');
  check('REGRESSION PROOF: the old buggy predicate `guard.blocked` is undefined/falsy even on a real block (would have let the spec through)',
    !!guard.blocked, false);
  check('the correct field `guard.status === \'system_blocked\'` is true on a real block',
    guard.status === 'system_blocked', true);
}

// Part 2: end-to-end — run() itself must exclude a spec that policyGuard
// blocks, and must keep a spec that policyGuard allows. Mocks supabase (the
// only I/O collectionsAgent.js performs) so this runs offline; policyGuard
// itself is NOT mocked, it runs for real against the built specs.
{
  function makeBuilder(result) {
    const builder = {
      select: () => builder,
      eq: () => builder,
      gt: () => builder,
      order: () => builder,
      limit: () => builder,
      in: () => builder,
      maybeSingle: () => Promise.resolve(result),
      then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
      catch: (fn) => Promise.resolve(result).catch(fn),
    };
    return builder;
  }

  const invoices = [
    // customer_name -> buildMessage's polite template embeds the first name
    // as "Namaste <first> ji ..." -> this one contains the blocked phrase
    // "police" and MUST be excluded from the returned specs.
    { id: 'inv-blocked', customer_id: null, customer_name: 'Police', customer_phone: '9999999999', invoice_amount: 5000, days_overdue: 3, last_reminder_sent: null },
    // Ordinary customer -> normal polite reminder, must be allowed through.
    { id: 'inv-allowed', customer_id: null, customer_name: 'Raj Sharma', customer_phone: '8888888888', invoice_amount: 4000, days_overdue: 3, last_reminder_sent: null },
  ];

  const fakeSupabase = {
    from(table) {
      if (table === 'invoices') return makeBuilder({ data: invoices, error: null });
      if (table === 'ai_actions') return makeBuilder({ data: [], error: null });
      if (table === 'business_memory') return makeBuilder({ data: [], error: null });
      if (table === 'customer_scores') return makeBuilder({ data: [], error: null });
      if (table === 'customers') return makeBuilder({ data: null, error: null });
      if (table === 'policy_decisions') return { insert: () => Promise.resolve({ data: null, error: null }) };
      return makeBuilder({ data: [], error: null });
    },
  };

  // Stub the shared supabaseClient module in require.cache BEFORE freshly
  // requiring collectionsAgent.js, so its top-level
  // `const { supabase } = require('../../config/supabaseClient')` binds to
  // our fake. policyGuard.service.js is required fresh too, so its own
  // internal supabase reference also binds to the fake (it is only exercised
  // via the 'customers' table above, which the blocked/allowed specs here
  // never touch since neither spec carries a customer_id).
  const supabaseClientPath = require.resolve('../../config/supabaseClient');
  const collectionsAgentPath = require.resolve('./collectionsAgent.js');
  const policyGuardPath = require.resolve('../orchestrator/policyGuard.service.js');

  const originalSupabaseModule = require.cache[supabaseClientPath];
  delete require.cache[collectionsAgentPath];
  delete require.cache[policyGuardPath];
  require.cache[supabaseClientPath] = {
    id: supabaseClientPath,
    filename: supabaseClientPath,
    loaded: true,
    exports: { supabase: fakeSupabase },
  };

  const freshCollectionsAgent = require('./collectionsAgent.js');
  const specs = await freshCollectionsAgent.run('test-user-regression', {});

  // Restore real modules so nothing downstream in this file (already run) or
  // in any other test file loaded later is affected by the stub.
  delete require.cache[collectionsAgentPath];
  delete require.cache[policyGuardPath];
  if (originalSupabaseModule) require.cache[supabaseClientPath] = originalSupabaseModule;
  else delete require.cache[supabaseClientPath];

  const returnedIds = specs.map(s => s.related_entity_id);
  check('FIXED collectionsAgent.run(): policy-blocked invoice (contains forbidden phrase) is excluded from returned specs',
    returnedIds.includes('inv-blocked'), false);
  check('FIXED collectionsAgent.run(): non-blocked invoice is still returned',
    returnedIds.includes('inv-allowed'), true);
  check('FIXED collectionsAgent.run(): exactly one spec survives policy filtering',
    specs.length, 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
