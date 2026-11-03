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
