-- tests/fixtures/outbound-ci-base.sql
-- The one pre-existing table migration 062 depends on (users), reduced to
-- the columns the outbound tests write. CI only: an empty throwaway
-- Postgres gets this, then 062 twice. Never applied to a real database.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  business_name TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
