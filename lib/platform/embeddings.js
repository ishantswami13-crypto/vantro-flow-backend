'use strict';
// Embeddings for meaning-based Knowledge search. Off unless
// FEATURE_KNOWLEDGE_EMBEDDINGS_ENABLED=true and a provider key is set,
// because indexing sends passage text to that provider. When off or
// failing, search falls back to word search and says so; nothing is faked.

const PROVIDERS = {
  openai: {
    keyEnv: 'OPENAI_API_KEY', modelEnv: 'OPENAI_EMBEDDING_MODEL', model: 'text-embedding-3-small',
    async embed(texts, { key, model, fetchImpl }) {
      const r = await fetchImpl('https://api.openai.com/v1/embeddings', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, input: texts }), signal: AbortSignal.timeout(20000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !Array.isArray(j.data)) throw new Error(`OpenAI embeddings ${r.status}: ${j.error?.message || 'unexpected answer'}`);
      return j.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    },
  },
  gemini: {
    keyEnv: 'GEMINI_API_KEY', modelEnv: 'GEMINI_EMBEDDING_MODEL', model: 'gemini-embedding-001',
    async embed(texts, { key, model, fetchImpl }) {
      const r = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ requests: texts.map((t) => ({ model: `models/${model}`, content: { parts: [{ text: t }] } })) }),
        signal: AbortSignal.timeout(20000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !Array.isArray(j.embeddings)) throw new Error(`Gemini embeddings ${r.status}: ${j.error?.message || 'unexpected answer'}`);
      return j.embeddings.map((e) => e.values);
    },
  },
};

let override = null;
/** Test seam: inject an embedder ({ model, embed(texts) }) or null to go back to the environment. */
function useEmbedder(e) { override = e; }

function on(env) { return String(env.FEATURE_KNOWLEDGE_EMBEDDINGS_ENABLED || '').toLowerCase() === 'true'; }

/** The configured embedder, or { embedder: null, reason }. */
function current(env = process.env, fetchImpl = globalThis.fetch) {
  if (override) return { embedder: override, reason: null };
  if (!on(env)) return { embedder: null, reason: 'Meaning-based search is off on this server (FEATURE_KNOWLEDGE_EMBEDDINGS_ENABLED).' };
  const wanted = String(env.KNOWLEDGE_EMBEDDINGS_PROVIDER || '').toLowerCase();
  const order = wanted ? [wanted] : ['openai', 'gemini'];
  for (const name of order) {
    const p = PROVIDERS[name];
    const key = p && env[p.keyEnv];
    if (!key) continue;
    const model = (env[p.modelEnv] || '').trim() || p.model;
    return { embedder: { model: `${name}/${model}`, embed: (texts) => p.embed(texts, { key, model, fetchImpl }) }, reason: null };
  }
  return { embedder: null, reason: wanted && !PROVIDERS[wanted] ? `Unknown embeddings provider "${wanted}".` : 'No embeddings provider key is set (OPENAI_API_KEY or GEMINI_API_KEY).' };
}

function unit(v) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (!Number.isFinite(n) || n === 0) throw new Error('The embeddings provider returned an empty vector.');
  return v.map((x) => x / n);
}

async function embedAll(embedder, texts) {
  const out = await embedder.embed(texts.map((t) => String(t).slice(0, 8000)));
  if (!Array.isArray(out) || out.length !== texts.length) throw new Error('The embeddings provider returned the wrong number of vectors.');
  return out.map(unit);
}

let running = false;
/** Embed passages that have none (or one from another model). Returns how many were written. */
async function indexPending(db, { limit = 128, batch = 32, log = console } = {}) {
  const { embedder } = current();
  if (!embedder || running) return 0;
  running = true;
  let written = 0;
  try {
    const { rows } = await db.query(
      `SELECT id, content FROM platform_knowledge_chunks WHERE embedding IS NULL OR embedding_model IS DISTINCT FROM $1 ORDER BY id LIMIT $2`,
      [embedder.model, limit],
    );
    for (let i = 0; i < rows.length; i += batch) {
      const slice = rows.slice(i, i + batch);
      const vectors = await embedAll(embedder, slice.map((r) => r.content));
      for (let j = 0; j < slice.length; j += 1) {
        await db.query('UPDATE platform_knowledge_chunks SET embedding = $2::real[], embedding_model = $3 WHERE id = $1', [slice[j].id, vectors[j], embedder.model]);
        written += 1;
      }
    }
  } catch (err) {
    if (err.code !== '42P01' && err.code !== '42703') log.warn?.('[knowledge embeddings] indexing paused:', err.message);
  } finally {
    running = false;
  }
  return written;
}

module.exports = { current, useEmbedder, indexPending, embedAll, PROVIDERS };
