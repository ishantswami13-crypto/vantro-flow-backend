'use strict';
// The tools an agent can be granted. This file is the only place a tool is
// defined, and the engine refuses any call that is not here.
//
// Each tool declares:
//   risk          read | internal_write | external | financial
//                 external and financial ALWAYS need human approval; a
//                 definition cannot remove that (definition.js forces it)
//   parameters    JSON schema of its arguments, checked before execution
//   requires      the app, connection kind or server flag it depends on
//   available()   whether it can run for this organization right now, with
//                 the honest reason when it cannot
//   execute()     what it does, scoped to the organization and to the
//                 identity the execution runs as
//
// 'planned' tools are listed so templates and drafts can say what is
// missing; they are never callable.

const knowledge = require('./knowledge');
const { badRequest } = require('./errors');

const MAX_RESULT_CHARS = 8000;

// ── Argument validation (a small JSON-schema subset) ────────────────────

function validateArgs(schema, args) {
  const a = args == null ? {} : args;
  if (typeof a !== 'object' || Array.isArray(a)) return 'Arguments must be an object';
  const props = schema.properties || {};
  for (const k of Object.keys(a)) if (!(k in props)) return `Unknown argument "${k}"`;
  for (const k of schema.required || []) if (a[k] == null || a[k] === '') return `Missing argument "${k}"`;
  for (const [k, p] of Object.entries(props)) {
    const v = a[k];
    if (v == null) continue;
    if (p.type === 'string') {
      if (typeof v !== 'string') return `"${k}" must be text`;
      if (p.maxLength && v.length > p.maxLength) return `"${k}" is longer than ${p.maxLength} characters`;
      if (p.minLength && v.length < p.minLength) return `"${k}" is shorter than ${p.minLength} characters`;
      if (p.enum && !p.enum.includes(v)) return `"${k}" must be one of ${p.enum.join(', ')}`;
      if (p.pattern && !new RegExp(p.pattern).test(v)) return `"${k}" is not in the expected format`;
    } else if (p.type === 'integer') {
      if (!Number.isInteger(v)) return `"${k}" must be a whole number`;
      if (p.minimum != null && v < p.minimum) return `"${k}" must be at least ${p.minimum}`;
      if (p.maximum != null && v > p.maximum) return `"${k}" must be at most ${p.maximum}`;
    } else if (p.type === 'object') {
      if (typeof v !== 'object' || Array.isArray(v)) return `"${k}" must be an object`;
      if (JSON.stringify(v).length > 20000) return `"${k}" is too large`;
    }
  }
  return null;
}

const UUID_PATTERN = '^[0-9a-fA-F-]{36}$';

const flagOn = (key) => {
  try { return require('../featureFlags').isEnabled(key) === true; } catch { return false; }
};

// ── Tools ───────────────────────────────────────────────────────────────

