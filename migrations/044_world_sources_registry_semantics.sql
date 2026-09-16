-- ============================================================
-- VANTRO STARLANE — Migration 044: world_sources registry semantics
-- ============================================================
-- Additive only. World Intelligence Phase 3C.
--
-- Problem: world_sources today (migration 015) has no way to distinguish a
-- real, continuously-refreshing external connector (USGS, Frankfurter/ECB)
-- from an internal fixture row used only by test scripts (provider =
-- 'TEST_SOURCE', dataset = 'phase19_test') or a sanctioned dev-demo reference
-- source (provider = 'manual_reference', dataset = '2xa_demo_events'). The
-- Sources UI previously worked around this with a hardcoded frontend
-- allowlist (REAL_WORLD_PROVIDERS in app/connections/page.tsx) — every future
-- client of world_sources would have had to reimplement that same guess.
--
-- Fix: make the distinction an explicit, queryable column on the table
-- itself, so /api/world/health (and any future caller) can filter correctly
-- without hardcoding provider names.
ALTER TABLE world_sources
  ADD COLUMN IF NOT EXISTS is_internal BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN world_sources.is_internal IS
  'true = this row is a test fixture or dev/demo reference source, not a real continuously-refreshing external connector. Sources UI and any health/status API should exclude is_internal=true rows from what it presents as production connector health.';

-- Backfill: the two rows that are demonstrably internal today, by the exact
-- fact that already distinguishes them (provider name), not a guess.
UPDATE world_sources SET is_internal = true
  WHERE provider = 'TEST_SOURCE' OR provider = 'manual_reference';
