-- FILE: migrations/026_belief_revision.sql
-- STARLANE Day 4 — Part 8: Belief revision. Additive only — extends
-- migrations/025_predictions.sql without altering any existing column.
-- Links an old (superseded) prediction to the new one that replaced it, and
-- records why the belief changed, so revision history is never lost by
-- overwriting a row.

ALTER TABLE predictions ADD COLUMN IF NOT EXISTS supersedes_id UUID REFERENCES predictions(id);
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS superseded_by_id UUID REFERENCES predictions(id);
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS revision_trigger TEXT;   -- e.g. 'PAYMENT_RECEIVED', 'WORLD_SIGNAL', 'MANUAL'
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS revision_reason TEXT;    -- free-text, must cite real upstream delta
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS revised_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_predictions_supersedes ON predictions (supersedes_id);
CREATE INDEX IF NOT EXISTS idx_predictions_superseded_by ON predictions (superseded_by_id);
