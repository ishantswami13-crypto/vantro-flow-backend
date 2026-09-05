// Offline proof for the Phase 5 temporal-trajectory logic in creditRiskAgent.js.
// No DB, no network — exercises the pure functions extracted for this purpose.
// Run: node lib/services/agents/creditRiskAgent.test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  classifyScoreTrajectory,
  countRecentTierChanges,
  upgradePriority,
  upgradeRiskLevel,
  TIER_CHANGE_WINDOW_DAYS,
  TIER_CHANGE_SUSTAINED_THRESHOLD,
} = require('./creditRiskAgent.js');

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✅' : '❌'} ${label}: ${JSON.stringify(got)}${ok ? '' : ' (expected ' + JSON.stringify(want) + ')'}`);
  ok ? pass++ : fail++;
}

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
const row = (score, recorded_at) => ({ credit_risk_score: score, recorded_at });
const evt = (created_at) => ({ event_type: 'CREDIT_RISK_TIER_CHANGED', created_at });

// -- classifyScoreTrajectory ---------------------------------------------------

// 1. No history at all -> UNKNOWN (must map to "no change in existing behavior")
check('no history -> UNKNOWN', classifyScoreTrajectory([]), 'UNKNOWN');

// 2. Exactly one snapshot -> UNKNOWN (insufficient history)
check('one snapshot -> UNKNOWN', classifyScoreTrajectory([row(80, daysAgo(0))]), 'UNKNOWN');

// 3. Two identical scores -> STABLE
check('two identical scores -> STABLE', classifyScoreTrajectory([row(50, daysAgo(0)), row(50, daysAgo(10))]), 'STABLE');

// 4. Improvement: latest score lower than previous (lower = less risky) -> IMPROVING
check('latest lower than previous -> IMPROVING', classifyScoreTrajectory([row(40, daysAgo(0)), row(70, daysAgo(10))]), 'IMPROVING');

// 5. Deterioration: latest score higher than previous -> DETERIORATING
check('latest higher than previous -> DETERIORATING', classifyScoreTrajectory([row(75, daysAgo(0)), row(50, daysAgo(10))]), 'DETERIORATING');

// 6. Malformed/non-numeric scores -> UNKNOWN, never throws
check('malformed scores -> UNKNOWN', classifyScoreTrajectory([row('bad', daysAgo(0)), row(null, daysAgo(10))]), 'UNKNOWN');
check('non-array input -> UNKNOWN', classifyScoreTrajectory(undefined), 'UNKNOWN');
check('null input -> UNKNOWN', classifyScoreTrajectory(null), 'UNKNOWN');

// -- countRecentTierChanges -----------------------------------------------------

// 7. No events -> 0
check('no events -> 0', countRecentTierChanges([]), 0);
check('undefined events -> 0', countRecentTierChanges(undefined), 0);

// 8. One event inside window -> 1 (below threshold)
check('one event in window -> count 1', countRecentTierChanges([evt(daysAgo(10))], TIER_CHANGE_WINDOW_DAYS), 1);

// 9. Two events inside window -> 2 (meets sustained threshold)
check('two events in window -> count 2', countRecentTierChanges([evt(daysAgo(5)), evt(daysAgo(40))], TIER_CHANGE_WINDOW_DAYS), 2);

// 10. Events outside the window are excluded
check('events outside window excluded', countRecentTierChanges([evt(daysAgo(90)), evt(daysAgo(120))], TIER_CHANGE_WINDOW_DAYS), 0);

// 11. Mixed: only in-window events counted
check('mixed in/out of window -> only in-window counted', countRecentTierChanges([evt(daysAgo(5)), evt(daysAgo(90))], TIER_CHANGE_WINDOW_DAYS), 1);

// 12. Malformed timestamps excluded, never throws
check('malformed timestamps excluded', countRecentTierChanges([{ created_at: 'not-a-date' }, { created_at: null }, {}]), 0);

// Threshold sanity
check('sustained threshold is 2', TIER_CHANGE_SUSTAINED_THRESHOLD, 2);

// -- upgradePriority / upgradeRiskLevel (bounded, upgrade-only, never invents/exceeds) ---

// 13. priority: medium -> high -> urgent, urgent stays urgent (never exceeds max)
check('priority medium -> high', upgradePriority('medium'), 'high');
check('priority high -> urgent', upgradePriority('high'), 'urgent');
check('priority urgent -> urgent (capped)', upgradePriority('urgent'), 'urgent');

// 14. risk_level: medium -> high, high stays high (never exceeds max, no 'urgent' invented)
check('risk_level medium -> high', upgradeRiskLevel('medium'), 'high');
check('risk_level high -> high (capped)', upgradeRiskLevel('high'), 'high');

// 15. Unrecognized/unexpected values pass through unchanged (never invents a new enum value)
check('unrecognized priority passes through', upgradePriority('low'), 'low');
check('unrecognized risk_level passes through', upgradeRiskLevel('low'), 'low');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
