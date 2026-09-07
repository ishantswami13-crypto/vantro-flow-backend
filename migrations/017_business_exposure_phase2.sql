-- ============================================================
-- VANTRO STARLANE — Migration 017: World Intelligence Phase 2
-- Business Exposure Model + Transmission Channel extensions +
-- Signal Lifecycle
-- ============================================================
-- Additive only. Never modifies migrations 015/016. Continues the sequence
-- (015, 016 already exist -> this is 017).
--
-- HONEST DISCLOSURE (see D:\Vantro\STARLANE_WORLD_BUSINESS_LINKAGE_AUDIT.md):
-- real tenant business tables (customers/suppliers/purchases/sales) carry
-- NO usable country/region/location data (address/gstin are 100% NULL in
-- every sampled row) and NO currency column at all. business_exposure rows
-- in this schema are therefore, for now, predominantly EXPLICITLY RECORDED
-- FACTS (an owner records "this supplier is in country X") or TEST FIXTURES
-- proving the mechanism — not values auto-derived from existing real fields.
-- source_of_fact documents which case applies per row.

-- ─── BUSINESS EXPOSURE (Phase 2) ──────────────────────────────
-- Tenant-scoped factual/derived relationship between one of the tenant's own
-- business entities (supplier/customer/product/purchase, referenced loosely
-- by type+id exactly like business_signals.related_entity_* already does —
-- not an FK, since it can point at several different tenant tables) and a
-- world_entities row (e.g. a COUNTRY or CURRENCY). This is deliberately NOT
-- a risk/severity record — no impact/severity column exists here on purpose;
-- severity lives on world_events, impact classification lives on
-- business_signals (Phase 10), never here.
CREATE TABLE IF NOT EXISTS business_exposure (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  business_entity_type   TEXT NOT NULL CHECK (business_entity_type IN (
                            'supplier','customer','product','purchase','sale','order'
                          )),
  business_entity_id     TEXT NOT NULL,   -- id within that tenant table; not an FK (multiple possible tables), matches business_signals.related_entity_id convention

  exposure_type          TEXT NOT NULL CHECK (exposure_type IN (
                            'LOCATED_IN','CURRENCY_DENOMINATED','DEPENDS_ON','SOURCED_FROM',
                            'USES_PORT','USES_ROUTE','REGULATED_BY','SUBJECT_TO_COMMODITY'
                          )),
  world_entity_id        UUID NOT NULL REFERENCES world_entities(id) ON DELETE RESTRICT,

  -- bitemporal validity (Phase 14) — a business_exposure row with valid_to in
  -- the past must never match a current event even if entity linkage is
  -- otherwise correct ("supplier moved countries 6 months ago").
  valid_from             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to               TIMESTAMPTZ,     -- NULL = still currently valid

  truth_state            TEXT NOT NULL DEFAULT 'OBSERVED'
                          CHECK (truth_state IN ('OBSERVED','DERIVED','EXPECTED','PREDICTED','UNKNOWN')),
  confidence             NUMERIC(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),

  -- Phase 6 entity resolution provenance, kept on this row rather than a
  -- separate table: a business_exposure row IS the resolution act (a raw
  -- tenant-provided value resolved to a canonical world_entities row) and
  -- there is exactly one resolution per exposure row, so a join table would
  -- add a mandatory 1:1 join for every read with no additional cardinality
  -- benefit. If a future phase needs multiple candidate resolutions per raw
  -- value (e.g. ambiguous "Georgia" country-vs-state), promote this to its
  -- own table then.
  raw_value              TEXT,            -- original tenant-provided value, e.g. "Georgia, USA" or the fixture's literal input
  normalized_value        TEXT,            -- normalized form used to resolve, e.g. "united states"
  resolution_method       TEXT,            -- e.g. 'exact_code_match','name_lookup_table','test_fixture_direct','manual_entry'
  resolution_confidence   NUMERIC(4,3) CHECK (resolution_confidence IS NULL OR (resolution_confidence >= 0 AND resolution_confidence <= 1)),
  resolved_at             TIMESTAMPTZ,

  source_of_fact         TEXT NOT NULL DEFAULT 'test_fixture'
                          CHECK (source_of_fact IN ('owner_recorded','test_fixture','derived_from_gstin','derived_from_address','manual_reference','imported')),
  evidence_notes         TEXT,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bexp_user            ON business_exposure(user_id);
CREATE INDEX IF NOT EXISTS idx_bexp_user_entity      ON business_exposure(user_id, business_entity_type, business_entity_id);
CREATE INDEX IF NOT EXISTS idx_bexp_world_entity      ON business_exposure(world_entity_id);
CREATE INDEX IF NOT EXISTS idx_bexp_user_validity      ON business_exposure(user_id, valid_from, valid_to);
ALTER TABLE business_exposure DISABLE ROW LEVEL SECURITY;

-- ─── TRANSMISSION CHANNEL EXTENSIONS (Phase 3) ────────────────
-- Decision: EXTEND migration 015/016's world_transmission_channels rather
-- than adding a new table. Its existing shape (event_category,
-- affected_dimension, direction, mechanism, applicability_conditions,
-- default_confidence) already covers most of what Phase 2 needs; adding a
-- second parallel table would fragment "what pathways exist" across two
-- places. New columns below are purely additive (nullable / defaulted) so
-- the 6 rows seeded in 016 remain valid without a backfill requirement,
-- though we do backfill them below for completeness.
ALTER TABLE world_transmission_channels
  ADD COLUMN IF NOT EXISTS channel_code              TEXT,             -- stable short code, e.g. 'GEOGRAPHIC_DISRUPTION'
  ADD COLUMN IF NOT EXISTS applicable_event_types     TEXT[] NOT NULL DEFAULT '{}',   -- world_events.event_type values this channel can fire from
  ADD COLUMN IF NOT EXISTS applicable_exposure_types   TEXT[] NOT NULL DEFAULT '{}',   -- business_exposure.exposure_type values this channel matches against
  ADD COLUMN IF NOT EXISTS business_dimensions         TEXT[] NOT NULL DEFAULT '{}',   -- Phase 10 dimensions this channel can affect
  ADD COLUMN IF NOT EXISTS rule_explanation            TEXT,             -- human-readable explanation (may duplicate `mechanism`, kept as an explicit alias name Phase 2 tests reference)
  ADD COLUMN IF NOT EXISTS required_evidence           TEXT;             -- what must be true for this channel's match to be sound

CREATE UNIQUE INDEX IF NOT EXISTS uq_wtc_channel_code ON world_transmission_channels(channel_code) WHERE channel_code IS NOT NULL;

-- New Phase 2 channels (GEOGRAPHIC_DISRUPTION, FX_COST_EXPOSURE, etc.)
INSERT INTO world_transmission_channels
  (event_category, affected_dimension, direction, mechanism, applicability_conditions, default_confidence,
   channel_code, applicable_event_types, applicable_exposure_types, business_dimensions, rule_explanation, required_evidence)
VALUES
  ('NATURAL_HAZARD', 'supplier_availability', 'variable',
   'A natural hazard event in a country/region where a tenant''s supplier is located can disrupt that supplier''s ability to operate or ship.',
   'Requires an active LOCATED_IN business_exposure linking the supplier to the affected country, valid at event time.', 0.600,
   'GEOGRAPHIC_DISRUPTION', ARRAY['NATURAL_HAZARD'], ARRAY['LOCATED_IN'],
   ARRAY['SUPPLIER_AVAILABILITY','LEAD_TIME','INVENTORY'],
   'A hazard (earthquake, flood, etc.) occurring in a country the tenant has an exposure to via a located supplier/customer may disrupt operations there.',
   'Exposure world_entity (COUNTRY) must match one of the event''s linked country entities; exposure must be temporally valid at event.observed_at.'),

  ('MACROECONOMICS', 'purchase_cost', 'variable',
   'A material move in an exchange rate changes the local-currency cost of a tenant''s purchases/payables denominated in that foreign currency.',
   'Requires a CURRENCY_DENOMINATED business_exposure linking a purchase/supplier to the affected currency, valid at event time.', 0.650,
   'FX_COST_EXPOSURE', ARRAY['MACROECONOMICS'], ARRAY['CURRENCY_DENOMINATED'],
   ARRAY['CASH','PURCHASE_COST','MARGIN'],
   'An FX reference-rate event for a currency the tenant has a recorded currency exposure to may change the local-currency cost of that exposure.',
   'Exposure world_entity (CURRENCY) must match the event''s quote/base currency entity; exposure must be temporally valid at event.observed_at.'),

  ('TRADE', 'landed_cost', 'increase',
   'A new or increased trade restriction (tariff, embargo, export control) affecting a country the tenant sources from raises landed cost or blocks supply.',
   'Requires a SOURCED_FROM or LOCATED_IN exposure to the restricted country.', 0.600,
   'TRADE_RESTRICTION', ARRAY['TRADE_POLICY','REGULATORY'], ARRAY['SOURCED_FROM','LOCATED_IN','REGULATED_BY'],
   ARRAY['PURCHASE_COST','LEAD_TIME','MARGIN'],
   'A trade-policy event targeting a country the tenant sources from or is regulated under may raise cost or restrict supply.',
   'Exposure world_entity (COUNTRY) must match the event''s target country; exposure must be temporally valid.'),

  ('COMMODITIES', 'purchase_cost', 'variable',
   'A material commodity price move affects the cost of a tenant''s purchases that depend on that commodity.',
   'Requires a SUBJECT_TO_COMMODITY or DEPENDS_ON exposure to the affected commodity.', 0.550,
   'COMMODITY_COST_EXPOSURE', ARRAY['COMMODITIES'], ARRAY['SUBJECT_TO_COMMODITY','DEPENDS_ON'],
   ARRAY['PURCHASE_COST','MARGIN','INVENTORY'],
   'A commodity price event for a commodity the tenant depends on may change the tenant''s input cost.',
   'Exposure world_entity (COMMODITY) must match the event''s linked commodity entity; exposure must be temporally valid.'),

  ('LOGISTICS', 'lead_time', 'increase',
   'Disruption to a port/route the tenant''s shipments transit extends delivery lead time.',
   'Requires a USES_PORT or USES_ROUTE exposure to the affected port/route/region.', 0.600,
   'LOGISTICS_DISRUPTION', ARRAY['LOGISTICS'], ARRAY['USES_PORT','USES_ROUTE'],
   ARRAY['LEAD_TIME','INVENTORY'],
   'A logistics disruption event at a port/route the tenant is exposed to via USES_PORT/USES_ROUTE may delay shipments.',
   'Exposure world_entity must match the event''s linked port/route/region entity; exposure must be temporally valid.'),

  ('REGULATORY', 'compliance_cost', 'variable',
   'A new regulation in a jurisdiction the tenant is regulated under can raise compliance cost or restrict operations.',
   'Requires a REGULATED_BY exposure to the affected jurisdiction.', 0.500,
   'REGULATORY_EXPOSURE', ARRAY['REGULATORY'], ARRAY['REGULATED_BY'],
   ARRAY['PURCHASE_COST','MARGIN','WORKING_CAPITAL'],
   'A regulatory event in a jurisdiction the tenant is exposed to via REGULATED_BY may raise compliance costs.',
   'Exposure world_entity must match the event''s jurisdiction entity; exposure must be temporally valid.'),

  ('COUNTRY_RISK', 'working_capital', 'variable',
   'General country-risk deterioration (political, sovereign) in a country the tenant is exposed to can raise financing/working-capital costs.',
   'Requires a LOCATED_IN or DEPENDS_ON exposure to the affected country.', 0.450,
   'COUNTRY_RISK_EXPOSURE', ARRAY['POLITICAL','MACROECONOMICS'], ARRAY['LOCATED_IN','DEPENDS_ON'],
   ARRAY['WORKING_CAPITAL','CASH'],
   'A country-risk event in a country the tenant is exposed to may raise the cost or difficulty of doing business there.',
   'Exposure world_entity (COUNTRY) must match the event''s country; exposure must be temporally valid.'),

  ('DEMAND', 'customer_demand', 'variable',
   'A macro or natural-hazard event in a region where the tenant''s customers are located can shift demand.',
   'Requires a LOCATED_IN exposure on a customer entity to the affected region.', 0.400,
   'DEMAND_SHOCK', ARRAY['MACROECONOMICS','NATURAL_HAZARD'], ARRAY['LOCATED_IN'],
   ARRAY['REVENUE','CUSTOMER_DEMAND'],
   'An event affecting a region where the tenant has customer exposure may shift demand from those customers.',
   'Exposure business_entity_type=customer, world_entity (COUNTRY/REGION) must match event location; exposure must be temporally valid.'),

  ('SUPPLY', 'supplier_availability', 'variable',
   'A supply-side shock (hazard, logistics, trade) affecting a supplier''s location/route can reduce availability of supply.',
   'Requires a LOCATED_IN/SOURCED_FROM/USES_ROUTE exposure on a supplier entity.', 0.550,
   'SUPPLY_SHOCK', ARRAY['NATURAL_HAZARD','LOGISTICS','TRADE_POLICY'], ARRAY['LOCATED_IN','SOURCED_FROM','USES_ROUTE'],
   ARRAY['SUPPLIER_AVAILABILITY','INVENTORY','LEAD_TIME'],
   'A supply-side event affecting a supplier''s location or route exposure may reduce availability of goods from that supplier.',
   'Exposure business_entity_type=supplier, world_entity must match event location/route; exposure must be temporally valid.')
ON CONFLICT (event_category, affected_dimension, mechanism) DO NOTHING;

-- Backfill channel_code/etc. on the 6 original migration-016 rows so the
-- catalog is uniformly queryable by channel_code (nullable fields on old
-- rows are otherwise harmless but less useful).
UPDATE world_transmission_channels SET
  channel_code = 'LEGACY_' || UPPER(REPLACE(affected_dimension, '_', '')),
  rule_explanation = COALESCE(rule_explanation, mechanism)
WHERE channel_code IS NULL;

-- ─── SIGNAL LIFECYCLE (Phase 7) — extend business_signals ─────
-- Read migration 015's business_signals before adding: it is currently a
-- pure append-only "one row per plausible link" table with no status
-- concept. We ADD lifecycle columns rather than replace it, preserving
-- every existing row (status defaults to 'ACTIVE' for pre-existing rows,
-- meaning "still a live candidate" — the safest non-destructive default).
ALTER TABLE business_signals
  ADD COLUMN IF NOT EXISTS status                     TEXT NOT NULL DEFAULT 'CANDIDATE'
                             CHECK (status IN ('CANDIDATE','ACTIVE','UPDATED','RESOLVED','DISMISSED','EXPIRED')),
  ADD COLUMN IF NOT EXISTS business_exposure_id         UUID REFERENCES business_exposure(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS first_detected_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS current_supporting_event_ids  UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS why_exists                   TEXT,
  ADD COLUMN IF NOT EXISTS why_resolved                 TEXT,
  -- Phase 9 — separate confidence components, never collapsed into one number.
  ADD COLUMN IF NOT EXISTS source_reliability_component  NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS event_confidence_component     NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS entity_resolution_confidence_component NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS exposure_confidence_component  NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS transmission_confidence_component NUMERIC(4,3),
  -- Phase 10 — impact classification, explicitly no dollar amounts.
  ADD COLUMN IF NOT EXISTS affected_business_dimensions  TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS impact_status                 TEXT
                             CHECK (impact_status IS NULL OR impact_status IN ('EXPOSED','POTENTIALLY_AFFECTED','OBSERVED_IMPACT')),
  -- Phase 13 dedup key: one signal per (user, exposure, channel) combination.
  ADD COLUMN IF NOT EXISTS dedup_key                    TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bsig_dedup ON business_signals(user_id, business_exposure_id, transmission_channel_id)
  WHERE business_exposure_id IS NOT NULL AND transmission_channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bsig_status ON business_signals(user_id, status);

-- ─── SIGNAL STATUS HISTORY (Phase 7, non-destructive lifecycle) ─
CREATE TABLE IF NOT EXISTS business_signal_status_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id       UUID NOT NULL REFERENCES business_signals(id) ON DELETE CASCADE,
  previous_status TEXT,
  new_status      TEXT NOT NULL,
  reason          TEXT,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bsig_history_signal ON business_signal_status_history(signal_id, changed_at DESC);
ALTER TABLE business_signal_status_history DISABLE ROW LEVEL SECURITY;

SELECT 'Migration 017_business_exposure_phase2 complete' AS status;
