# Error Events RLS Staging Test Plan

**Goal:** Safely verify the `error_events` database schema and RLS policies on a staging environment before hitting production.

## Step 1: Backup
- Take a manual backup of the staging database via the Supabase dashboard.

## Step 2: Apply Migration
- Copy the contents of `supabase-error-events-rollout.sql`.
- Paste into the Supabase SQL Editor and execute.

## Step 3: Verify Table Exists
- Navigate to the Supabase Table Editor.
- Confirm `error_events` exists with all columns and RLS is marked as "Active".

## Step 4: Test Unauthenticated Access Blocked
- Attempt to read from `error_events` via the Supabase Data API using the `anon` key.
- Result should be an empty array or `401 Unauthorized`.

## Step 5: Test Normal User Read Blocked
- Use an authenticated frontend user's JWT to query `error_events`.
- Result must be an empty array (RLS policy block).

## Step 6: Test Admin/Service Read Works
- Using the backend Service Role key, query `error_events`.
- Result should return rows successfully.

## Step 7: Test Client Errors Writes Sanitized Event
- Enable `ERROR_STORAGE_ENABLED=true` in staging backend.
- Fire a `POST /api/client-errors` payload from the frontend.
- Verify the DB receives the insert and the payload was sanitized.

## Step 8: Test Admin Errors Page
- Log in as an Admin user.
- Navigate to `/admin/errors`.
- Verify the API routes return data and the UI loads cleanly.

## Step 9: Test Rollback
- Execute `supabase-error-events-rollback.sql`.
- Confirm the table and policies are cleanly removed without affecting other tables.

## Step 10: Production Checklist
- If all steps 1-9 pass, you are clear to apply this to the live Production database.
