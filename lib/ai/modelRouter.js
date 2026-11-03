'use strict';
// Model router for Ask Starlane. Picks among the model providers that are
// actually configured (a key is set), fails over when one errors, records
// every call (provider, model, tokens, latency, tenant, purpose) in
// ai_usage, and enforces a per-tenant daily token budget.
//
// The agent or feature asking stays independent of the model: callers say
// what they need (`purpose`), the router decides who answers.
//
// Order: the provider named by SCAN_LLM_PROVIDER first (the existing switch),
// then the remaining configured providers in DEFAULT_ORDER. A conversation is
// sticky: once a provider answers, the rest of that conversation's tool loop
// stays on it, because tool-call ids and Gemini thought signatures do not
// survive a switch.

const { MODELS, findModel } = require('./modelCatalog');

const DEFAULT_ORDER = ['groq', 'gemini', 'anthropic'];
const KEY_ENV = { groq: 'GROQ_API_KEY', gemini: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };
const MODEL_LABEL = {
  groq: () => (env => (env.GROQ_MODEL || '').trim() || 'openai/gpt-oss-120b')(process.env),
  gemini: () => process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
  anthropic: () => process.env.ANTHROPIC_CHAT_MODEL || require('./anthropicChat').DEFAULT_MODEL,
};

class ModelUnavailableError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ModelUnavailableError';
    this.code = code;
    this.detail = detail;
  }
}

const usable = (v) => typeof v === 'string' && v.trim().length > 0 && !/your[-_]|placeholder|example/i.test(v);

function configuredProviders(env = process.env) {
  const preferred = String(env.SCAN_LLM_PROVIDER || '').trim().toLowerCase();
  const order = [...new Set([preferred, ...DEFAULT_ORDER].filter((p) => KEY_ENV[p]))];
  return order.filter((p) => usable(env[KEY_ENV[p]]));
}

// Tokens used today by this tenant, or null when the ledger table is absent
// (migration 065 not applied yet): budget is then not enforceable and the
// router says so in health() rather than pretending.
async function tokensToday(pool, userId) {
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS used
         FROM ai_usage WHERE user_id = $1 AND created_at >= date_trunc('day', now())`,
      [userId],
    );
    return Number(rows[0].used);
  } catch (err) {
    if (err.code === '42P01') return null;
    throw err;
  }
}

async function record(pool, row) {
  try {
    await pool.query(
      `INSERT INTO ai_usage (user_id, purpose, provider, model, input_tokens, output_tokens, latency_ms, ok, error, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [row.userId, row.purpose, row.provider, row.model, row.input || 0, row.output || 0, row.latencyMs, row.ok, row.error ? String(row.error).slice(0, 300) : null, row.correlationId || null],
    );
  } catch (err) {
    if (err.code !== '42P01') console.warn('[modelRouter] usage not recorded:', err.message);
  }
}

function normalizeUsage(choice) {
  const u = choice?.usage || {};
  return { input: u.input ?? u.prompt_tokens ?? u.promptTokenCount ?? 0, output: u.output ?? u.completion_tokens ?? u.candidatesTokenCount ?? 0 };
}

function createModelRouter({ providers, pool, env = process.env, log = console }) {
  const dailyBudget = () => Number(env.AI_DAILY_TOKEN_BUDGET || 300000);

  function health() {
    const configured = configuredProviders(env).filter((p) => providers[p]);
    return {
      configured,
      preferred: configured[0] || null,
      providers: DEFAULT_ORDER.map((p) => ({ provider: p, configured: configured.includes(p), model: configured.includes(p) ? MODEL_LABEL[p]() : null })),
      // What a person can pick. A model is available only when its provider
      // has a key; Auto is available when any provider does.
      models: MODELS.map((m) => ({
        id: m.id, label: m.label, note: m.note, provider: m.provider,
        available: m.provider ? configured.includes(m.provider) : configured.length > 0,
      })),
      dailyTokenBudget: dailyBudget(),
    };
  }

  // One conversation (one /api/ai-chat request with its tool loop).
  // `model` is a catalog id the person picked ('auto' or absent = router's
  // choice). A picked model goes first; if it fails, the others still answer
  // (the response says which model did), so a busy model never leaves the
  // person without an answer.
  function session({ userId, purpose = 'chat', correlationId = null, model = null }) {
    let sticky = null;
    let budgetChecked = false;
    const picked = findModel(model);
    if (!picked) throw new ModelUnavailableError('UNKNOWN_MODEL', `There is no model called "${model}".`);
    let answeredBy = null;
    return {
      get provider() { return sticky; },
      get model() { return answeredBy; },
      get requested() { return picked.id; },
      async chat(messages, tools, toolChoice = 'auto') {
        let order = sticky ? [sticky] : configuredProviders(env).filter((p) => providers[p]);
        if (!sticky && picked.provider) {
          if (!order.includes(picked.provider)) {
            throw new ModelUnavailableError('MODEL_NOT_CONFIGURED', `${picked.label} is not set up for this workspace.`, { model: picked.id });
          }
          order = [picked.provider, ...order.filter((p) => p !== picked.provider)];
        }
        if (!order.length) {
          throw new ModelUnavailableError('NO_PROVIDER', 'No AI model is configured for Ask Starlane.');
        }
        if (!budgetChecked && pool && userId) {
          budgetChecked = true;
          const used = await tokensToday(pool, userId);
          if (used != null && used >= dailyBudget()) {
            throw new ModelUnavailableError('BUDGET_EXCEEDED', 'Today\'s AI budget for this company is used up.', { used, budget: dailyBudget() });
          }
        }
        const failures = [];
        for (const provider of order) {
          const started = Date.now();
          try {
            const override = picked.provider === provider ? picked.model : null;
            const choice = override
              ? await providers[provider](messages, tools, toolChoice, override)
              : await providers[provider](messages, tools, toolChoice);
            const usage = normalizeUsage(choice);
            const usedModel = choice.model || override || MODEL_LABEL[provider]();
            if (pool && userId) await record(pool, { userId, purpose, provider, model: usedModel, ...usage, latencyMs: Date.now() - started, ok: true, correlationId });
            sticky = provider;
            answeredBy = { provider, model: usedModel, picked: picked.provider === provider ? picked.id : null };
            return choice;
          } catch (err) {
            const message = String(err?.message || err).slice(0, 200);
            failures.push({ provider, error: message });
            log.warn?.(`[modelRouter] ${provider} failed: ${message}`);
            if (pool && userId) await record(pool, { userId, purpose, provider, model: (picked.provider === provider && picked.model) || MODEL_LABEL[provider](), latencyMs: Date.now() - started, ok: false, error: message, correlationId });
            if (sticky) break;
          }
        }
        throw new ModelUnavailableError('PROVIDERS_FAILED', 'Ask Starlane could not reach its AI model.', { failures });
      },
    };
  }

  return { session, health };
}

module.exports = { createModelRouter, configuredProviders, ModelUnavailableError, DEFAULT_ORDER, KEY_ENV };
