'use strict';
// FILE: lib/domain/workflows/customWorkflows.js
// Custom workflows: an owner chains Starlane's agents and their connected
// tools into their own automation. A workflow is
//
//   trigger  →  step  →  step  →  …
//
// Triggers   when I press Run, a schedule, a new Gmail message, or a POST to
//            one of the tenant's incoming webhooks (any software).
// Steps      agent      run a real agent (Scan, Working capital, Email triage)
//            condition  continue only if a value from the trigger or an
//                       earlier agent passes a test
//            action     notify the owner, create a task, draft an email for
//                       approval, call any REST API, post to Slack
//
// Values from the trigger and earlier steps can be written into action text
// as {{trigger.subject}} or {{triage.amount}}.
//
// Honesty contract, enforced here and tested:
//   - Triggers, agents and actions that are not built are listed as
//     'coming_soon' with a reason, and a workflow that uses one is refused.
//   - No customer receives anything without the owner. "Send an email" only
//     drafts it; the email leaves through the owner's Gmail after they
//     approve it, and only while FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED is
//     on and no global stop is set (lib/safety/externalSend).
//   - Calls to the owner's own tools (an API, Slack) run only while
//     FEATURE_WORKFLOW_HTTP_ACTIONS_ENABLED is on, through safeHttp (https
//     only, no private addresses).
//   - Agents keep their own safety: each agent checks its kill switch, and a
//     workflow-scoped stop (Controls) blocks the whole run.
//   - A run is claimed by (workflow, slot) so a schedule firing, an email or
//     a webhook delivery runs once across servers, and a manual run at most
//     once a minute.
//   - Every query is scoped by user_id; no function takes an id without it.

const { checkStops, getSettings } = require('../decisions/controls');
const { safeLog } = require('../../observability/logger');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STEP_ID_RE = /^[a-z][a-z0-9_]{0,23}$/;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
const MAX_STEPS = 12;
const MAX_WORKFLOWS = 50;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// ── Catalog ─────────────────────────────────────────────────────────────

const TEXT = 'text';

const TRIGGERS = Object.freeze([
  { type: 'manual', name: 'When I run it', summary: 'Runs when you press Run now.', availability: 'available', outputs: [] },
  { type: 'schedule', name: 'On a schedule', summary: 'Every day or every week at an hour you pick, in your business timezone.', availability: 'available', outputs: [] },
  {
    type: 'email_received', name: 'When an email arrives in Gmail', summary: 'Runs for each new message in your connected Gmail inbox, optionally only from a sender or with a subject you choose.',
    availability: 'available', requires: 'gmail',
    outputs: [
      { key: 'from', label: 'Sender', unit: TEXT },
      { key: 'fromAddress', label: 'Sender address', unit: TEXT },
      { key: 'subject', label: 'Subject', unit: TEXT },
      { key: 'body', label: 'Message text', unit: TEXT },
    ],
  },
  {
    type: 'webhook_received', name: 'When another app sends data', summary: 'Runs each time a tool posts to one of your incoming webhooks: Zapier, Make, Stripe, Shopify, your CRM or a script.',
    availability: 'available', requires: 'webhook',
    outputs: [
      { key: 'eventType', label: 'Event type (the "event" or "type" field)', unit: TEXT },
      { key: 'data', label: 'Any field it sent, as data.field', unit: 'any', dynamic: true },
    ],
  },
  { type: 'connector_synced', name: 'When a data source syncs', summary: 'Runs after QuickBooks, Xero, Tally or another source finishes a sync.', availability: 'coming_soon', reason: 'Sync events are recorded but do not start workflows yet.', outputs: [] },
  { type: 'invoice_overdue', name: 'When an invoice becomes overdue', summary: 'Runs the day an invoice passes its due date.', availability: 'coming_soon', reason: 'Not built yet. A daily schedule with the Scan agent covers this today.', outputs: [] },
  { type: 'payment_received', name: 'When a payment arrives', summary: 'Runs when a bank feed or payment processor reports a payment.', availability: 'coming_soon', reason: 'Needs a live bank or payments connector. Today, point your payment processor’s webhook at an incoming webhook and use "When another app sends data".', outputs: [] },
]);

// Agents a workflow can run, the values each one produces (for conditions
// and templates), and how to read them from the agent's result.
const AGENTS = Object.freeze([
  {
    key: 'starlane.scan',
    name: 'Scan',
    summary: 'Rebuilds your invoice-to-payment process, finds decisions that need you and proposes automations.',
    availability: 'available',
    outputs: [
      { key: 'openDecisions', label: 'Decisions waiting for you', unit: 'count' },
      { key: 'automationOpportunities', label: 'Automation opportunities found', unit: 'count' },
      { key: 'businessOpportunities', label: 'Business opportunities found', unit: 'count' },
      { key: 'invoicesScanned', label: 'Invoices scanned', unit: 'count' },
    ],
  },
  {
    key: 'starlane.working_capital',
    name: 'Working capital',
    summary: 'Lays out money due in against money owed out for the next weeks and names the first week that runs short.',
    availability: 'available',
    params: [{ key: 'horizonDays', label: 'Days ahead', min: 7, max: 90, default: 28 }],
    outputs: [
      { key: 'gap', label: 'Cash gap (money out minus money in)', unit: 'money' },
      { key: 'net', label: 'Net flow', unit: 'money' },
      { key: 'moneyIn', label: 'Money due in', unit: 'money' },
      { key: 'moneyOut', label: 'Money owed out', unit: 'money' },
      { key: 'overdueIn', label: 'Overdue from customers', unit: 'money' },
      { key: 'firstShortWeek', label: 'First week that runs short', unit: 'week' },
    ],
  },
  {
    key: 'starlane.email_triage',
    name: 'Email triage',
    summary: 'Reads the email (or the subject and body a webhook sent) and says whether it is an invoice, a payment, a promise to pay, a dispute or a question, with the amount, invoice number and date it states, and the customer it comes from.',
    availability: 'available',
    needsTrigger: ['email_received', 'webhook_received'],
    outputs: [
      { key: 'category', label: 'Kind of email (invoice, payment_sent, payment_promise, dispute, question, other)', unit: TEXT },
      { key: 'amount', label: 'Amount it states', unit: 'money' },
      { key: 'currency', label: 'Currency it states', unit: TEXT },
      { key: 'invoiceNumber', label: 'Invoice number it states', unit: TEXT },
      { key: 'date', label: 'Date it states', unit: TEXT },
      { key: 'customerName', label: 'Customer it comes from', unit: TEXT },
      { key: 'customerOpenBalance', label: 'That customer’s open balance', unit: 'money' },
    ],
  },
  { key: 'starlane.supplier_risk', name: 'Supplier risk', summary: 'Flags suppliers likely to deliver late or raise prices.', availability: 'coming_soon', reason: 'Needs supplier and lead-time data that no connector provides yet.', outputs: [] },
  { key: 'starlane.research', name: 'Research', summary: 'Looks up a customer or market before a decision.', availability: 'coming_soon', reason: 'No external research source is connected, and Starlane does not invent market data.', outputs: [] },
]);

