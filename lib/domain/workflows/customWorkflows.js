'use strict';
// FILE: lib/domain/workflows/customWorkflows.js
// Custom workflows: an owner chains Starlane's agents into their own
// automation. A workflow is
//
//   trigger  →  step  →  step  →  …
//
// where the trigger is "when I press Run" or a schedule, and each step is one
// of
//   agent      run one of the real agents (Scan, Working capital)
//   condition  continue only if a number an earlier agent produced passes a test
//   action     do something with the result (today: notify the owner in Starlane)
//
// Honesty contract, enforced here and tested:
//   - The catalog lists triggers, agents and actions that are not built yet
//     (email, Slack, CRM, "when a sync finishes", …) with availability
//     'coming_soon' and a reason. A workflow that uses one is refused, so a
//     saved workflow only ever contains steps that really run.
//   - No step sends anything outside Starlane. The only live action writes to
//     the owner's own inbox.
//   - Agents keep their own safety: each agent checks its kill switch, and a
//     workflow-scoped stop (Controls) blocks the whole run.
//   - A run is claimed by (workflow, slot) so a schedule firing runs once
//     across servers, and a manual run at most once a minute.
//   - Every query is scoped by user_id; no function takes an id without it.

const { checkStops, getSettings } = require('../decisions/controls');
const { safeLog } = require('../../observability/logger');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STEP_ID_RE = /^[a-z][a-z0-9_]{0,23}$/;
const MAX_STEPS = 12;
const MAX_WORKFLOWS = 50;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// ── Catalog ─────────────────────────────────────────────────────────────

const TRIGGERS = Object.freeze([
  { type: 'manual', name: 'When I run it', summary: 'Runs when you press Run now.', availability: 'available' },
  { type: 'schedule', name: 'On a schedule', summary: 'Every day or every week at an hour you pick, in your business timezone.', availability: 'available' },
  { type: 'connector_synced', name: 'When a data source syncs', summary: 'Runs after QuickBooks, Xero, Tally or another source finishes a sync.', availability: 'coming_soon', reason: 'Sync events are recorded but do not start workflows yet.' },
  { type: 'invoice_overdue', name: 'When an invoice becomes overdue', summary: 'Runs the day an invoice passes its due date.', availability: 'coming_soon', reason: 'Not built yet. A daily schedule with the Scan agent covers this today.' },
  { type: 'payment_received', name: 'When a payment arrives', summary: 'Runs when a bank feed or payment processor reports a payment.', availability: 'coming_soon', reason: 'Needs a live bank or payments connector (Plaid, Stripe), which is not built yet.' },
  { type: 'email_received', name: 'When an email arrives', summary: 'Runs when a matching email lands in Gmail or Outlook.', availability: 'coming_soon', reason: 'Needs the Gmail or Outlook connector, which is not built yet.' },
]);

// Agents a workflow can run, the numbers each one produces (for conditions),
// and how to read them from the agent's result.
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
  { key: 'starlane.supplier_risk', name: 'Supplier risk', summary: 'Flags suppliers likely to deliver late or raise prices.', availability: 'coming_soon', reason: 'Needs supplier and lead-time data that no connector provides yet.', outputs: [] },
  { key: 'starlane.research', name: 'Research', summary: 'Looks up a customer or market before a decision.', availability: 'coming_soon', reason: 'No external research source is connected, and Starlane does not invent market data.', outputs: [] },
]);

const ACTIONS = Object.freeze([
  { key: 'notify_owner', name: 'Notify me in Starlane', summary: 'Puts a notification in your Starlane inbox (web, desktop and phone).', availability: 'available' },
  { key: 'send_email', name: 'Send an email', summary: 'Sends an email from your Gmail or Outlook, after you approve it.', availability: 'coming_soon', reason: 'Needs the Gmail or Outlook connector, which is not built yet.' },
  { key: 'post_slack', name: 'Post to Slack or Teams', summary: 'Posts the result to a channel.', availability: 'coming_soon', reason: 'Needs the Slack or Microsoft Teams connector, which is not built yet.' },
  { key: 'send_whatsapp', name: 'Send a WhatsApp or SMS message', summary: 'Messages a customer, after you approve each message.', availability: 'coming_soon', reason: 'External messages need an approval gate per message, which custom workflows do not have yet.' },
  { key: 'create_crm_task', name: 'Create a CRM task', summary: 'Creates a follow-up task in HubSpot or Salesforce.', availability: 'coming_soon', reason: 'Needs the HubSpot or Salesforce connector, which is not built yet.' },
  { key: 'update_sheet', name: 'Add a row to a spreadsheet', summary: 'Appends the result to Google Sheets or Excel.', availability: 'coming_soon', reason: 'Needs the Google Sheets or Microsoft 365 connector, which is not built yet.' },
]);

