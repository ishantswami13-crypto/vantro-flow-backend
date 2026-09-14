-- Migration 042: Investigations
--
-- NOT YET APPLIED. Written for review per explicit instruction — do not run
-- against any database (dev, staging, or production) without a human
-- reviewing this file first.
--
-- Purpose: give the existing intelligence loop (signal -> impact -> forecast
-- -> action -> outcome, already real via business_signals, predictions, and
-- ai_actions) a persisted "investigation" wrapper object, so a
-- bounded effort to understand a question can be tracked, named, and linked
-- back to the real evidence/forecast/decision that answered it — matching
-- the product's own core loop (Business Reality -> Evidence -> Understanding
-- -> Forecast -> Decision -> Action -> Verification -> Memory).
--
-- Design decisions:
--   1. An investigation can originate from an existing intelligence_signal
--      (source_signal_id, nullable) OR from a free-text question typed by a
--      user with no matching signal yet (question column, nullable only
--      when source_signal_id is set). Exactly one of the two must be
--      present — enforced by a CHECK constraint — so an investigation is
--      never created with neither a real trigger nor a real question.
--   2. status is a small, real state machine (open/answered/closed), not an
--      invented richer one — matches what the frontend can actually render
--      today (see StatusBadge conventions already in the frontend repo).
--   3. investigation_links is a separate join table (not JSONB arrays on
--      investigations) so links to evidence/forecasts/actions/artifacts stay
--      queryable and referentially checkable, and so adding a new linkable
--      object type later never requires an investigations schema change.
--   4. No "workspace_id" column. Workspaces do not exist as a persisted
--      concept anywhere in this schema (see migration 021's own comment:
--      one user = one business, enforced 1:1 today) — adding a fake
--      workspace_id here would imply a multi-context model this database
--      does not have. If workspaces are built later, add the column then.

CREATE TABLE IF NOT EXISTS investigations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_signal_id UUID REFERENCES business_signals(id) ON DELETE SET NULL,
  question TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status = ANY (ARRAY['open'::text, 'answered'::text, 'closed'::text])),
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT investigations_has_trigger_or_question
    CHECK (source_signal_id IS NOT NULL OR (question IS NOT NULL AND length(trim(question)) > 0))
);

CREATE INDEX IF NOT EXISTS idx_investigations_user_id ON investigations(user_id);
CREATE INDEX IF NOT EXISTS idx_investigations_source_signal_id ON investigations(source_signal_id) WHERE source_signal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_investigations_status ON investigations(user_id, status);

CREATE TABLE IF NOT EXISTS investigation_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  -- Deliberately a text discriminator + text id, not per-type FK columns,
  -- because the linkable object set already spans multiple existing tables
  -- (business_signals, predictions, ai_actions) with no
  -- shared parent to foreign-key against, and will grow (artifacts do not
  -- exist as a table yet). A CHECK constraint keeps the discriminator
  -- closed to real, currently-linkable object types only.
  object_type TEXT NOT NULL CHECK (object_type = ANY (ARRAY['evidence'::text, 'forecast'::text, 'action'::text])),
  object_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_investigation_links_investigation_id ON investigation_links(investigation_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_investigation_links_object ON investigation_links(investigation_id, object_type, object_id);

ALTER TABLE IF EXISTS investigations ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS investigation_links ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE investigations IS
  'A bounded effort to understand a question, anomaly, or change. Wraps the existing intelligence loop; does not replace business_signals/predictions/ai_actions. NOT YET APPLIED — review before running.';
COMMENT ON COLUMN investigations.question IS 'User-typed question. NULL only when source_signal_id is set (the signal itself is the trigger).';
COMMENT ON TABLE investigation_links IS
  'Join table linking an investigation to the real evidence/forecast/action objects that answered it. object_type is closed to types that actually exist as tables today.';
