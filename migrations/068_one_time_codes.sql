-- Sign-up verification codes, phone sign-in codes and app sign-in handoffs
-- (lib/auth/oneTimeCodes.js). They were held in each server's memory, so a
-- code sent by one Railway replica failed on another, and a redeploy in the
-- middle of a sign-up lost it. Only a SHA-256 hash of each code is stored.
-- Additive only; expired rows are removed by the app.
CREATE TABLE IF NOT EXISTS one_time_codes (
  key        TEXT        PRIMARY KEY,
  hash       TEXT        NOT NULL,
  data       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts   INT         NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_one_time_codes_expires ON one_time_codes (expires_at);
ALTER TABLE IF EXISTS one_time_codes ENABLE ROW LEVEL SECURITY;
