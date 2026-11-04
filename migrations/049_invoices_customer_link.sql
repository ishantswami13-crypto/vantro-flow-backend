-- Migration 049: invoices.customer_id — the FK the receivables code already reads
--
-- Found by running the agent test suite against a database built only from
-- this repo's migrations (scripts/migrate.js on an empty Postgres):
-- collectionsAgent.js and receivablesRiskAgent.js both SELECT
-- invoices.customer_id, and supabase-performance-indexes.sql indexes it, but
-- no migration ever created the column. Databases where it exists got it by
-- hand; every freshly bootstrapped database failed the collections agent on
-- its first query ("column customer_id does not exist").
--
-- Additive and nullable: existing rows keep customer_id NULL, which the agents
-- already handle by resolving the customer by name (scoring.service.js
-- resolveCustomerId). ON DELETE SET NULL so deleting a customer never deletes
-- a receivable. Safe to re-run.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_id UUID;

-- FK only when the column is UUID (a hand-added column of another type is left
-- untouched rather than failing the migration) and no FK exists yet.
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'invoices' AND column_name = 'customer_id') = 'uuid'
     AND NOT EXISTS (SELECT 1 FROM pg_constraint
        WHERE conrelid = 'invoices'::regclass AND contype = 'f'
          AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'invoices'::regclass AND attname = 'customer_id')])
  THEN
    ALTER TABLE invoices
      ADD CONSTRAINT invoices_customer_id_fkey
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_invoices_user_customer ON invoices(user_id, customer_id);
