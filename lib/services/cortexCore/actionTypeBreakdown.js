// FILE: lib/services/cortexCore/actionTypeBreakdown.js
//
// Pure grouping logic for GET /api/cortex/health's `by_action_type` field.
// Extracted out of server.js (commit d5ab19b) so it can be unit-tested
// directly, without spinning up the real HTTP server or depending on the
// local dev pgSupabaseShim (which does not implement `.not()` and cannot
// execute the route's real query chain end-to-end in local dev).
//
// Input shape matches exactly what the route's Supabase query returns:
//   supabase.from('ai_actions').select('outcome, action_type')
//     .eq('user_id', userId).not('outcome', 'is', null).limit(100)
// i.e. an array of { outcome, action_type } rows.

'use strict';

function buildActionTypeBreakdown(evalActions) {
  const byActionType = {};
  (evalActions || []).forEach(a => {
    const type = a.action_type || 'UNKNOWN';
    if (!byActionType[type]) byActionType[type] = { effective: 0, ineffective: 0, unknown: 0 };
    if (a.outcome === 'effective') byActionType[type].effective++;
    else if (a.outcome === 'ineffective') byActionType[type].ineffective++;
    else byActionType[type].unknown++;
  });
  Object.keys(byActionType).forEach(type => {
    const t = byActionType[type];
    const total = t.effective + t.ineffective + t.unknown;
    t.rate = total > 0 ? Math.round((t.effective / total) * 100) : null;
  });
  return byActionType;
}

module.exports = { buildActionTypeBreakdown };
