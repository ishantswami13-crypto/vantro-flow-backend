// Offline proof for the `by_action_type` grouping logic used by
// GET /api/cortex/health (introduced in commit d5ab19b, extracted into
// buildActionTypeBreakdown() in actionTypeBreakdown.js so it is testable
// without the real HTTP route).
//
// IMPORTANT — what this test does and does NOT prove:
//   It proves the grouping/rate-math logic is correct against synthetic
//   rows shaped exactly like what the route's Supabase query would return
//   (`{ outcome, action_type }` rows from `ai_actions`).
//   It does NOT exercise the route over real HTTP, and it does NOT prove
//   the full query chain (`.not('outcome','is',null)`) works against the
//   local dev environment — the local pgSupabaseShim (lib/config/pgSupabaseShim.js,
//   untracked, pre-existing, out of scope for this fix) does not implement
//   `.not()`, so calling the real endpoint locally still throws
//   `TypeError: ...not is not a function`. That is a separate, pre-existing
//   shim limitation and is not fixed or masked by this test.
//
// Run: node lib/services/cortexCore/actionTypeBreakdown.test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildActionTypeBreakdown } = require('./actionTypeBreakdown.js');

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✅' : '❌'} ${label}: ${JSON.stringify(got)}${ok ? '' : ' (expected ' + JSON.stringify(want) + ')'}`);
  ok ? pass++ : fail++;
}

const row = (action_type, outcome) => ({ action_type, outcome });

// 1. Empty input -> {} (no throw)
check('empty array -> {}', buildActionTypeBreakdown([]), {});

// 2. null/undefined input -> {} (no throw, guarded by `|| []`)
check('null -> {}', buildActionTypeBreakdown(null), {});
check('undefined -> {}', buildActionTypeBreakdown(undefined), {});

// 3. Known counts -> correct rate math for a single action_type
//    3 effective, 1 ineffective, 0 unknown => rate = round(3/4*100) = 75
check(
  'REMINDER: 3 effective / 1 ineffective -> rate 75',
  buildActionTypeBreakdown([
    row('REMINDER', 'effective'),
    row('REMINDER', 'effective'),
    row('REMINDER', 'effective'),
    row('REMINDER', 'ineffective'),
  ]),
  { REMINDER: { effective: 3, ineffective: 1, unknown: 0, rate: 75 } }
);

// 4. All-unknown outcomes for a type -> rate 0 (0 effective / 2 total), no throw.
//    Rate is only null when a type's total is 0, which cannot happen here since
//    every row that lands in a bucket contributes to effective/ineffective/unknown.
check(
  'all-unknown outcomes -> rate 0 (not null; total > 0)',
  buildActionTypeBreakdown([
    row('DISCOUNT_OFFER', 'pending'),
    row('DISCOUNT_OFFER', undefined),
  ]),
  { DISCOUNT_OFFER: { effective: 0, ineffective: 0, unknown: 2, rate: 0 } }
);

// 4b. True zero-data case (no rows at all for a type, i.e. the whole input is
// empty) -> {} overall, matching case 1; there is no way to have a `total === 0`
// per-type bucket since a bucket is only created when a row is seen.
check('no rows at all -> {} (rate never computed)', buildActionTypeBreakdown([]), {});

// 5. Missing action_type falls back to 'UNKNOWN' bucket
check(
  'missing action_type -> UNKNOWN bucket',
  buildActionTypeBreakdown([row(null, 'effective'), row(undefined, 'ineffective')]),
  { UNKNOWN: { effective: 1, ineffective: 1, unknown: 0, rate: 50 } }
);

// 6. Multiple action types tracked independently
check(
  'multiple action types -> independent buckets',
  buildActionTypeBreakdown([
    row('REMINDER', 'effective'),
    row('REMINDER', 'ineffective'),
    row('ESCALATION', 'effective'),
    row('ESCALATION', 'effective'),
  ]),
  {
    REMINDER: { effective: 1, ineffective: 1, unknown: 0, rate: 50 },
    ESCALATION: { effective: 2, ineffective: 0, unknown: 0, rate: 100 },
  }
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
