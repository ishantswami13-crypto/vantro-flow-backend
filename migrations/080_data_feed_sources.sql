-- Migration 080: more data feed sources.
--
--   tally   orders, purchase orders and stock read from Tally by the Starlane
--           bridge on the shop PC (tally-connector/tally-sync.mjs) and sent
--           with its device credential. Nothing is read from the server side.
--   sftp    the newest matching file in a folder on an SFTP server (an ERP's
--           or warehouse system's scheduled export). Password or private key
--           is AES-256-GCM encrypted in secret_enc and never returned.
--   email   the newest report emailed to the owner's connected Gmail from a
--           given sender (and subject), read with the gmail.readonly access
--           the owner already granted. Nothing is ever sent.
--
-- source_state keeps what a source needs between runs and is not a secret:
-- the SFTP server's host key fingerprint (pinned on first read, so a changed
-- server is refused), and the last file or message read.
--
-- Additive only: widens a CHECK and adds one column with a default.

ALTER TABLE data_feeds DROP CONSTRAINT IF EXISTS data_feeds_source_type_check;
ALTER TABLE data_feeds ADD CONSTRAINT data_feeds_source_type_check
  CHECK (source_type IN ('sheet_link', 'file_url', 'push', 'app', 'tally', 'sftp', 'email'));

ALTER TABLE data_feeds ADD COLUMN IF NOT EXISTS source_state JSONB NOT NULL DEFAULT '{}'::jsonb;