const ACTIONS = Object.freeze([
  { key: 'notify_owner', name: 'Notify me in Starlane', summary: 'Puts a notification in your Starlane inbox (web, desktop and phone).', availability: 'available', external: false },
  { key: 'create_task', name: 'Create a task', summary: 'Adds a task to your Starlane task list, with an optional due date.', availability: 'available', external: false },
  { key: 'send_email', name: 'Draft an email for my approval', summary: 'Writes an email (or a reply in the same thread) from your Gmail. It is sent only after you approve it.', availability: 'available', external: true, requires: 'gmail', flag: 'external_message_sending_enabled' },
  { key: 'http_request', name: 'Call an API', summary: 'Sends a request to any software with a REST API, through a connection you set up (API key, token, basic or OAuth2).', availability: 'available', external: true, requires: 'http_api', flag: 'workflow_http_actions_enabled' },
  { key: 'post_slack', name: 'Post to Slack', summary: 'Posts a message to a Slack channel through an incoming webhook you connect.', availability: 'available', external: true, requires: 'slack', flag: 'workflow_http_actions_enabled' },
  { key: 'send_whatsapp', name: 'Send a WhatsApp or SMS message', summary: 'Messages a customer, after you approve each message.', availability: 'coming_soon', reason: 'WhatsApp and SMS approvals are not wired into workflows yet. Use "Draft an email for my approval" today.' },
  { key: 'create_crm_task', name: 'Create a CRM task', summary: 'Creates a follow-up task in HubSpot or Salesforce.', availability: 'coming_soon', reason: 'No dedicated HubSpot or Salesforce connector yet. "Call an API" with your CRM’s API key does this today.' },
  { key: 'update_sheet', name: 'Add a row to a spreadsheet', summary: 'Appends the result to Google Sheets or Excel.', availability: 'coming_soon', reason: 'No Sheets write access yet. "Call an API" to a Sheets webhook (Apps Script, Zapier) does this today.' },
]);

const NUM_OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'exists', 'missing'];
const TEXT_OPS = ['eq', 'neq', 'contains', 'not_contains', 'exists', 'missing'];
const norm = (v) => String(v ?? '').trim().toLowerCase();
const OPS = Object.freeze({
  gt: { label: 'is more than', needsValue: true, test: (a, b) => a > b },
  gte: { label: 'is at least', needsValue: true, test: (a, b) => a >= b },
  lt: { label: 'is less than', needsValue: true, test: (a, b) => a < b },
  lte: { label: 'is at most', needsValue: true, test: (a, b) => a <= b },
  eq: { label: 'equals', needsValue: true, test: (a, b) => (typeof b === 'string' ? norm(a) === norm(b) : a === b) },
  neq: { label: 'is not', needsValue: true, test: (a, b) => (typeof b === 'string' ? norm(a) !== norm(b) : a !== b) },
  contains: { label: 'contains', needsValue: true, test: (a, b) => a !== null && a !== undefined && norm(a).includes(norm(b)) },
  not_contains: { label: 'does not contain', needsValue: true, test: (a, b) => !norm(a).includes(norm(b)) },
  exists: { label: 'has a value', needsValue: false, test: (a) => a !== null && a !== undefined && a !== '' },
  missing: { label: 'has no value', needsValue: false, test: (a) => a === null || a === undefined || a === '' },
});

// Starter workflows shown in the builder. Each one validates.
const TEMPLATES = Object.freeze([
  {
    key: 'weekly_cash_check',
    name: 'Monday cash check',
    description: 'Every Monday at 8, project the next four weeks and tell me if cash runs short.',
    definition: {
      trigger: { type: 'schedule', every: 'weekly', weekday: 'mon', hour: 8 },
      steps: [
        { id: 'cash', type: 'agent', agent: 'starlane.working_capital', params: { horizonDays: 28 } },
        { id: 'short', type: 'condition', signal: 'cash.gap', op: 'gt', value: 0 },
        { id: 'tell', type: 'action', action: 'notify_owner', params: { title: 'Cash runs short in the next four weeks', includeSummaryOf: 'cash' } },
      ],
    },
  },
  {
    key: 'daily_receivables_scan',
    name: 'Morning receivables scan',
    description: 'Every morning at 9, scan invoices and payments and tell me when decisions are waiting.',
    definition: {
      trigger: { type: 'schedule', every: 'daily', hour: 9 },
      steps: [
        { id: 'scan', type: 'agent', agent: 'starlane.scan' },
        { id: 'waiting', type: 'condition', signal: 'scan.openDecisions', op: 'gt', value: 0 },
        { id: 'tell', type: 'action', action: 'notify_owner', params: { title: 'Decisions are waiting for you', includeSummaryOf: 'scan' } },
      ],
    },
  },
  {
    key: 'promise_reply',
    name: 'Answer payment promises',
    description: 'When a customer emails a promise to pay, thank them in the same thread (after I approve) and add a follow-up task.',
    definition: {
      trigger: { type: 'email_received' },
      steps: [
        { id: 'triage', type: 'agent', agent: 'starlane.email_triage' },
        { id: 'promise', type: 'condition', signal: 'triage.category', op: 'eq', value: 'payment_promise' },
        { id: 'reply', type: 'action', action: 'send_email', params: { replyToTrigger: true, to: '{{trigger.fromAddress}}', subject: 'Re: {{trigger.subject}}', body: 'Thank you for confirming. We have noted the payment date and will look out for it.' } },
        { id: 'follow', type: 'action', action: 'create_task', params: { title: 'Check payment promised by {{trigger.from}}', detail: '{{triage.amount}} {{triage.currency}} for {{triage.invoiceNumber}}, promised for {{triage.date}}.', dueInDays: 3 } },
      ],
    },
  },
  {
    key: 'invoice_inbox',
    name: 'Invoices from my inbox',
    description: 'When an email with an invoice or bill arrives, tell me what it says and add a task to review it.',
    definition: {
      trigger: { type: 'email_received' },
      steps: [
        { id: 'triage', type: 'agent', agent: 'starlane.email_triage' },
        { id: 'is_invoice', type: 'condition', signal: 'triage.category', op: 'eq', value: 'invoice' },
        { id: 'tell', type: 'action', action: 'notify_owner', params: { title: 'Invoice received from {{trigger.from}}', message: '{{triage.currency}} {{triage.amount}}, invoice {{triage.invoiceNumber}}, due {{triage.date}}.' } },
        { id: 'review', type: 'action', action: 'create_task', params: { title: 'Review invoice {{triage.invoiceNumber}} from {{trigger.from}}', dueInDays: 2 } },
      ],
    },
  },
  {
    key: 'disputes_alert',
    name: 'Flag disputes',
    description: 'When a customer disputes an invoice by email, alert me straight away.',
    definition: {
      trigger: { type: 'email_received' },
      steps: [
        { id: 'triage', type: 'agent', agent: 'starlane.email_triage' },
        { id: 'is_dispute', type: 'condition', signal: 'triage.category', op: 'eq', value: 'dispute' },
        { id: 'tell', type: 'action', action: 'notify_owner', params: { title: 'Dispute from {{trigger.from}}', message: '{{trigger.subject}}' } },
      ],
    },
  },
  {
    key: 'scan_then_cash',
    name: 'Full check, on demand',
    description: 'When I run it, scan receivables, then project cash, and send me both results.',
    definition: {
      trigger: { type: 'manual' },
      steps: [
        { id: 'scan', type: 'agent', agent: 'starlane.scan' },
        { id: 'cash', type: 'agent', agent: 'starlane.working_capital', params: { horizonDays: 28 } },
        { id: 'tell', type: 'action', action: 'notify_owner', params: { title: 'Your full check is ready', includeSummaryOf: 'cash' } },
      ],
    },
  },
]);

