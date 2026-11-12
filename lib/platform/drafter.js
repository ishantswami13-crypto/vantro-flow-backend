'use strict';
// Natural-language agent drafting: turns "Create an agent that ..." into an
// editable, validated definition.
//
// This is a configuration aid, not execution. Whatever comes back (from a
// model, or from the keyword rules when no model is configured) goes through
// normalizeDefinition() like any other definition, unknown tools are dropped
// with a note, external and financial tools are forced to need approval, and
// nothing runs until a person tests and publishes it. The response says which
// method drafted it, so a rule-based draft never poses as a model's.

const { normalizeDefinition } = require('./definition');
const { CATALOG, TOOLS } = require('./tools');
const { badRequest } = require('./errors');

const RULES = [
  { re: /\b(knowledge|document|docs?|policy|policies|contract|catalog(ue)?|handbook|research|manual|faq|wiki|files?)\b/i, tools: ['knowledge.search', 'knowledge.read_document'] },
  { re: /\b(receivable|invoice|overdue|collections?|cash|debtor|ledger|payment)s?\b/i, tools: ['finance.receivables_summary'] },
  { re: /\b(supplier|purchase|bill|vendor|procure|payable)s?\b/i, tools: ['procurement.bills_due'] },
  { re: /\b(task|follow[- ]?up|to-?do|assign)s?\b/i, tools: ['tasks.create'] },
  { re: /\b(notify|alert|tell me|remind|ping)\b/i, tools: ['notifications.notify'] },
  { re: /\b(api|endpoint|system status|webhook|erp|integration)s?\b/i, tools: ['connections.http_request'] },
  { re: /\b(send|sending|sends|reply|replies|e-?mails?|outreach)\b/i, tools: ['email.send'] },
  { re: /\b(inbox|incoming (business )?e-?mails?|emails? (that|which) (come|arrive))\b/i, tools: ['email.read_inbox'] },
  { re: /\b(crm|salesforce|hubspot|pipeline|deal)s?\b/i, tools: ['crm.lookup'] },
  { re: /\b(web|internet|online|google)\b/i, tools: ['web.search'] },
  { re: /\b(lead|quotation|quote|prospect)s?\b/i, tools: ['knowledge.search', 'tasks.create'] },
];

function titleFrom(objective) {
  const m = objective.match(/agent (that|which|to|who)\s+(.+?)(,|\.|;| and |$)/i);
  const core = (m ? m[2] : objective).replace(/^(please\s+)?(create|build|make)\s+(an?\s+)?/i, '');
  const words = core.split(/\s+/).filter((w) => w.length > 2).slice(0, 4);
  const t = words.join(' ').replace(/[^\w\s-]/g, '');
  return (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, 60) || 'New agent';
}

function draftByRules(objective) {
  const tools = new Set();
  for (const r of RULES) if (r.re.test(objective)) r.tools.forEach((t) => tools.add(t));
  if (!tools.size) tools.add('knowledge.search');
  const triggers = [{ type: 'manual' }];
  if (/\b(every|daily|each day|morning|weekly|each week|hourly|monitor)\b/i.test(objective)) {
    triggers.push(/\b(hour|hourly)\b/i.test(objective) ? { type: 'schedule', every: 'hour' }
      : /\b(week|weekly|monday)\b/i.test(objective) ? { type: 'schedule', every: 'week', weekday: 'mon', at_hour: 8 }
        : { type: 'schedule', every: 'day', at_hour: 8 });
  }
  if (/\b(incoming|when .* (arrives?|comes? in)|webhook|event)\b/i.test(objective)) triggers.push({ type: 'webhook' });
  const wantsApproval = /\b(approv|review before|before sending|sign[- ]off)\w*/i.test(objective);
  return {
    name: titleFrom(objective),
    description: objective.length > 160 ? `${objective.slice(0, 157)}...` : objective,
    objective,
    instructions: [
      'Work only from what the tools return; never invent data, prices or results.',
      'Cite the knowledge you rely on as (document, part).',
      'If a step needs a tool you do not have, stop and say which one is missing.',
      wantsApproval ? 'Anything that leaves Starlane or changes a record waits for a person to approve it.' : null,
    ].filter(Boolean).join('\n'),
    expected_outputs: ['A short summary of what was done and found'],
    success_criteria: ['Every claim is backed by a tool result or citation'],
    tools: [...tools].map((key) => ({ key, requires_approval: wantsApproval && CATALOG.get(key)?.risk !== 'read' })),
    triggers,
    approval: { approver_role: 'admin', always_for_writes: true },
    limits: {},
  };
}

