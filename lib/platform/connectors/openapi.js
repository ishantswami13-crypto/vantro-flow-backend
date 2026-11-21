'use strict';
// Turns an OpenAPI 3.x or Swagger 2.0 document (JSON or YAML) into the
// operations Starlane may call on a connection.
//
// What is kept per operation: id, method, path template, summary, the
// declared path/query/header parameters, whether a JSON body is accepted,
// and a risk class:
//   read      GET and HEAD. An agent may call these without approval.
//   external  everything else (POST, PUT, PATCH, DELETE). An agent call
//             always waits for a person to approve it (engine.js).
// The spec cannot lower a risk class. `readOnly: true` on import keeps only
// the read operations.
//
// Nothing in the document is executed or fetched; $ref is resolved only
// inside the same document (no remote refs), to a bounded depth.

const YAML = require('yaml');
const { badRequest } = require('../errors');

const METHODS = ['get', 'head', 'post', 'put', 'patch', 'delete'];
const MAX_SPEC_BYTES = 3 * 1024 * 1024;
const MAX_OPERATIONS = 200;
const OP_ID = /^[A-Za-z0-9_.-]{1,80}$/;

function riskOf(method) {
  return ['GET', 'HEAD'].includes(String(method).toUpperCase()) ? 'read' : 'external';
}

function parseDocument(input) {
  if (input && typeof input === 'object') return input;
  const text = String(input || '');
  if (!text.trim()) throw badRequest('Paste an OpenAPI or Swagger document, or give its URL.');
  if (Buffer.byteLength(text) > MAX_SPEC_BYTES) throw badRequest('The document is larger than 3 MB.');
  try {
    return text.trim().startsWith('{') ? JSON.parse(text) : YAML.parse(text, { maxAliasCount: 50 });
  } catch (err) {
    throw badRequest(`The document is not valid JSON or YAML (${String(err.message).slice(0, 120)}).`);
  }
}

function resolveRef(doc, value, depth = 0) {
  if (!value || typeof value !== 'object' || !value.$ref || depth > 8) return value;
  const ref = String(value.$ref);
  if (!ref.startsWith('#/')) return {}; // remote refs are not followed
  let cur = doc;
  for (const part of ref.slice(2).split('/')) {
    cur = cur && typeof cur === 'object' ? cur[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
  }
  return resolveRef(doc, cur || {}, depth + 1);
}

/** A small, bounded copy of a JSON schema for display and argument checks. */
function trimSchema(doc, schema, depth = 0) {
  const s = resolveRef(doc, schema);
  if (!s || typeof s !== 'object' || depth > 3) return {};
  const out = {};
  if (s.type) out.type = Array.isArray(s.type) ? s.type[0] : s.type;
  if (s.description) out.description = String(s.description).slice(0, 200);
  if (Array.isArray(s.enum)) out.enum = s.enum.slice(0, 30);
  if (s.format) out.format = String(s.format).slice(0, 30);
  if (s.properties && typeof s.properties === 'object') {
    out.properties = {};
    for (const [k, v] of Object.entries(s.properties).slice(0, 40)) out.properties[k] = trimSchema(doc, v, depth + 1);
  }
  if (Array.isArray(s.required)) out.required = s.required.slice(0, 40).map(String);
  if (s.items) out.items = trimSchema(doc, s.items, depth + 1);
  return out;
}

function slug(method, path) {
  return `${method.toLowerCase()}_${path.replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`.slice(0, 80) || method.toLowerCase();
}

function baseUrlOf(doc) {
  if (Array.isArray(doc.servers) && doc.servers[0]?.url) {
    let url = String(doc.servers[0].url);
    const vars = doc.servers[0].variables || {};
    url = url.replace(/\{([^}]+)\}/g, (m, name) => (vars[name]?.default != null ? String(vars[name].default) : m));
    return url;
  }
  if (doc.swagger && doc.host) {
    const scheme = Array.isArray(doc.schemes) && doc.schemes.includes('https') ? 'https' : (doc.schemes?.[0] || 'https');
    return `${scheme}://${doc.host}${doc.basePath || ''}`;
  }
  return null;
}

