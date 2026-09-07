-- ============================================================
-- VANTRO STARLANE — Migration 015: World Intelligence Backbone (core schema)
-- ============================================================
-- Additive only — no destructive change, no existing table touched.
-- Phase 1 of the "World Intelligence Backbone" mission. Greenfield: confirmed
-- via STARLANE_WORLD_INTELLIGENCE_EXISTING_STATE.md that no external-world
-- data model exists anywhere in this codebase prior to this migration.
--
-- Conventions reused from this repo (not invented fresh):
--   - UUID PKs via gen_random_uuid(), TIMESTAMPTZ, created_at/updated_at pairs
--     (migration 001).
--   - Append-only event log shape, narrow columns, indexed for "recent" +
--     "by entity" queries (business_events, migration 001).
--   - Separate append-only history/revision table alongside a live table,
--     ON DELETE CASCADE, no fabricated backfill (customer_score_history,
--     migration 011).
--   - Idempotency via UNIQUE(...) constraint rather than app-side locking
--     (execution_records, migration 014).
--   - RLS disabled on new tables to match every other non-tenant-primary
--     table added since migration 006 (this backend enforces tenant
--     isolation in application code via user_id filters, not RLS; see
--     migration 011/014's `ALTER TABLE ... DISABLE ROW LEVEL SECURITY`).
--     business_signals is the one tenant-scoped table below and gets the
--     same treatment for consistency with customers/business_events.
--
-- ─────────────────────────────────────────────────────────────
-- DEVIATIONS FROM THE MISSION'S SUGGESTED world_events FIELD LIST
-- ─────────────────────────────────────────────────────────────
-- 1. country_codes / region_codes: mission left this open ("array or
--    normalized join table — your call, justify it"). Chosen: TEXT[] arrays
--    directly on world_events, NOT a join table. Justification: an event's
--    country/region set is a property of the event itself (announced once at
--    ingestion, immutable thereafter — an earthquake doesn't gain new
--    countries later), it is small (1-5 codes almost always), and every
--    query pattern we implement (Phase 16) is "events WHERE country_code =
--    ANY(country_codes)" — a GIN index on the array serves that directly with
--    far less join overhead than a normalized event_countries table would
--    for a column that never needs its own attributes (no per-country
--    confidence, no per-country timestamp). If a future phase needs
--    per-country metadata on the same event, a join table can be added then
--    without touching this array. This does NOT replace world_entities links
--    for COUNTRY/REGION entities — world_event_entities (015 below) still
--    carries the disciplined entity relationship; country_codes/region_codes
--    are a cheap denormalized filter for the common case, not a strong
--    reference.
-- 2. raw_payload_reference: implemented as source_record_id (UUID) FK to
--    world_source_records(id), NOT inline JSONB — exactly as the mission
--    asked ("FK to a raw-records table, not inline JSON blob"). Named
--    source_record_id to match the plain-language column already requested
--    for "the source's own record id" would collide, so this FK column is
--    named `raw_record_id` and the source's own external identifier is kept
--    as `source_external_id` — see column comments below for the exact
--    naming resolution.
-- 3. No separate `magnitude` type column beyond NUMERIC — the mission's
--    `magnitude` is deliberately untyped/unitless at the canonical-event
--    level (an earthquake's Richter magnitude and a currency's percent move
--    are not comparable), with `magnitude_unit` added as a companion text
--    column so consumers know how to interpret the number. This is an
--    addition, not a removal, to prevent silent unit confusion.
-- 4. `status` is CHECK-constrained to a small closed list
--    ('active','resolved','superseded','retracted') rather than left as a
--    free-text field per the mission's plain list, matching this codebase's
--    universal convention of CHECK-constraining every status/enum-shaped
--    column (ai_actions.status, execution_records.status, etc.).
-- ============================================================

-- ─── WORLD SOURCES (registry of external data providers) ────
-- Phase 6. One row per distinct external data provider/dataset STARLANE
-- ingests from. Reliability here is about the SOURCE's trustworthiness in
-- general (is USGS authoritative? is a random blog unverified?) — this is
-- deliberately never conflated with an individual event's severity/magnitude,
-- which live on world_events instead. Confirmed: no column here overlaps
-- with world_events.severity/magnitude.
CREATE TABLE IF NOT EXISTS world_sources (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                      TEXT NOT NULL,          -- e.g. 'USGS', 'Frankfurter/ECB'
  dataset                       TEXT NOT NULL,           -- e.g. 'significant_earthquakes_month', 'ecb_reference_rates'
  authority_type                TEXT,                    -- e.g. 'government_agency','intergovernmental','ngo','commercial'
  homepage_url                  TEXT,
  license_notes                 TEXT,
  update_cadence                TEXT,                    -- free text, e.g. 'real-time (5 min)', 'daily ~16:00 CET'
  geographic_coverage           TEXT,                    -- e.g. 'global', 'EU + major currencies'
  historical_coverage_notes     TEXT,
  data_category                 TEXT,                    -- e.g. 'NATURAL_HAZARD', 'MACROECONOMICS'
  reliability_tier               TEXT NOT NULL DEFAULT 'unverified'
                                   CHECK (reliability_tier IN ('authoritative','reputable','unverified','manual_reference')),
  schema_version                TEXT NOT NULL DEFAULT 'v1',
  last_successful_ingestion_at  TIMESTAMPTZ,
  last_failure_at               TIMESTAMPTZ,
  last_failure_reason           TEXT,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider, dataset)
);
ALTER TABLE world_sources DISABLE ROW LEVEL SECURITY;

-- ─── WORLD SOURCE RECORDS (raw preservation layer, Phase 7/14) ─
-- This IS the correct place for a raw JSONB blob — it is explicitly the
-- preservation/staging layer, never queried as the domain model. Every
-- world_events row must trace back to exactly one of these (Phase 19
-- provenance test). canonical_event_id is nullable and set once the record
-- has been normalized and matched/created into world_events — this is how
-- "was this raw record already processed" is answered without re-parsing.
CREATE TABLE IF NOT EXISTS world_source_records (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id           UUID NOT NULL REFERENCES world_sources(id) ON DELETE CASCADE,
  source_record_id    TEXT NOT NULL,   -- the source's own unique id for this record (e.g. USGS event id, FX date+base)
  raw_payload         JSONB NOT NULL,
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  canonical_event_id  UUID,            -- FK added below after world_events exists
  parse_status        TEXT NOT NULL DEFAULT 'pending' CHECK (parse_status IN ('pending','normalized','parse_failed','duplicate_skipped')),
  parse_error         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Idempotent re-fetch: the same source_id + source_record_id fetched twice
  -- (e.g. cron running again before the window rolls) must not create a
  -- second raw record. This is the primary dedup mechanism for Phase 7.
  UNIQUE(source_id, source_record_id)
);
CREATE INDEX IF NOT EXISTS idx_wsr_source_fetched ON world_source_records(source_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_wsr_canonical_event ON world_source_records(canonical_event_id) WHERE canonical_event_id IS NOT NULL;
ALTER TABLE world_source_records DISABLE ROW LEVEL SECURITY;

-- ─── WORLD EVENTS (the canonical normalized event primitive, Phase 2) ──
-- ONE table for every external-world event type, distinguished by
-- event_type/event_subtype rather than one table per source. Bitemporal by
-- design (Phase 5): observed_at/started_at/ended_at/valid_from/valid_to
-- answer "when was this true in the world"; published_at/ingested_at answer
-- "when did STARLANE learn it". See the doc-comment on world_event_revisions
-- below for exactly how to reconstruct "what STARLANE knew at time T" vs
-- "what was true at time T" from these columns.
CREATE TABLE IF NOT EXISTS world_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- classification
  event_type            TEXT NOT NULL,   -- top-level category, see WORLD_EVENT_TAXONOMY_V1.md (e.g. 'NATURAL_HAZARD','MACROECONOMICS')
  event_subtype         TEXT,            -- e.g. 'earthquake', 'fx_reference_rate'
  title                 TEXT NOT NULL,
  summary               TEXT,

  -- bitemporal: when true in the world
  observed_at           TIMESTAMPTZ,     -- when the event was actually observed/measured (e.g. earthquake origin time, FX rate's reference date)
  started_at            TIMESTAMPTZ,
  ended_at              TIMESTAMPTZ,
  valid_from            TIMESTAMPTZ,     -- for state-like events (e.g. an FX rate holds from this timestamp
  valid_to              TIMESTAMPTZ,     --   until the next day's rate supersedes it)
  temporal_precision    TEXT NOT NULL DEFAULT 'exact'
                          CHECK (temporal_precision IN ('exact','day','week','month','quarter','year','unknown')),

  -- bitemporal: when STARLANE learned it
  published_at          TIMESTAMPTZ,     -- when the SOURCE published/released this record
  ingested_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- when STARLANE's pipeline wrote this row

  -- geography (see deviation note #1 above re: arrays vs join table)
  country_codes         TEXT[] NOT NULL DEFAULT '{}',   -- ISO 3166-1 alpha-2, e.g. {'US','JP'}
  region_codes           TEXT[] NOT NULL DEFAULT '{}',   -- free-form region identifiers (e.g. 'US-CA', 'APAC')
  latitude               NUMERIC(9,6),
  longitude              NUMERIC(9,6),

  -- provenance
  source_id              UUID NOT NULL REFERENCES world_sources(id) ON DELETE RESTRICT,
  source_external_id     TEXT,           -- the source's own id for the real-world thing (e.g. USGS event id) — may equal source_record_records.source_record_id but kept distinct since one raw record can in principle describe zero-or-one canonical events
  raw_record_id          UUID REFERENCES world_source_records(id) ON DELETE RESTRICT,  -- "raw_payload_reference" from the mission spec
  source_url             TEXT,
  source_published_at    TIMESTAMPTZ,

  -- assessment (deliberately separate from source_reliability, see header)
  confidence             NUMERIC(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  source_reliability      TEXT CHECK (source_reliability IS NULL OR source_reliability IN ('authoritative','reputable','unverified','manual_reference')),
  truth_state             TEXT NOT NULL DEFAULT 'OBSERVED'
                           CHECK (truth_state IN ('OBSERVED','DERIVED','EXPECTED','PREDICTED','UNKNOWN')),
  severity                TEXT CHECK (severity IS NULL OR severity IN ('low','moderate','high','severe','critical')),
  magnitude               NUMERIC,
  magnitude_unit          TEXT,           -- e.g. 'richter', 'percent_change', 'usd_per_barrel' — required context for magnitude
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved','superseded','retracted')),

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE world_source_records
  ADD CONSTRAINT fk_wsr_canonical_event FOREIGN KEY (canonical_event_id) REFERENCES world_events(id) ON DELETE SET NULL;

-- Deduplication guard (Phase 7): the SAME source reporting the SAME external
-- record must resolve to at most one canonical event row. Cross-source
-- dedup is explicitly NOT attempted in Phase 1 (see lib/world/dedup.js
-- header comment for why the two vertical-slice sources don't overlap).
CREATE UNIQUE INDEX IF NOT EXISTS uq_world_events_source_external
  ON world_events(source_id, source_external_id) WHERE source_external_id IS NOT NULL;

ALTER TABLE world_events DISABLE ROW LEVEL SECURITY;

-- ─── WORLD ENTITIES (Phase 3) ─────────────────────────────────
-- One disciplined table, not one-table-per-type and not a single JSON blob.
-- `attributes` JSONB holds ONLY genuinely type-varying extensible metadata
-- (e.g. a COMMODITY's unit-of-measure, a CURRENCY's minor-unit count) — it is
-- explicitly NOT a dumping ground for fields that are the same shape across
-- many rows (those get real columns, as code/name/entity_type already are).
-- Tradeoff being made: normalizing further (e.g. a countries table with its
-- own FK) would buy referential integrity for one entity_type at the cost of
-- fragmenting queries that want to treat all entity types uniformly (e.g.
-- world_event_entities joins one table regardless of whether the entity is a
-- COUNTRY or a COMPANY); JSONB attributes buys flexibility for entity types
-- we don't yet know the full shape of (e.g. INFRASTRUCTURE) at the cost of
-- weaker validation on those columns. We accept that tradeoff for Phase 1
-- because the two vertical-slice sources only need COUNTRY/REGION/CURRENCY
-- entities today.
CREATE TABLE IF NOT EXISTS world_entities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   TEXT NOT NULL CHECK (entity_type IN (
                  'PERSON','ORGANIZATION','COMPANY','GOVERNMENT','COUNTRY','REGION','CITY',
                  'PORT','AIRPORT','FACILITY','INDUSTRY','COMMODITY','CURRENCY',
                  'PRODUCT_CATEGORY','TRANSPORT_ROUTE','ENERGY_ASSET','INFRASTRUCTURE',
                  'DISEASE','NATURAL_HAZARD','POLITICAL_BODY','REGULATION'
                )),
  code          TEXT,          -- stable canonical code where one exists (ISO country code, currency code, etc.); NULL for entities with no standard code
  slug          TEXT,          -- human-stable identifier, always populated, generated from name if no code
  name          TEXT NOT NULL,
  attributes    JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(entity_type, slug)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_world_entities_type_code ON world_entities(entity_type, code) WHERE code IS NOT NULL;
ALTER TABLE world_entities DISABLE ROW LEVEL SECURITY;

-- ─── WORLD EVENT <-> ENTITY (Phase 4) ────────────────────────
-- Which entities a given event concerns, and how. relationship_type is
-- CHECK-constrained to the mission's vocabulary now, extensible later via a
-- migration (never via free text) so it can never silently drift into an
-- unbounded ontology.
CREATE TABLE IF NOT EXISTS world_event_entities (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id           UUID NOT NULL REFERENCES world_events(id) ON DELETE CASCADE,
  entity_id          UUID NOT NULL REFERENCES world_entities(id) ON DELETE CASCADE,
  relationship_type  TEXT NOT NULL CHECK (relationship_type IN ('AFFECTS','INVOLVES','TARGETS','DISRUPTS','CHANGES')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(event_id, entity_id, relationship_type)
);
CREATE INDEX IF NOT EXISTS idx_wee_entity ON world_event_entities(entity_id);
CREATE INDEX IF NOT EXISTS idx_wee_event  ON world_event_entities(event_id);
ALTER TABLE world_event_entities DISABLE ROW LEVEL SECURITY;

-- ─── WORLD ENTITY <-> ENTITY (Phase 4) ───────────────────────
-- Relationships between entities that persist over TIME (not tied to a
-- single event) — e.g. PERSON LEADS ORGANIZATION, COMPANY OPERATES_IN
-- COUNTRY. valid_from/valid_to make these bitemporal-capable too (a CEO
-- change doesn't delete the old LEADS row, it closes valid_to and a new row
-- opens). relationship_type is again CHECK-constrained and documented, not
-- free text.
CREATE TABLE IF NOT EXISTS world_entity_relationships (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_entity_id     UUID NOT NULL REFERENCES world_entities(id) ON DELETE CASCADE,
  to_entity_id       UUID NOT NULL REFERENCES world_entities(id) ON DELETE CASCADE,
  relationship_type  TEXT NOT NULL CHECK (relationship_type IN (
                        'LEADS','OPERATES_IN','LOCATED_IN','DEPENDS_ON','SUPPLIES',
                        'OWNS','PART_OF','COMPETES_WITH','MEMBER_OF','REGULATES'
                      )),
  valid_from         TIMESTAMPTZ,
  valid_to           TIMESTAMPTZ,
  source_id          UUID REFERENCES world_sources(id) ON DELETE SET NULL,
  confidence         NUMERIC(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wer_from ON world_entity_relationships(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_wer_to   ON world_entity_relationships(to_entity_id);
ALTER TABLE world_entity_relationships DISABLE ROW LEVEL SECURITY;

-- ─── WORLD EVENT REVISIONS (Phase 5/15) ──────────────────────
-- world_events rows ARE updated in place when a correction arrives (e.g. USGS
-- revises a magnitude) — but never destructively: every field-level change
-- writes a revision row here FIRST capturing the old value, then the
-- world_events row's current-value column is updated. This is how the two
-- bitemporal questions are answered:
--   "What was true in the world at time T?"
--     -> filter world_events (or, for a specific field, walk
--        world_event_revisions ordered by revised_at and take the value
--        whose observed/valid window covers T) using observed_at/started_at/
--        ended_at/valid_from/valid_to.
--   "What did STARLANE know at time T?" (i.e. reconstruct the row as it
--   existed in our database at time T, regardless of what was later true)
--     -> take world_events.raw current value if ingested_at <= T and no
--        revision exists with revised_at between ingested_at and T; else walk
--        world_event_revisions for that event_id where revised_at <= T,
--        take the latest such revision per field_name, and use previous
--        world_event_revisions.new_value as of that revision (i.e. reconstruct
--        the field's value as it stood immediately after the last revision
--        at-or-before T).
CREATE TABLE IF NOT EXISTS world_event_revisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES world_events(id) ON DELETE CASCADE,
  field_name      TEXT NOT NULL,
  previous_value  TEXT,
  new_value       TEXT,
  source_id       UUID REFERENCES world_sources(id) ON DELETE SET NULL,
  revised_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wer_revisions_event ON world_event_revisions(event_id, revised_at DESC);
ALTER TABLE world_event_revisions DISABLE ROW LEVEL SECURITY;

-- ─── WORLD INGESTION CHECKPOINTS (Phase 13) ──────────────────
-- Resume-safe pagination/backfill state, one row per source (or per source +
-- logical stream if a source ever needs more than one cursor).
CREATE TABLE IF NOT EXISTS world_ingestion_checkpoints (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id             UUID NOT NULL REFERENCES world_sources(id) ON DELETE CASCADE,
  cursor_value          TEXT,       -- last_processed_marker: e.g. ISO date string or source-defined cursor
  last_run_at           TIMESTAMPTZ,
  status                TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','running','succeeded','failed')),
  last_error            TEXT,
  records_processed      INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_id)
);
ALTER TABLE world_ingestion_checkpoints DISABLE ROW LEVEL SECURITY;

-- ─── WORLD TRANSMISSION CHANNELS (Phase 9) ───────────────────
-- Small, deterministic reference catalog — reusable across many events, not
-- one row per event. Seeded with real example rows in migration 016.
CREATE TABLE IF NOT EXISTS world_transmission_channels (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_category           TEXT NOT NULL,   -- e.g. 'COMMODITIES','LOGISTICS','MONETARY_POLICY'
  affected_dimension       TEXT NOT NULL,   -- e.g. 'transport_cost','supplier_cost','lead_time','fx_exposure','borrowing_cost','landed_cost'
  direction                TEXT NOT NULL CHECK (direction IN ('increase','decrease','variable')),
  mechanism                TEXT NOT NULL,   -- short human-readable causal explanation
  applicability_conditions TEXT,            -- short text or JSON-in-text describing when this channel applies
  default_confidence       NUMERIC(4,3) CHECK (default_confidence IS NULL OR (default_confidence >= 0 AND default_confidence <= 1)),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(event_category, affected_dimension, mechanism)
);
ALTER TABLE world_transmission_channels DISABLE ROW LEVEL SECURITY;

-- ─── BUSINESS SIGNALS (Phase 10/11 — tenant-scoped) ──────────
-- The ONE table in this migration that is tenant-scoped (user_id), matching
-- this codebase's universal tenant-scoping convention (customers,
-- business_events, ai_actions, etc. all carry user_id). Links a world event
-- to a PLAUSIBLE tenant-specific consequence. MUST NEVER be queried across
-- tenants — every application-code query against this table must filter by
-- user_id (see lib/world/queries.js and the dedicated cross-tenant-leakage
-- test in scripts/test-phase19-world-intelligence.mjs).
CREATE TABLE IF NOT EXISTS business_signals (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  world_event_id            UUID NOT NULL REFERENCES world_events(id) ON DELETE CASCADE,
  related_entity_type       TEXT,     -- e.g. 'supplier','customer','product' (this tenant's own domain tables)
  related_entity_id         TEXT,     -- id within that tenant table; not an FK since it can point at any of several tenant tables
  transmission_channel_id   UUID REFERENCES world_transmission_channels(id) ON DELETE SET NULL,
  plausibility_confidence   NUMERIC(4,3) CHECK (plausibility_confidence IS NULL OR (plausibility_confidence >= 0 AND plausibility_confidence <= 1)),
  evidence_notes            TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bsig_user          ON business_signals(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bsig_user_event    ON business_signals(user_id, world_event_id);
CREATE INDEX IF NOT EXISTS idx_bsig_user_related  ON business_signals(user_id, related_entity_type, related_entity_id);
ALTER TABLE business_signals DISABLE ROW LEVEL SECURITY;

-- ─── INDEXES for Phase 16 query patterns (Phase 20) ──────────
-- Each justified against a query function actually implemented in
-- lib/world/queries.js:
-- getEventsForCountryInRange(country, from, to) -> event_type filter + time range + country_codes array membership
CREATE INDEX IF NOT EXISTS idx_we_country_time ON world_events USING GIN (country_codes);
CREATE INDEX IF NOT EXISTS idx_we_observed_at   ON world_events(observed_at DESC);
-- getRecentEventsByCategory(event_type, limit) -> filter by event_type ordered by observed_at
CREATE INDEX IF NOT EXISTS idx_we_type_observed ON world_events(event_type, observed_at DESC);
-- getEventsForEntity(entity_id) -> already served by idx_wee_entity above
-- getEventStatus/source lookups, and ingestion dedup checks by source
CREATE INDEX IF NOT EXISTS idx_we_source ON world_events(source_id);
CREATE INDEX IF NOT EXISTS idx_we_status ON world_events(status) WHERE status <> 'active';

SELECT 'Migration 015_world_intelligence_core complete' AS status;