function catalog({ schedulerEnabled = false, flags = {} } = {}) {
  return {
    triggers: TRIGGERS.map((t) => ({ ...t, outputs: t.outputs.map((o) => ({ ...o })), ...(t.type === 'schedule' || t.type === 'email_received' ? { schedulerEnabled } : {}) })),
    agents: AGENTS.map((a) => ({ ...a, outputs: a.outputs.map((o) => ({ ...o })) })),
    actions: ACTIONS.map((a) => ({ ...a, ...(a.flag ? { enabledOnServer: flags[a.flag] === true } : {}) })),
    operators: Object.entries(OPS).map(([key, o]) => ({ key, label: o.label, needsValue: o.needsValue, for: [...(NUM_OPS.includes(key) ? ['number'] : []), ...(TEXT_OPS.includes(key) ? ['text'] : [])] })),
    templates: TEMPLATES.map((t) => JSON.parse(JSON.stringify(t))),
    limits: { maxSteps: MAX_STEPS, maxWorkflows: MAX_WORKFLOWS },
  };
}

// ── Templates ({{ref.field}}) ───────────────────────────────────────────

const TEMPLATE_RE = /\{\{\s*([a-z][a-z0-9_]*)((?:\.[A-Za-z0-9_]+){1,6})\s*\}\}/g;

function templateRefs(str) {
  const out = [];
  String(str || '').replace(TEMPLATE_RE, (_, root, rest) => { out.push({ root, path: rest.slice(1).split('.') }); return ''; });
  return out;
}

function lookup(ctx, root, path) {
  let v = ctx[root];
  for (const k of path) {
    if (v === null || v === undefined || typeof v !== 'object') return null;
    v = Object.prototype.hasOwnProperty.call(v, k) ? v[k] : null;
  }
  return v === undefined ? null : v;
}

/** Writes values into {{…}} placeholders. Missing values become "". */
function renderTemplate(str, ctx, { maxLen = 4000 } = {}) {
  return String(str || '').replace(TEMPLATE_RE, (_, root, rest) => {
    const v = lookup(ctx, root, rest.slice(1).split('.'));
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v).slice(0, 500);
    return String(v);
  }).slice(0, maxLen);
}

// ── Validation ──────────────────────────────────────────────────────────

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

function unitKind(unit) {
  if (unit === TEXT) return 'text';
  if (unit === 'any') return 'any';
  return 'number';
}

/**
 * Validates and normalizes a workflow definition. Returns
 * { ok, errors, definition } where errors are plain sentences.
 */
