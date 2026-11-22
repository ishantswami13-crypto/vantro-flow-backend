// Blocked-phrase matching in policyGuard is whole-word (parity with
// vantro-automation-rs tests/policy_guard_fir_regression.rs).
// Run: node lib/services/orchestrator/policyGuard.phrases.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findBlockedPhrase } = require('./policyGuard.service.js');

const allowed = [
  'Kindly confirm if the payment has been initiated.',
  'This is the first follow-up on the overdue invoice.',
  'Hi Raj, please send firm reminder for invoice #1042.',
  'We will confirm as soon as the goods are in.',
  'Thank you for your courtesy.',
];
const blocked = [
  ['We will file an FIR.', 'FIR'],
  ['Please pay or we will involve the police.', 'police'],
  ['Our lawyers will contact you.', 'lawyer'],
  ['Stop threatening our staff.', 'threaten'],
  ['You will be arrested.', 'arrest'],
  ['We may take LEGAL   ACTION.', 'legal action'],
];
for (const m of allowed) assert.equal(findBlockedPhrase(m), null, `allowed: ${m}`);
for (const [m, p] of blocked) assert.equal(findBlockedPhrase(m), p, `blocked: ${m}`);

console.log(`policyGuard phrases: ${allowed.length + blocked.length} checks passed`);
