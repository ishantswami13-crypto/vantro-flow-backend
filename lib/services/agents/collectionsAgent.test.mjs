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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
