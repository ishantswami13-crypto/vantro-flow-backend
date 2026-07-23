// FILE: lib/services/agents/collectionsAgent.js
// Collections Recovery Agent — generates reminder actions based on overdue stage.
// Stages: polite (1–7d) → firm (8–30d) → escalation-WhatsApp (31–35d) →
//         escalation-call (36–89d) → bad debt flag (90+d)
// Uses Hinglish templates from aiPlanner. Respects policyGuard before returning.
// Pure async function — never throws, returns [] on error.
//
// "Closing the loop" (Cortex X, agent auto-execute pass) additions, per the
// user-approved plan:
//   - Escalation cap: at most one NEW escalation-tier action (firm reminder,
//     WhatsApp escalation, or auto-call) per customer per rolling 24h,
//     regardless of how many overdue invoices they have. Polite reminders
//     are not subject to this cap (they aren't an escalation).
//   - Cooldown before jumping to the voice-call tier: a customer has to have
//     been in the WhatsApp-escalation band (31+ days overdue) for at least
//     CALL_TIER_COOLDOWN_DAYS before ESCALATE_COLLECTION_CALL becomes
//     eligible, instead of jumping straight from a WhatsApp message to an
//     automated phone call the moment day 31 is crossed. Implemented as a
//     simple day-threshold (daysOverdue >= 31 + cooldown) rather than
//     checking for evidence a prior WhatsApp escalation was actually sent —
//     a deliberate simplicity/robustness tradeoff, noted here as a judgment
//     call.
//   - Per-customer pause: customers.escalation_paused (checked via
//     scoring.service's existing resolveCustomerId helper) stops ALL
//     reminder/escalation generation for that customer's invoices, polite
//     included, so the owner has one obvious kill switch.
//   - Actual sending: SEND_POLITE_REMINDER auto-sends (no tap) when both
//     FEATURE_AGENT_AUTOEXECUTE_ENABLED and
//     FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED are on (see server.js's
//     autoSendCollectionsReminders). SEND_FIRM_REMINDER and
//     ESCALATE_COLLECTION remain requires_approval (already forced by
//     policyGuard.ALWAYS_REQUIRES_APPROVAL for SEND_FIRM_REMINDER, and by
//     this agent's own high risk_level for ESCALATE_COLLECTION) — tapping
//     approve now actually sends the message (server.js's
//     executeCollectionsMessage). ESCALATE_COLLECTION_CALL always requires
//     approval and places a real call only on tap (server.js's
//     executeCollectionCall), same as before.
const { supabase }     = require('../../config/supabaseClient');
const { safeLog }      = require('../../observability/logger');

const CALL_TIER_COOLDOWN_DAYS = 5; // days spent in the WhatsApp-escalation band before voice-call escalation is offered
const ESCALATION_TYPES = ['SEND_FIRM_REMINDER', 'ESCALATE_COLLECTION', 'ESCALATE_COLLECTION_CALL'];

const STAGE_CONFIG = [
  { minDays: 1,  maxDays: 7,  type: 'SEND_POLITE_REMINDER',   priority: 'medium', riskLevel: 'low'    },
  { minDays: 8,  maxDays: 30, type: 'SEND_FIRM_REMINDER',      priority: 'high',   riskLevel: 'medium' },
  { minDays: 31, maxDays: 30 + CALL_TIER_COOLDOWN_DAYS, type: 'ESCALATE_COLLECTION',      priority: 'urgent', riskLevel: 'high' },
  { minDays: 31 + CALL_TIER_COOLDOWN_DAYS, maxDays: 89, type: 'ESCALATE_COLLECTION_CALL', priority: 'urgent', riskLevel: 'high' },
  { minDays: 90, maxDays: Infinity, type: 'FLAG_BAD_DEBT',     priority: 'urgent', riskLevel: 'high'   },
];

function getStage(daysOverdue) {
  return STAGE_CONFIG.find(s => daysOverdue >= s.minDays && daysOverdue <= s.maxDays) || STAGE_CONFIG[0];
}

function buildMessage(customerName, amount, daysOverdue, stage) {
  const first  = (customerName || 'ji').split(' ')[0];
  const amtStr = amount >= 100000
    ? `₹${(amount / 100000).toFixed(1)}L`
    : `₹${Math.round(amount).toLocaleString('en-IN')}`;

  if (stage.type === 'SEND_POLITE_REMINDER') {
    return `Namaste ${first} ji 🙏 Umeed hai sab theek hai. Bas ek chhoti si reminder — hamare ${amtStr} (${daysOverdue} din se pending) aapka wait kar rahe hain. Aaj payment ho sakti hai kya? UPI/NEFT dono chalega. Shukriya!`;
  }
  if (stage.type === 'SEND_FIRM_REMINDER') {
    return `${first} ji, ${amtStr} ${daysOverdue} din se overdue hai. Ye amount jaldi settle karna zaroori hai. Aaj hi payment bhej do ya call karein — 8448 0XX XXX. Aapki cooperation ki zaroorat hai.`;
  }
  if (stage.type === 'ESCALATE_COLLECTION') {
    return `${first} ji, ${amtStr} (${daysOverdue} din overdue) abhi tak settle nahi hua. Ye serious ho raha hai. Aaj hi contact karein warna aage ki proceedings shuru hongi. Immediate action required.`;
  }
  if (stage.type === 'ESCALATE_COLLECTION_CALL') {
    return `Internal: ${customerName} — ₹${amount} (${daysOverdue} din overdue), WhatsApp escalation already sent. Auto-call queued pending owner approval.`;
  }
  return `Internal: ${customerName} — ₹${amount} flagged as potential bad debt after ${daysOverdue} days. Review required.`;
}

