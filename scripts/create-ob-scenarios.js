const fs = require('fs');
const path = require('path');

const dir = 'cortex-lab/scenarios/owner-briefing';

const scenarios = [
  {
    id: 'owner-briefing/empty-data',
    category: 'owner-briefing',
    mode: ['static', 'dry-run'],
    description: 'Empty business data produces safe empty briefing, no fake claims.',
    riskLevel: 'low',
    expected: { "sections_present": true, "fake_data_found": false }
  },
  {
    id: 'owner-briefing/overdue-invoice-action',
    category: 'owner-briefing',
    mode: ['static'],
    description: 'Overdue invoice triggers top action generation.',
    riskLevel: 'medium',
    expected: { "has_actions": true, "action_type": "CHASE_OVERDUE" }
  },
  {
    id: 'owner-briefing/broken-promise-action',
    category: 'owner-briefing',
    mode: ['static'],
    description: 'Broken promise triggers high priority action.',
    riskLevel: 'high',
    expected: { "has_actions": true, "action_priority": "high", "action_type": "ESCALATE_PROMISE" }
  },
  {
    id: 'owner-briefing/missing-due-date-dq',
    category: 'owner-briefing',
    mode: ['static'],
    description: 'Missing due date triggers data quality warning.',
    riskLevel: 'medium',
    expected: { "data_quality_warning": true }
  },
  {
    id: 'owner-briefing/external-message-approval',
    category: 'owner-briefing',
    mode: ['static'],
    description: 'External message suggestion requires approval.',
    riskLevel: 'medium',
    expected: { "approval_required": true }
  },
  {
    id: 'owner-briefing/financial-mutation-blocked',
    category: 'owner-briefing',
    mode: ['static'],
    description: 'Financial mutation suggestion is blocked / not auto-executable.',
    riskLevel: 'high',
    expected: { "safe_to_auto_execute": false }
  },
  {
    id: 'owner-briefing/cost-routing-rules',
    category: 'owner-briefing',
    mode: ['static'],
    description: 'Cost routing is strictly rules_only (no LLM).',
    riskLevel: 'low',
    expected: { "cost_route": "rules_only" }
  },
  {
    id: 'owner-briefing/rust-unavailable-fallback',
    category: 'owner-briefing',
    mode: ['dry-run'],
    description: 'Rust unavailable returns safe unavailable fallback, no fake data.',
    riskLevel: 'medium',
    expected: { "fallback": true }
  },
  {
    id: 'owner-briefing/missing-token',
    category: 'owner-briefing',
    mode: ['dry-run'],
    description: 'Missing token returns 401.',
    riskLevel: 'low',
    expected: { "status_code": 401 }
  },
  {
    id: 'owner-briefing/invalid-token',
    category: 'owner-briefing',
    mode: ['dry-run'],
    description: 'Invalid token returns 401.',
    riskLevel: 'low',
    expected: { "status_code": 401 }
  },
  {
    id: 'owner-briefing/cross-user-leakage',
    category: 'owner-briefing',
    mode: ['static', 'dry-run'],
    description: 'Cross-user data attempt results in no leakage.',
    riskLevel: 'critical',
    expected: { "cross_user_data_found": false }
  },
  {
    id: 'owner-briefing/large-data-budget',
    category: 'owner-briefing',
    mode: ['static'],
    description: 'Large data set payload stays under budget due to max_items.',
    riskLevel: 'low',
    expected: { "payload_capped": true }
  }
];

scenarios.forEach(s => {
  fs.writeFileSync(path.join(dir, `${s.id.split('/')[1]}.json`), JSON.stringify(s, null, 2));
});
console.log('12 Scenarios created.');
