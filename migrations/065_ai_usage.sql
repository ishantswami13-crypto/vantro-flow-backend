-- AI FinOps ledger for the model router (lib/ai/modelRouter.js): one row per
-- model call with provider, model, tokens, latency and outcome, scoped to the
-- tenant. The router enforces AI_DAILY_TOKEN_BUDGET from this table and keeps
-- working (budget unenforced, reported in /api/ai/health) until it exists.
-- Additive only.
CREATE TABLE IF NOT EXISTS ai_usage (
  id             BIGSERIAL PRIMARY KEY,
  user_id        UUID        NOT NULL,
  purpose        TEXT        NOT NULL DEFAULT 'chat',
  provider       TEXT        NOT NULL,
  model          TEXT        NOT NULL,
  input_tokens   INTEGER     NOT NULL DEFAULT 0,
  output_tokens  INTEGER     NOT NULL DEFAULT 0,
  latency_ms     INTEGER,
  ok             BOOLEAN     NOT NULL,
  error          TEXT,
  correlation_id TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_day ON ai_usage (user_id, created_at DESC);