function validateDefinition(input) {
  const errors = [];
  if (!input || typeof input !== 'object') return { ok: false, errors: ['The workflow is empty.'], definition: null };
  const out = { trigger: null, steps: [] };

  const t = input.trigger || {};
  const tMeta = TRIGGERS.find((x) => x.type === t.type);
  if (!tMeta) errors.push('Pick a trigger.');
  else if (tMeta.availability !== 'available') errors.push(`"${tMeta.name}" is not available yet: ${tMeta.reason}`);
  else if (t.type === 'manual') out.trigger = { type: 'manual' };
  else if (t.type === 'schedule') {
    const every = t.every === 'weekly' ? 'weekly' : t.every === 'daily' ? 'daily' : null;
    const hour = Number(t.hour);
    if (!every) errors.push('A schedule runs daily or weekly.');
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) errors.push('Pick an hour between 0 and 23.');
    let weekday = null;
    if (every === 'weekly') {
      weekday = WEEKDAYS.includes(String(t.weekday)) ? String(t.weekday) : null;
      if (!weekday) errors.push('Pick a day of the week.');
    }
    out.trigger = { type: 'schedule', every, hour, ...(weekday ? { weekday } : {}) };
  } else if (t.type === 'email_received') {
    const fromContains = String(t.fromContains || '').trim().slice(0, 120);
    const subjectContains = String(t.subjectContains || '').trim().slice(0, 120);
    out.trigger = { type: 'email_received', ...(fromContains ? { fromContains } : {}), ...(subjectContains ? { subjectContains } : {}) };
  } else if (t.type === 'webhook_received') {
    if (!UUID_RE.test(String(t.connectionId || ''))) errors.push('Pick which incoming webhook starts this workflow.');
    const eventType = String(t.eventType || '').trim().slice(0, 80);
    out.trigger = { type: 'webhook_received', connectionId: String(t.connectionId || ''), ...(eventType ? { eventType } : {}) };
  }

  // What each earlier step (and the trigger) offers to conditions and templates.
  const seen = new Map(); // id -> { outputs, dynamic }
  if (tMeta && tMeta.outputs.length) seen.set('trigger', { outputs: tMeta.outputs, dynamic: tMeta.outputs.some((o) => o.dynamic) });

  const checkRefs = (n, field, str) => {
    for (const r of templateRefs(str)) {
      const s = seen.get(r.root);
      if (!s) { errors.push(`Step ${n}: {{${r.root}.${r.path.join('.')}}} in the ${field} does not name the trigger or a step before this one.`); continue; }
      const o = s.outputs.find((x) => x.key === r.path[0]);
      if (!o) errors.push(`Step ${n}: {{${r.root}.${r.path.join('.')}}} is not something that step produces.`);
    }
  };

  const steps = Array.isArray(input.steps) ? input.steps : [];
  if (!steps.length) errors.push('Add at least one step.');
  if (steps.length > MAX_STEPS) errors.push(`A workflow has at most ${MAX_STEPS} steps.`);
  const ids = new Set(['trigger']);
  steps.slice(0, MAX_STEPS).forEach((s, i) => {
    const n = i + 1;
    if (!s || typeof s !== 'object') { errors.push(`Step ${n} is empty.`); return; }
    const id = typeof s.id === 'string' && STEP_ID_RE.test(s.id) ? s.id : `step${n}`;
    if (ids.has(id)) { errors.push(`Step ${n}: ${id === 'trigger' ? '"trigger" is reserved' : `another step is already called "${id}"`}.`); return; }
    ids.add(id);
    if (s.type === 'agent') {
      const a = AGENTS.find((x) => x.key === s.agent);
      if (!a) { errors.push(`Step ${n}: pick an agent.`); return; }
      if (a.availability !== 'available') { errors.push(`Step ${n}: the ${a.name} agent is not available yet: ${a.reason}`); return; }
      if (a.needsTrigger && !(out.trigger && a.needsTrigger.includes(out.trigger.type))) { errors.push(`Step ${n}: the ${a.name} agent reads the email or data that started the workflow, so use it with an email or webhook trigger.`); return; }
      const params = {};
      for (const p of a.params || []) {
        const raw = s.params?.[p.key];
        if (raw === undefined || raw === null || raw === '') { params[p.key] = p.default; continue; }
        const v = Math.round(Number(raw));
        if (!Number.isFinite(v) || v < p.min || v > p.max) errors.push(`Step ${n}: ${p.label} must be between ${p.min} and ${p.max}.`);
        else params[p.key] = v;
      }
      seen.set(id, { outputs: a.outputs, dynamic: false, agent: true });
      out.steps.push({ id, type: 'agent', agent: a.key, ...(Object.keys(params).length ? { params } : {}) });
    } else if (s.type === 'condition') {
      const parts = String(s.signal || '').split('.');
      const [ref, field] = parts;
      const src = seen.get(ref);
      if (!src) { errors.push(`Step ${n}: a condition checks the trigger or an agent step that comes before it.`); return; }
      const o = src.outputs.find((x) => x.key === field);
      if (!o) { errors.push(`Step ${n}: "${ref}" does not produce "${field || ''}".`); return; }
      if (o.dynamic && parts.length < 3) { errors.push(`Step ${n}: name the field to check, such as ${ref}.data.amount.`); return; }
      if (parts.length > (o.dynamic ? 8 : 2) || parts.some((p) => !/^[A-Za-z0-9_]+$/.test(p))) { errors.push(`Step ${n}: "${s.signal}" is not a field name.`); return; }
      const kind = unitKind(o.unit);
      const op = OPS[s.op];
      if (!op || (kind === 'number' && !NUM_OPS.includes(s.op)) || (kind === 'text' && !TEXT_OPS.includes(s.op))) { errors.push(`Step ${n}: pick how to compare.`); return; }
      let value;
      if (op.needsValue) {
        const raw = s.value;
        if (raw === '' || raw === null || raw === undefined) { errors.push(`Step ${n}: enter a value to compare with.`); return; }
        const asNum = Number(raw);
        const numericOp = ['gt', 'gte', 'lt', 'lte'].includes(s.op);
        if (kind === 'number' || (kind === 'any' && numericOp)) {
          if (!Number.isFinite(asNum)) { errors.push(`Step ${n}: enter a number to compare with.`); return; }
          value = asNum;
        } else if (kind === 'any' && Number.isFinite(asNum) && typeof raw === 'number') {
          value = asNum;
        } else {
          value = String(raw).slice(0, 200);
        }
      }
      out.steps.push({ id, type: 'condition', signal: parts.join('.'), op: s.op, ...(op.needsValue ? { value } : {}) });
    } else if (s.type === 'action') {
      const a = ACTIONS.find((x) => x.key === s.action);
      if (!a) { errors.push(`Step ${n}: pick an action.`); return; }
      if (a.availability !== 'available') { errors.push(`Step ${n}: "${a.name}" is not available yet: ${a.reason}`); return; }
      const p = s.params || {};
      const text = (v, max) => String(v ?? '').trim().slice(0, max);
      let params;
      if (a.key === 'notify_owner') {
        const title = text(p.title, 200);
        if (!title) errors.push(`Step ${n}: write what the notification should say.`);
        if (String(p.title || '').trim().length > 140 && !templateRefs(p.title).length) errors.push(`Step ${n}: keep the notification under 140 characters.`);
        const inc = p.includeSummaryOf;
        if (inc && !(seen.has(inc) && seen.get(inc).agent)) errors.push(`Step ${n}: "include the result of" must name an agent step before it.`);
        const message = text(p.message, 600);
        checkRefs(n, 'title', title); checkRefs(n, 'message', message);
        params = { title, ...(message ? { message } : {}), ...(inc ? { includeSummaryOf: inc } : {}) };
      } else if (a.key === 'create_task') {
        const title = text(p.title, 200);
        if (!title) errors.push(`Step ${n}: write the task.`);
        const detail = text(p.detail, 1000);
        const due = p.dueInDays === undefined || p.dueInDays === null || p.dueInDays === '' ? null : Math.round(Number(p.dueInDays));
        if (due !== null && (!Number.isFinite(due) || due < 0 || due > 365)) errors.push(`Step ${n}: the due date is 0 to 365 days ahead.`);
        checkRefs(n, 'task', title); checkRefs(n, 'detail', detail);
        params = { title, ...(detail ? { detail } : {}), ...(due !== null && Number.isFinite(due) ? { dueInDays: due } : {}) };
      } else if (a.key === 'send_email') {
        const replyToTrigger = p.replyToTrigger === true && out.trigger?.type === 'email_received';
        const to = text(p.to || (replyToTrigger ? '{{trigger.fromAddress}}' : ''), 300);
        const subject = text(p.subject || (replyToTrigger ? 'Re: {{trigger.subject}}' : ''), 300);
        const body = text(p.body, 4000);
        if (!to) errors.push(`Step ${n}: enter who the email goes to.`);
        else if (!templateRefs(to).length && !EMAIL_RE.test(to)) errors.push(`Step ${n}: "${to}" is not an email address.`);
        if (!subject) errors.push(`Step ${n}: write a subject.`);
        if (!body) errors.push(`Step ${n}: write the email.`);
        checkRefs(n, 'recipient', to); checkRefs(n, 'subject', subject); checkRefs(n, 'email', body);
        params = { to, subject, body, ...(replyToTrigger ? { replyToTrigger: true } : {}) };
      } else if (a.key === 'http_request' || a.key === 'post_slack') {
        if (!UUID_RE.test(String(p.connectionId || ''))) errors.push(`Step ${n}: pick the connection to use.`);
        if (a.key === 'post_slack') {
          const message = text(p.message, 3000);
          if (!message) errors.push(`Step ${n}: write the message.`);
          checkRefs(n, 'message', message);
          params = { connectionId: String(p.connectionId || ''), message };
        } else {
          const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(p.method || 'POST').toUpperCase()) ? String(p.method || 'POST').toUpperCase() : null;
          if (!method) errors.push(`Step ${n}: pick GET, POST, PUT, PATCH or DELETE.`);
          const path = text(p.path, 500);
          if (path && (!path.startsWith('/') || /\s/.test(path.replace(TEMPLATE_RE, '')))) errors.push(`Step ${n}: the path starts with / and has no spaces.`);
          const body = text(p.body, 8000);
          if (body && !templateRefs(body).length) { try { JSON.parse(body); } catch { errors.push(`Step ${n}: the request body must be JSON.`); } }
          checkRefs(n, 'path', path); checkRefs(n, 'body', body);
          params = { connectionId: String(p.connectionId || ''), method: method || 'POST', ...(path ? { path } : {}), ...(body ? { body } : {}) };
        }
      }
      out.steps.push({ id, type: 'action', action: a.key, params });
    } else {
      errors.push(`Step ${n}: a step runs an agent, checks a condition or takes an action.`);
    }
  });
  if (!errors.length && !out.steps.some((s) => s.type === 'agent' || s.type === 'action')) errors.push('Add at least one agent or action step; that is what does the work.');
  if (!errors.length && out.trigger && ['manual', 'schedule'].includes(out.trigger.type) && !out.steps.some((s) => s.type === 'agent')) errors.push('Add at least one agent step; on a schedule or Run now, an agent is what finds the work.');
  return { ok: errors.length === 0, errors, definition: errors.length ? null : out };
}

function validateName(name) {
  const n = String(name || '').trim();
  if (!n) throw httpError(400, 'Give the workflow a name.');
  if (n.length > 80) throw httpError(400, 'Keep the name under 80 characters.');
  return n;
}

// ── Running ─────────────────────────────────────────────────────────────

