-- 094_search.sql
-- L5 search (lib/data/search): fuzzy, typo-tolerant name search over
-- customers, suppliers and products, and duplicate detection for names that
-- arrive spelled differently (Tally exports, CSV imports, "M/s Sharma Traders
-- Pvt Ltd" vs "Sharma Traders").
--
-- search_entities is a derived index, rebuilt per tenant from the source
-- tables. The source tables get no new indexes or triggers, so writes to them
-- are unaffected.
--
-- Needs the pg_trgm extension (available on Supabase). On Supabase it lives in
-- the "extensions" schema; the index below finds it wherever it is.
--
-- Additive and idempotent. Rollback:
--   DROP TABLE IF EXISTS search_entities; DROP FUNCTION IF EXISTS starlane_norm_name(text);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
      CREATE EXTENSION pg_trgm WITH SCHEMA extensions;
    ELSE
      CREATE EXTENSION pg_trgm;
    END IF;
  END IF;
END $$;

-- Lower-case, "&" -> "and", punctuation to spaces, legal-form words and the
-- "M/s" prefix removed, whitespace collapsed. "M/s. Sharma & Sons Pvt. Ltd."
-- and "sharma and sons" normalise to the same text.
CREATE OR REPLACE FUNCTION starlane_norm_name(v text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 regexp_replace(lower(COALESCE(v, '')), '&', ' and ', 'g'),
               '^\s*m\s*/\s*s\.?\s+', '', 'g'),
             '[^a-z0-9]+', ' ', 'g'),
           '\m(pvt|private|ltd|limited|llp|inc|corp|corporation|co|company|plc|llc|gmbh)\M', ' ', 'g'),
         '\s+', ' ', 'g'))
$$;

CREATE TABLE IF NOT EXISTS search_entities (
  user_id      UUID NOT NULL,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('customer', 'supplier', 'product')),
  entity_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  norm         TEXT NOT NULL,
  detail       TEXT,
  PRIMARY KEY (user_id, entity_type, entity_id)
);

DO $$
DECLARE s text;
BEGIN
  SELECT n.nspname INTO s FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm';
  EXECUTE format('CREATE INDEX IF NOT EXISTS idx_search_entities_norm_trgm ON search_entities USING gin (norm %I.gin_trgm_ops)', s);
END $$;
CREATE INDEX IF NOT EXISTS idx_search_entities_detail ON search_entities (user_id, lower(detail)) WHERE detail IS NOT NULL;

SELECT starlane_lock_down_table('search_entities');
