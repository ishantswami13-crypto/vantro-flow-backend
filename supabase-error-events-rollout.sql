-- supabase-error-events-rollout.sql

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Table: error_events
CREATE TABLE IF NOT EXISTS error_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    error_id TEXT UNIQUE NOT NULL,
    request_id TEXT,
    source TEXT NOT NULL CHECK (source IN ('backend', 'frontend', 'webhook', 'worker')),
    type TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'error', 'critical')),
    status_code INTEGER,
    method TEXT,
    route TEXT,
    page TEXT,
    safe_message TEXT NOT NULL,
    fingerprint TEXT,
    stack_hash TEXT,
    user_id UUID,
    business_id UUID,
    session_hash TEXT,
    user_agent_hash TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    resolution_note TEXT
);

-- Indexes for fast admin querying and deduplication
CREATE INDEX IF NOT EXISTS idx_error_events_created_at ON error_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_events_type ON error_events (type);
CREATE INDEX IF NOT EXISTS idx_error_events_severity ON error_events (severity);
CREATE INDEX IF NOT EXISTS idx_error_events_request_id ON error_events (request_id);
CREATE INDEX IF NOT EXISTS idx_error_events_error_id ON error_events (error_id);
CREATE INDEX IF NOT EXISTS idx_error_events_business_id ON error_events (business_id);
CREATE INDEX IF NOT EXISTS idx_error_events_fingerprint ON error_events (fingerprint);

-- Row Level Security (RLS)
ALTER TABLE error_events ENABLE ROW LEVEL SECURITY;

-- Policies:
-- CREATE POLICY has no IF NOT EXISTS in any Postgres version, so a second run
-- of this file (setup:database is documented as safe to re-run) aborted at the
-- first CREATE POLICY with "policy ... already exists" — caught by the runner
-- as a per-file warning rather than fatal, but still not actually idempotent.
-- Dropping first, matching the pattern the paired rollback file already uses.

-- 1. Service Role / Admin can do everything
DROP POLICY IF EXISTS "Admins can view and manage error events" ON error_events;
CREATE POLICY "Admins can view and manage error events"
ON error_events
FOR ALL
TO authenticated
USING (auth.jwt() ->> 'role' = 'service_role' OR auth.jwt() ->> 'is_admin' = 'true');

-- 2. Normal users cannot read or write global errors directly via client SDK
-- (The backend Node.js server using SERVICE_ROLE will write the events)
DROP POLICY IF EXISTS "Users cannot access error events" ON error_events;
CREATE POLICY "Users cannot access error events"
ON error_events
FOR ALL
TO authenticated
USING (false);

DROP POLICY IF EXISTS "Anon cannot access error events" ON error_events;
CREATE POLICY "Anon cannot access error events"
ON error_events
FOR ALL
TO anon
USING (false);
