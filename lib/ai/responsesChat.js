'use strict';
// Providers that speak the Responses API (POST {base}/responses): OpenAI,
// xAI (Grok) and Perplexity's Agent API all document function tools on it
// with the same shapes:
//   tool:    { type: 'function', name, description, parameters }
//   call:    output item { type: 'function_call', call_id, name, arguments }
//   result:  input item  { type: 'function_call_output', call_id, output }
// Same contract as groqChat/geminiChat/anthropicChat: OpenAI chat-style
// messages and tools in, one chat-style "choice" out. Each call sends the
// whole transcript (store: false), so nothing is kept at the provider and
// the router can fail over mid-conversation.

const PROVIDERS = {
  openai:     { base: 'https://api.openai.com/v1',     keyEnv: 'OPENAI_API_KEY',     modelEnv: 'OPENAI_CHAT_MODEL',     model: 'gpt-6-luna' },
  xai:        { base: 'https://api.x.ai/v1',           keyEnv: 'XAI_API_KEY',        modelEnv: 'XAI_CHAT_MODEL',        model: 'grok-4.7' },
  perplexity: { base: 'https://api.perplexity.ai/v1',  keyEnv: 'PERPLEXITY_API_KEY', modelEnv: 'PERPLEXITY_CHAT_MODEL', model: 'perplexity/sonar' },
};

function toResponsesTools(tools) {
  return (tools || []).map((t) => ({
    type: 'function',
    name: t.function.name,
    description: t.function.description || '',
    parameters: t.function.parameters || { type: 'object', properties: {} },
  }));
}

function toResponsesInput(messages) {
  const input = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'user') {
      if (m.content) input.push({ role: m.role, content: String(m.content) });
    } else if (m.role === 'assistant') {
      if (m.content) input.push({ role: 'assistant', content: String(m.content) });
      for (const tc of m.tool_calls || []) {
        input.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}' });
      }
    } else if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: String(m.content || '') });
    }
  }
  return input;
}

function fromResponses(resp) {
  const items = Array.isArray(resp.output) ? resp.output : [];
  const text = items
    .filter((i) => i.type === 'message')
    .flatMap((i) => (Array.isArray(i.content) ? i.content : []))
    .filter((c) => c.type === 'output_text' && c.text)
    .map((c) => c.text)
    .join('\n')
    .trim() || (typeof resp.output_text === 'string' ? resp.output_text.trim() : '');
  const calls = items.filter((i) => i.type === 'function_call');
  const usage = { input: resp.usage?.input_tokens || 0, output: resp.usage?.output_tokens || 0 };
  if (calls.length) {
    return {
      message: {
        role: 'assistant',
        content: text || null,
        tool_calls: calls.map((c) => ({ id: c.call_id || c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })),
      },
      finish_reason: 'tool_calls',
      usage,
      model: resp.model,
    };
  }
  return { message: { role: 'assistant', content: text }, finish_reason: 'stop', usage, model: resp.model };
}

function makeResponsesChat(provider, { fetchImpl = (...a) => fetch(...a), env = process.env } = {}) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown Responses provider: ${provider}`);
  return async function responsesChat(messages, tools, toolChoice = 'auto', modelOverride = null) {
    const body = {
      model: modelOverride || (env[cfg.modelEnv] || '').trim() || cfg.model,
      input: toResponsesInput(messages),
      // Reasoning models spend part of this on thinking; the visible answer is short.
      max_output_tokens: 4000,
      store: false,
    };
    const rTools = toResponsesTools(tools);
    if (rTools.length && toolChoice !== 'none') {
      body.tools = rTools;
      body.tool_choice = toolChoice === 'required' ? 'required' : 'auto';
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Number(env.RESPONSES_TIMEOUT_MS || 60000));
    try {
      const res = await fetchImpl(`${cfg.base}/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env[cfg.keyEnv]}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data?.error?.message || data?.message || `HTTP ${res.status}`;
        throw new Error(`${provider} ${res.status}: ${String(msg).slice(0, 160)}`);
      }
      return fromResponses(data);
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = { makeResponsesChat, toResponsesInput, toResponsesTools, fromResponses, RESPONSES_PROVIDERS: PROVIDERS };
