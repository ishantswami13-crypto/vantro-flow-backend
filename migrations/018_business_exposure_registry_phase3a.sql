-- ============================================================
-- VANTRO STARLANE — Migration 018: World Intelligence Phase 3 Part A
-- Business Exposure Registry: provenance + verification lifecycle + candidates
-- ============================================================
-- Additive only. EXTENDS migration 017's business_exposure table rather than
-- superseding it — 017's schema already carries the core primitive (tenant
-- entity link, exposure_type, world_entity_id, bitemporal valid_from/valid_to,
-- truth_state, confidence, raw_value/normalized_value/resolution_* columns,
-- source_of_fact/evidence_notes). What it is MISSING for this phase, per the
-- mission, is a first-class verification lifecycle distinct from truth_state
-- (truth_state answers "how was this known" — OBSERVED/DERIVED/etc — not
-- "has a human confirmed this specific row is correct"), and a controlled
-- provenance_type vocabulary broader than the existing source_of_fact enum
-- (which conflates "who/what produced this" with a couple of hardcoded
-- resolution methods). We add both as new columns rather than repurposing
-- source_of_fact, so every pre-existing 017 row (all currently
-- source_of_fact='test_fixture' per that migration's own default) continues
-- to read correctly — it simply gets verification_status='VERIFIED'
-- (see backfill below): those rows were written directly, no separate
-- verification step existed yet, so treating them as already-verified is the
-- honest backward-reading, not a fabrication.
--
-- Also widens exposure_type's CHECK constraint to the full taxonomy from
-- STARLANE_BUSINESS_EXPOSURE_TAXONOMY_V1.md (GEOGRAPHY/CURRENCY/SUPPLY/
-- LOGISTICS/COMMODITY/REGULATORY families) instead of 017's flatter list,
-- since Part A's write/bulk-import/candidate APIs need the full vocabulary.
-- 017's original 8 values are kept verbatim as aliases inside the new list
-- (nothing is removed) so existing rows/tests referencing them keep working.
-- ============================================================

-- ─── 1. Widen exposure_type CHECK (additive superset) ─────────
ALTER TABLE business_exposure DROP CONSTRAINT IF EXISTS business_exposure_exposure_type_check;
ALTER TABLE business_exposure ADD CONSTRAINT business_exposure_exposure_type_check CHECK (exposure_type IN (
  -- 017 original values, preserved verbatim
  'LOCATED_IN','CURRENCY_DENOMINATED','DEPENDS_ON','SOURCED_FROM',
  'USES_PORT','USES_ROUTE','REGULATED_BY','SUBJECT_TO_COMMODITY',
  -- GEOGRAPHY
  'OPERATES_IN','MANUFACTURES_IN','SOURCES_FROM','SELLS_IN',
  -- CURRENCY
  'BILLS_IN','PAYS_IN','DENOMINATED_IN','RECEIVES_IN',
  -- SUPPLY
  'SUPPLIED_BY','SUPPLIES',
  -- LOGISTICS
  'SHIPS_FROM','SHIPS_TO','SHIPS_THROUGH',
  -- COMMODITY
  'DEPENDS_ON_COMMODITY','PRICE_EXPOSED_TO',
  -- REGULATORY
  'IMPORTS_FROM','EXPORTS_TO','SUBJECT_TO_JURISDICTION'
));

-- ─── 2. Provenance + verification lifecycle columns ────────────
ALTER TABLE business_exposure
  ADD COLUMN IF NOT EXISTS verification_status  TEXT NOT NULL DEFAULT 'UNVERIFIED'
                            CHECK (verification_status IN ('VERIFIED','UNVERIFIED','REJECTED','SUPERSEDED')),
  ADD COLUMN IF NOT EXISTS provenance_type       TEXT NOT NULL DEFAULT 'OWNER_ENTERED'
                            CHECK (provenance_type IN ('OWNER_ENTERED','IMPORT','BUSINESS_RECORD','CONNECTOR','DERIVED','EXTERNAL_SOURCE')),
  ADD COLUMN IF NOT EXISTS provenance_reference  TEXT,   -- e.g. 'bulk_import:2026-09-07T...:row-14', 'candidate:<uuid>', 'suppliers.gstin'
  ADD COLUMN IF NOT EXISTS recorded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- when this fact was captured by STARLANE (distinct from valid_from = when true in the business)
  ADD COLUMN IF NOT EXISTS verified_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verified_by_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS superseded_by_id      UUID REFERENCES business_exposure(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejection_reason      TEXT;

-- Honest backfill: every pre-existing row was written directly by Phase 2
-- code/fixtures with no verification step in existence at the time — mark it
-- VERIFIED (not a fabrication of new facts, purely a status label for rows
-- that predate this lifecycle) so Phase 2's proof/tests continue to pass
-- unmodified, and so the mandatory "unverified does not produce a signal"
-- rule introduced below does not silently break already-shipped behavior.
UPDATE business_exposure SET verification_status = 'VERIFIED', verified_at = created_at
  WHERE verification_status = 'UNVERIFIED';

CREATE INDEX IF NOT EXISTS idx_bexp_verification ON business_exposure(user_id, verification_status);

-- ─── 3. Candidate registry (Phase 5/6) — separate from verified exposure ──
-- A candidate is NOT a business_exposure row. It becomes one only via the
-- explicit verify-candidate API call (never automatically). Kept in its own
-- table per the mission's explicit instruction, so an unverified candidate
-- can never accidentally be picked up by the relevance engine, which only
-- ever reads business_exposure.
CREATE TABLE IF NOT EXISTS business_exposure_candidates (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  business_entity_type  TEXT NOT NULL CHECK (business_entity_type IN (
                          'supplier','customer','product','purchase','sale','order'
                        )),
  business_entity_id    TEXT NOT NULL,

  exposure_type         TEXT NOT NULL,   -- validated against the same vocabulary in application code (kept as TEXT here to avoid duplicating/drifting the CHECK across two tables)
  raw_value             TEXT NOT NULL,   -- the literal value found in the source tenant table (e.g. suppliers.gstin content)

  source_table          TEXT NOT NULL,   -- e.g. 'suppliers', 'purchases'
  source_column         TEXT NOT NULL,   -- e.g. 'gstin', 'address'
  source_row_id         TEXT NOT NULL,   -- id of the row in source_table this candidate was extracted from

  classification        TEXT NOT NULL CHECK (classification IN ('DIRECT_FACT','SAFE_DERIVATION','WEAK_DERIVATION','UNUSABLE')),
  extraction_method     TEXT NOT NULL,   -- short code identifying which extractor rule produced this, e.g. 'gstin_state_code_prefix'
  extraction_notes      TEXT,

  candidate_status      TEXT NOT NULL DEFAULT 'PROPOSED'
                          CHECK (candidate_status IN ('PROPOSED','VERIFIED','REJECTED')),
  promoted_exposure_id  UUID REFERENCES business_exposure(id) ON DELETE SET NULL,
  reviewed_at           TIMESTAMPTZ,
  reviewed_by_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  review_notes          TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Same raw fact from the same source row should not be proposed twice.
  UNIQUE(user_id, source_table, source_row_id, source_column, exposure_type)
);
CREATE INDEX IF NOT EXISTS idx_bexpc_user_status ON business_exposure_candidates(user_id, candidate_status);
ALTER TABLE business_exposure_candidates DISABLE ROW LEVEL SECURITY;

SELECT 'Migration 018_business_exposure_registry_phase3a complete' AS status;