const OPS = Object.freeze({
  gt: { label: 'is more than', needsValue: true, test: (a, b) => a > b },
  gte: { label: 'is at least', needsValue: true, test: (a, b) => a >= b },
  lt: { label: 'is less than', needsValue: true, test: (a, b) => a < b },
  lte: { label: 'is at most', needsValue: true, test: (a, b) => a <= b },
  eq: { label: 'equals', needsValue: true, test: (a, b) => a === b },
  neq: { label: 'is not', needsValue: true, test: (a, b) => a !== b },
  exists: { label: 'has a value', needsValue: false, test: (a) => a !== null && a !== undefined },
  missing: { label: 'has no value', needsValue: false, test: (a) => a === null || a === undefined },
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

function catalog({ schedulerEnabled = false } = {}) {
  return {
    triggers: TRIGGERS.map((t) => ({ ...t, ...(t.type === 'schedule' ? { schedulerEnabled } : {}) })),
    agents: AGENTS.map((a) => ({ ...a, outputs: a.outputs.map((o) => ({ ...o })) })),
    actions: ACTIONS.map((a) => ({ ...a })),
    operators: Object.entries(OPS).map(([key, o]) => ({ key, label: o.label, needsValue: o.needsValue })),
    templates: TEMPLATES.map((t) => JSON.parse(JSON.stringify(t))),
    limits: { maxSteps: MAX_STEPS, maxWorkflows: MAX_WORKFLOWS },
  };
}

// ── Validation ──────────────────────────────────────────────────────────

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
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
  }

  const steps = Array.isArray(input.steps) ? input.steps : [];
  if (!steps.length) errors.push('Add at least one step.');
  if (steps.length > MAX_STEPS) errors.push(`A workflow has at most ${MAX_STEPS} steps.`);
  const seen = new Map(); // id -> agent meta (for agent steps)
  steps.slice(0, MAX_STEPS).forEach((s, i) => {
    const n = i + 1;
    const id = s && typeof s.id === 'string' && STEP_ID_RE.test(s.id) ? s.id : `step${n}`;
    if (seen.has(id)) { errors.push(`Step ${n}: another step is already called "${id}".`); return; }
    if (!s || typeof s !== 'object') { errors.push(`Step ${n} is empty.`); return; }
    if (s.type === 'agent') {
      const a = AGENTS.find((x) => x.key === s.agent);
      if (!a) { errors.push(`Step ${n}: pick an agent.`); return; }
      if (a.availability !== 'available') { errors.push(`Step ${n}: the ${a.name} agent is not available yet: ${a.reason}`); return; }
      const params = {};
      for (const p of a.params || []) {
        const raw = s.params?.[p.key];
        if (raw === undefined || raw === null || raw === '') { params[p.key] = p.default; continue; }
        const v = Math.round(Number(raw));
        if (!Number.isFinite(v) || v < p.min || v > p.max) errors.push(`Step ${n}: ${p.label} must be between ${p.min} and ${p.max}.`);
        else params[p.key] = v;
      }
      seen.set(id, a);
      out.steps.push({ id, type: 'agent', agent: a.key, ...(Object.keys(params).length ? { params } : {}) });
    } else if (s.type === 'condition') {
      const [ref, field] = String(s.signal || '').split('.');
      const a = seen.get(ref);
      const o = a?.outputs.find((x) => x.key === field);
      if (!a) { errors.push(`Step ${n}: a condition checks the result of an agent step that comes before it.`); seen.set(id, null); return; }
      if (!o) { errors.push(`Step ${n}: the ${a.name} agent does not produce "${field || ''}".`); seen.set(id, null); return; }
      const op = OPS[s.op];
      if (!op) { errors.push(`Step ${n}: pick how to compare.`); seen.set(id, null); return; }
      let value = null;
      if (op.needsValue) {
        value = Number(s.value);
        if (s.value === '' || s.value === null || s.value === undefined || !Number.isFinite(value)) { errors.push(`Step ${n}: enter a number to compare with.`); seen.set(id, null); return; }
      }
      seen.set(id, null);
      out.steps.push({ id, type: 'condition', signal: `${ref}.${field}`, op: s.op, ...(op.needsValue ? { value } : {}) });
    } else if (s.type === 'action') {
      const a = ACTIONS.find((x) => x.key === s.action);
      if (!a) { errors.push(`Step ${n}: pick an action.`); return; }
      if (a.availability !== 'available') { errors.push(`Step ${n}: "${a.name}" is not available yet: ${a.reason}`); return; }
      const title = String(s.params?.title || '').trim();
      if (!title) errors.push(`Step ${n}: write what the notification should say.`);
      if (title.length > 140) errors.push(`Step ${n}: keep the notification under 140 characters.`);
      const inc = s.params?.includeSummaryOf;
      if (inc && !(seen.has(inc) && seen.get(inc))) errors.push(`Step ${n}: "include the result of" must name an agent step before it.`);
      seen.set(id, null);
      out.steps.push({ id, type: 'action', action: a.key, params: { title: title.slice(0, 140), ...(inc ? { includeSummaryOf: inc } : {}) } });
    } else {
      errors.push(`Step ${n}: a step runs an agent, checks a condition or takes an action.`);
    }
  });
  if (!errors.length && !out.steps.some((s) => s.type === 'agent')) errors.push('Add at least one agent step; that is what does the work.');
  return { ok: errors.length === 0, errors, definition: errors.length ? null : out };
}