const TOOLS = [
  {
    key: 'knowledge.search',
    name: 'Search knowledge',
    description: 'Full-text search across the knowledge collections this agent is granted and the person running it may read. Returns snippets with citations.',
    risk: 'read',
    parameters: { type: 'object', properties: { query: { type: 'string', minLength: 2, maxLength: 300, description: 'What to search for' }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query'] },
    requires: { knowledge: true },
    available: () => ({ available: true }),
    async execute(ctx, args) {
      return knowledge.search(ctx.db, ctx.org.id, ctx.identity.userId, args.query, { collectionIds: ctx.knowledgeScope, limit: args.limit || 6 });
    },
  },
  {
    key: 'knowledge.read_document',
    name: 'Read a document',
    description: 'Reads the text of one document found by Search knowledge (by its documentId).',
    risk: 'read',
    parameters: { type: 'object', properties: { document_id: { type: 'string', pattern: UUID_PATTERN } }, required: ['document_id'] },
    requires: { knowledge: true },
    available: () => ({ available: true }),
    async execute(ctx, args) {
      return knowledge.readDocument(ctx.db, ctx.org.id, ctx.identity.userId, args.document_id, { collectionIds: ctx.knowledgeScope });
    },
  },
  {
    key: 'finance.receivables_summary',
    name: 'Receivables summary',
    description: 'Totals of open and overdue customer invoices from the organization\'s ledger, and the customers with the most overdue.',
    risk: 'read',
    parameters: { type: 'object', properties: { top: { type: 'integer', minimum: 1, maximum: 20 } } },
    requires: { app: 'finance' },
    available: (ctx) => (ctx.apps.has('finance') ? { available: true } : { available: false, reason: 'The Finance application is not enabled for this organization.' }),
    async execute(ctx, args) {
      const owner = ctx.org.ownerUserId;
      const totals = await ctx.db.query(
        `SELECT COUNT(*)::int AS open_invoices,
                COALESCE(SUM(invoice_amount - COALESCE(payment_amount, 0)), 0)::float AS outstanding,
                COUNT(*) FILTER (WHERE COALESCE(days_overdue, 0) > 0)::int AS overdue_invoices,
                COALESCE(SUM(invoice_amount - COALESCE(payment_amount, 0)) FILTER (WHERE COALESCE(days_overdue, 0) > 0), 0)::float AS overdue_amount,
                array_remove(array_agg(DISTINCT currency), NULL) AS currencies
           FROM invoices WHERE user_id = $1 AND LOWER(COALESCE(payment_status, '')) <> 'paid'`,
        [owner],
      );
      const top = await ctx.db.query(
        `SELECT customer_name, COUNT(*)::int AS invoices, SUM(invoice_amount - COALESCE(payment_amount, 0))::float AS overdue, MAX(days_overdue)::int AS max_days_overdue
           FROM invoices WHERE user_id = $1 AND LOWER(COALESCE(payment_status, '')) <> 'paid' AND COALESCE(days_overdue, 0) > 0
          GROUP BY customer_name ORDER BY overdue DESC LIMIT $2`,
        [owner, args.top || 5],
      );
      const t = totals.rows[0];
      return { source: 'invoices ledger', ...t, top_overdue_customers: top.rows, note: t.open_invoices === 0 ? 'No open invoices are in the ledger.' : undefined };
    },
  },
  {
    key: 'procurement.bills_due',
    name: 'Supplier bills due',
    description: 'Unpaid supplier bills due within a number of days, from the organization\'s purchases.',
    risk: 'read',
    parameters: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 120 } } },
    requires: { app: 'procurement' },
    available: (ctx) => (ctx.apps.has('procurement') ? { available: true } : { available: false, reason: 'The Procurement application is not enabled for this organization.' }),
    async execute(ctx, args) {
      const days = args.days || 14;
      const { rows } = await ctx.db.query(
        `SELECT supplier_name, bill_number, (amount - COALESCE(paid_amount, 0))::float AS open_amount, currency, due_date
           FROM purchases WHERE user_id = $1 AND LOWER(COALESCE(status, '')) <> 'paid'
            AND due_date IS NOT NULL AND due_date <= CURRENT_DATE + $2::int
          ORDER BY due_date ASC LIMIT 50`,
        [ctx.org.ownerUserId, days],
      );
      return { source: 'purchases', window_days: days, bills: rows, count: rows.length };
    },
  },
  {
    key: 'tasks.create',
    name: 'Create a task',
    description: 'Creates a task in Starlane for the person running the agent.',
    risk: 'internal_write',
    parameters: { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 200 }, detail: { type: 'string', maxLength: 2000 }, due_on: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } }, required: ['title'] },
    requires: {},
    available: () => ({ available: true }),
    async execute(ctx, args, { stepKey }) {
      const { rows } = await ctx.db.query(
        `INSERT INTO starlane_workflow_tasks (user_id, step_id, title, detail, due_on)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [ctx.identity.userId, `agent:${ctx.execution.id}:${stepKey}`.slice(0, 120), args.title, args.detail || null, args.due_on || null],
      );
      return { task_id: rows[0].id, created: true };
    },
  },
  {
    key: 'notifications.notify',
    name: 'Notify the requester',
    description: 'Sends an in-app notification to the person who ran the agent (inside Starlane only, never to customers).',
    risk: 'internal_write',
    parameters: { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 140 }, body: { type: 'string', maxLength: 300 } }, required: ['title'] },
    requires: {},
    available: () => ({ available: true }),
    async execute(ctx, args, { stepKey }) {
      const { notify } = require('../notifications/notify');
      const n = await notify(ctx.db, ctx.identity.userId, {
        type: 'action_completed', title: args.title, body: args.body || null, route: `/command/runs/${ctx.execution.id}`,
        entity: { type: 'agent_execution', id: ctx.execution.id }, dedupeKey: `agent:${ctx.execution.id}:${stepKey}`,
      });
      return { delivered: !!n };
    },
  },
  {
    key: 'agents.handoff',
    name: 'Hand off to another agent',
    description: 'Starts another active agent in this organization with typed input and returns its execution id. The other agent runs separately under the same person.',
    risk: 'internal_write',
    parameters: { type: 'object', properties: { agent_id: { type: 'string', pattern: UUID_PATTERN }, input: { type: 'object' } }, required: ['agent_id'] },
    requires: {},
    available: () => ({ available: true }),
    async execute(ctx, args, { stepKey }) {
      if (!ctx.handoff) throw new Error('Handoff is not available in this context');
      return ctx.handoff(args.agent_id, args.input || {}, { stepKey });
    },
  },
  {
    key: 'connections.http_request',
    name: 'Call a connected API',
    description: 'Sends a request to one of the organization\'s API connections (Connections > API). Always waits for human approval.',
    risk: 'external',
    parameters: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', pattern: UUID_PATTERN },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH'] },
        path: { type: 'string', maxLength: 500 },
        body: { type: 'object' },
      },
      required: ['connection_id', 'method'],
    },
    requires: { connection: 'http_api', flag: 'workflow_http_actions_enabled' },
    available(ctx) {
      if (!ctx.flags('workflow_http_actions_enabled')) return { available: false, reason: 'Calling other software is switched off on this server (FEATURE_WORKFLOW_HTTP_ACTIONS_ENABLED).' };
      if (!ctx.connectionCount) return { available: false, reason: 'No API connection is set up. Add one under Connections.', configurationRequired: true };
      return { available: true };
    },
    async execute(ctx, args, { stepKey }) {
      const r = await ctx.callConnection(ctx.org.ownerUserId, args.connection_id, {
        method: args.method, path: args.path || '', body: args.body || null, idempotencyKey: `starlane-${ctx.execution.id}-${stepKey}`,
      });
      return { status: r.status, ok: r.ok, json: r.json ?? null, body_preview: r.json ? undefined : r.bodyPreview };
    },
  },
  // Planned: listed so drafts and templates can say what is missing.
  {
    key: 'email.send',
    name: 'Send an email',
    description: 'Send an email from a connected mailbox after approval.',
    risk: 'external',
    parameters: { type: 'object', properties: {} },
    requires: { connection: 'mailbox' },
    planned: true,
    available: () => ({ available: false, reason: 'Planned. Agents cannot send email yet; custom workflows can draft one for your approval.' }),
  },
  {
    key: 'email.read_inbox',
    name: 'Read incoming email',
    description: 'Read new messages from a connected mailbox.',
    risk: 'read',
    parameters: { type: 'object', properties: {} },
    requires: { connection: 'mailbox' },
    planned: true,
    available: () => ({ available: false, reason: 'Planned. Today a Gmail inbox can trigger custom workflows, not agents.' }),
  },
  {
    key: 'crm.lookup',
    name: 'Look up a CRM record',
    description: 'Read accounts, contacts and deals from a CRM.',
    risk: 'read',
    parameters: { type: 'object', properties: {} },
    requires: { connection: 'crm' },
    planned: true,
    available: () => ({ available: false, reason: 'Planned. No CRM connector is live yet.' }),
  },
  {
    key: 'web.search',
    name: 'Search the web',
    description: 'Search public web pages.',
    risk: 'read',
    parameters: { type: 'object', properties: {} },
    requires: {},
    planned: true,
    available: () => ({ available: false, reason: 'Planned. Starlane does not search the web for agents yet.' }),
  },
];

const CATALOG = new Map(TOOLS.map((t) => [t.key, t]));

/** Provider-safe function name: knowledge.search -> knowledge__search. */
const fnName = (key) => key.replace('.', '__');
const fromFnName = (name) => String(name || '').replace('__', '.');

/** Context about the organization that decides availability. */
async function availabilityContext(db, org, { flags = flagOn } = {}) {
  const { enabledApps } = require('./apps');
  const [apps, conns] = await Promise.all([
    enabledApps(db, org.id),
    db.query(`SELECT COUNT(*)::int AS n FROM starlane_connections WHERE user_id = $1 AND kind = 'http_api' AND status = 'ACTIVE'`, [org.ownerUserId])
      .then((r) => r.rows[0].n).catch(() => 0),
  ]);
  return { apps, connectionCount: conns, flags };
}

/** The catalog as the API shows it, with availability for this org. */
function describe(ctx, policy = { disabledTools: [] }) {
  return TOOLS.map((t) => {
    const a = t.available(ctx);
    const disabledByPolicy = policy.disabledTools?.includes(t.key);
    return {
      key: t.key, name: t.name, description: t.description, risk: t.risk, parameters: t.parameters, requires: t.requires,
      status: t.planned ? 'planned' : disabledByPolicy ? 'disabled_by_policy' : a.available ? 'available' : a.configurationRequired ? 'configuration_required' : 'unavailable',
      reason: t.planned ? a.reason : disabledByPolicy ? 'An admin turned this tool off for the organization.' : a.reason || null,
      alwaysRequiresApproval: t.risk === 'external' || t.risk === 'financial',
    };
  });
}

function truncateResult(value) {
  const json = JSON.stringify(value ?? null);
  if (json.length <= MAX_RESULT_CHARS) return { value, truncated: false };
  return { value: { truncated: true, preview: json.slice(0, MAX_RESULT_CHARS) }, truncated: true };
}

function assertKnownTool(key) {
  if (!CATALOG.has(key)) throw badRequest(`There is no tool called ${key}`);
  return CATALOG.get(key);
}

module.exports = { TOOLS, CATALOG, validateArgs, availabilityContext, describe, fnName, fromFnName, truncateResult, assertKnownTool, flagOn };