function toolMenu() {
  return TOOLS.map((t) => `- ${t.key} (${t.risk}${t.planned ? ', planned: not callable yet' : ''}): ${t.description}`).join('\n');
}

const DRAFT_PROMPT = `You configure agents for Starlane, an enterprise AI work platform. Turn the person's objective into one JSON object with these keys only:
name (<=60 chars), description (<=160 chars), objective, instructions (numbered operating rules), expected_outputs (array of strings), success_criteria (array of strings),
tools (array of {"key": tool key, "requires_approval": boolean}), triggers (array; each {"type":"manual"} or {"type":"webhook"} or {"type":"schedule","every":"hour"|"day"|"week","at_hour":0-23,"weekday":"mon".."sun"}),
approval ({"approver_role":"admin","always_for_writes":true}), limits ({"max_steps":1-25,"timeout_seconds":10-600}),
input_schema ({"fields":[{"name":"snake_case","type":"text"|"number"|"boolean","required":bool,"description":"..."}]}).
Choose tools only from this list, and include planned tools only when the objective truly needs them:
${'{{TOOLS}}'}
Reply with the JSON object only, no prose.`;

function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

/**
 * Draft a definition. `router` is the model router; when no provider is
 * configured (or the model fails) the keyword rules draft it and say so.
 */
async function draftFromObjective(objective, { router = null, userId = null, describeTool }) {
  const obj = typeof objective === 'string' ? objective.trim() : '';
  if (obj.length < 12) throw badRequest('Describe what the agent should achieve in a sentence or two.');
  if (obj.length > 2000) throw badRequest('Keep the objective under 2000 characters.');

  let raw = null;
  let method = 'rules';
  let modelNote = null;
  const configured = router?.health ? router.health().configured.length > 0 : false;
  if (configured) {
    try {
      const session = router.session({ userId, purpose: 'agent_draft' });
      const choice = await session.chat([
        { role: 'system', content: DRAFT_PROMPT.replace('{{TOOLS}}', toolMenu()) },
        { role: 'user', content: obj },
      ], []);
      raw = extractJson(choice?.message?.content);
      if (raw) method = `model:${session.model?.model || 'unknown'}`;
      else modelNote = 'The model did not return a usable configuration, so this draft was made by Starlane\'s keyword rules.';
    } catch (err) {
      modelNote = `The model could not be reached (${String(err.message || err).slice(0, 120)}), so this draft was made by Starlane's keyword rules.`;
    }
  } else {
    modelNote = 'No AI model is configured on this server, so this draft was made by Starlane\'s keyword rules. Review every field.';
  }
  if (!raw) raw = draftByRules(obj);

  const notes = [];
  if (modelNote) notes.push(modelNote);
  // Drop unknown tools (a model may invent one) with a note, then validate.
  const tools = Array.isArray(raw.tools) ? raw.tools : [];
  raw.tools = tools.filter((t) => {
    const key = typeof t === 'string' ? t : t?.key;
    if (CATALOG.has(key)) return true;
    notes.push(`Removed "${key}": Starlane has no tool by that name.`);
    return false;
  });
  raw.objective = raw.objective || obj;
  let definition;
  try {
    definition = normalizeDefinition(raw, { toolCatalog: CATALOG });
  } catch (err) {
    notes.push(`The drafted configuration was invalid (${err.message}); Starlane's keyword rules drafted it instead.`);
    method = 'rules';
    definition = normalizeDefinition(draftByRules(obj), { toolCatalog: CATALOG });
  }
  const missing = [];
  for (const t of definition.tools) {
    const d = describeTool(t.key);
    if (d && d.status !== 'available') missing.push({ tool: t.key, name: d.name, status: d.status, reason: d.reason });
  }
  for (const m of missing) notes.push(`${m.name} is ${m.status.replace(/_/g, ' ')}: ${m.reason}`);
  const permissions = definition.tools.map((t) => {
    const tool = CATALOG.get(t.key);
    return { tool: t.key, name: tool.name, risk: tool.risk, requiresApproval: t.requires_approval || (tool.risk !== 'read' && definition.approval.always_for_writes) };
  });
  return { definition, draftedBy: method, notes, missing, permissions };
}

module.exports = { draftFromObjective, draftByRules, extractJson };
