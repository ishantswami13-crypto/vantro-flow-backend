// FILE: lib/services/agents/collectionsAgent.js
// Collections Recovery Agent — generates reminder actions based on overdue stage.
// Stages: polite (1–7d) → firm (8–30d) → escalation (31–89d) → bad debt flag (90+d)
// Uses Hinglish templates from aiPlanner. Respects policyGuard before returning.
// Pure async function — never throws, returns [] on error.
const { supabase }     = require('../../config/supabaseClient');
const { safeLog }      = require('../../observability/logger');

const STAGE_CONFIG = [
  { minDays: 1,  maxDays: 7,  type: 'SEND_POLITE_REMINDER',   priority: 'medium', riskLevel: 'low'    },
  { minDays: 8,  maxDays: 30, type: 'SEND_FIRM_REMINDER',      priority: 'high',   riskLevel: 'medium' },
  { minDays: 31, maxDays: 89, type: 'ESCALATE_COLLECTION',     priority: 'urgent', riskLevel: 'high'   },
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

    let query = supabase
      .from('invoices')
      .select('id, customer_name, customer_phone, invoice_amount, days_overdue, last_reminder_sent')
      .eq('user_id', userId)
      .eq('payment_status', 'Pending')
      .gt('days_overdue', 0)
      .order('days_overdue', { ascending: false })
      .limit(context.customerId ? 10 : 50);

    if (context.invoiceId) query = query.eq('id', context.invoiceId);

    const { data: invoices, error } = await query;
    if (error) throw error;

    // Check which customers already have a pending action to avoid duplication
    const { data: existingActions } = await supabase
      .from('ai_actions')
      .select('related_entity_id')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .in('action_type', ['SEND_POLITE_REMINDER', 'SEND_FIRM_REMINDER', 'ESCALATE_COLLECTION', 'FLAG_BAD_DEBT']);

    const alreadyQueued = new Set((existingActions || []).map(a => a.related_entity_id));

    const specs = [];

    for (const inv of (invoices || [])) {
      if (alreadyQueued.has(inv.id)) continue;

      const stage   = getStage(inv.days_overdue);
      const message = buildMessage(inv.customer_name, inv.invoice_amount, inv.days_overdue, stage);

      const spec = {
        action_type:          stage.type,
        title:                `${stage.type === 'FLAG_BAD_DEBT' ? '⚠️ Bad Debt Risk' : stage.type === 'ESCALATE_COLLECTION' ? '🚨 Escalate'  : '📩 Reminder'}: ${inv.customer_name}`,
        description:          `₹${Math.round(inv.invoice_amount).toLocaleString('en-IN')} — ${inv.days_overdue} days overdue`,
        priority:             stage.priority,
        risk_level:           stage.riskLevel,
        recommended_message:  stage.type !== 'FLAG_BAD_DEBT' ? message : null,
        related_entity_type:  'invoice',
        related_entity_id:    inv.id,
        suggested_by:         'collections_agent',
        requires_approval:    stage.riskLevel === 'high',
        _customer_phone:      inv.customer_phone, // for policy guard context
        _customer_name:       inv.customer_name,
      };

      // Policy guard
      const guard = await policyValidate(spec, userId);
      if (guard.blocked) {
        safeLog('info', '[CollectionsAgent] Action blocked by policy', { reason: guard.reason, invoice: inv.id });
        continue;
      }

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
