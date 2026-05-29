// FILE: lib/services/agents/briefingAgent.js
// Daily Briefing Agent — produces ONE structured DAILY_OWNER_BRIEFING action per day.
// Priority order: 1) urgent collections 2) promises due today 3) cashflow gaps 4) inventory.
// Called by the 7am IST cron and by GET /api/ai-actions/counts auto-seed.
const { supabase } = require('../../config/supabaseClient');
const { safeLog }  = require('../../observability/logger');

function fmtINR(n) {
  return n >= 100000
    ? `₹${(n / 100000).toFixed(1)}L`
    : `₹${Math.round(n).toLocaleString('en-IN')}`;
}

/**
 * Run the Briefing Agent.
 * Idempotent: skips if today's briefing already exists.
 * @param {string} userId
 * @returns {Array} ActionSpecs (0 or 1 element)
 */
async function run(userId, context = {}) {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Idempotency check
    const { data: existing } = await supabase
      .from('ai_actions')
      .select('id')
      .eq('user_id', userId)
      .eq('action_type', 'DAILY_OWNER_BRIEFING')
      .gte('created_at', today)
      .maybeSingle();

    if (existing && !context.force) return [];

    // Gather all the data in parallel
    const [overdueRes, promisesRes, pendingActionsRes, urgentActionsRes] = await Promise.all([
      supabase.from('invoices')
        .select('customer_name, invoice_amount, days_overdue')
        .eq('user_id', userId)
        .eq('payment_status', 'Pending')
        .gt('days_overdue', 0)
        .order('days_overdue', { ascending: false })
        .limit(5),

      supabase.from('promises')
        .select('customer_id, promised_amount, promised_date, customers(name)')
        .eq('user_id', userId)
        .eq('status', 'active')
        .lte('promised_date', today),

      supabase.from('ai_actions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('status', 'pending'),

      supabase.from('ai_actions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('status', 'pending')
        .in('priority', ['urgent', 'high']),
    ]);

    const overdue        = overdueRes.data || [];
    const promisesDue    = promisesRes.data || [];
    const pendingCount   = pendingActionsRes.count || 0;
    const urgentCount    = urgentActionsRes.count || 0;

    // Build description
    const parts = [];
    if (overdue.length > 0) {
      const topOverdue = overdue[0];
      parts.push(`${overdue.length} overdue invoice${overdue.length > 1 ? 's' : ''} — top: ${topOverdue.customer_name} (${fmtINR(topOverdue.invoice_amount)}, ${topOverdue.days_overdue}d)`);
    }
    if (promisesDue.length > 0) {
      parts.push(`${promisesDue.length} payment promise${promisesDue.length > 1 ? 's' : ''} due today`);
    }
    if (urgentCount > 0) {
      parts.push(`${urgentCount} urgent/high action${urgentCount > 1 ? 's' : ''} in queue`);
    }

    const description = parts.length > 0
      ? parts.join(' · ')
      : 'No overdue invoices or pending actions. Business is on track.';

    const hasUrgent = overdue.some(i => i.days_overdue > 45) || urgentCount > 0 || promisesDue.length > 0;
    const title = overdue.length > 0
      ? `${overdue.length} overdue invoice${overdue.length > 1 ? 's' : ''} need attention today`
      : pendingCount > 0
        ? `${pendingCount} pending action${pendingCount > 1 ? 's' : ''} — review your queue`
        : 'Daily Briefing — all clear';

    safeLog('info', '[BriefingAgent] Run complete', { userId, parts: parts.length });

    return [{
      action_type:       'DAILY_OWNER_BRIEFING',
      title,
      description,
      priority:          hasUrgent ? 'high' : 'medium',
      risk_level:        'low',
      suggested_by:      'briefing_agent',
      requires_approval: false,
    }];
  } catch (err) {
    safeLog('error', '[BriefingAgent] run failed', { error: err.message, userId });
    return [];
  }
}

module.exports = { run };
