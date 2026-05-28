# Supabase Apply Guide: Error Events Rollout

## Pre-requisites
- Ensure you have read `RLS_ERROR_EVENTS_STAGING_TEST_PLAN.md` and verified the migration safely in staging.
- Ensure you have access to the Supabase Production Dashboard.

## Where to Paste SQL
1. Open the Supabase Dashboard.
2. Navigate to the **SQL Editor** on the left sidebar.
3. Click **New Query**.
4. Paste the entire contents of `supabase-error-events-rollout.sql`.

## What to Check Before Running
- Read through the SQL. Ensure it says `CREATE TABLE IF NOT EXISTS error_events`.
- Verify the policies are explicitly scoped to `service_role` and `is_admin`.
- Ensure there are no destructive `DROP TABLE` or `DELETE` commands.

## Running the Migration
- Click the **Run** button in the bottom right of the SQL Editor.

## What Success Looks Like
- A green "Success" banner appears.
- The `error_events` table appears in the Table Editor with Row Level Security (RLS) marked as "Active".

## Verification Queries
Run this safely in the SQL Editor:
\`\`\`sql
SELECT count(*) FROM error_events;
\`\`\`
It should successfully return `0`.

## What Not To Do
- **DO NOT** turn off RLS manually from the Table Editor.
- **DO NOT** edit the RLS policies manually in the UI; always use code/migrations.

## WARNING
**DO NOT** set `ERROR_STORAGE_ENABLED=true` in Railway until you have fully verified that this migration has succeeded. If the backend attempts to write to a non-existent table, it will generate noisy fallback logs.

## Rollback Instructions
If something goes wrong (e.g., the table blocks unrelated queries, though highly unlikely since it's an isolated table):
1. Copy the contents of `supabase-error-events-rollback.sql`.
2. Run it in the SQL Editor to instantly drop the table and policies.