/**
 * Run the Collections Agent for a user.
 * Scans overdue invoices and generates reminder ActionSpecs for unprompted customers.
 * @param {string} userId
 * @param {object} context - optional: { customerId, invoiceId } to scope to one customer
 * @returns {Array} ActionSpecs (not yet persisted)
 */
async function run(userId, context = {}) {
  try {
    const { validate: policyValidate } = require('../orchestrator/policyGuard.service');
    const { resolveCustomerId } = require('../orchestrator/scoring.service');

    let query = supabase
      .from('invoices')
      .select('id, customer_name, customer_phone, invoice_amount, days_overdue, last_reminder_sent')
      .eq('user_id', userId)
      .eq('payment_status', 'Pending')
      .eq('dunning_paused', false) // NOTE(disputeAgent): disputed invoices are paused here and must be excluded from reminders
      .gt('days_overdue', 0)
      .order('days_overdue', { ascending: false })
      .limit(context.customerId ? 10 : 50);
    // last_reminder_sent doubles as a cross-system "contacted today" gate
    // shared with the legacy dunning_rules cron (see server.js's
    // runDunningCycle) -- whichever system contacts an invoice first today,
    // the other skips it below, so a customer never gets double-contacted.
    const todayStr = new Date().toISOString().split('T')[0];

    if (context.invoiceId) query = query.eq('id', context.invoiceId);

    const { data: invoices, error } = await query;
    if (error) throw error;
    if (!invoices?.length) return [];

    // Check which invoices already have a pending action to avoid duplication
    const { data: existingActions } = await supabase
      .from('ai_actions')
      .select('related_entity_id')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .in('action_type', ['SEND_POLITE_REMINDER', 'SEND_FIRM_REMINDER', 'ESCALATE_COLLECTION', 'ESCALATE_COLLECTION_CALL', 'FLAG_BAD_DEBT']);
    const alreadyQueued = new Set((existingActions || []).map(a => a.related_entity_id));

    // Escalation cap: which customers already got a NEW escalation-tier
    // action (firm reminder or above) in the last rolling 24h?
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentEscalations } = await supabase
      .from('ai_actions')
      .select('customer_id')
      .eq('user_id', userId)
      .in('action_type', ESCALATION_TYPES)
      .gte('created_at', since24h)
      .not('customer_id', 'is', null);
    const escalatedRecently = new Set((recentEscalations || []).map(a => a.customer_id));

    const specs = [];

    for (const inv of (invoices || [])) {
      if (alreadyQueued.has(inv.id)) continue;

      if (inv.last_reminder_sent && String(inv.last_reminder_sent).split('T')[0] === todayStr) {
        safeLog('info', '[CollectionsAgent] Skipping — already contacted today (cross-system gate)', { userId, invoiceId: inv.id });
        continue;
      }

      // Resolve customer_id so we can check the per-customer pause + cap.
      // Best-effort: if resolution fails (no matching customers row), the
      // pause/cap simply can't apply to this invoice — same as before this
      // change, not a regression.
      let customerId = null;
      try { customerId = await resolveCustomerId(userId, inv.customer_name, inv.customer_phone); } catch { /* ignore */ }

      if (customerId) {
        const { data: customer } = await supabase.from('customers').select('escalation_paused').eq('id', customerId).maybeSingle();
        if (customer?.escalation_paused) {
          safeLog('info', '[CollectionsAgent] Skipping — escalation paused for customer', { userId, customerId, invoiceId: inv.id });
          continue;
        }
      }

      const stage   = getStage(inv.days_overdue);
      const isEscalationTier = ESCALATION_TYPES.includes(stage.type);

      if (isEscalationTier && customerId && escalatedRecently.has(customerId)) {
        safeLog('info', '[CollectionsAgent] Escalation cap hit — skipping for 24h', { userId, customerId, invoiceId: inv.id });
        continue;
      }

      const message = buildMessage(inv.customer_name, inv.invoice_amount, inv.days_overdue, stage);

      const spec = {
        action_type:          stage.type,
        title:                `${stage.type === 'FLAG_BAD_DEBT' ? '⚠️ Bad Debt Risk' : stage.type === 'ESCALATE_COLLECTION_CALL' ? '📞 Auto-call ready' : stage.type === 'ESCALATE_COLLECTION' ? '🚨 Escalate'  : '📩 Reminder'}: ${inv.customer_name}`,
        description:          `₹${Math.round(inv.invoice_amount).toLocaleString('en-IN')} — ${inv.days_overdue} days overdue`,
        priority:             stage.priority,
        risk_level:           stage.riskLevel,
        recommended_message:  stage.type !== 'FLAG_BAD_DEBT' ? message : null,
        related_entity_type:  'invoice',
        related_entity_id:    inv.id,
        customer_id:          customerId || null,
        suggested_by:         'system',
        requires_approval:    stage.riskLevel === 'high' || stage.type === 'ESCALATE_COLLECTION_CALL',
        _customer_phone:      inv.customer_phone, // for policy guard context
        _customer_name:       inv.customer_name,
      };

      // Policy guard
      const guard = await policyValidate(spec, userId);
      if (guard.status === 'system_blocked') {
        safeLog('info', '[CollectionsAgent] Action blocked by policy', { reason: guard.block_reason, invoice: inv.id });
        continue;
      }

      // Mark this customer as "escalated recently" for the rest of this run
      // too, so a customer with 3 overdue invoices doesn't get 3 escalation
      // actions in the same pass.
      if (isEscalationTier && customerId) escalatedRecently.add(customerId);

      specs.push(spec);
    }

    safeLog('info', '[CollectionsAgent] Run complete', { userId, generated: specs.length });
    return specs;
  } catch (err) {
    safeLog('error', '[CollectionsAgent] run failed', { error: err.message, userId });
    return [];
  }
}

module.exports = { run };
