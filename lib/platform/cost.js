'use strict';
// Model cost. Starlane records tokens per model on every run; it does not
// know what a provider charges this organization (prices change, and
// contracts and credits differ), so it never guesses one. An admin enters
// the price per million tokens for each model the organization uses, in one
// currency. Cost is shown only when every model a figure covers has a
// price; otherwise the answer is { available: false } with the reason.

const { badRequest } = require('./errors');

const CURRENCIES = ['USD', 'INR', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD', 'JPY'];
const MODEL_KEY = /^[a-z0-9_-]{1,40}\/[A-Za-z0-9_.:@/-]{1,120}$/;
const MAX_MODELS = 50;
const MAX_PRICE = 100000; // per million tokens, in the chosen currency

const EMPTY = Object.freeze({ currency: 'USD', models: {} });

/** Validate an admin's price list. Returns { currency, models: { 'provider/model': { input, output } } }. */
function normalizePrices(input) {
  if (input == null) return { ...EMPTY, models: {} };
  if (typeof input !== 'object' || Array.isArray(input)) throw badRequest('modelPrices must be an object with currency and models');
  const currency = String(input.currency || 'USD').toUpperCase();
  if (!CURRENCIES.includes(currency)) throw badRequest(`currency must be one of ${CURRENCIES.join(', ')}`);
  const raw = input.models || {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('models must map "provider/model" to its prices');
  const entries = Object.entries(raw);
  if (entries.length > MAX_MODELS) throw badRequest(`Up to ${MAX_MODELS} model prices can be set`);
  const models = {};
  for (const [key, p] of entries) {
    if (!MODEL_KEY.test(key)) throw badRequest(`"${String(key).slice(0, 60)}" is not a model name in the form provider/model`);
    const input = Number(p?.input);
    const output = Number(p?.output);
    for (const [label, v] of [['input', input], ['output', output]]) {
      if (!Number.isFinite(v) || v < 0 || v > MAX_PRICE) throw badRequest(`The ${label} price for ${key} must be a number from 0 to ${MAX_PRICE} per million tokens`);
    }
    models[key] = { input, output };
  }
  return { currency, models };
}

const round = (v) => Math.round(v * 1e6) / 1e6;

/**
 * Cost of token usage per model.
 * @param {Record<string,{calls?:number,input?:number,output?:number}>} usage
 * @param {{currency:string, models:Record<string,{input:number,output:number}>}} prices
 * @param {{untrackedTokens?: number}} [opts] tokens recorded without a model (older runs)
 */
function costOf(usage, prices, { untrackedTokens = 0 } = {}) {
  const p = prices && prices.models ? prices : EMPTY;
  const byModel = [];
  const unpriced = [];
  let total = 0;
  for (const [model, u] of Object.entries(usage || {})) {
    const input = Number(u?.input) || 0;
    const output = Number(u?.output) || 0;
    const price = p.models[model];
    const cost = price ? round((input * price.input + output * price.output) / 1e6) : null;
    if (price) total += cost; else if (input + output > 0) unpriced.push(model);
    byModel.push({ model, calls: Number(u?.calls) || 0, inputTokens: input, outputTokens: output, price: price || null, cost });
  }
  byModel.sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
  let summary;
  if (untrackedTokens > 0) {
    summary = { available: false, reason: `${untrackedTokens.toLocaleString('en-US')} tokens were recorded before Starlane tracked which model used them, so their cost is unknown.` };
  } else if (unpriced.length) {
    summary = { available: false, reason: `No price is set for ${unpriced.join(', ')}. An admin can add it in Agent policies.`, unpriced };
  } else if (!byModel.length) {
    summary = { available: false, reason: 'No model was used.' };
  } else {
    summary = { available: true, value: round(total), currency: p.currency };
  }
  return { ...summary, currency: p.currency, byModel };
}

module.exports = { normalizePrices, costOf, CURRENCIES, EMPTY };
