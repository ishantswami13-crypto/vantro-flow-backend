// FILE: lib/domain/os/workflowTemplates.js
// MISSIONS: the automation manifests Starlane can actually run.
//
// Only workflows with a real engine behind them are listed. Each step
// declares who performs it and what Starlane can really do there:
//   EXECUTABLE    Starlane does it (internal, deterministic)
//   HUMAN         a person does it (approval)
//   PREPARE_ONLY  Starlane prepares it; a person completes it outside
//   BLOCKED       cannot run with what is connected today
// A step is never shown as automated when it is only prepared.

const AGENT_KEY = 'starlane.collections_agent';
const ENGINE_KEY = 'starlane.workflow_engine';
const AGENT_VERSION = 'collections-agent@2026.09.29-1';
const MODEL = 'deterministic (no LLM)';

const PERMISSIONS = ['READ', 'ANALYZE', 'PREPARE', 'EXECUTE'];

// Levels from the automation ladder. Level 5 (execute within policy) is
// never set by Starlane itself.
const LEVELS = {
  0: 'Manual process detected',
  1: 'Starlane observes',
  2: 'Starlane recommends automation',
  3: 'Starlane prepares actions (shadow)',
  4: 'Starlane executes with approval',
  5: 'Starlane executes within policy',
};

const DEFAULTS = Object.freeze({ overdueDays: 30, minBalance: 10000, verifyWithinDays: 7, maxActionsPerRun: 25, approvalExpiryDays: 7 });

function receivablesFollowup({ overdueDays = DEFAULTS.overdueDays, minBalance = DEFAULTS.minBalance, currency = 'INR' } = {}) {
  return {
    templateKey: 'receivables_followup',
    name: 'Overdue invoice follow-up',
    objective: `Collect invoices that are ${overdueDays}+ days overdue without anyone having to notice and chase them by hand.`,
    trigger: { type: 'INVOICE_OVERDUE', overdueDays, description: `An invoice is ${overdueDays} or more days past its due date` },
    conditions: [
      { key: 'min_balance', operator: '>=', value: minBalance, currency, description: `The customer owes at least ${minBalance.toLocaleString('en-IN')} ${currency} on those invoices` },
      { key: 'not_disputed', description: 'No open dispute on the invoice (disputed invoices are never chased)' },
      { key: 'not_paused', description: 'Collections are not paused for the customer' },
    ],
    steps: [
      { key: 'detect', label: 'Find customers with invoices past the trigger', performer: 'SYSTEM', capability: 'EXECUTABLE' },
      { key: 'context', label: 'Read payment history and promises', performer: 'SYSTEM', capability: 'EXECUTABLE' },
      { key: 'priority', label: 'Rank by amount at risk', performer: 'SYSTEM', capability: 'EXECUTABLE' },
      { key: 'draft', label: 'Draft a reminder from the ledger facts', performer: 'AGENT', agent: AGENT_KEY, capability: 'EXECUTABLE', permission: 'PREPARE' },
      { key: 'approve', label: 'Owner approves or rejects each reminder', performer: 'HUMAN', capability: 'HUMAN' },
      { key: 'send', label: 'Send the reminder', performer: 'HUMAN', capability: 'PREPARE_ONLY', permission: 'EXECUTE',
        note: 'Starlane does not send reminders from workflows yet. Approved reminders are ready to copy and send; manual completion required.' },
      { key: 'verify', label: `Check whether payment arrived within ${DEFAULTS.verifyWithinDays} days`, performer: 'SYSTEM', capability: 'EXECUTABLE' },
    ],
    approvals: [{ step: 'approve', rule: 'Every customer reminder needs the owner\'s approval', expiresAfterDays: DEFAULTS.approvalExpiryDays }],
    policies: [
      { key: 'no_disputed', description: 'Never contact a customer about a disputed invoice' },
      { key: 'strategic_requires_approval', description: 'Customers tagged strategic are never contacted without approval' },
      { key: 'no_payment_marking', description: 'The workflow can never mark an invoice paid or change an amount' },
      { key: 'shadow_by_default', description: 'In shadow mode nothing leaves Starlane; it records what it would have done' },
    ],
    agentPermissions: { [AGENT_KEY]: ['READ', 'ANALYZE', 'PREPARE'] },
    budget: { maxActionsPerRun: DEFAULTS.maxActionsPerRun, tokens: 0, money: 0, apiCalls: 0 },
    successMetric: { metric: 'payment_received', withinDays: DEFAULTS.verifyWithinDays, description: `Payment (full or part) recorded in the ledger within ${DEFAULTS.verifyWithinDays} days of the reminder` },
    expectedOutcome: { metric: 'payment_received', withinDays: DEFAULTS.verifyWithinDays, measuredAgainst: 'the historical share of overdue invoices paid in the same window without a reminder' },
    fallback: [
      { on: 'step_failure', then: 'retry once, then hand the item to a person' },
      { on: 'stale_data', then: 'stop the run; never act on balances older than the freshness limit' },
      { on: 'reality_changed', then: 'cancel the item (invoice paid, disputed or changed) and re-plan on the next run' },
    ],
    stopConditions: [
      { key: 'kill_switch', description: 'Tenant, agent, workflow or action-class stop is on' },
      { key: 'stale_data', description: 'Receivables data is older than the freshness limit' },
      { key: 'permission_revoked', description: 'The collections agent no longer has permission to prepare' },
    ],
  };
}

const TEMPLATES = { receivables_followup: receivablesFollowup };

module.exports = { receivablesFollowup, TEMPLATES, LEVELS, DEFAULTS, PERMISSIONS, AGENT_KEY, ENGINE_KEY, AGENT_VERSION, MODEL };
