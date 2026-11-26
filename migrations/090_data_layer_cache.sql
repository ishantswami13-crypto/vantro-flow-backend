-- 090_data_layer_cache.sql
-- L1 shared cache for the data access layer (lib/data/cache/postgresBackend.js).
-- Used only when STARLANE_CACHE_BACKEND=postgres; the default stays in-memory.
--
-- UNLOGGED: no write-ahead log, emptied after a crash, not copied to read
-- replicas. Correct for a cache and never a source of truth.
-- Additive and idempotent. Rollback: DROP TABLE IF EXISTS starlane_cache;

CREATE UNLOGGED TABLE IF NOT EXISTS starlane_cache (
  cache_key   TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  value       JSONB NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_starlane_cache_tenant  ON starlane_cache (tenant_id);
CREATE INDEX IF NOT EXISTS idx_starlane_cache_expires ON starlane_cache (expires_at);

-- Server-side only: the backend uses the service connection. Deny the
-- PostgREST roles so cached tenant data is never readable through the API.
ALTER TABLE starlane_cache ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON starlane_cache FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON starlane_cache FROM authenticated';
  END IF;
END $$;
