// FILE: lib/domain/os/knowledge.js
// BRIDGE ("Teach Starlane") and MEMORY: one shared, typed knowledge store.
//
// Kinds are never collapsed: an owner's remark is a HUMAN_OBSERVATION, a
// line from a contract is a SOURCE_CLAIM, what the engine measured is a
// LEARNED_PATTERN. People can add observations and claims; only the engine
// writes learned patterns. Knowledge is evidence, not truth: it is shown
// next to decisions, and never inserted into drafts, policy or permissions.
// Text is screened for prompt injection and quarantined when suspicious.

const { detectPromptInjection } = require('../../services/orchestrator/promptGuard.service');
const { appendEvent, humanActor } = require('../decisions/store');

const KINDS = ['OBSERVED_FACT', 'SOURCE_CLAIM', 'HUMAN_OBSERVATION', 'INFERENCE', 'HYPOTHESIS', 'LEARNED_PATTERN', 'POLICY', 'SEMANTIC_DEFINITION'];
// What a person may add through Teach Starlane. Policies go through Control;
// learned patterns and facts come only from the engine.
const HUMAN_KINDS = ['HUMAN_OBSERVATION', 'SOURCE_CLAIM', 'HYPOTHESIS'];
const SCOPE_TYPES = ['business', 'customer', 'supplier', 'product', 'process'];

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function clean(text, max) {
  return String(text || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}

async function addKnowledge(pool, userId, input, { actorId }) {
  const statement = clean(input?.statement, 1000);
  if (statement.length < 5) throw httpError(400, 'Write what Starlane should know in a sentence or two.');
  const kind = input.kind || 'HUMAN_OBSERVATION';
  if (!HUMAN_KINDS.includes(kind)) throw httpError(400, `You can teach Starlane an observation, a claim from a document, or a hypothesis (${HUMAN_KINDS.join(', ')}). Rules go through Control.`);
  const scopeType = SCOPE_TYPES.includes(input.scope?.type) ? input.scope.type : 'business';
  const scope = { type: scopeType, name: input.scope?.name ? clean(input.scope.name, 120) : null };
  let confidence = input.confidence == null ? 0.5 : Number(input.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) confidence = 0.5;
  const guard = detectPromptInjection(statement);
  const quarantined = guard.isSuspicious || guard.hardBlock;
  const source = { type: kind === 'SOURCE_CLAIM' ? 'DOCUMENT' : 'HUMAN', person: String(actorId), ref: input.sourceRef ? clean(input.sourceRef, 200) : null };
  const r = await pool.query(
    `INSERT INTO starlane_knowledge (user_id, kind, statement, scope, source, confidence, authority, valid_from, valid_until, safety, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8,$9,$10,$11) RETURNING *`,
    [userId, kind, statement, JSON.stringify(scope), JSON.stringify(source), confidence, kind === 'SOURCE_CLAIM' ? 'document' : 'person',
      input.validUntil ? new Date(input.validUntil).toISOString() : null, JSON.stringify({ flags: guard.flags, score: guard.score }), quarantined ? 'QUARANTINED' : 'ACTIVE', String(actorId)]
  );
  await appendEvent(pool, { userId, decisionId: null, type: 'KNOWLEDGE_ADDED', actor: humanActor(actorId), payload: { knowledgeId: r.rows[0].id, kind, quarantined } }).catch(() => {});
  return r.rows[0];
}

async function listKnowledge(pool, userId, { kind, limit = 200 } = {}) {
  const params = [userId];
  let q = 'SELECT * FROM starlane_knowledge WHERE user_id = $1 AND status <> \'RETIRED\'';
  if (kind && KINDS.includes(kind)) { params.push(kind); q += ` AND kind = $${params.length}`; }
  params.push(Math.min(Number(limit) || 200, 500));
  q += ` ORDER BY updated_at DESC LIMIT $${params.length}`;
  return (await pool.query(q, params)).rows;
}

async function retireKnowledge(pool, userId, id, { actorId }) {
  const r = await pool.query(`UPDATE starlane_knowledge SET status = 'RETIRED', updated_at = NOW() WHERE id = $1 AND user_id = $2 AND kind = ANY($3) RETURNING *`, [id, userId, HUMAN_KINDS]);
  if (!r.rows[0]) throw httpError(404, 'knowledge item not found');
  await appendEvent(pool, { userId, decisionId: null, type: 'KNOWLEDGE_RETIRED', actor: humanActor(actorId), payload: { knowledgeId: id } }).catch(() => {});
  return r.rows[0];
}

/** Engine-only: upsert a learned pattern by its key. */
async function recordLearnedPattern(pool, userId, { patternKey, statement, scope, sampleCount, confidence, evidence, asOfIso }) {
  const r = await pool.query(
    `INSERT INTO starlane_knowledge (user_id, kind, statement, scope, source, confidence, authority, sample_count, last_verified_at, evidence, pattern_key, created_by, valid_from)
     VALUES ($1,'LEARNED_PATTERN',$2,$3,$4,$5,'engine',$6,$7,$8,$9,'starlane.workflow_engine',$7)
     ON CONFLICT (user_id, pattern_key) WHERE pattern_key IS NOT NULL
     DO UPDATE SET statement = EXCLUDED.statement, scope = EXCLUDED.scope, confidence = EXCLUDED.confidence, sample_count = EXCLUDED.sample_count,
       last_verified_at = EXCLUDED.last_verified_at, evidence = EXCLUDED.evidence, updated_at = NOW()
     RETURNING *`,
    [userId, statement, JSON.stringify(scope), JSON.stringify({ type: 'ENGINE', ref: patternKey }), confidence, sampleCount, asOfIso, JSON.stringify(evidence), patternKey]
  );
  return r.rows[0];
}

module.exports = { addKnowledge, listKnowledge, retireKnowledge, recordLearnedPattern, KINDS, HUMAN_KINDS };