/** Reads the values conditions and templates use from an agent's result. */
function extractOutputs(agentKey, r) {
  if (!r || typeof r !== 'object') return {};
  if (agentKey === 'starlane.scan') {
    return {
      openDecisions: num(r.decisions?.open ?? r.found?.decisions),
      automationOpportunities: num(r.found?.automationOpportunities),
      businessOpportunities: num(r.found?.businessOpportunities),
      invoicesScanned: num(r.process?.coverage?.invoices),
    };
  }
  if (agentKey === 'starlane.working_capital') {
    if (r.status === 'NEEDS_DATA') return { gap: null, net: null, moneyIn: null, moneyOut: null, overdueIn: null, firstShortWeek: null };
    return {
      gap: Math.max(0, -num(r.net)),
      net: num(r.net),
      moneyIn: num(r.moneyIn),
      moneyOut: num(r.moneyOut),
      overdueIn: num(r.inflow?.overdue),
      firstShortWeek: r.firstShortWeek ?? null,
    };
  }
  if (agentKey === 'starlane.email_triage') {
    return {
      category: r.category ?? null,
      amount: r.amount ?? null,
      currency: r.currency ?? null,
      invoiceNumber: r.invoiceNumber ?? null,
      date: r.date ?? null,
      customerName: r.customer?.name ?? null,
      customerOpenBalance: r.customer ? num(r.customer.openBalance) : null,
    };
  }
  return {};
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function summaryOf(agentKey, r) {
  if (!r) return null;
  if (r.headline) return String(r.headline);
  if (Array.isArray(r.summary)) return r.summary.join(' ');
  return null;
}

/** Evaluates one condition against the trigger and the outputs collected so far. */
function evaluateCondition(step, outputs) {
  const [ref, ...path] = step.signal.split('.');
  const actual = lookup(outputs, ref, path);
  const op = OPS[step.op];
  let a = actual;
  if (typeof step.value === 'number' && a !== null && a !== '' && Number.isFinite(Number(a))) a = Number(a);
  const passed = !!op && op.test(a, step.value);
  return { passed, actual: actual === undefined ? null : actual };
}

/** The trigger's values for a run: { from, subject, … } or { eventType, data }. */
function triggerContext(type, event) {
  if (!event) return null;
  if (type === 'email_received') {
    const p = event.payload || event;
    return { from: p.from || '', fromAddress: p.fromAddress || '', subject: p.subject || '', body: p.body || '', threadId: p.threadId || null, messageId: p.messageId || null, accountId: p.accountId || null, receivedAt: p.receivedAt || null };
  }
  if (type === 'webhook_received') {
    const data = event.payload && typeof event.payload === 'object' ? event.payload : {};
    return { eventType: String(data.event || data.type || data.event_type || ''), data, connectionId: event.connection_id || null, receivedAt: event.received_at || null };
  }
  return null;
}

// The default agent runners: the same functions the Agents page calls.
function defaultRunAgent(pool) {
  return async (agentKey, userId, params, actorId, trig) => {
    if (agentKey === 'starlane.working_capital') {
      const { runWorkingCapital } = require('../os/workingCapital');
      return runWorkingCapital(pool, userId, { actorId, horizonDays: params?.horizonDays });
    }
    if (agentKey === 'starlane.scan') {
      const { runScan } = require('../os/scan');
      const { isEnabled } = require('../../featureFlags');
      let getSignalImpact = null;
      try { getSignalImpact = require('../intelligence/supplyChainOrchestrator').getSignalImpact; } catch { /* optional */ }
      return runScan(pool, userId, { actorId, externalSendEnabled: isEnabled('external_message_sending_enabled'), getSignalImpact });
    }
    if (agentKey === 'starlane.email_triage') {
      const { runEmailTriage } = require('./emailTriage');
      const email = trig && (trig.subject !== undefined || trig.body !== undefined)
        ? trig
        : trig && trig.data ? { subject: trig.data.subject || '', body: trig.data.body || trig.data.text || '', fromAddress: trig.data.from || trig.data.email || '' } : null;
      return runEmailTriage(pool, userId, email);
    }
    throw new Error(`No runner for agent ${agentKey}`);
  };
}

function defaultNotify(pool) {
  return (userId, n) => require('../../notifications/notify').notify(pool, userId, n);
}

function defaultFlags() {
  const { isEnabled } = require('../../featureFlags');
  return (key) => { try { return isEnabled(key) === true; } catch { return false; } };
}

function defaultCallConnection(pool) {
  return (userId, connectionId, req) => require('../../connectors/connections').callConnection(pool, userId, connectionId, req);
}

async function connectionFor(pool, userId, id) {
  return require('../../connectors/connections').getConnectionRow(pool, userId, id);
}

/**
 * Runs one workflow once. `slot` makes the run idempotent: a second call
 * with the same (workflow, slot) returns { status: 'DUPLICATE' } and does
 * nothing. `event` is the email or webhook delivery that started it.
 */
async function executeWorkflow(pool, userId, wf, { trigger, slot, event = null, actorId = null, runAgent = null, notifyFn = null, flagFn = null, callConnection = null } = {}) {
  if (!userId || !wf || String(wf.user_id) !== String(userId)) throw httpError(404, 'workflow not found');
  const claim = await pool.query(
    `INSERT INTO starlane_custom_workflow_runs (workflow_id, user_id, workflow_version, trigger, slot)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (workflow_id, slot) DO NOTHING RETURNING id, started_at`,
    [wf.id, userId, wf.version, trigger, slot]
  );
  if (!claim.rows.length) return { status: 'DUPLICATE' };
  const runId = claim.rows[0].id;
  const run = runAgent || defaultRunAgent(pool);
  const notifyOwner = notifyFn || defaultNotify(pool);
  const flag = flagFn || defaultFlags();
  const call = callConnection || defaultCallConnection(pool);
  const def = wf.definition || {};
  const trig = triggerContext(def.trigger?.type, event);
  const steps = [];
  const outputs = trig ? { trigger: trig } : {};
  const results = {};
  let status = 'COMPLETED';
  let summary = null;
  let error = null;

  const finish = async () => {
    await pool.query(
      `UPDATE starlane_custom_workflow_runs SET status = $3, steps = $4, summary = $5, error = $6, finished_at = NOW()
        WHERE id = $1 AND user_id = $2`,
      [runId, userId, status, JSON.stringify(steps), summary, error]
    );
    return { runId, status, steps, summary, error };
  };
  const fail = (rec, msg) => { rec.status = 'FAILED'; rec.summary = msg; steps.push(rec); status = 'FAILED'; error = msg; };
  const blocked = (rec, msg) => { rec.status = 'BLOCKED'; rec.summary = msg; steps.push(rec); status = 'BLOCKED'; summary = msg; };

  try {
    const stops = await checkStops(pool, userId, { workflowId: wf.id });
    if (!stops.allowed) {
      status = 'BLOCKED';
      summary = `Stopped by a kill switch: ${stops.blockedBy.map((b) => b.reason).join('; ')}`;
      return await finish();
    }
    if (trig) steps.push({ id: 'trigger', type: 'trigger', status: 'DONE', summary: def.trigger.type === 'email_received' ? `Email from ${trig.from || trig.fromAddress || 'an unknown sender'}: ${trig.subject || '(no subject)'}` : `Received ${trig.eventType || 'data'} from a webhook.` });
    for (let i = 0; i < (def.steps || []).length; i++) {
      const s = def.steps[i];
      const started = Date.now();
      const rec = { id: s.id, type: s.type, startedAt: new Date(started).toISOString() };
      const render = (str, max) => renderTemplate(str, outputs, { maxLen: max });
      if (s.type === 'agent') {
        rec.agent = s.agent;
        const r = await run(s.agent, userId, s.params || {}, actorId, trig);
        rec.durationMs = Date.now() - started;
        if (r && r.status === 'STOPPED') { blocked(rec, `The agent is stopped by a kill switch: ${(r.blockedBy || []).map((b) => b.reason).join('; ')}`); break; }
        results[s.id] = r;
        outputs[s.id] = extractOutputs(s.agent, r);
        rec.status = 'DONE';
        rec.summary = summaryOf(s.agent, r);
        rec.outputs = outputs[s.id];
        rec.agentRunId = r?.runId || null;
        steps.push(rec);
      } else if (s.type === 'condition') {
        const { passed, actual } = evaluateCondition(s, outputs);
        rec.durationMs = Date.now() - started;
        rec.status = passed ? 'PASSED' : 'NOT_MET';
        rec.actual = typeof actual === 'string' ? actual.slice(0, 200) : actual;
        rec.summary = `${s.signal} ${OPS[s.op]?.label || s.op}${s.value !== undefined ? ` ${s.value}` : ''}: ${actual === null || actual === '' ? 'no value' : String(rec.actual)} → ${passed ? 'continue' : 'stop here'}`;
        steps.push(rec);
        if (!passed) { status = 'ENDED_BY_CONDITION'; summary = 'The condition was not met, so the remaining steps did not run.'; break; }
      } else if (s.type === 'action' && s.action === 'notify_owner') {
        const inc = s.params?.includeSummaryOf ? summaryOf(null, results[s.params.includeSummaryOf]) : null;
        const message = s.params?.message ? render(s.params.message, 300) : null;
        const n = await notifyOwner(userId, {
          type: 'business_change',
          severity: 'normal',
          title: render(s.params?.title || wf.name, 140) || wf.name,
          body: (message || inc || `From your workflow "${wf.name}".`).slice(0, 300),
          entity: { type: 'custom_workflow', id: wf.id },
          route: `/workflows?id=${wf.id}`,
          dedupeKey: `cwf:${runId}:${s.id}`,
        });
        rec.durationMs = Date.now() - started;
        if (!n) { fail(rec, 'The notification could not be written.'); break; }
        rec.status = 'DONE';
        rec.summary = 'Notification sent to your Starlane inbox.';
        steps.push(rec);
      } else if (s.type === 'action' && s.action === 'create_task') {
        const due = Number.isInteger(s.params?.dueInDays) ? new Date(Date.now() + s.params.dueInDays * 86400000).toISOString().slice(0, 10) : null;
        const title = render(s.params.title, 200) || wf.name;
        await pool.query(
          `INSERT INTO starlane_workflow_tasks (user_id, workflow_id, run_id, step_id, title, detail, due_on) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (run_id, step_id) DO NOTHING`,
          [userId, wf.id, runId, s.id, title, s.params.detail ? render(s.params.detail, 1000) : null, due]
        );
        rec.durationMs = Date.now() - started;
        rec.status = 'DONE';
        rec.summary = `Task added: ${title}${due ? ` (due ${due})` : ''}.`;
        steps.push(rec);
      } else if (s.type === 'action' && s.action === 'send_email') {
        // "Name <address>" (a From header, or what a webhook sent) is reduced to the address.
        const toRaw = render(s.params.to, 300).trim();
        const to = ((/<([^<>\s]+@[^<>\s]+)>/.exec(toRaw) || [])[1] || toRaw).toLowerCase();
        if (!EMAIL_RE.test(to)) { fail(rec, `"${to || '(empty)'}" is not an email address, so no draft was made.`); break; }
        const reply = s.params.replyToTrigger && trig && trig.threadId;
        const payload = {
          to,
          subject: render(s.params.subject, 300),
          body: render(s.params.body, 4000),
          ...(reply ? { threadId: trig.threadId, inReplyToMessageId: trig.messageId, accountId: trig.accountId } : {}),
          workflowName: wf.name,
        };
        const ins = await pool.query(
          `INSERT INTO starlane_workflow_approvals (user_id, workflow_id, run_id, step_id, kind, payload) VALUES ($1,$2,$3,$4,'send_email',$5)
           ON CONFLICT (run_id, step_id) DO NOTHING RETURNING id`,
          [userId, wf.id, runId, s.id, JSON.stringify(payload)]
        );
        await notifyOwner(userId, {
          type: 'approval_required', severity: 'normal',
          title: `Email to ${to} is waiting for your approval`,
          body: payload.subject.slice(0, 300),
          entity: { type: 'workflow_approval', id: ins.rows[0]?.id || runId },
          route: '/workflows?tab=approvals',
          dedupeKey: `cwf-approval:${runId}:${s.id}`,
        });
        rec.durationMs = Date.now() - started;
        rec.status = 'WAITING_APPROVAL';
        rec.approvalId = ins.rows[0]?.id || null;
        rec.summary = `Drafted an email to ${to}. It waits for your approval and is not sent until you approve it.`;
        steps.push(rec);
      } else if (s.type === 'action' && (s.action === 'http_request' || s.action === 'post_slack')) {
        if (!flag('workflow_http_actions_enabled')) { blocked(rec, 'Calling other apps from workflows is switched off on this server (FEATURE_WORKFLOW_HTTP_ACTIONS_ENABLED).'); break; }
        const { isGloballyStopped } = require('../../safety/externalSend');
        if (isGloballyStopped()) { blocked(rec, 'All outbound activity is stopped (global stop).'); break; }
        const conn = await connectionFor(pool, userId, s.params.connectionId);
        if (!conn || conn.kind !== 'http_api') { fail(rec, 'The connection for this step no longer exists.'); break; }
        if (s.action === 'post_slack' && conn.config?.preset !== 'slack') { fail(rec, `"${conn.name}" is not a Slack connection.`); break; }
        let body = null;
        if (s.action === 'post_slack') body = { text: render(s.params.message, 3000) };
        else if (s.params.body) {
          const raw = renderTemplate(s.params.body, Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, jsonSafe(v)])), { maxLen: 8000 });
          try { body = JSON.parse(raw); } catch { fail(rec, 'The request body is not valid JSON after filling in the values.'); break; }
        }
        try {
          const r = await call(userId, conn.id, { method: s.action === 'post_slack' ? 'POST' : s.params.method, path: s.params.path ? render(s.params.path, 500) : '', body, idempotencyKey: `cwf:${runId}:${s.id}` });
          rec.durationMs = Date.now() - started;
          rec.httpStatus = r.status;
          if (!r.ok) { fail(rec, `${conn.name} answered HTTP ${r.status}.`); rec.response = r.bodyPreview; break; }
          rec.status = 'DONE';
          rec.summary = s.action === 'post_slack' ? `Posted to Slack (${conn.name}).` : `${s.params.method} ${conn.name}${s.params.path ? render(s.params.path, 200) : ''} → HTTP ${r.status}.`;
          rec.response = r.bodyPreview;
          steps.push(rec);
        } catch (err) {
          fail(rec, `Could not call ${conn.name}: ${String(err.message || err).slice(0, 200)}`);
          break;
        }
      } else {
        fail(rec, 'This step type cannot run.');
        break;
      }
    }
    // Steps after a stop are recorded as skipped so the run reads end to end.
    const ran = new Set(steps.map((x) => x.id));
    for (const s of (def.steps || [])) if (!ran.has(s.id)) steps.push({ id: s.id, type: s.type, status: 'SKIPPED' });
    if (status === 'COMPLETED') {
      const waiting = steps.filter((x) => x.status === 'WAITING_APPROVAL').length;
      const last = [...steps].reverse().find((x) => x.type === 'agent' && x.summary);
      summary = waiting ? `${waiting === 1 ? 'An email is' : `${waiting} emails are`} waiting for your approval.` : last ? last.summary : 'Every step ran.';
    }
  } catch (err) {
    status = 'FAILED';
    error = String(err.message || err).slice(0, 500);
    safeLog('warn', '[custom-workflows] run failed', { workflowId: wf.id, error: error });
  }
  return finish();
}