/** The auth the spec declares, as a suggestion for the connect form. */
function suggestedAuth(doc) {
  const schemes = doc.components?.securitySchemes || doc.securityDefinitions || {};
  for (const raw of Object.values(schemes)) {
    const s = resolveRef(doc, raw);
    if (!s || typeof s !== 'object') continue;
    if (s.type === 'apiKey' && ['header', 'query'].includes(s.in)) return { type: 'api_key', in: s.in, name: s.name };
    if (s.type === 'http' && /^bearer$/i.test(s.scheme || '')) return { type: 'bearer' };
    if ((s.type === 'http' && /^basic$/i.test(s.scheme || '')) || s.type === 'basic') return { type: 'basic' };
    if (s.type === 'oauth2') {
      const f = s.flows || {};
      if (f.authorizationCode) return { type: 'oauth2_authorization_code', authorizeUrl: f.authorizationCode.authorizationUrl, tokenUrl: f.authorizationCode.tokenUrl, scopes: Object.keys(f.authorizationCode.scopes || {}).slice(0, 20) };
      if (f.clientCredentials) return { type: 'oauth2_client_credentials', tokenUrl: f.clientCredentials.tokenUrl, scopes: Object.keys(f.clientCredentials.scopes || {}).slice(0, 20) };
      if (s.flow === 'accessCode') return { type: 'oauth2_authorization_code', authorizeUrl: s.authorizationUrl, tokenUrl: s.tokenUrl, scopes: Object.keys(s.scopes || {}).slice(0, 20) };
      if (s.flow === 'application') return { type: 'oauth2_client_credentials', tokenUrl: s.tokenUrl, scopes: Object.keys(s.scopes || {}).slice(0, 20) };
    }
  }
  return { type: 'none' };
}

/**
 * Parses a spec. Returns { title, version, format, baseUrl, auth, operations,
 * skipped, totalOperations }.
 */
function importSpec(input, { readOnly = false } = {}) {
  const doc = parseDocument(input);
  if (!doc || typeof doc !== 'object') throw badRequest('The document is empty.');
  const format = doc.openapi ? `OpenAPI ${String(doc.openapi).slice(0, 10)}` : doc.swagger ? `Swagger ${String(doc.swagger).slice(0, 10)}` : null;
  if (!format) throw badRequest('This is not an OpenAPI 3 or Swagger 2 document (no "openapi" or "swagger" field).');
  if (!doc.paths || typeof doc.paths !== 'object') throw badRequest('The document has no paths.');

  const operations = [];
  const skipped = [];
  const ids = new Set();
  let total = 0;
  for (const [path, rawItem] of Object.entries(doc.paths)) {
    const item = resolveRef(doc, rawItem) || {};
    if (!String(path).startsWith('/')) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method];
      if (!op || typeof op !== 'object') continue;
      total += 1;
      const upper = method.toUpperCase();
      const risk = riskOf(upper);
      if (readOnly && risk !== 'read') { skipped.push({ method: upper, path, reason: 'read-only import' }); continue; }
      if (operations.length >= MAX_OPERATIONS) { skipped.push({ method: upper, path, reason: `more than ${MAX_OPERATIONS} operations` }); continue; }
      let id = OP_ID.test(String(op.operationId || '')) ? String(op.operationId) : slug(upper, path);
      while (ids.has(id)) id = `${id}_${ids.size}`.slice(0, 80);
      ids.add(id);
      const params = [];
      const byKey = new Map();
      for (const raw of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const p = resolveRef(doc, raw);
        if (!p || !p.name || !['path', 'query', 'header'].includes(p.in)) continue;
        if (p.in === 'header' && /^(authorization|cookie|host|content-length|content-type|accept)$/i.test(p.name)) continue;
        byKey.set(`${p.in}:${p.name}`, {
          name: String(p.name).slice(0, 80), in: p.in, required: p.in === 'path' ? true : !!p.required,
          type: (p.schema ? resolveRef(doc, p.schema)?.type : p.type) || 'string',
          description: p.description ? String(p.description).slice(0, 200) : undefined,
        });
      }
      params.push(...byKey.values());
      let body = null;
      const rb = resolveRef(doc, op.requestBody);
      if (rb && rb.content) {
        const json = rb.content['application/json'] || Object.entries(rb.content).find(([k]) => /json/i.test(k))?.[1];
        body = { required: !!rb.required, schema: json ? trimSchema(doc, json.schema) : {}, jsonOnly: !!json };
      } else if (Array.isArray(op.parameters)) {
        const b = op.parameters.map((x) => resolveRef(doc, x)).find((x) => x && x.in === 'body');
        if (b) body = { required: !!b.required, schema: trimSchema(doc, b.schema), jsonOnly: true };
      }
      operations.push({
        id, method: upper, path: String(path).slice(0, 300),
        summary: String(op.summary || op.description || `${upper} ${path}`).replace(/\s+/g, ' ').slice(0, 200),
        risk, parameters: params.slice(0, 30), body,
      });
    }
  }
  if (!operations.length) throw badRequest(readOnly ? 'The document has no read (GET) operations.' : 'The document has no operations.');
  return {
    title: String(doc.info?.title || 'Imported API').slice(0, 80),
    version: doc.info?.version ? String(doc.info.version).slice(0, 40) : null,
    format, baseUrl: baseUrlOf(doc), auth: suggestedAuth(doc), operations, skipped: skipped.slice(0, 50), totalOperations: total,
  };
}

module.exports = { importSpec, riskOf, parseDocument, MAX_OPERATIONS, OP_ID };
