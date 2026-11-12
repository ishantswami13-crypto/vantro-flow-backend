// Model cost (lib/platform/cost.js): prices are validated, cost is computed
// only when every model with tokens has a price, and anything unknown is
// reported as not measured with the reason, never estimated.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizePrices, costOf } = require('../lib/platform/cost.js');

let pass = 0; let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name, detail !== undefined ? `— ${JSON.stringify(detail)}` : ''); }
};
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

const prices = normalizePrices({ currency: 'usd', models: { 'anthropic/claude-x': { input: 3, output: 15 }, 'groq/llama-3.3-70b': { input: '0.59', output: 0.79 } } });
check('currency upper-cased and numbers parsed', prices.currency === 'USD' && prices.models['groq/llama-3.3-70b'].input === 0.59, prices);
check('null clears the list', Object.keys(normalizePrices(null).models).length === 0);
check('unknown currency refused', throws(() => normalizePrices({ currency: 'XYZ', models: {} }))?.status === 400);
check('negative price refused', throws(() => normalizePrices({ models: { 'a/b': { input: -1, output: 1 } } }))?.status === 400);
check('missing price refused', throws(() => normalizePrices({ models: { 'a/b': { input: 1 } } }))?.status === 400);
check('name without provider refused', throws(() => normalizePrices({ models: { gpt: { input: 1, output: 1 } } }))?.status === 400);

const c = costOf({ 'anthropic/claude-x': { calls: 2, input: 1_000_000, output: 200_000 }, 'groq/llama-3.3-70b': { calls: 1, input: 500_000, output: 0 } }, prices);
check('cost adds each model at its own price', c.available === true && c.value === 3 + 3 + 0.295 && c.currency === 'USD', c);
check('breakdown per model', c.byModel.length === 2 && c.byModel[0].model === 'anthropic/claude-x' && c.byModel[0].cost === 6, c.byModel);

const partial = costOf({ 'anthropic/claude-x': { input: 10, output: 10 }, 'openai/other': { input: 5, output: 5 } }, prices);
check('one unpriced model makes the total not measured', partial.available === false && partial.unpriced[0] === 'openai/other' && partial.value === undefined, partial);
check('priced models still show their own cost', partial.byModel.find((m) => m.model === 'anthropic/claude-x').cost > 0);
check('tokens without a model make the total not measured', costOf({ 'anthropic/claude-x': { input: 1, output: 1 } }, prices, { untrackedTokens: 500 }).available === false);
check('no usage is not a zero cost', costOf({}, prices).available === false);
check('no prices at all is not measured', costOf({ 'a/b': { input: 1, output: 1 } }, undefined).available === false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
