// Offline proof for the `receivables_execution` grouping logic used by
// GET /api/cortex/health (Phase E of the "Verified Execution Loop V1 —
// Receivables" initiative). Mirrors actionTypeBreakdown.test.mjs conventions:
// pure-function unit tests over synthetic rows shaped exactly like what the
// route's Supabase queries return, no DB or HTTP server needed.
//
// Run: node lib/services/cortexCore/receivablesExecutionMetrics.test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildReceivablesExecutionMetrics } = require('./receivablesExecutionMetrics.js');

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✅' : '❌'} ${label}: ${JSON.stringify(got)}${ok ? '' : ' (expected ' + JSON.stringify(want) + ')'}`);
  ok ? pass++ : fail++;
}

const exec = (channel, status) => ({ channel, status });
const promise = (status) => ({ status });

// 1. Mix of whatsapp/sent and test/sent execution_records -> correct separate channel counts.
check(
  'whatsapp vs test channel breakdown',
  buildReceivablesExecutionMetrics({
    executionRecords: [
      exec('whatsapp', 'sent'),
      exec('whatsapp', 'delivered'),
      exec('test', 'sent'),
    ],
    promises: [],
  }).execution_records,
  {
    total: 3,
    by_channel: { whatsapp: 2, test: 1 },
    by_status: { sent: 2, delivered: 1 },
  }
);

// 2. Mix of kept/broken/active promises -> correct counts and correctly-computed promise_kept_rate.
check(
  'kept/broken/active promise counts + rate',
  buildReceivablesExecutionMetrics({
    executionRecords: [],
    promises: [promise('kept'), promise('kept'), promise('kept'), promise('broken'), promise('active')],
  }).promises,
  {
    total: 5,
    by_status: { active: 1, kept: 3, broken: 1, rescheduled: 0 },
    promise_kept_rate: 75, // round(3/4*100)
  }
);

// 3. Zero kept + zero broken (only active/rescheduled) -> promise_kept_rate: null, not NaN/Infinity/0.
const zeroKeptBroken = buildReceivablesExecutionMetrics({
  executionRecords: [],
  promises: [promise('active'), promise('active'), promise('rescheduled')],
}).promises;
check('zero kept+broken -> rate null (not NaN/Infinity/0)', zeroKeptBroken.promise_kept_rate, null);
check('zero kept+broken -> counts still correct', zeroKeptBroken.by_status, { active: 2, kept: 0, broken: 0, rescheduled: 1 });

// 4. Empty/null input arrays -> well-formed zero-state object, no throw.
const emptyResult = buildReceivablesExecutionMetrics({ executionRecords: [], promises: [] });
check('empty arrays -> zero-state object', emptyResult, {
  execution_records: { total: 0, by_channel: {}, by_status: {} },
  promises: { total: 0, by_status: { active: 0, kept: 0, broken: 0, rescheduled: 0 }, promise_kept_rate: null },
});

const nullResult = buildReceivablesExecutionMetrics({ executionRecords: null, promises: null });
check('null arrays -> zero-state object (no throw)', nullResult, emptyResult);

const noArgResult = buildReceivablesExecutionMetrics();
check('no args at all -> zero-state object (no throw)', noArgResult, emptyResult);

// Extra: unknown/missing channel or status values don't crash and bucket as 'unknown'.
check(
  'missing channel/status -> unknown bucket, no throw',
  buildReceivablesExecutionMetrics({
    executionRecords: [exec(undefined, undefined), exec(null, null)],
    promises: [{ status: 'weird_value' }],
  }),
  {
    execution_records: { total: 2, by_channel: { unknown: 2 }, by_status: { unknown: 2 } },
    promises: { total: 1, by_status: { active: 0, kept: 0, broken: 0, rescheduled: 0, unknown: 1 }, promise_kept_rate: null },
  }
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
