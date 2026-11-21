'use strict';
// Agent factory: builds several agents in one step, from a department pack,
// a list of templates, a connected app, or plain-language objectives.
//
// The factory only creates DRAFT agents through agents.create(), so every
// rule of Agent Studio still applies to what it makes:
//   * definitions are validated; external and financial tools always need
//     approval, and a draft cannot remove that;
//   * nothing runs live until a person tests, publishes and activates it;
//   * a draft whose tools are not available (an app not connected, a planned
//     tool) says what is missing and cannot be activated until it is fixed.
// With autoTest, the factory also queues one test run per new agent. Test
// runs never carry out writes or external calls (engine.js records them as
// dry runs).
//
// Building is admin-only (factory.build) and audited. An agent whose name
// already exists in the organization is skipped, so running the same pack
// twice does not duplicate agents.

const agents = require('./agents');
const engine = require('./engine');
const audit = require('./audit');
const store = require('./connectors/store');
const { getTemplate, TEMPLATES } = require('./templates');
const { draftFromObjective } = require('./drafter');
const { badRequest, UUID_RE } = require('./errors');

const MAX_PER_BUILD = 20;

const PACKS = [
  { key: 'finance', name: 'Finance', description: 'Receivables, supplier bills and a weekly brief.', templates: ['finance_analysis', 'procurement_review', 'executive_briefing'] },
  { key: 'sales', name: 'Sales', description: 'Lead qualification and CRM upkeep.', templates: ['sales_qualification', 'crm_hygiene', 'app_data_analyst'] },
  { key: 'support', name: 'Customer support', description: 'Ticket triage and answers from your documents.', templates: ['support_triage', 'document_research'] },
  { key: 'operations', name: 'Operations and IT', description: 'Watch systems and trackers, answer from live app data.', templates: ['operations_monitoring', 'it_incident_watch', 'app_data_analyst'] },
  { key: 'people', name: 'People', description: 'Onboarding and policy questions.', templates: ['hr_onboarding', 'document_research'] },
  { key: 'leadership', name: 'Leadership', description: 'Weekly briefing and cash position.', templates: ['executive_briefing', 'finance_analysis'] },
];

function sampleInput(def) {
  const input = { instruction: 'Factory test run: check the tools work and describe what you would do. Do not change anything.' };
  for (const f of def.input_schema?.fields || []) {
    if (!f.required) continue;
    input[f.name] = f.type === 'number' ? 1 : f.type === 'boolean' ? false : `Sample ${f.name.replace(/_/g, ' ')} for a test run`;
  }
  return input;
}

/** A definition for an agent that works in one connected app. */
function blueprintFromConnection(conn, { includeActions = false } = {}) {
  const ops = conn.operations || [];
  const reads = ops.filter((o) => o.risk === 'read');
  const writes = ops.filter((o) => o.risk !== 'read');
  const lines = (list) => list.slice(0, 40).map((o) => `- ${o.id} (${o.method}${o.path ? ` ${o.path}` : ''}): ${o.summary}`).join('\n');
  const canAct = includeActions && writes.length > 0;
  if (!reads.length && !canAct) throw badRequest(`${conn.name} has no read operations. Allow actions to build an agent for it.`);
  const instructions = [
    `You work in ${conn.name} through Starlane connection ${conn.id}. Always pass that id as connection_id.`,
    reads.length ? `Read operations you may call with apps.read:\n${lines(reads)}` : 'This app has no read operations.',
    canAct ? `Operations that change something in ${conn.name}, called with apps.act (each waits for a person to approve the exact request):\n${lines(writes)}` : `Do not try to change anything in ${conn.name}.`,
    'Quote what the app returned; never invent records, ids or figures. If an operation fails, say which one and why.',
  ].join('\n\n');
  return {
    name: `${conn.name} assistant`.slice(0, 80),
    description: `Works with live data in ${conn.name}${canAct ? ' and proposes changes for approval' : ' (read only)'}.`.slice(0, 500),
    objective: `Carry out the request using ${conn.name}'s data${canAct ? ', proposing any change for approval' : ''}, and report exactly what was read${canAct ? ' or changed' : ''}.`,
    instructions: instructions.slice(0, 8000),
    expected_outputs: ['Answer or result', `The ${conn.name} operations used`],
    success_criteria: ['Every figure comes from an operation result', ...(canAct ? ['No change without approval'] : [])],
    tools: [{ key: 'apps.list' }, { key: 'apps.read' }, ...(canAct ? [{ key: 'apps.act' }] : []), { key: 'notifications.notify' }],
    triggers: [{ type: 'manual' }],
    input_schema: { fields: [{ name: 'request', type: 'text', required: true, description: `What to do in ${conn.name}` }] },
  };
}

