// FILE: lib/services/agents/dataQualityAgent.js
// Data Quality Agent — finds missing phone numbers, duplicates, invoices without due dates.
// Runs weekly (Sundays 8am IST) and creates grouped data_quality ai_actions.
const { supabase } = require('../../config/supabaseClient');
const { safeLog }  = require('../../observability/logger');

/**
 * Run the Data Quality Agent.
 * @param {string} userId
 * @returns {Array} ActionSpecs (one per issue category found)
 */
async function run(userId, context = {}) {
  try {
    const specs = [];

    const [invoicesRes, customersRes] = await Promise.all([
      supabase.from('invoices')
        .select('id, customer_name, customer_phone, payment_status')
        .eq('user_id', userId)
        .eq('payment_status', 'Pending'),
      supabase.from('customers')
        .select('id, name, phone')
        .eq('user_id', userId)
        .eq('is_active', true),
    ]);

    const invoices  = invoicesRes.data  || [];
    const customers = customersRes.data || [];

    // ── 1. Invoices with no phone number ──────────────────────────────────
    const noPhoneInvoices = invoices.filter(i => !i.customer_phone);
    if (noPhoneInvoices.length >= 3) {
      const { data: existing } = await supabase
        .from('ai_actions').select('id').eq('user_id', userId)
        .eq('action_type', 'DATA_QUALITY').eq('status', 'pending')
        .ilike('title', '%phone%').maybeSingle();
      if (!existing) {
        specs.push({
          action_type:   'DATA_QUALITY',
          title:         `${noPhoneInvoices.length} invoices missing phone numbers`,
          description:   `Can't send WhatsApp reminders without phone numbers. Add phone to: ${noPhoneInvoices.slice(0, 3).map(i => i.customer_name).join(', ')}${noPhoneInvoices.length > 3 ? ` +${noPhoneInvoices.length - 3} more` : ''}.`,
          priority:      noPhoneInvoices.length >= 10 ? 'high' : 'medium',
          risk_level:    'low',
          suggested_by:  'data_quality_agent',
          requires_approval: false,
        });
      }
    }

    // ── 2. Duplicate customer names ────────────────────────────────────────
    const nameCounts = {};
    customers.forEach(c => {
      const key = c.name.toLowerCase().trim();
      nameCounts[key] = (nameCounts[key] || []).concat(c.id);
    });
    const duplicates = Object.entries(nameCounts).filter(([, ids]) => ids.length > 1);
    if (duplicates.length >= 2) {
      const { data: existingDup } = await supabase
        .from('ai_actions').select('id').eq('user_id', userId)
        .eq('action_type', 'DATA_QUALITY').eq('status', 'pending')
        .ilike('title', '%duplicate%').maybeSingle();
      if (!existingDup) {
        specs.push({
          action_type:   'DATA_QUALITY',
          title:         `${duplicates.length} duplicate customer names found`,
          description:   `Duplicates may cause split collection history. Review: ${duplicates.slice(0, 3).map(([n]) => n).join(', ')}.`,
          priority:      'medium',
          risk_level:    'low',
          suggested_by:  'data_quality_agent',
          requires_approval: false,
        });
      }
    }

    // ── 3. Pending invoices without due date ───────────────────────────────
    const noDueDate = invoices.filter(i => !i.due_date && i.payment_status === 'Pending');
    if (noDueDate.length >= 5) {
      const { data: existingDue } = await supabase
        .from('ai_actions').select('id').eq('user_id', userId)
        .eq('action_type', 'DATA_QUALITY').eq('status', 'pending')
        .ilike('title', '%due date%').maybeSingle();
      if (!existingDue) {
        specs.push({
          action_type:   'DATA_QUALITY',
          title:         `${noDueDate.length} invoices have no due date`,
          description:   'Without due dates, Cortex can\'t prioritize collection timing accurately. Set due dates on pending invoices.',
          priority:      'low',
          risk_level:    'low',
          suggested_by:  'data_quality_agent',
          requires_approval: false,
        });
      }
    }

    safeLog('info', '[DataQualityAgent] Run complete', { userId, issues: specs.length });
    return specs;
  } catch (err) {
    safeLog('error', '[DataQualityAgent] run failed', { error: err.message, userId });
    return [];
  }
}

module.exports = { run };
