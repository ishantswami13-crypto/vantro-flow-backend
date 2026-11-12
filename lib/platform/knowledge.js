'use strict';
// Knowledge: collections of documents an organization gives Starlane, with
// personal, team and organization scope, full-text search and citations.
//
// Access rule (the same for a person searching and an agent running):
//   organization  every member of the organization
//   team          members of that team
//   personal      only its owner
// An agent's knowledge grants are intersected with what the identity it runs
// as may read (accessibleCollectionIds), so a shared agent never reveals a
// collection its current user cannot open.
//
// Documents are stored as text and split into chunks for Postgres full-text
// search. Binary formats (PDF, Word) are not parsed here; the UI says so.

const crypto = require('crypto');
const audit = require('./audit');
const { atLeast } = require('./roles');
const { badRequest, forbidden, notFound, conflict, assertUuid } = require('./errors');

const MAX_DOC_CHARS = 1_000_000;
const CHUNK_CHARS = 1200;

async function teamIds(db, orgId, userId) {
  const { rows } = await db.query('SELECT team_id FROM platform_team_members WHERE organization_id = $1 AND user_id = $2', [orgId, userId]);
  return rows.map((r) => r.team_id);
}

/** Every collection id the user may read in this organization. */
async function accessibleCollectionIds(db, orgId, userId) {
  const { rows } = await db.query(
    `SELECT c.id FROM platform_knowledge_collections c
      WHERE c.organization_id = $1
        AND EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = $1 AND m.user_id = $2)
        AND (c.scope = 'organization'
             OR (c.scope = 'personal' AND c.owner_user_id = $2)
             OR (c.scope = 'team' AND c.team_id IN (SELECT team_id FROM platform_team_members WHERE organization_id = $1 AND user_id = $2)))`,
    [orgId, userId],
  );
  return rows.map((r) => r.id);
}

function canWrite(c, org, userId, myTeams) {
  if (!atLeast(org.role, 'member')) return false;
  if (c.owner_user_id === userId) return true;
  if (c.scope === 'personal') return false;
  if (atLeast(org.role, 'admin')) return true;
  return c.scope === 'team' && myTeams.includes(c.team_id);
}

async function listCollections(db, org, userId) {
  const ids = await accessibleCollectionIds(db, org.id, userId);
  if (!ids.length) return [];
  const myTeams = await teamIds(db, org.id, userId);
  const { rows } = await db.query(
    `SELECT c.*, t.name AS team_name, u.email AS owner_email,
            (SELECT COUNT(*)::int FROM platform_knowledge_documents d WHERE d.collection_id = c.id) AS document_count,
            (SELECT COUNT(*)::int FROM platform_knowledge_documents d WHERE d.collection_id = c.id AND d.status <> 'ready') AS not_ready_count,
            (SELECT MAX(d.created_at) FROM platform_knowledge_documents d WHERE d.collection_id = c.id) AS last_added_at
       FROM platform_knowledge_collections c
       LEFT JOIN platform_teams t ON t.id = c.team_id
       LEFT JOIN users u ON u.id = c.owner_user_id
      WHERE c.organization_id = $1 AND c.id = ANY($2::uuid[])
      ORDER BY array_position(ARRAY['organization','team','personal'], c.scope), lower(c.name)`,
    [org.id, ids],
  );
  return rows.map((c) => ({
    id: c.id, name: c.name, description: c.description, scope: c.scope, teamId: c.team_id, teamName: c.team_name,
    ownerUserId: c.owner_user_id, ownerEmail: c.owner_email, documentCount: c.document_count, notReadyCount: c.not_ready_count,
    lastAddedAt: c.last_added_at, createdAt: c.created_at, canWrite: canWrite(c, org, userId, myTeams),
  }));
}

async function collectionFor(db, org, userId, id, { write = false } = {}) {
  assertUuid(id, 'collectionId');
  const ids = await accessibleCollectionIds(db, org.id, userId);
  if (!ids.includes(id)) throw notFound('That collection');
  const { rows } = await db.query('SELECT * FROM platform_knowledge_collections WHERE organization_id = $1 AND id = $2', [org.id, id]);
  const c = rows[0];
  if (write && !canWrite(c, org, userId, await teamIds(db, org.id, userId))) throw forbidden('You can read this collection but not change it.');
  return c;
}

