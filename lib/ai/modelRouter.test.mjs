// Model router: configured-only providers, failover, stickiness, budget,
// usage ledger, and the Anthropic wire translation.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createModelRouter, configuredProviders, ModelUnavailableError } = require('./modelRouter');
const { makeAnthropicChat, toAnthropicMessages } = require('./anthropicChat');

const quiet = { warn() {} };
const ok = (text, usage = { prompt_tokens: 10, completion_tokens: 5 }) => async () => ({ message: { role: 'assistant', content: text }, finish_reason: 'stop', usage });
const boom = (msg) => async () => { throw new Error(msg); };

// Only providers with a key count; the preferred one goes first; placeholders do not count.
assert.deepEqual(configuredProviders({ GROQ_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }), ['groq', 'anthropic']);
assert.deepEqual(configuredProviders({ GROQ_API_KEY: 'g', ANTHROPIC_API_KEY: 'a', SCAN_LLM_PROVIDER: 'anthropic' }), ['anthropic', 'groq']);
assert.deepEqual(configuredProviders({ GEMINI_API_KEY: 'your-gemini-key' }), []);

// No provider configured -> NO_PROVIDER, nothing called.
{
  const r = createModelRouter({ providers: { groq: ok('x') }, env: {}, log: quiet });
  await assert.rejects(r.session({}).chat([], []), (e) => e instanceof ModelUnavailableError && e.code === 'NO_PROVIDER');
}

// Failover to the next configured provider, then stay on it for the conversation.
{
  const calls = [];
  const providers = {
    groq: async (...a) => { calls.push('groq'); return boom('groq down')(...a); },
    anthropic: async (...a) => { calls.push('anthropic'); return ok('hi')(...a); },
  };
  const r = createModelRouter({ providers, env: { GROQ_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }, log: quiet });
  const s = r.session({});
  assert.equal((await s.chat([], [])).message.content, 'hi');
  await s.chat([], []);
  assert.deepEqual(calls, ['groq', 'anthropic', 'anthropic']);
  assert.equal(s.provider, 'anthropic');
}

// Every provider failing -> PROVIDERS_FAILED with each failure listed.
{
  const r = createModelRouter({ providers: { groq: boom('a'), gemini: boom('b') }, env: { GROQ_API_KEY: 'g', GEMINI_API_KEY: 'k' }, log: quiet });
  await assert.rejects(r.session({}).chat([], []), (e) => e.code === 'PROVIDERS_FAILED' && e.detail.failures.length === 2);
}

// Usage ledger and daily budget through a fake pool.
{
  const inserts = [];
  let used = 0;
  const pool = { async query(sql, params) {
    if (/SUM\(input_tokens/.test(sql)) return { rows: [{ used }] };
    if (/INSERT INTO ai_usage/.test(sql)) { inserts.push(params); return { rows: [] }; }
    throw new Error('unexpected ' + sql);
  } };
  const r = createModelRouter({ providers: { groq: ok('x') }, pool, env: { GROQ_API_KEY: 'g', AI_DAILY_TOKEN_BUDGET: '100' }, log: quiet });
  await r.session({ userId: 'u1', purpose: 'chat' }).chat([], []);
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0].slice(0, 6), ['u1', 'chat', 'groq', 'llama-3.3-70b-versatile', 10, 5]);
  used = 100;
  await assert.rejects(r.session({ userId: 'u1' }).chat([], []), (e) => e.code === 'BUDGET_EXCEEDED');
}

// Missing ledger table (migration not applied) is tolerated.
{
  const pool = { async query() { const e = new Error('relation "ai_usage" does not exist'); e.code = '42P01'; throw e; } };
  const r = createModelRouter({ providers: { groq: ok('x') }, pool, env: { GROQ_API_KEY: 'g' }, log: quiet });
  assert.equal((await r.session({ userId: 'u1' }).chat([], [])).message.content, 'x');
}

// Anthropic translation: system, tool calls and tool results round-trip.
{
  const { system, messages } = toAnthropicMessages([
    { role: 'system', content: 'S' },
    { role: 'user', content: 'who owes most?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_overdue', arguments: '{"min_days":30}' } }] },
    { role: 'tool', tool_call_id: 't1', content: '{"rows":[]}' },
  ]);
  assert.equal(system, 'S');
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.deepEqual(messages[1].content[0], { type: 'tool_use', id: 't1', name: 'get_overdue', input: { min_days: 30 } });
  assert.equal(messages[2].content[0].type, 'tool_result');

  let sent;
  const client = { messages: { async create(body) { sent = body; return { model: 'm', usage: { input_tokens: 3, output_tokens: 4 }, stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'get_summary', input: {} }] }; } } };
  const choice = await makeAnthropicChat({ client, model: 'm' })([{ role: 'user', content: 'hi' }], [{ type: 'function', function: { name: 'get_summary', description: 'd', parameters: { type: 'object', properties: {} } } }]);
  assert.equal(sent.tools[0].name, 'get_summary');
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.equal(choice.message.tool_calls[0].function.name, 'get_summary');
  assert.deepEqual(choice.usage, { input: 3, output: 4 });
}

console.log('PASS model router');
