-- One row per scheduled job per firing, claimed by whichever server instance
-- inserts it first (lib/jobs/scheduler.js). With more than one Railway
-- replica, every replica's node-cron fires the same schedule; without a claim,
-- the 9 AM dunning cycle, the morning briefing and the weekly scorecard would
-- each go out once per replica. Additive only. Rows older than 14 days are
-- removed by the scheduler.
CREATE TABLE IF NOT EXISTS cron_runs (
  job_key     TEXT        NOT NULL,
  slot        TIMESTAMPTZ NOT NULL,
  instance    TEXT,
  claimed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  error       TEXT,
  PRIMARY KEY (job_key, slot)
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_claimed ON cron_runs (claimed_at);
ALTER TABLE IF EXISTS cron_runs ENABLE ROW LEVEL SECURITY;

-- Hot paths without an index on (user_id, sort column):
--   inventory screen: stock_movements by user, newest first
--   weekly scorecard and call history: call_logs by user since a date
CREATE INDEX IF NOT EXISTS idx_stock_movements_user_moved ON stock_movements (user_id, moved_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_logs_user_called ON call_logs (user_id, called_at DESC);