// JSON-escape string values so a template inside a JSON body stays valid JSON.
function jsonSafe(v) {
  if (typeof v === 'string') return JSON.stringify(v).slice(1, -1);
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
  return v;
}

// ── Events: email and webhook triggers ──────────────────────────────────

function emailMatches(trigger, p) {
  if (!p || p.isBounce || p.autoReply) return false;
  if (p.to && p.fromAddress && String(p.to).toLowerCase() === String(p.fromAddress).toLowerCase()) return false; // our own mail
  if (trigger.fromContains && !norm(`${p.from} ${p.fromAddress}`).includes(norm(trigger.fromContains))) return false;
  if (trigger.subjectContains && !norm(p.subject).includes(norm(trigger.subjectContains))) return false;
  return true;
}

/**
 * Starts every ACTIVE workflow of this tenant that listens for this event.
 * Each run is claimed with slot event:<id>, so redelivery runs nothing twice.
 */
async function dispatchEvent(pool, userId, eventRow, opts = {}) {
  if (!eventRow || String(eventRow.user_id) !== String(userId)) return { ran: 0 };
  const type = eventRow.source === 'gmail' ? 'email_received' : 'webhook_received';
  const wfs = await pool.query(
    `SELECT * FROM starlane_custom_workflows WHERE user_id = $1 AND status = 'ACTIVE' AND definition->'trigger'->>'type' = $2`,
    [userId, type]
  );
  let ran = 0;
  for (const wf of wfs.rows) {
    const t = wf.definition.trigger || {};
    if (type === 'email_received' && !emailMatches(t, eventRow.payload)) continue;
    if (type === 'webhook_received') {
      if (String(t.connectionId) !== String(eventRow.connection_id)) continue;
      if (t.eventType) {
        const p = eventRow.payload || {};
        if (norm(p.event || p.type || p.event_type) !== norm(t.eventType)) continue;
      }
    }
    try {
      const r = await executeWorkflow(pool, userId, wf, { trigger: type, slot: `event:${eventRow.id}`, event: eventRow, ...opts });
      if (r.status !== 'DUPLICATE') ran++;
    } catch (err) {
      safeLog('warn', '[custom-workflows] event run failed', { workflowId: wf.id, error: err.message });
    }
  }
  await pool.query('UPDATE starlane_connection_events SET dispatched_at = now() WHERE id = $1 AND user_id = $2', [eventRow.id, userId]);
  return { ran };
}

