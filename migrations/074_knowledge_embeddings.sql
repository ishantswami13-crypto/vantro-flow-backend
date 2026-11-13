-- Migration 074: meaning-based (vector) search for Knowledge.
--
-- NOT APPLIED TO PRODUCTION BY THIS CHANGE. Depends on 072. Apply with
-- `npm run db:migrate` against staging first.
--
-- Adds an embedding to each knowledge passage, written in the background
-- only when FEATURE_KNOWLEDGE_EMBEDDINGS_ENABLED=true and an embeddings
-- provider key is set. Vectors are stored as REAL[] (normalised to length
-- 1) so this works on any Postgres without the pgvector extension; the
-- similarity is a dot product. Passages embedded by a different model are
-- never compared with each other.

ALTER TABLE platform_knowledge_chunks ADD COLUMN IF NOT EXISTS embedding REAL[];
ALTER TABLE platform_knowledge_chunks ADD COLUMN IF NOT EXISTS embedding_model TEXT;
CREATE INDEX IF NOT EXISTS idx_platform_chunks_embedding_model ON platform_knowledge_chunks (organization_id, embedding_model);
CREATE INDEX IF NOT EXISTS idx_platform_chunks_unembedded ON platform_knowledge_chunks (id) WHERE embedding IS NULL;

CREATE OR REPLACE FUNCTION platform_dot(a REAL[], b REAL[]) RETURNS DOUBLE PRECISION
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(SUM(x::double precision * y::double precision), 0) FROM unnest(a, b) AS t(x, y)
$$;

COMMENT ON COLUMN platform_knowledge_chunks.embedding IS 'Unit-length embedding of content from embedding_model; NULL until indexed.';
