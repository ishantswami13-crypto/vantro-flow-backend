'use strict';
// A minimal Model Context Protocol client over Streamable HTTP, enough to
// connect a remote MCP server as a Starlane connection:
//   initialize  -> notifications/initialized -> tools/list | tools/call
//
// Each use opens a fresh session (initialize first) and does not keep it, so
// nothing long-lived holds a server's session id. Responses may be plain JSON
// or a text/event-stream; both are read. Requests go through safeHttp (https
// only, no private addresses, no redirects, size and time limits).
//
// Every MCP tool is treated as `external`: Starlane cannot know what a remote
// tool does, so an agent's call always waits for a person's approval. The
// server's own readOnlyHint is shown, never trusted to skip approval.

const { safeRequest } = require('../../connectors/safeHttp');
const { badRequest, PlatformError } = require('../errors');

const PROTOCOL_VERSION = '2025-06-18';
const MAX_TOOLS = 200;

function parseBody(res) {
  if (res.json) return res.json;
  const text = String(res.body || '');
  if (/text\/event-stream/i.test(String(res.headers?.['content-type'] || '')) || text.startsWith('event:') || text.startsWith('data:')) {
    // The last JSON-RPC message carried in a data: line is the response.
    let last = null;
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      try { const msg = JSON.parse(data); if (msg && (msg.result !== undefined || msg.error !== undefined)) last = msg; } catch { /* not JSON */ }
    }
    return last;
  }
  try { return JSON.parse(text); } catch { return null; }
}

function mcpError(message) {
  return new PlatformError(502, 'MCP_ERROR', message);
}

class McpSession {
  constructor(url, { headers = {}, http = {} } = {}) {
    this.url = url;
    this.headers = headers;
    this.http = http;
    this.sessionId = null;
    this.nextId = 1;
  }

  async send(method, params, { notification = false } = {}) {
    const msg = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
    if (!notification) msg.id = this.nextId++;
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      ...this.headers,
      ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
    };
    const res = await safeRequest(this.url, { method: 'POST', headers, body: JSON.stringify(msg), ...this.http });
    if (res.headers?.['mcp-session-id']) this.sessionId = String(res.headers['mcp-session-id']).slice(0, 200);
    if (notification) return null;
    if (res.status === 401 || res.status === 403) throw mcpError(`The MCP server refused the credentials (HTTP ${res.status}).`);
    if (res.status >= 400) throw mcpError(`The MCP server answered HTTP ${res.status}.`);
    const body = parseBody(res);
    if (!body) throw mcpError('The MCP server sent a response Starlane could not read.');
    if (body.error) throw mcpError(`The MCP server returned an error: ${String(body.error.message || body.error.code).slice(0, 200)}`);
    return body.result;
  }

  async initialize() {
    const result = await this.send('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'Starlane', version: '1.0' },
    });
    await this.send('notifications/initialized', undefined, { notification: true });
    return { serverName: result?.serverInfo?.name || null, serverVersion: result?.serverInfo?.version || null, protocolVersion: result?.protocolVersion || null };
  }

  async listTools() {
    const tools = [];
    let cursor;
    for (let page = 0; page < 5 && tools.length < MAX_TOOLS; page += 1) {
      const r = await this.send('tools/list', cursor ? { cursor } : {});
      for (const t of r?.tools || []) if (tools.length < MAX_TOOLS) tools.push(t);
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  callTool(name, args) {
    return this.send('tools/call', { name, arguments: args || {} });
  }
}

/** Connects, lists tools and returns them as connection operations. */
async function discover(url, { headers = {}, http = {} } = {}) {
  const s = new McpSession(url, { headers, http });
  const info = await s.initialize();
  const tools = await s.listTools();
  if (!tools.length) throw badRequest('The MCP server lists no tools.');
  const operations = tools
    .filter((t) => t && /^[A-Za-z0-9_.-]{1,80}$/.test(String(t.name || '')))
    .map((t) => ({
      id: String(t.name),
      method: 'MCP',
      path: null,
      summary: String(t.description || t.title || t.name).replace(/\s+/g, ' ').slice(0, 200),
      risk: 'external',
      readOnlyHint: t.annotations?.readOnlyHint === true,
      inputSchema: t.inputSchema && typeof t.inputSchema === 'object' && JSON.stringify(t.inputSchema).length <= 8000 ? t.inputSchema : {},
      parameters: [],
      body: null,
    }));
  return { info, operations };
}

async function callTool(url, name, args, { headers = {}, http = {} } = {}) {
  const s = new McpSession(url, { headers, http });
  await s.initialize();
  const result = await s.callTool(name, args);
  const text = Array.isArray(result?.content)
    ? result.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n').slice(0, 8000)
    : null;
  return { isError: result?.isError === true, text, structured: result?.structuredContent ?? null };
}

module.exports = { discover, callTool, McpSession, parseBody, PROTOCOL_VERSION };
