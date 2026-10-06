'use strict';
// Anthropic provider for the Ask Starlane chat loop. Speaks the same contract
// as groqChat/geminiChat in server.js: OpenAI-style messages and function
// tools in, one OpenAI-style "choice" out:
//   { message: { role: 'assistant', content, tool_calls? }, finish_reason, usage }
// All Anthropic wire-format translation lives here.

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

function toAnthropicTools(tools) {
  return (tools || []).map((t) => ({
    name: t.function.name,
    description: t.function.description || '',
    input_schema: t.function.parameters || { type: 'object', properties: {} },
  }));
}

function toAnthropicMessages(messages) {
  const system = [];
  const out = [];
  const push = (role, blocks) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const m of messages) {
    if (m.role === 'system') { if (m.content) system.push(m.content); continue; }
    if (m.role === 'user') { push('user', [{ type: 'text', text: String(m.content || '') }]); continue; }
    if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: String(m.content) });
      for (const tc of m.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = {}; }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      if (blocks.length) push('assistant', blocks);
      continue;
    }
    if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content || '') }]);
    }
  }
  return { system: system.join('\n\n'), messages: out };
}

function fromAnthropicResponse(resp) {
  const blocks = resp.content || [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const toolUses = blocks.filter((b) => b.type === 'tool_use');
  const usage = { input: resp.usage?.input_tokens || 0, output: resp.usage?.output_tokens || 0 };
  if (toolUses.length) {
    return {
      message: {
        role: 'assistant',
        content: text || null,
        tool_calls: toolUses.map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } })),
      },
      finish_reason: 'tool_calls',
      usage,
      model: resp.model,
    };
  }
  return { message: { role: 'assistant', content: text }, finish_reason: 'stop', usage, model: resp.model };
}

function makeAnthropicChat({ client, model } = {}) {
  return async function anthropicChat(messages, tools, toolChoice = 'auto') {
    let api = client;
    if (!api) {
      const Anthropic = require('@anthropic-ai/sdk');
      api = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    const { system, messages: msgs } = toAnthropicMessages(messages);
    const body = {
      model: model || process.env.ANTHROPIC_CHAT_MODEL || DEFAULT_MODEL,
      max_tokens: 1500,
      temperature: 0.2,
      messages: msgs,
    };
    if (system) body.system = system;
    const anthropicTools = toAnthropicTools(tools);
    if (anthropicTools.length && toolChoice !== 'none') {
      body.tools = anthropicTools;
      body.tool_choice = toolChoice === 'required' ? { type: 'any' } : { type: 'auto' };
    }
    return fromAnthropicResponse(await api.messages.create(body));
  };
}

module.exports = { makeAnthropicChat, toAnthropicMessages, toAnthropicTools, fromAnthropicResponse, DEFAULT_MODEL };
