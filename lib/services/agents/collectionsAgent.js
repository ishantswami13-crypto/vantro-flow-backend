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

// Ordered index of stages, used to move one step up/down the escalation ladder.
const STAGE_INDEX = STAGE_CONFIG.reduce((m, s, i) => { m[s.type] = i; return m; }, {});

/**
 * Pure function: nudge the deterministically-chosen stage using the learned
 * `responds_to_${tone}_reminder` business_memory signal that evaluationAgent.js
 * writes and (until now) nobody read.
 *
 * Inputs:
 *   - stage: the STAGE_CONFIG entry chosen by getStage(daysOverdue) — the existing,
 *     unmodified deterministic decision based on days overdue.
 *   - memory: a plain object such as { polite: {v:true}, firm: {v:false} } keyed by
 *     tone, built from the customer's business_memory rows for
 *     responds_to_polite_reminder / responds_to_firm_reminder. Missing/malformed/
 *     empty MUST be tolerated — pass {} or undefined for "no memory".
 *
 * Rule (simple, explainable, derived from what evaluationAgent.js's value actually
 * means — "this reminder tone got this invoice paid before"):
 *   - Only applies to the two reminder stages (SEND_POLITE_REMINDER / SEND_FIRM_REMINDER);
 *     ESCALATE_COLLECTION and FLAG_BAD_DEBT are left untouched (memory only exists for the
 *     two reminder tones, and escalation/bad-debt already represents "reminders didn't work").
 *   - If the customer is currently on SEND_POLITE_REMINDER but memory says polite has NOT
 *     worked for them before (v === false) and firm HAS worked (v === true) in the past,
 *     escalate one step early to SEND_FIRM_REMINDER — evidence-based skip of a tone that's
 *     already known to fail for this customer.
 *   - If the customer is currently on SEND_FIRM_REMINDER but memory says polite DID work for
 *     them before (v === true) and there's no evidence firm worked, de-escalate to
 *     SEND_POLITE_REMINDER — a customer who has previously responded to a polite tone doesn't
 *     need to be greeted with a firmer one just because this particular invoice crossed the
 *     8-day threshold.
 *   - Any other combination (no memory, both/neither recorded, malformed values) falls back
 *     to the stage the existing threshold logic already picked — never throws, never blocks.
 */
function applyMemoryTonePreference(stage, memory) {
  try {
    if (!stage || (stage.type !== 'SEND_POLITE_REMINDER' && stage.type !== 'SEND_FIRM_REMINDER')) {
      return stage;
    }
    const m = memory && typeof memory === 'object' ? memory : {};
    const politeWorked = m.polite && m.polite.v === true;
    const politeFailed = m.polite && m.polite.v === false;
    const firmWorked   = m.firm && m.firm.v === true;

    if (stage.type === 'SEND_POLITE_REMINDER' && politeFailed && firmWorked) {
      return STAGE_CONFIG[STAGE_INDEX.SEND_FIRM_REMINDER];
    }
    if (stage.type === 'SEND_FIRM_REMINDER' && politeWorked && !firmWorked) {
      return STAGE_CONFIG[STAGE_INDEX.SEND_POLITE_REMINDER];
    }
    return stage;
  } catch (_e) {
    // Never let a malformed memory value block the existing deterministic flow.
    return stage;
  }
}

/**
 * Build a { polite, firm } memory map for one customer from raw business_memory rows.
 * Tolerates missing/malformed memory_value shapes — returns {} rather than throwing.
 */
function buildToneMemory(rows) {
  const out = {};
  for (const r of (rows || [])) {
    try {
      if (r.memory_key === 'responds_to_polite_reminder') out.polite = r.memory_value;
      if (r.memory_key === 'responds_to_firm_reminder')    out.firm   = r.memory_value;
    } catch (_e) { /* skip malformed row */ }
  }
  return out;
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
      .select('id, customer_id, customer_name, customer_phone, invoice_amount, days_overdue, last_reminder_sent')
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

    // Bulk-fetch reminder-tone memory for every customer_id in scope (tenant-scoped,
    // one query instead of N) — this is the Learning-loop read: evaluationAgent.js
    // already writes responds_to_polite_reminder / responds_to_firm_reminder to
    // business_memory when a reminder works; nothing consulted it until now.
    const customerIds = [...new Set((invoices || []).map(i => i.customer_id).filter(Boolean))];
    let memoryByCustomer = {};
    if (customerIds.length) {
      const { data: memRows } = await supabase
        .from('business_memory')
        .select('entity_id, memory_key, memory_value')
        .eq('user_id', userId)
        .eq('entity_type', 'customer')
        .in('entity_id', customerIds)
        .in('memory_key', ['responds_to_polite_reminder', 'responds_to_firm_reminder']);

      memoryByCustomer = (memRows || []).reduce((acc, r) => {
        (acc[r.entity_id] = acc[r.entity_id] || []).push(r);
        return acc;
      }, {});
    }

    const specs = [];

    for (const inv of (invoices || [])) {
      if (alreadyQueued.has(inv.id)) continue;

      const baseStage = getStage(inv.days_overdue);
      const toneMemory = inv.customer_id ? buildToneMemory(memoryByCustomer[inv.customer_id]) : {};
      const stage      = applyMemoryTonePreference(baseStage, toneMemory);
      const message    = buildMessage(inv.customer_name, inv.invoice_amount, inv.days_overdue, stage);

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
      if (guard.status === 'system_blocked') {
        safeLog('info', '[CollectionsAgent] Action blocked by policy', { reason: guard.block_reason, invoice: inv.id });
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

module.exports = {
  run,
  getStage,
  applyMemoryTonePreference,
  buildToneMemory,
  STAGE_CONFIG,
};
