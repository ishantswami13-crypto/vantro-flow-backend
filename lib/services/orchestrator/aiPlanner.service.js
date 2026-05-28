// FILE: lib/services/orchestrator/aiPlanner.service.js
// AI Planner — improves recommendations and generates message drafts using Claude.
// IMPORTANT: AI never modifies financial data. It only returns structured JSON suggestions.
// Every output is validated by policyGuard before being saved as an ai_action.
//
// Milestone A: template-based stubs. Full Claude integration in Milestone C.
const { safeLog } = require('../../observability/logger');
const { isEnabled } = require('../../featureFlags');

// Tones mapped to Hinglish/Hindi-English message templates
const MESSAGE_TEMPLATES = {
  soft: (name, amount, invoiceNo) =>
    `Namaste ${name} ji! Aapka invoice ${invoiceNo} ka ₹${amount} payment pending hai. Jab bhi convenient ho, please clear kar dein. Dhanyawad! 🙏`,
  professional: (name, amount, invoiceNo) =>
    `Dear ${name}, your invoice ${invoiceNo} for ₹${amount} is pending. Kindly arrange payment at your earliest convenience. Thank you.`,
  firm: (name, amount, invoiceNo, days) =>
    `Dear ${name}, payment of ₹${amount} for invoice ${invoiceNo} is overdue by ${days} days. Please clear immediately to avoid disruption to your account.`,
  escalation: (name, amount, invoiceNo, days) =>
    `${name}, this is an urgent notice. ₹${amount} for invoice ${invoiceNo} has been outstanding for ${days} days. Immediate attention is required.`,
};

// Generate a collection message draft.
// In Milestone A this is template-based. Milestone C will call Claude for context-aware drafts.
async function generateCollectionMessage(customer, receivable, tone = 'professional') {
  if (!isEnabled('ai_message_drafts')) {
    return MESSAGE_TEMPLATES[tone]?.(
      customer.name || 'Customer',
      parseFloat(receivable.invoice_amount || 0).toLocaleString('en-IN'),
      receivable.invoice_number || '',
      receivable.days_overdue || 0
    ) || MESSAGE_TEMPLATES.professional(customer.name, receivable.invoice_amount, receivable.invoice_number);
  }

  // Milestone C: Claude API call with structured JSON output
  // Will be wired here — for now fall through to template
  return MESSAGE_TEMPLATES[tone]?.(
    customer.name,
    parseFloat(receivable.invoice_amount || 0).toLocaleString('en-IN'),
    receivable.invoice_number || '',
    receivable.days_overdue || 0
  );
}

// Generate daily owner briefing text.
// In Milestone A: template. Milestone C: Claude summarises anomalies.
async function generateOwnerBriefing(userId, summary = {}) {
  const lines = [];
  if (summary.todaySalesAmount) {
    lines.push(`Sales today: ₹${parseFloat(summary.todaySalesAmount).toLocaleString('en-IN')} (${summary.todaySalesCount || 0} invoices)`);
  }
  if (summary.overdueAmount) {
    lines.push(`Overdue: ₹${parseFloat(summary.overdueAmount).toLocaleString('en-IN')} across ${summary.overdueCount || 0} invoices`);
  }
  if (summary.brokenPromises > 0) {
    lines.push(`Broken promises today: ${summary.brokenPromises}`);
  }
  if (summary.lowStockCount > 0) {
    lines.push(`Low stock alerts: ${summary.lowStockCount} products need reorder`);
  }
  if (summary.supplierPaymentsDue > 0) {
    lines.push(`Supplier payments due this week: ${summary.supplierPaymentsDue}`);
  }

  return {
    briefing:      lines.length ? lines.join('\n') : 'No critical actions today.',
    source:        'template',
    generated_at:  new Date().toISOString(),
  };
}

// Placeholder for Milestone C — will call Claude with event context and return structured action specs.
async function planActionsForEvent(userId, event, context = {}) {
  safeLog('info', '[AiPlanner] planActionsForEvent called (stub — full AI in Milestone C)', {
    eventType: event.event_type,
    userId,
  });
  return []; // Milestone C will return ActionSpec[]
}

module.exports = { generateCollectionMessage, generateOwnerBriefing, planActionsForEvent };
