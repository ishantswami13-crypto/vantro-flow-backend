-- supabase-error-events-rollback.sql

-- WARNING: This will permanently delete the error_events table and all stored error logs.
-- ONLY run this if the migration caused a severe production issue and needs immediate reversal.

-- 1. Drop Policies
DROP POLICY IF EXISTS "Admins can view and manage error events" ON error_events;
DROP POLICY IF EXISTS "Users cannot access error events" ON error_events;
DROP POLICY IF EXISTS "Anon cannot access error events" ON error_events;

-- 2. Disable RLS
ALTER TABLE error_events DISABLE ROW LEVEL SECURITY;

-- 3. Drop Indexes
DROP INDEX IF EXISTS idx_error_events_created_at;
DROP INDEX IF EXISTS idx_error_events_type;
DROP INDEX IF EXISTS idx_error_events_severity;
DROP INDEX IF EXISTS idx_error_events_request_id;
DROP INDEX IF EXISTS idx_error_events_error_id;
DROP INDEX IF EXISTS idx_error_events_business_id;
DROP INDEX IF EXISTS idx_error_events_fingerprint;

-- 4. Drop Table
DROP TABLE IF EXISTS error_events;

-- Note: We DO NOT drop the "uuid-ossp" extension here, because other existing tables
-- in Vantro (users, businesses, etc.) likely rely on it.