async function createCollection(db, org, userId, { name, description, scope = 'personal', teamId = null }) {
  if (!atLeast(org.role, 'member')) throw forbidden('Viewers cannot create collections.');
  if (!['personal', 'team', 'organization'].includes(scope)) throw badRequest('scope must be personal, team or organization');
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n || n.length > 120) throw badRequest('Give the collection a name (up to 120 characters)');
  if (description != null && (typeof description !== 'string' || description.length > 1000)) throw badRequest('Description must be text up to 1000 characters');
  if (scope === 'organization' && !atLeast(org.role, 'admin')) {
    const pol = await db.query('SELECT policy FROM platform_org_policies WHERE organization_id = $1', [org.id]);
    if (pol.rows[0]?.policy?.membersMayShareWithOrganization === false) throw forbidden('Only admins can create organization-wide collections here.');
  }
  if (scope === 'team') {
    assertUuid(teamId, 'teamId');
    const mine = await teamIds(db, org.id, userId);
    const exists = await db.query('SELECT 1 FROM platform_teams WHERE organization_id = $1 AND id = $2', [org.id, teamId]);
    if (!exists.rows[0]) throw notFound('That team');
    if (!mine.includes(teamId) && !atLeast(org.role, 'admin')) throw forbidden('You can only share with a team you belong to.');
  }
  const { rows } = await db.query(
    `INSERT INTO platform_knowledge_collections (organization_id, owner_user_id, scope, team_id, name, description)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [org.id, userId, scope, scope === 'team' ? teamId : null, n, description ? description.trim() : null],
  );
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: userId, action: 'knowledge.collection_created', resourceType: 'collection', resourceId: rows[0].id, detail: { name: n, scope } });
  return { id: rows[0].id };
}

async function deleteCollection(db, org, userId, id) {
  const c = await collectionFor(db, org, userId, id, { write: true });
  if (c.owner_user_id !== userId && !atLeast(org.role, 'admin')) throw forbidden('Only the owner or an admin can delete a collection.');
  await db.query('DELETE FROM platform_knowledge_collections WHERE organization_id = $1 AND id = $2', [org.id, id]);
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: userId, action: 'knowledge.collection_deleted', resourceType: 'collection', resourceId: id, detail: { name: c.name } });
}

/** Split text into chunks on paragraph, then sentence, boundaries. */
function chunkText(text, size = CHUNK_CHARS) {
  const paras = text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  const flush = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ''; };
  for (const p of paras) {
    if (p.length > size) {
      flush();
      const sentences = p.split(/(?<=[.!?])\s+/);
      for (const s of sentences) {
        if ((cur + ' ' + s).length > size) flush();
        if (s.length > size) { for (let i = 0; i < s.length; i += size) chunks.push(s.slice(i, i + size)); continue; }
        cur = cur ? `${cur} ${s}` : s;
      }
      flush();
      continue;
    }
    if ((cur + '\n\n' + p).length > size) flush();
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  flush();
  return chunks;
}

async function addDocument(db, org, userId, collectionId, { title, content, sourceName = null, mimeType = null, sourceKind = 'upload' }) {
  await collectionFor(db, org, userId, collectionId, { write: true });
  const t = typeof title === 'string' ? title.trim() : '';
  if (!t || t.length > 200) throw badRequest('Give the document a title (up to 200 characters)');
  if (typeof content !== 'string' || !content.trim()) throw badRequest('The document has no text. Add text, a text file, a PDF with a text layer or a Word (.docx) file.');
  if (content.length > MAX_DOC_CHARS) throw badRequest('That document is over 1,000,000 characters. Split it into smaller documents.');
  if (!['upload', 'paste'].includes(sourceKind)) throw badRequest('sourceKind must be upload or paste');
   
  const clean = content.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  const sha = crypto.createHash('sha256').update(clean).digest('hex');
  const chunks = chunkText(clean);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO platform_knowledge_documents (organization_id, collection_id, title, source_kind, source_name, mime_type, byte_size, content_sha256, status, chunk_count, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ready', $9, $10)
       ON CONFLICT (collection_id, content_sha256) DO NOTHING RETURNING id`,
      [org.id, collectionId, t, sourceKind, sourceName ? String(sourceName).slice(0, 200) : null, mimeType ? String(mimeType).slice(0, 100) : null,
        Buffer.byteLength(clean), sha, chunks.length, userId],
    );
    if (!ins.rows[0]) throw conflict('This exact document is already in the collection.', 'DUPLICATE_DOCUMENT');
    const docId = ins.rows[0].id;
    for (let i = 0; i < chunks.length; i += 200) {
      const slice = chunks.slice(i, i + 200);
      const values = slice.map((_, j) => `($1, $2, $3, $${4 + j * 2}, $${5 + j * 2})`).join(',');
      await client.query(
        `INSERT INTO platform_knowledge_chunks (organization_id, collection_id, document_id, ordinal, content) VALUES ${values}`,
        [org.id, collectionId, docId, ...slice.flatMap((c, j) => [i + j, c])],
      );
    }
    await audit.record(client, { organizationId: org.id, actorUserId: userId, action: 'knowledge.document_added', resourceType: 'document', resourceId: docId, detail: { collectionId, title: t, chunks: chunks.length } });
    await client.query('COMMIT');
    return { id: docId, chunkCount: chunks.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function listDocuments(db, org, userId, collectionId) {
  await collectionFor(db, org, userId, collectionId);
  const { rows } = await db.query(
    `SELECT d.id, d.title, d.source_kind, d.source_name, d.mime_type, d.byte_size, d.status, d.status_detail, d.chunk_count, d.created_at, u.email AS uploaded_by_email
       FROM platform_knowledge_documents d LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE d.organization_id = $1 AND d.collection_id = $2 ORDER BY d.created_at DESC LIMIT 500`,
    [org.id, collectionId],
  );
  return rows.map((d) => ({ id: d.id, title: d.title, sourceKind: d.source_kind, sourceName: d.source_name, mimeType: d.mime_type, byteSize: d.byte_size, status: d.status, statusDetail: d.status_detail, chunkCount: d.chunk_count, createdAt: d.created_at, uploadedBy: d.uploaded_by_email }));
}

async function deleteDocument(db, org, userId, collectionId, documentId) {
  await collectionFor(db, org, userId, collectionId, { write: true });
  assertUuid(documentId, 'documentId');
  const r = await db.query('DELETE FROM platform_knowledge_documents WHERE organization_id = $1 AND collection_id = $2 AND id = $3 RETURNING title', [org.id, collectionId, documentId]);
  if (!r.rowCount) throw notFound('That document');
  await audit.recordSoft(db, { organizationId: org.id, actorUserId: userId, action: 'knowledge.document_deleted', resourceType: 'document', resourceId: documentId, detail: { collectionId, title: r.rows[0].title } });
}

/**
 * Full-text search over chunks the caller may read. `collectionIds`, when
 * given, narrows further (an agent's grants); it can never widen access.
 */
async function search(db, orgId, userId, query, { collectionIds = null, limit = 8 } = {}) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (q.length < 2 || q.length > 300) throw badRequest('Search for 2 to 300 characters');
  let allowed = await accessibleCollectionIds(db, orgId, userId);
  if (collectionIds) allowed = allowed.filter((id) => collectionIds.includes(id));
  if (!allowed.length) return { results: [], searchedCollections: 0 };
  const lim = Math.min(Math.max(Number(limit) || 8, 1), 20);
  const { rows } = await db.query(
    `WITH q AS (SELECT websearch_to_tsquery('simple', $3) AS tsq)
     SELECT ch.document_id, ch.ordinal, d.title, c.id AS collection_id, c.name AS collection_name,
            ts_rank(ch.tsv, q.tsq) AS rank,
            ts_headline('simple', ch.content, q.tsq, 'MaxFragments=2, MinWords=8, MaxWords=40, StartSel=«, StopSel=»') AS snippet
       FROM platform_knowledge_chunks ch
       JOIN platform_knowledge_documents d ON d.id = ch.document_id AND d.organization_id = ch.organization_id
       JOIN platform_knowledge_collections c ON c.id = ch.collection_id AND c.organization_id = ch.organization_id
       CROSS JOIN q
      WHERE ch.organization_id = $1 AND ch.collection_id = ANY($2::uuid[]) AND ch.tsv @@ q.tsq
      ORDER BY rank DESC, ch.document_id, ch.ordinal LIMIT $4`,
    [orgId, allowed, q, lim],
  );
  return {
    searchedCollections: allowed.length,
    results: rows.map((r) => ({
      documentId: r.document_id, title: r.title, collectionId: r.collection_id, collectionName: r.collection_name,
      chunk: r.ordinal, snippet: r.snippet, score: Number(Number(r.rank).toFixed(4)),
      citation: `${r.title} (${r.collection_name}), part ${r.ordinal + 1}`,
    })),
  };
}

