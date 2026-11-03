'use strict';
// The models a person can pick for Ask Starlane. Each one runs on a provider
// the router already speaks to (Groq, Gemini, Anthropic); a model is offered
// as available only when its provider's key is configured. The first model
// of each provider is the one the router uses when nobody picks.
//
// Ids are stable and public; `model` is the provider's own name for it.

const MODELS = [
  { id: 'auto',            provider: null,        model: null, label: 'Auto', note: 'Starlane picks the best available model and fails over if one is down.' },
  { id: 'gpt-oss-120b',    provider: 'groq',      model: null /* the Groq default */, label: 'GPT-OSS 120B', note: 'Fast, strong all-rounder (Groq).' },
  { id: 'qwen3.6-27b',     provider: 'groq',      model: 'qwen/qwen3.6-27b', label: 'Qwen 3.6 27B', note: 'Quick answers with good reasoning (Groq).' },
  { id: 'gpt-oss-20b',     provider: 'groq',      model: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', note: 'Fastest and cheapest, for simple questions (Groq).' },
  { id: 'gemini-flash-lite', provider: 'gemini',  model: null /* GEMINI_MODEL or gemini-3.1-flash-lite */, label: 'Gemini Flash Lite', note: 'Reliable and low cost (Google).' },
  { id: 'gemini-3.5-flash-lite', provider: 'gemini', model: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', note: 'Newer Flash Lite, still low cost (Google).' },
  { id: 'gemini-3.6-flash', provider: 'gemini',   model: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', note: 'Stronger reasoning (Google).' },
  { id: 'gemini-3.8-flash', provider: 'gemini',   model: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', note: 'Google\'s newest Flash model. Can be busy at peak times.' },
  { id: 'claude-haiku-4-5', provider: 'anthropic', model: null /* ANTHROPIC_CHAT_MODEL or the default */, label: 'Claude Haiku 4.5', note: 'Quick and careful (Anthropic).' },
  { id: 'claude-sonnet-4-6', provider: 'anthropic', model: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', note: 'Strong analysis (Anthropic).' },
  { id: 'claude-sonnet-5-5', provider: 'anthropic', model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Latest Sonnet, best balance of speed and depth (Anthropic).' },
  { id: 'claude-opus-5-5', provider: 'anthropic', model: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'Most capable, slower and costlier (Anthropic).' },
  { id: 'gpt-6-luna',      provider: 'openai',    model: null /* OPENAI_CHAT_MODEL or gpt-6-luna */, label: 'GPT-6 Luna', note: 'Quick and low cost (OpenAI).' },
  { id: 'gpt-6.1-sol',     provider: 'openai',    model: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', note: 'Near-Astra quality at a lower cost (OpenAI).' },
  { id: 'gpt-6-astra',     provider: 'openai',    model: 'gpt-6-astra', label: 'GPT-6 Astra', note: 'OpenAI\'s most capable model, slower and costlier.' },
  { id: 'grok-4.7',        provider: 'xai',       model: null /* XAI_CHAT_MODEL or grok-4.7 */, label: 'Grok 4.7', note: 'xAI\'s flagship model.' },
  { id: 'perplexity-sonar', provider: 'perplexity', model: null /* PERPLEXITY_CHAT_MODEL or perplexity/sonar */, label: 'Perplexity Sonar', note: 'Perplexity\'s grounded model.' },
];

function findModel(id) {
  if (id == null || id === '') return MODELS[0];
  return MODELS.find((m) => m.id === String(id)) || null;
}

module.exports = { MODELS, findModel };