async function existingNames(db, orgId) {
  const { rows } = await db.query(`SELECT lower(name) AS n FROM platform_agents WHERE organization_id = $1 AND status <> 'archived'`, [orgId]);
  return new Set(rows.map((r) => r.n));
}

/** Packs and templates with what each is missing for this organization. */
async function overview(db, org, { describeTool }) {
  const tpl = (key) => {
    const t = getTemplate(key);
    const missing = t.definition.tools.map((x) => describeTool(x.key)).filter((d) => d && d.status !== 'available').map((d) => ({ tool: d.key, name: d.name, status: d.status, reason: d.reason }));
    return { key: t.key, name: t.definition.name, category: t.category, description: t.definition.description, missing, ready: missing.length === 0 };
  };
  const conns = await store.list(db, org);
  const builds = await db.query(
    `SELECT b.id, b.source, b.request, b.agent_ids, b.test_execution_ids, b.skipped, b.created_at, u.email AS requested_by_email
       FROM platform_factory_builds b LEFT JOIN users u ON u.id = b.requested_by
      WHERE b.organization_id = $1 ORDER BY b.created_at DESC LIMIT 20`, [org.id]);
  return {
    packs: PACKS.map((p) => ({ ...p, templates: p.templates.map(tpl) })),
    templates: TEMPLATES.map((t) => tpl(t.key)),
    connections: conns.filter((c) => c.status === 'active').map((c) => ({ id: c.id, name: c.name, source: c.source, operationCounts: c.operationCounts })),
    builds: builds.rows.map((b) => ({ id: b.id, source: b.source, request: b.request, agentCount: b.agent_ids.length, testCount: b.test_execution_ids.length, skipped: b.skipped, createdAt: b.created_at, requestedBy: b.requested_by_email })),
    limits: { maxPerBuild: MAX_PER_BUILD },
  };
}

/**
 * Builds agents. `request` is one of:
 *   { source: 'pack', pack }
 *   { source: 'templates', templateKeys: [...] }
 *   { source: 'connection', connectionId, includeActions }
 *   { source: 'objectives', objectives: [...] }   (up to 5)
 * plus optional { visibility, autoTest }.
 */