function validateName(name) {
  const n = String(name || '').trim();
  if (!n) throw httpError(400, 'Give the workflow a name.');
  if (n.length > 80) throw httpError(400, 'Keep the name under 80 characters.');
  return n;
}

// ── Running ─────────────────────────────────────────────────────────────

/** Reads the numbers conditions can test from an agent's result. */
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

/** Evaluates one condition against the outputs collected so far. */
function evaluateCondition(step, outputs) {
  const [ref, field] = step.signal.split('.');
  const actual = outputs[ref] ? outputs[ref][field] : undefined;
  const op = OPS[step.op];
  const passed = !!op && op.test(actual === undefined ? null : actual, step.value);
  return { passed, actual: actual === undefined ? null : actual };
}

// The default agent runners: the same functions the Agents page calls.
function defaultRunAgent(pool) {
  return async (agentKey, userId, params, actorId) => {
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
    throw new Error(`No runner for agent ${agentKey}`);
  };
}

function defaultNotify(pool) {
  return (userId, n) => require('../../notifications/notify').notify(pool, userId, n);
}

/**
 * Runs one workflow once. `slot` makes the run idempotent: a second call
 * with the same (workflow, slot) returns { status: 'DUPLICATE' } and does
 * nothing.
 */
async function executeWorkflow(pool, userId, wf, { trigger, slot, actorId = null, runAgent = null, notifyFn = null } = {}) {
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
  const steps = [];
  const outputs = {};
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

  try {
    const stops = await checkStops(pool, userId, { workflowId: wf.id });
    if (!stops.allowed) {
      status = 'BLOCKED';
      summary = `Stopped by a kill switch: ${stops.blockedBy.map((b) => b.reason).join('; ')}`;
      return await finish();
    }
    const def = wf.definition || {};
    for (let i = 0; i < (def.steps || []).length; i++) {
      const s = def.steps[i];
      const started = Date.now();
      const rec = { id: s.id, type: s.type, startedAt: new Date(started).toISOString() };
      if (s.type === 'agent') {
        rec.agent = s.agent;
        const r = await run(s.agent, userId, s.params || {}, actorId);
        rec.durationMs = Date.now() - started;
        if (r && r.status === 'STOPPED') {
          rec.status = 'BLOCKED';
          rec.summary = `The agent is stopped by a kill switch: ${(r.blockedBy || []).map((b) => b.reason).join('; ')}`;
          steps.push(rec);
          status = 'BLOCKED';
          summary = rec.summary;
          break;
        }
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
        rec.actual = actual;
        rec.summary = `${s.signal} ${OPS[s.op]?.label || s.op}${s.value !== undefined ? ` ${s.value}` : ''}: ${actual === null ? 'no value' : actual} → ${passed ? 'continue' : 'stop here'}`;
        steps.push(rec);
        if (!passed) {
          status = 'ENDED_BY_CONDITION';
          summary = 'The condition was not met, so the remaining steps did not run.';
          break;
        }
      } else if (s.type === 'action' && s.action === 'notify_owner') {
        const body = s.params?.includeSummaryOf ? summaryOf(null, results[s.params.includeSummaryOf]) : null;
        const n = await notifyOwner(userId, {
          type: 'business_change',
          severity: 'normal',
          title: s.params?.title || wf.name,
          body: body ? String(body).slice(0, 300) : `From your workflow "${wf.name}".`,
          entity: { type: 'custom_workflow', id: wf.id },
          route: `/workflows?id=${wf.id}`,
          dedupeKey: `cwf:${runId}:${s.id}`,
        });
        rec.durationMs = Date.now() - started;
        rec.status = n ? 'DONE' : 'FAILED';
        rec.summary = n ? 'Notification sent to your Starlane inbox.' : 'The notification could not be written.';
        steps.push(rec);
        if (!n) { status = 'FAILED'; error = rec.summary; break; }
      } else {
        rec.status = 'FAILED';
        rec.summary = 'This step type cannot run.';
        steps.push(rec);
        status = 'FAILED';
        error = rec.summary;
        break;
      }
    }
    // Steps after a stop are recorded as skipped so the run reads end to end.
    for (const s of (def.steps || []).slice(steps.length)) steps.push({ id: s.id, type: s.type, status: 'SKIPPED' });
    if (status === 'COMPLETED') {
      const last = [...steps].reverse().find((x) => x.type === 'agent' && x.summary);
      summary = last ? last.summary : 'Every step ran.';
    }
  } catch (err) {
    status = 'FAILED';
    error = String(err.message || err).slice(0, 500);
    safeLog('warn', '[custom-workflows] run failed', { workflowId: wf.id, error: error });
  }
  return finish();
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
  catalog, validateDefinition, extractOutputs, evaluateCondition, scheduleSlot, nextRunAt,
  executeWorkflow, runScheduledCustomWorkflows,
  getWorkflow, listWorkflows, createWorkflow, updateWorkflow, setStatus, deleteWorkflow, listRuns,
};