/** A document's text, if the caller (and the agent's grants) allow it. */
async function readDocument(db, orgId, userId, documentId, { collectionIds = null, maxChars = 12000 } = {}) {
  assertUuid(documentId, 'documentId');
  let allowed = await accessibleCollectionIds(db, orgId, userId);
  if (collectionIds) allowed = allowed.filter((id) => collectionIds.includes(id));
  const { rows } = await db.query(
    `SELECT d.id, d.title, d.collection_id, c.name AS collection_name FROM platform_knowledge_documents d
       JOIN platform_knowledge_collections c ON c.id = d.collection_id AND c.organization_id = d.organization_id
      WHERE d.organization_id = $1 AND d.id = $2 AND d.collection_id = ANY($3::uuid[])`,
    [orgId, documentId, allowed],
  );
  if (!rows[0]) throw notFound('That document');
  const ch = await db.query('SELECT content FROM platform_knowledge_chunks WHERE organization_id = $1 AND document_id = $2 ORDER BY ordinal', [orgId, documentId]);
  const full = ch.rows.map((r) => r.content).join('\n\n');
  return {
    documentId, title: rows[0].title, collectionId: rows[0].collection_id, collectionName: rows[0].collection_name,
    text: full.slice(0, maxChars), truncated: full.length > maxChars, citation: `${rows[0].title} (${rows[0].collection_name})`,
  };
}

module.exports = {
  accessibleCollectionIds, listCollections, createCollection, deleteCollection, collectionFor,
  addDocument, listDocuments, deleteDocument, search, readDocument, chunkText,
};
