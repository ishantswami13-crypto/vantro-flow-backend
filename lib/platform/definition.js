'use strict';
// The agent definition contract (schema_version 1).
//
// A definition is data, never code: the engine reads it to decide which
// instructions the model sees, which tools it may call, its limits, its
// triggers and who approves protected actions. normalizeDefinition() is the
// single gate: anything a person types, a template provides, or a model
// drafts goes through it, unknown keys are dropped, and values are clamped to
// what the engine supports. A definition that fails here is never saved.

const crypto = require('crypto');
const { badRequest, UUID_RE } = require('./errors');

const SCHEMA_VERSION = 1;
const LIMITS = Object.freeze({
  max_steps: { min: 1, max: 25, default: 8 },
  max_tool_calls: { min: 0, max: 50, default: 12 },
  timeout_seconds: { min: 10, max: 600, default: 120 },
  max_retries: { min: 0, max: 5, default: 2 },
});
const FIELD_TYPES = ['text', 'number', 'boolean'];
const FIELD_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const TOOL_KEY = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;
const SCHEDULE_EVERY = ['hour', 'day', 'week'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function str(v, max, what, { required = false, multiline = true } = {}) {
  if (v == null || v === '') {
    if (required) throw badRequest(`${what} is required`);
    return '';
  }
  if (typeof v !== 'string') throw badRequest(`${what} must be text`);
   
  let t = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!multiline) t = t.replace(/\s+/g, ' ');
  if (required && !t) throw badRequest(`${what} is required`);
  if (t.length > max) throw badRequest(`${what} must be at most ${max} characters`);
  return t;
}

function strList(v, maxItems, maxLen, what) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw badRequest(`${what} must be a list`);
  if (v.length > maxItems) throw badRequest(`${what} can have at most ${maxItems} entries`);
  return v.map((x, i) => str(x, maxLen, `${what} ${i + 1}`, { multiline: false })).filter(Boolean);
}

function int(v, spec, what) {
  if (v == null || v === '') return spec.default;
  const n = Number(v);
  if (!Number.isInteger(n) || n < spec.min || n > spec.max) throw badRequest(`${what} must be a whole number from ${spec.min} to ${spec.max}`);
  return n;
}

function fields(v, what) {
  if (v == null) return [];
  const list = Array.isArray(v) ? v : v.fields;
  if (!Array.isArray(list)) throw badRequest(`${what} must be a list of fields`);
  if (list.length > 20) throw badRequest(`${what} can have at most 20 fields`);
  const seen = new Set();
  return list.map((f, i) => {
    if (!f || typeof f !== 'object') throw badRequest(`${what} field ${i + 1} is invalid`);
    const name = String(f.name || '').trim();
    if (!FIELD_NAME.test(name)) throw badRequest(`${what} field names use lowercase letters, digits and underscores (got "${name}")`);
    if (seen.has(name)) throw badRequest(`${what} has two fields called ${name}`);
    seen.add(name);
    const type = f.type || 'text';
    if (!FIELD_TYPES.includes(type)) throw badRequest(`${what} field ${name} must be text, number or boolean`);
    return { name, type, required: !!f.required, description: str(f.description, 200, `${name} description`, { multiline: false }) };
  });
}

function triggers(v) {
  const list = v == null ? [{ type: 'manual' }] : v;
  if (!Array.isArray(list) || list.length > 5) throw badRequest('triggers must be a list of at most 5');
  const out = [];
  const types = new Set();
  for (const t of list) {
    if (!t || typeof t !== 'object') throw badRequest('Each trigger must be an object');
    if (types.has(t.type)) throw badRequest(`Only one ${t.type} trigger is allowed`);
    types.add(t.type);
    if (t.type === 'manual' || t.type === 'webhook') { out.push({ type: t.type }); continue; }
    if (t.type === 'schedule') {
      if (!SCHEDULE_EVERY.includes(t.every)) throw badRequest('A schedule runs every hour, day or week');
      const s = { type: 'schedule', every: t.every };
      if (t.every !== 'hour') s.at_hour = int(t.at_hour, { min: 0, max: 23, default: 8 }, 'Schedule hour');
      if (t.every === 'week') {
        if (!WEEKDAYS.includes(t.weekday || 'mon')) throw badRequest('Schedule weekday must be sun to sat');
        s.weekday = t.weekday || 'mon';
      }
      out.push(s);
      continue;
    }
    throw badRequest(`Unknown trigger type ${t.type}. Use manual, schedule or webhook.`);
  }
  if (!out.some((t) => t.type === 'manual')) out.unshift({ type: 'manual' });
  return out;
}

