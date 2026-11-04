-- Migration 053: the persistence the seven features need and did not have
--
-- 1. watch_events — what Watch noticed, one row per real-world condition.
--    dedupe_key makes re-detection a no-op (an invoice crossing 31 days is one
--    event, however many times Watch looks). Explicit state machine:
--      open -> acknowledged -> resolved   (or open/acknowledged -> dismissed)
--    'resolved' is set by Watch itself when the condition clears (the invoice
--    was paid, the sync recovered); 'dismissed' only by the owner.
-- 2. missions — an objective Starlane works towards over a horizon.
--      draft -> active <-> paused -> completed | failed | cancelled
--    baseline is frozen at activation so progress is measured against what was
--    true then, not against a moving target.
-- 3. ai_actions.mission_id — actions a mission proposed. They go through the
--    same approval/execution path as every other action; nothing bypasses it.
-- 4. memory_records — what Starlane has learned, with provenance. Inferred
--    records come from data and can be confirmed, corrected or removed by the
--    owner; a removed record is never re-inferred (status stays 'removed').
-- Additive. Safe to re-run.

CREATE TABLE IF NOT EXISTS watch_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,     -- invoice_overdue | sync_failed | sync_stale | watch_triggered | promise_broken
  dedupe_key       TEXT NOT NULL,
  severity         TEXT NOT NULL DEFAULT 'normal' CHECK (severity IN ('low', 'normal', 'high', 'critical')),
  state            TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  title            TEXT NOT NULL,
  detail           TEXT,
  entity_type      TEXT,
  entity_id        TEXT,
  evidence         JSONB NOT NULL DEFAULT '{}'::jsonb,
  mission_id       UUID,
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at  TIMESTAMPTZ,
  resolved_at      TIMESTAMPTZ,
  resolution       TEXT,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_watch_events_user_state ON watch_events (user_id, state, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_watch_events_entity ON watch_events (user_id, entity_type, entity_id);
ALTER TABLE watch_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS missions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('collections')),
  status        TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'active', 'paused', 'completed', 'failed', 'cancelled')),
  title         TEXT NOT NULL,
  objective     TEXT NOT NULL,
  target        JSONB NOT NULL,           -- { amount, invoiceIds[] }
  horizon_days  INTEGER NOT NULL CHECK (horizon_days BETWEEN 1 AND 180),
  constraints   JSONB NOT NULL DEFAULT '{}'::jsonb,
  baseline      JSONB,                    -- frozen at activation
  outcome       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at  TIMESTAMPTZ,
  ends_at       TIMESTAMPTZ,
  closed_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_missions_user_status ON missions (user_id, status, updated_at DESC);
ALTER TABLE missions ENABLE ROW LEVEL SECURITY;

ALTER TABLE ai_actions ADD COLUMN IF NOT EXISTS mission_id UUID REFERENCES missions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ai_actions_mission ON ai_actions (user_id, mission_id) WHERE mission_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_records (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_type   TEXT NOT NULL CHECK (subject_type IN ('customer', 'business')),
  subject_key    TEXT NOT NULL,           -- customer: normalised name; business: 'self'
  subject_label  TEXT NOT NULL,
  topic          TEXT NOT NULL,           -- payment_timing | open_exposure | mission_result | note
  statement      TEXT NOT NULL,
  value          JSONB,
  status         TEXT NOT NULL DEFAULT 'inferred' CHECK (status IN ('inferred', 'confirmed', 'corrected', 'removed')),
  provenance     JSONB NOT NULL,          -- { source, table, ids[], method, sampleSize }
  observed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  stale_after    TIMESTAMPTZ,
  decided_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, subject_type, subject_key, topic)
);
CREATE INDEX IF NOT EXISTS idx_memory_user_status ON memory_records (user_id, status, updated_at DESC);
ALTER TABLE memory_records ENABLE ROW LEVEL SECURITY;

-- A paused, cancelled or closed mission's actions cannot be approved by ANY
-- path (desktop, mobile, web, WhatsApp approval link): enforced here, not
-- only in one route.
CREATE OR REPLACE FUNCTION starlane_mission_holds_approval() RETURNS trigger AS $$
DECLARE m_status TEXT;
BEGIN
  IF NEW.mission_id IS NOT NULL AND NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' THEN
    SELECT status INTO m_status FROM missions WHERE id = NEW.mission_id;
    IF m_status IS NOT NULL AND m_status <> 'active' THEN
      RAISE EXCEPTION 'mission_not_active: the mission for this action is %', m_status USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_mission_holds_approval ON ai_actions;
CREATE TRIGGER trg_mission_holds_approval BEFORE UPDATE OF status ON ai_actions
  FOR EACH ROW EXECUTE FUNCTION starlane_mission_holds_approval();
