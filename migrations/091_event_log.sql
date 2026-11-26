-- 091_event_log.sql
-- L2 event log for the data access layer (lib/data/events).
--
-- event_log is both the business event history and the transactional outbox:
-- an event is appended in the same transaction as the change it describes, so
-- it exists if and only if that change committed.
--
-- Consumers read in commit order, not id order. A bigserial id is handed out
-- when a row is inserted, not when its transaction commits, so a reader that
-- walks ids can pass id 41 while the transaction holding id 40 is still open
-- and never see 40. Each row therefore records its transaction id (txid), and a
-- reader only takes rows whose transaction is older than every transaction
-- still in progress (txid < pg_snapshot_xmin(pg_current_snapshot())). Needs
-- Postgres 13+ (xid8); Supabase runs 15.
--
-- Additive and idempotent. Rollback:
--   DROP TABLE IF EXISTS event_consumers; DROP TABLE IF EXISTS event_log;
--   DROP FUNCTION IF EXISTS starlane_event_notify();

CREATE TABLE IF NOT EXISTS event_log (
  id               BIGSERIAL PRIMARY KEY,
  event_id         UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  user_id          UUID NOT NULL,
  stream           TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key  TEXT,
  txid             XID8 NOT NULL DEFAULT pg_current_xact_id(),
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT event_log_type_format CHECK (event_type ~ '^[a-z][a-z0-9_.]{1,80}$'),
  CONSTRAINT event_log_stream_len  CHECK (char_length(stream) BETWEEN 1 AND 200)
);

CREATE INDEX IF NOT EXISTS idx_event_log_commit_order ON event_log (txid, id);
CREATE INDEX IF NOT EXISTS idx_event_log_tenant       ON event_log (user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_stream       ON event_log (user_id, stream, id);
CREATE INDEX IF NOT EXISTS idx_event_log_type         ON event_log (event_type, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_log_idempotency
  ON event_log (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- One row per durable consumer: where it has read up to, and its last error.
CREATE TABLE IF NOT EXISTS event_consumers (
  name           TEXT PRIMARY KEY,
  last_txid      XID8 NOT NULL DEFAULT '0'::xid8,
  last_id        BIGINT NOT NULL DEFAULT 0,
  processed      BIGINT NOT NULL DEFAULT 0,
  last_error     TEXT,
  last_error_at  TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Wake listeners when events commit. NOTIFY is transactional: it is delivered
-- only if the inserting transaction commits. Listeners treat it as a hint and
-- read the log; a lost notification only delays processing until the next poll.
CREATE OR REPLACE FUNCTION starlane_event_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('starlane_events', '');
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_event_log_notify ON event_log;
CREATE TRIGGER trg_event_log_notify
  AFTER INSERT ON event_log
  FOR EACH STATEMENT EXECUTE FUNCTION starlane_event_notify();

-- Server-side only, like every table the backend owns.
ALTER TABLE event_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_consumers ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON event_log, event_consumers FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON event_log, event_consumers FROM authenticated';
  END IF;
END $$;