// ── Approvals and tasks ─────────────────────────────────────────────────

function approvalView(r) {
  return {
    id: r.id, workflowId: r.workflow_id, runId: r.run_id, stepId: r.step_id, kind: r.kind, status: r.status, statusReason: r.status_reason,
    to: r.payload?.to, subject: r.payload?.subject, body: r.payload?.body, isReply: !!r.payload?.threadId, workflowName: r.payload?.workflowName || null,
    result: r.result ? { sentFrom: r.result.from || null, providerMessageId: r.result.providerMessageId || null, alreadySent: !!r.result.alreadySent } : null,
    decidedAt: r.decided_at, createdAt: r.created_at,
  };
}

async function listApprovals(pool, userId, { status = null, limit = 50 } = {}) {
  const r = await pool.query(
    `SELECT * FROM starlane_workflow_approvals WHERE user_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC LIMIT $3`,
    [userId, status, Math.max(1, Math.min(200, Number(limit) || 50))]
  );
  return r.rows.map(approvalView);
}

/**
 * The owner approves or rejects a drafted email. Approve sends it from
 * their Gmail only when external sending is enabled and nothing stops it;
 * otherwise the draft is marked BLOCKED with the reason and can be approved
 * again later. The send is idempotent on the approval id.
 */
async function decideApproval(pool, userId, id, decision, { actorId = null, edits = null, sendFn = null, guardFn = null } = {}) {
  if (!UUID_RE.test(String(id || ''))) throw httpError(404, 'approval not found');
  const cur = (await pool.query('SELECT * FROM starlane_workflow_approvals WHERE id = $1 AND user_id = $2', [id, userId])).rows[0];
  if (!cur) throw httpError(404, 'approval not found');
  if (decision === 'reject') {
    if (!['PENDING', 'BLOCKED'].includes(cur.status)) throw httpError(409, `This email is already ${cur.status.toLowerCase()}.`);
    const r = await pool.query(`UPDATE starlane_workflow_approvals SET status = 'REJECTED', decided_by = $3, decided_at = now(), updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING *`, [id, userId, actorId]);
    return approvalView(r.rows[0]);
  }
  if (decision !== 'approve') throw httpError(400, 'Approve or reject.');
  if (!['PENDING', 'BLOCKED'].includes(cur.status)) throw httpError(409, `This email is already ${cur.status.toLowerCase()}.`);

  let payload = cur.payload;
  if (edits && typeof edits === 'object') {
    payload = { ...payload, ...(edits.subject ? { subject: String(edits.subject).slice(0, 300) } : {}), ...(edits.body ? { body: String(edits.body).slice(0, 4000) } : {}) };
  }
  const setBlocked = async (reason) => {
    const r = await pool.query(`UPDATE starlane_workflow_approvals SET status = 'BLOCKED', status_reason = $3, payload = $4, decided_by = $5, decided_at = now(), updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING *`,
      [id, userId, reason, JSON.stringify(payload), actorId]);
    return approvalView(r.rows[0]);
  };
  const guard = guardFn || ((ch) => require('../../safety/externalSend').guardExternalSend(ch));
  const blockedBy = guard('email');
  if (blockedBy) return setBlocked(blockedBy.reason === 'global_stop' ? 'All outbound sending is stopped (global stop).' : 'Sending to people outside Starlane is switched off on this server (FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED). Approve again once it is on.');
  if (cur.workflow_id) {
    const stops = await checkStops(pool, userId, { workflowId: cur.workflow_id });
    if (!stops.allowed) return setBlocked(`Stopped by a kill switch: ${stops.blockedBy.map((b) => b.reason).join('; ')}`);
  }
  try {
    const sup = await require('../outbound/store').suppressionFor(pool, userId, payload.to);
    if (sup.some((x) => x.hard)) return setBlocked(`${payload.to} is on your do-not-contact list (${sup[0].reason.toLowerCase().replace(/_/g, ' ')}).`);
  } catch (err) { if (err.code !== '42P01') throw err; }

  // Claim: only one approver sends.
  const claim = await pool.query(
    `UPDATE starlane_workflow_approvals SET status = 'SENDING', payload = $3, decided_by = $4, decided_at = now(), updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status IN ('PENDING','BLOCKED') RETURNING *`,
    [id, userId, JSON.stringify(payload), actorId]
  );
  if (!claim.rows[0]) throw httpError(409, 'Someone else is already handling this email.');
  const send = sendFn || ((args) => require('../../connectors/gmailInbox').sendFromGmail(pool, userId, args));
  try {
    const r = await send({
      accountId: payload.accountId || null, to: payload.to, subject: payload.subject, body: payload.body,
      threadId: payload.threadId || null, inReplyTo: null, idempotencyKey: `cwf-approval:${id}`,
    });
    const u = await pool.query(`UPDATE starlane_workflow_approvals SET status = 'SENT', status_reason = NULL, result = $3, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING *`, [id, userId, JSON.stringify(r)]);
    return approvalView(u.rows[0]);
  } catch (err) {
    const msg = String(err.message || err).slice(0, 300);
    const u = await pool.query(`UPDATE starlane_workflow_approvals SET status = 'FAILED', status_reason = $3, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING *`, [id, userId, msg]);
    return approvalView(u.rows[0]);
  }
}

async function listTasks(pool, userId, { status = 'OPEN', limit = 100 } = {}) {
  const r = await pool.query(
    `SELECT t.*, w.name AS workflow_name FROM starlane_workflow_tasks t LEFT JOIN starlane_custom_workflows w ON w.id = t.workflow_id AND w.user_id = t.user_id
      WHERE t.user_id = $1 AND ($2::text IS NULL OR t.status = $2) ORDER BY t.status, t.due_on NULLS LAST, t.created_at DESC LIMIT $3`,
    [userId, status, Math.max(1, Math.min(300, Number(limit) || 100))]
  );
  return r.rows.map((t) => ({ id: t.id, title: t.title, detail: t.detail, dueOn: t.due_on, status: t.status, workflowId: t.workflow_id, workflowName: t.workflow_name, createdAt: t.created_at, doneAt: t.done_at }));
}