async function build(db, org, userId, request = {}, { describeTool, router = null } = {}) {
  const source = request.source;
  const items = []; // { label, templateKey?, definition? }
  const skipped = [];
  if (source === 'pack') {
    const pack = PACKS.find((p) => p.key === request.pack);
    if (!pack) throw badRequest('Choose a pack.');
    for (const k of pack.templates) items.push({ label: getTemplate(k).definition.name, templateKey: k });
  } else if (source === 'templates') {
    const keys = Array.isArray(request.templateKeys) ? [...new Set(request.templateKeys.map(String))] : [];
    if (!keys.length) throw badRequest('Choose at least one template.');
    for (const k of keys) {
      const t = getTemplate(k);
      if (!t) skipped.push({ name: k, reason: 'There is no template with that key.' });
      else items.push({ label: t.definition.name, templateKey: k });
    }
  } else if (source === 'connection') {
    if (!UUID_RE.test(String(request.connectionId || ''))) throw badRequest('Choose a connection.');
    const conn = await store.get(db, org, request.connectionId);
    if (conn.status !== 'active') throw badRequest(`${conn.name} is not active. Authorize or turn it on first.`);
    items.push({ label: `${conn.name} assistant`, definition: blueprintFromConnection(conn, { includeActions: request.includeActions === true }) });
  } else if (source === 'objectives') {
    const list = Array.isArray(request.objectives) ? request.objectives.map((o) => String(o || '').trim()).filter(Boolean) : [];
    if (!list.length) throw badRequest('Write at least one objective.');
    if (list.length > 5) throw badRequest('Up to 5 objectives per build.');
    for (const o of list) {
      try {
        const d = await draftFromObjective(o, { router, userId: org.ownerUserId, describeTool });
        items.push({ label: d.definition.name, definition: d.definition, draftedBy: d.draftedBy });
      } catch (err) {
        skipped.push({ name: o.slice(0, 80), reason: err.message });
      }
    }
  } else {
    throw badRequest('source must be pack, templates, connection or objectives');
  }
  if (items.length > MAX_PER_BUILD) throw badRequest(`Up to ${MAX_PER_BUILD} agents per build.`);

  const names = await existingNames(db, org.id);
  const created = [];
  for (const it of items) {
    const name = (it.definition?.name || getTemplate(it.templateKey)?.definition.name || it.label).toLowerCase();
    if (names.has(name)) { skipped.push({ name: it.label, reason: 'An agent with this name already exists.' }); continue; }
    try {
      const { id } = await agents.create(db, org, userId, { templateKey: it.templateKey || null, definition: it.definition || null, visibility: request.visibility || 'organization' });
      names.add(name);
      created.push({ id, name: it.label, templateKey: it.templateKey || null, draftedBy: it.draftedBy || null });
    } catch (err) {
      skipped.push({ name: it.label, reason: err.message });
    }
  }

  // Readiness of each created draft.
  for (const c of created) {
    const a = await agents.get(db, org, userId, c.id);
    const missing = (a.draft?.tools || a.definition?.tools || []).map((t) => describeTool(t.key)).filter((d) => d && d.status !== 'available').map((d) => ({ tool: d.key, name: d.name, reason: d.reason }));
    c.missing = missing;
    c.ready = missing.length === 0;
  }

  const tests = [];
  if (request.autoTest === true) {
    for (const c of created) {
      try {
        const a = await db.query('SELECT draft_definition FROM platform_agents WHERE organization_id = $1 AND id = $2', [org.id, c.id]);
        const { execution } = await engine.enqueue(db, org, userId, c.id, { mode: 'test', input: sampleInput(a.rows[0].draft_definition) });
        tests.push(execution.id);
        c.testExecutionId = execution.id;
      } catch (err) {
        c.testError = err.message;
      }
    }
  }

  const reqRecord = { source, pack: request.pack, templateKeys: request.templateKeys, connectionId: request.connectionId, includeActions: request.includeActions === true, objectives: Array.isArray(request.objectives) ? request.objectives.length : undefined, autoTest: request.autoTest === true };
  const { rows } = await db.query(
    `INSERT INTO platform_factory_builds (organization_id, requested_by, source, request, agent_ids, test_execution_ids, skipped)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
    [org.id, userId, source, JSON.stringify(reqRecord), created.map((c) => c.id), tests, JSON.stringify(skipped)],
  );
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: userId, action: 'factory.build', resourceType: 'factory_build', resourceId: rows[0].id, detail: { source, created: created.length, skipped: skipped.length, tests: tests.length } });
  return { buildId: rows[0].id, createdAt: rows[0].created_at, created, skipped, testExecutionIds: tests };
}

module.exports = { PACKS, build, overview, blueprintFromConnection, sampleInput, MAX_PER_BUILD };