/**
 * Validate and canonicalize a definition. `toolCatalog` is a Map of known
 * tool keys; tools not in it are refused (not silently dropped) so a person
 * sees why.
 */
function normalizeDefinition(input, { toolCatalog }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('The agent definition must be an object');
  const d = {};
  d.schema_version = SCHEMA_VERSION;
  d.name = str(input.name, 80, 'Name', { required: true, multiline: false });
  d.description = str(input.description, 500, 'Description', { multiline: false });
  d.objective = str(input.objective, 2000, 'Objective', { required: true });
  d.instructions = str(input.instructions, 8000, 'Instructions');
  d.expected_outputs = strList(input.expected_outputs, 10, 200, 'Expected output');
  d.success_criteria = strList(input.success_criteria, 10, 200, 'Success criterion');

  const kIds = input.knowledge?.collection_ids ?? [];
  if (!Array.isArray(kIds) || kIds.length > 20 || kIds.some((id) => !UUID_RE.test(String(id)))) throw badRequest('knowledge.collection_ids must be a list of up to 20 collection ids');
  d.knowledge = { collection_ids: [...new Set(kIds.map(String))] };

  const tools = input.tools ?? [];
  if (!Array.isArray(tools) || tools.length > 20) throw badRequest('tools must be a list of up to 20 tools');
  const seen = new Set();
  d.tools = tools.map((t) => {
    const key = typeof t === 'string' ? t : t?.key;
    if (!TOOL_KEY.test(String(key || '')) || !toolCatalog.has(key)) throw badRequest(`There is no tool called "${key}"`);
    if (seen.has(key)) throw badRequest(`Tool ${key} is listed twice`);
    seen.add(key);
    const tool = toolCatalog.get(key);
    // External and financial tools always need approval; a definition can
    // add approval to any tool but never remove it from those.
    const forced = tool.risk === 'external' || tool.risk === 'financial';
    return { key, requires_approval: forced || !!(typeof t === 'object' && t.requires_approval) };
  });

  d.triggers = triggers(input.triggers);
  const lim = input.limits || {};
  d.limits = {};
  for (const [k, spec] of Object.entries(LIMITS)) d.limits[k] = int(lim[k], spec, `limits.${k}`);

  const ap = input.approval || {};
  if (ap.approver_role != null && !['owner', 'admin', 'member'].includes(ap.approver_role)) throw badRequest('approval.approver_role must be owner, admin or member');
  d.approval = { approver_role: ap.approver_role || 'admin', always_for_writes: ap.always_for_writes !== false };

  const model = input.model == null || input.model === '' ? 'auto' : String(input.model);
  if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/i.test(model)) throw badRequest('model must be a model id from the catalog');
  d.model = model;

  d.input_schema = { fields: fields(input.input_schema, 'Input') };
  d.output_schema = { fields: fields(input.output_schema, 'Output') };
  return d;
}

function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function checksum(def) {
  return crypto.createHash('sha256').update(canonicalJson(def)).digest('hex');
}

/** Validate run input against the definition's input schema. */
function validateInput(def, input) {
  const raw = input == null ? {} : input;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('Run input must be an object');
  const out = {};
  const declared = def.input_schema?.fields || [];
  if (typeof raw.instruction === 'string' || raw.instruction == null) {
    const instr = str(raw.instruction, 4000, 'Instruction');
    if (instr) out.instruction = instr;
  } else {
    throw badRequest('instruction must be text');
  }
  for (const f of declared) {
    const v = raw[f.name];
    if (v == null || v === '') {
      if (f.required) throw badRequest(`${f.name} is required`);
      continue;
    }
    if (f.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) throw badRequest(`${f.name} must be a number`);
      out[f.name] = n;
    } else if (f.type === 'boolean') {
      if (typeof v !== 'boolean') throw badRequest(`${f.name} must be true or false`);
      out[f.name] = v;
    } else {
      out[f.name] = str(v, 4000, f.name);
    }
  }
  // Event payloads (webhook, handoff) are kept as untrusted data, bounded.
  if (raw.event !== undefined) {
    const json = JSON.stringify(raw.event);
    if (json.length > 20000) throw badRequest('event payload is too large (20 KB max)');
    out.event = JSON.parse(json);
  }
  return out;
}

module.exports = { normalizeDefinition, checksum, canonicalJson, validateInput, SCHEMA_VERSION, LIMITS, WEEKDAYS };