async function setTaskStatus(pool, userId, id, status) {
  if (!UUID_RE.test(String(id || ''))) throw httpError(404, 'task not found');
  if (!['OPEN', 'DONE'].includes(status)) throw httpError(400, 'unknown status');
  const r = await pool.query(
    `UPDATE starlane_workflow_tasks SET status = $3, done_at = CASE WHEN $3 = 'DONE' THEN now() ELSE NULL END WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId, status]
  );
  if (!r.rowCount) throw httpError(404, 'task not found');
}

// ── Schedules ───────────────────────────────────────────────────────────

/** The local date, weekday and hour of `now` in a timezone. */
function localParts(now, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const p = Object.fromEntries(fmt.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday: String(p.weekday).toLowerCase().slice(0, 3) };
}

/**
 * The schedule slot `now` falls in, or null when the trigger is not due.
 * A slot is one local date, so the 15-minute ticks inside the chosen hour
 * all claim the same slot and the workflow runs once.
 */
function scheduleSlot(trigger, timeZone, now = Date.now()) {
  if (!trigger || trigger.type !== 'schedule') return null;
  let tz = timeZone;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = 'UTC'; }
  const p = localParts(now, tz || 'UTC');
  if (p.hour !== Number(trigger.hour)) return null;
  if (trigger.every === 'weekly' && p.weekday !== trigger.weekday) return null;
  return `schedule:${p.date}`;
}

/** The next time a schedule fires, as an ISO string (for the UI). */
function nextRunAt(trigger, timeZone, now = Date.now()) {
  if (!trigger || trigger.type !== 'schedule') return null;
  const start = Math.floor(now / 3600000) * 3600000 + 3600000;
  for (let h = 0; h < 24 * 8; h++) {
    const t = start + h * 3600000;
    if (scheduleSlot(trigger, timeZone, t)) return new Date(t).toISOString();
  }
  return null;
}

async function runScheduledCustomWorkflows(pool, { now = Date.now(), limit = 500, runAgent = null, notifyFn = null } = {}) {
  const res = await pool.query(
    `SELECT * FROM starlane_custom_workflows WHERE status = 'ACTIVE' AND definition->'trigger'->>'type' = 'schedule'
      ORDER BY updated_at ASC LIMIT $1`,
    [limit]
  );
  const tzByUser = new Map();
  const out = { checked: res.rows.length, ran: 0, notDue: 0, duplicate: 0, failed: 0 };
  for (const wf of res.rows) {
    try {
      if (!tzByUser.has(wf.user_id)) {
        const s = await getSettings(pool, wf.user_id);
        tzByUser.set(wf.user_id, s.definitions.timezone || 'UTC');
      }
      const slot = scheduleSlot(wf.definition.trigger, tzByUser.get(wf.user_id), now);
      if (!slot) { out.notDue++; continue; }
      const r = await executeWorkflow(pool, wf.user_id, wf, { trigger: 'schedule', slot, runAgent, notifyFn });
      if (r.status === 'DUPLICATE') out.duplicate++;
      else if (r.status === 'FAILED') out.failed++;
      else out.ran++;
    } catch (err) {
      out.failed++;
      safeLog('warn', '[custom-workflows] scheduled run failed', { workflowId: wf.id, error: err.message });
    }
  }
  return out;
}

// ── Persistence ─────────────────────────────────────────────────────────

function assertUuid(id) {
  if (!UUID_RE.test(String(id || ''))) throw httpError(404, 'workflow not found');
}

async function getWorkflow(pool, userId, id) {
  assertUuid(id);
  const r = await pool.query('SELECT * FROM starlane_custom_workflows WHERE id = $1 AND user_id = $2', [id, userId]);
  return r.rows[0] || null;
}

async function listWorkflows(pool, userId) {
  const r = await pool.query(
    `SELECT w.*, lr.status AS last_run_status, lr.started_at AS last_run_at, lr.summary AS last_run_summary,
            (SELECT COUNT(*)::int FROM starlane_custom_workflow_runs c WHERE c.workflow_id = w.id) AS run_count
       FROM starlane_custom_workflows w
       LEFT JOIN LATERAL (
         SELECT status, started_at, summary FROM starlane_custom_workflow_runs r
          WHERE r.workflow_id = w.id ORDER BY started_at DESC LIMIT 1
       ) lr ON TRUE
      WHERE w.user_id = $1 ORDER BY w.updated_at DESC`,
    [userId]
  );
  return r.rows;
}

async function createWorkflow(pool, userId, { name, description, definition }) {
  const n = validateName(name);
  const v = validateDefinition(definition);
  if (!v.ok) throw httpError(400, v.errors[0], { errors: v.errors });
  const count = await pool.query('SELECT COUNT(*)::int AS n FROM starlane_custom_workflows WHERE user_id = $1', [userId]);
  if (count.rows[0].n >= MAX_WORKFLOWS) throw httpError(409, `You can keep up to ${MAX_WORKFLOWS} workflows. Delete one to add another.`);
  const r = await pool.query(
    `INSERT INTO starlane_custom_workflows (user_id, name, description, definition) VALUES ($1,$2,$3,$4) RETURNING *`,
    [userId, n, description ? String(description).trim().slice(0, 300) : null, JSON.stringify(v.definition)]
  );
  return r.rows[0];
}

async function updateWorkflow(pool, userId, id, { name, description, definition }) {
  const cur = await getWorkflow(pool, userId, id);
  if (!cur) throw httpError(404, 'workflow not found');
  const n = name !== undefined ? validateName(name) : cur.name;
  let def = cur.definition;
  if (definition !== undefined) {
    const v = validateDefinition(definition);
    if (!v.ok) throw httpError(400, v.errors[0], { errors: v.errors });
    def = v.definition;
  }
  const desc = description !== undefined ? (description ? String(description).trim().slice(0, 300) : null) : cur.description;
  const r = await pool.query(
    `UPDATE starlane_custom_workflows SET name = $3, description = $4, definition = $5, version = version + 1, updated_at = NOW()
      WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId, n, desc, JSON.stringify(def)]
  );
  return r.rows[0];
}

async function setStatus(pool, userId, id, status) {
  if (!['ACTIVE', 'PAUSED', 'DRAFT'].includes(status)) throw httpError(400, 'unknown status');
  const cur = await getWorkflow(pool, userId, id);
  if (!cur) throw httpError(404, 'workflow not found');
  // An old row could predate a catalog change; re-validate before it runs.
  if (status === 'ACTIVE') {
    const v = validateDefinition(cur.definition);
    if (!v.ok) throw httpError(400, v.errors[0], { errors: v.errors });
  }
  const r = await pool.query(
    'UPDATE starlane_custom_workflows SET status = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING *',
    [id, userId, status]
  );
  return r.rows[0];
}

async function deleteWorkflow(pool, userId, id) {
  assertUuid(id);
  const r = await pool.query('DELETE FROM starlane_custom_workflows WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!r.rowCount) throw httpError(404, 'workflow not found');
}

async function listRuns(pool, userId, id, { limit = 20 } = {}) {
  assertUuid(id);
  const n = Math.max(1, Math.min(100, Number(limit) || 20));
  const r = await pool.query(
    `SELECT id, workflow_id, workflow_version, trigger, status, steps, summary, error, started_at, finished_at
       FROM starlane_custom_workflow_runs WHERE workflow_id = $1 AND user_id = $2 ORDER BY started_at DESC LIMIT $3`,
    [id, userId, n]
  );
  return r.rows;
}

module.exports = {
  TRIGGERS, AGENTS, ACTIONS, OPS, TEMPLATES, WEEKDAYS, MAX_STEPS, MAX_WORKFLOWS,
  catalog, validateDefinition, extractOutputs, evaluateCondition, scheduleSlot, nextRunAt, renderTemplate, templateRefs, triggerContext,
  executeWorkflow, runScheduledCustomWorkflows, dispatchEvent, emailMatches,
  listApprovals, decideApproval, listTasks, setTaskStatus,
  getWorkflow, listWorkflows, createWorkflow, updateWorkflow, setStatus, deleteWorkflow, listRuns,
};
