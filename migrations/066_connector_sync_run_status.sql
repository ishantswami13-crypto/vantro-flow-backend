-- connector_sync_runs.status in production came from a table created before
-- 051 with DEFAULT 'RUNNING' and uppercase statuses. The connector only finishes
-- runs WHERE status = 'running', so every run started with the default stayed
-- 'RUNNING' forever: device-reported failures never closed it, and a sync that
-- succeeded wrote a second row instead of finishing the one it started.
--
-- Forward-only, no rows deleted:
--   - the default becomes 'running' (what 051 intended);
--   - legacy uppercase statuses become the lowercase values the code reads;
--   - runs still 'RUNNING' after an hour are closed as failed, with a reason,
--     so health and history stop counting them as in progress.
ALTER TABLE connector_sync_runs ALTER COLUMN status SET DEFAULT 'running';

UPDATE connector_sync_runs SET status = 'succeeded' WHERE status = 'SUCCEEDED';
UPDATE connector_sync_runs SET status = 'failed'    WHERE status = 'FAILED';

UPDATE connector_sync_runs
   SET status = 'failed',
       finished_at = COALESCE(finished_at, started_at),
       error = COALESCE(error, 'Never finished: started before migration 066 fixed the run status')
 WHERE status = 'RUNNING' AND started_at < now() - interval '1 hour';

UPDATE connector_sync_runs SET status = 'running' WHERE status = 'RUNNING';
