'use strict';
// Model picker: the router honours a picked model, refuses unknown or
// unconfigured ones, and fails over (saying who answered) when the pick errors.
const test = require('node:test');
const assert = require('node:assert');
const { createModelRouter, ModelUnavailableError } = require('../lib/ai/modelRouter');
const { MODELS, findModel } = require('../lib/ai/modelCatalog');

const ok = (name) => async (_m, _t, _c, override) => ({ message: { content: name }, finish_reason: 'stop', model: override || `${name}-default` });
const env = { GROQ_API_KEY: 'gsk_real', GEMINI_API_KEY: 'AIza_real' };
const log = { warn() {} };

test('catalog ids are unique and auto is first', () => {
  assert.strictEqual(MODELS[0].id, 'auto');
  assert.strictEqual(new Set(MODELS.map((m) => m.id)).size, MODELS.length);
  assert.strictEqual(findModel(''), MODELS[0]);
  assert.strictEqual(findModel('nope'), null);
});

test('health marks only configured providers as available', () => {
  const r = createModelRouter({ providers: { groq: ok('groq'), gemini: ok('gemini'), anthropic: ok('anthropic') }, env, log });
  const byId = Object.fromEntries(r.health().models.map((m) => [m.id, m.available]));
  assert.strictEqual(byId.auto, true);
  assert.strictEqual(byId['gpt-oss-120b'], true);
  assert.strictEqual(byId['gemini-3.6-flash'], true);
  assert.strictEqual(byId['claude-opus-5-5'], false);
});

test('a picked model goes first with its provider model name', async () => {
  const r = createModelRouter({ providers: { groq: ok('groq'), gemini: ok('gemini') }, env, log });
  const s = r.session({ userId: null, model: 'gemini-3.6-flash' });
  await s.chat([], []);
  assert.deepStrictEqual(s.model, { provider: 'gemini', model: 'gemini-3.6-flash', picked: 'gemini-3.6-flash' });
  assert.strictEqual(s.requested, 'gemini-3.6-flash');
});

test('auto keeps the default order', async () => {
  const r = createModelRouter({ providers: { groq: ok('groq'), gemini: ok('gemini') }, env, log });
  const s = r.session({ userId: null });
  await s.chat([], []);
  assert.strictEqual(s.model.provider, 'groq');
  assert.strictEqual(s.model.picked, null);
});

test('unknown model is refused before any call', () => {
  const r = createModelRouter({ providers: { groq: ok('groq') }, env, log });
  assert.throws(() => r.session({ userId: null, model: 'gpt-9' }), (e) => e instanceof ModelUnavailableError && e.code === 'UNKNOWN_MODEL');
});

test('a model whose provider has no key is refused', async () => {
  const r = createModelRouter({ providers: { groq: ok('groq'), anthropic: ok('anthropic') }, env, log });
  const s = r.session({ userId: null, model: 'claude-opus-5-5' });
  await assert.rejects(s.chat([], []), (e) => e.code === 'MODEL_NOT_CONFIGURED');
});

test('if the pick fails, another model answers and says so', async () => {
  const boom = async () => { throw new Error('503 busy'); };
  const r = createModelRouter({ providers: { groq: ok('groq'), gemini: boom }, env, log });
  const s = r.session({ userId: null, model: 'gemini-3.6-flash' });
  await s.chat([], []);
  assert.strictEqual(s.model.provider, 'groq');
  assert.strictEqual(s.model.picked, null);
  assert.strictEqual(s.requested, 'gemini-3.6-flash');
});

// Responses API providers (OpenAI, xAI, Perplexity): wire shapes round-trip.
const { makeResponsesChat, toResponsesInput } = require('../lib/ai/responsesChat');

test('chat transcript becomes Responses input items', () => {
  const input = toResponsesInput([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'who owes me?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_overdue', arguments: '{"limit":5}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"untrusted_data":[]}' },
  ]);
  assert.deepStrictEqual(input, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'who owes me?' },
    { type: 'function_call', call_id: 'call_1', name: 'list_overdue', arguments: '{"limit":5}' },
    { type: 'function_call_output', call_id: 'call_1', output: '{"untrusted_data":[]}' },
  ]);
});

test('Responses provider sends tools and maps calls and text back', async () => {
  const sent = [];
  const replies = [
    { model: 'grok-4.7', output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'list_overdue', arguments: '{}' }], usage: { input_tokens: 12, output_tokens: 3 } },
    { model: 'grok-4.7', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Mehta owes 2 lakh.' }] }], usage: { input_tokens: 20, output_tokens: 6 } },
  ];
  const fetchImpl = async (url, init) => { sent.push({ url, init, body: JSON.parse(init.body) }); return { ok: true, json: async () => replies.shift() }; };
  const chat = makeResponsesChat('xai', { fetchImpl, env: { XAI_API_KEY: 'xai-test' } });
  const tools = [{ type: 'function', function: { name: 'list_overdue', description: 'd', parameters: { type: 'object', properties: {} } } }];
  const first = await chat([{ role: 'user', content: 'q' }], tools);
  assert.strictEqual(sent[0].url, 'https://api.x.ai/v1/responses');
  assert.strictEqual(sent[0].init.headers.Authorization, 'Bearer xai-test');
  assert.deepStrictEqual(sent[0].body.tools, [{ type: 'function', name: 'list_overdue', description: 'd', parameters: { type: 'object', properties: {} } }]);
  assert.strictEqual(sent[0].body.store, false);
  assert.strictEqual(first.finish_reason, 'tool_calls');
  assert.strictEqual(first.message.tool_calls[0].id, 'call_9');
  const second = await chat([{ role: 'user', content: 'q' }, first.message, { role: 'tool', tool_call_id: 'call_9', content: '[]' }], tools, 'auto', 'grok-4.7');
  assert.strictEqual(sent[1].body.input[2].type, 'function_call_output');
  assert.deepStrictEqual(second, { message: { role: 'assistant', content: 'Mehta owes 2 lakh.' }, finish_reason: 'stop', usage: { input: 20, output: 6 }, model: 'grok-4.7' });
});

test('a provider error is thrown so the router can fail over', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }) });
  const chat = makeResponsesChat('openai', { fetchImpl, env: { OPENAI_API_KEY: 'k' } });
  await assert.rejects(chat([{ role: 'user', content: 'q' }], []), /openai 401: bad key/);
});
