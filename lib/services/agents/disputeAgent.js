// FILE: lib/services/agents/disputeAgent.js
// Dispute Agent — classifies open customer disputes and makes sure collection
// activity actually stops on disputed invoices.
//
// The `invoices.dunning_paused` column and the manual POST /api/disputes route
// already exist and set dunning_paused=true when a dispute is raised through
// that route. This agent is a defensive safety net: any 'open' dispute whose
// linked invoice is NOT paused gets paused here too (idempotent, reversible —
// never deletes or resolves a dispute, never touches money). It also surfaces
// severity and staleness to the owner as ai_actions, same shape as the other
// agents in this folder.
const { supabase } = require('../../config/supabaseClient');
const { safeLog }  = require('../../observability/logger');

function fmtINR(n) {
  return n >= 100000
    ? `₹${(n / 100000).toFixed(1)}L`
    : `₹${Math.round(n).toLocaleString('en-IN')}`;
}

// Keywords that bump a dispute to high severity for owner attention —
// mirrors the blocked-phrase spirit of policyGuard.service.js, but here it's
// used to prioritize review, not to block anything.
const HIGH_SEVERITY_KEYWORDS = ['legal', 'court', 'fraud', 'fir', 'police', 'lawyer', 'criminal'];

function classifySeverity(dispute) {
  const amount = parseFloat(dispute.disputed_amount || 0);
  const text = `${dispute.reason || ''} ${dispute.notes || ''}`.toLowerCase();
  if (HIGH_SEVERITY_KEYWORDS.some(k => text.includes(k))) return 'high';
  if (amount >= 20000) return 'high';
  return 'medium';
}

/**
 * Run the Dispute Agent.
 * @param {string} userId
 * @returns {Array} ActionSpecs
 */
async function run(userId, context = {}) {
  try {
    const specs = [];
    const now = new Date();

    const { data: disputes, error } = await supabase
      .from('disputes')
      .select('id, invoice_id, customer_name, disputed_amount, reason, notes, status, created_at')
      .eq('user_id', userId)
      .eq('status', 'open');
    if (error) throw error;
    if (!disputes?.length) return [];

    // ── Safety net: make sure every open dispute's linked invoice is paused ──
    const invoiceIds = disputes.map(d => d.invoice_id).filter(Boolean);
    if (invoiceIds.length) {
      const { data: unpaused } = await supabase
        .from('invoices')
        .select('id')
        .eq('user_id', userId)
        .in('id', invoiceIds)
        .eq('dunning_paused', false);

      if (unpaused?.length) {
        const idsToPause = unpaused.map(i => i.id);
        const { error: pauseErr } = await supabase
          .from('invoices')
          .update({ dunning_paused: true })
          .eq('user_id', userId)
          .in('id', idsToPause);
        if (pauseErr) {
          safeLog('warn', '[DisputeAgent] Failed to pause dunning', { error: pauseErr.message, userId });
        } else {
          safeLog('info', '[DisputeAgent] Paused dunning on invoices with open disputes', { userId, count: idsToPause.length });
        }
      }
    }

    // ── Existing pending actions, to avoid duplicates per dispute ───────────
    const { data: existingActions } = await supabase
      .from('ai_actions')
      .select('related_entity_id')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .in('action_type', ['DISPUTE_OPENED_REVIEW', 'DISPUTE_STALE_REVIEW']);
    const alreadyQueued = new Set((existingActions || []).map(a => a.related_entity_id));

    for (const d of disputes) {
      if (alreadyQueued.has(d.id)) continue;

      const severity   = classifySeverity(d);
      const ageDays     = Math.floor((now.getTime() - new Date(d.created_at).getTime()) / 86400000);
      const isStale     = ageDays > 14;

      specs.push({
        action_type:          isStale ? 'DISPUTE_STALE_REVIEW' : 'DISPUTE_OPENED_REVIEW',
        title:                isStale
          ? `Dispute unresolved ${ageDays}d: ${d.customer_name}`
          : `New dispute: ${d.customer_name}`,
        description:          `${fmtINR(d.disputed_amount || 0)} disputed — "${(d.reason || '').slice(0, 140)}". Collection paused on linked invoice while open.`,
        priority:             isStale ? 'high' : (severity === 'high' ? 'high' : 'medium'),
        risk_level:           severity,
        related_entity_type:  'dispute',
        related_entity_id:    d.id,
        suggested_by:         'system',
        requires_approval:    false,
      });
    }

    safeLog('info', '[DisputeAgent] Run complete', { userId, openDisputes: disputes.length, generated: specs.length });
    return specs;
  } catch (err) {
    safeLog('error', '[DisputeAgent] run failed', { error: err.message, userId });
    return [];
  }
}

module.exports = { run };
