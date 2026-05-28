# Railway Activation Guide: Error Storage

## Context
By default, the backend degrades gracefully to safe `console.error` logs if database storage is unavailable. Once the Supabase `error_events` table is created via the SQL rollout, you must activate the storage flag to persist errors for the Admin Dashboard.

## Prerequisites
- The `supabase-error-events-rollout.sql` migration MUST be successfully applied to the live Supabase Database.
- The `SUPABASE_SERVICE_ROLE_KEY` must be present in the Railway environment.

## How to Set the Env Var
1. Open your Vantro Backend project in the Railway Dashboard.
2. Navigate to the **Variables** tab.
3. Add a new variable:
   - **Key:** `ERROR_STORAGE_ENABLED`
   - **Value:** `true`

## How to Redeploy
- Adding or modifying a variable in Railway will automatically trigger a rolling redeployment. 
- Wait ~2 minutes for the new container to become active and pass health checks.

## How to Verify
1. Open the frontend and trigger a safe UI error, or manually fire a POST to `https://vantro-flow-backend-production.up.railway.app/api/client-errors`.
2. Open the Supabase Table Editor and check the `error_events` table. You should see 1 new row.
3. Open the Frontend Admin Dashboard at `/admin/errors` and ensure the error appears.

## How to Disable Quickly
If database writes become a bottleneck or the table grows too fast:
1. In Railway Variables, change `ERROR_STORAGE_ENABLED` to `false`.
2. The redeploy will safely revert Vantro back to console-only JSON logging.

## Logs to Watch
- Monitor Railway deploy logs for: `[OBSERVABILITY] Error events database storage: ENABLED`.
- Monitor for `PGRST` or `Supabase` errors indicating the table is missing or RLS is blocking the insert.
