-- 095_data_layer_rls.sql
-- Row-level security that actually applies to the backend, for the data-layer
-- tables (090-094).
--
-- Why a role: the backend connects as the table owner, and owners bypass RLS,
-- so policies alone protect nothing on this path. withTenant() can instead run
-- each transaction as `starlane_app` (SET LOCAL ROLE, ends with the
-- transaction), a role with no BYPASSRLS, and the policies below then limit
-- every statement to the tenant in app.user_id, even one whose WHERE clause
-- forgets the tenant. Turned on by STARLANE_DB_TENANT_ROLE=starlane_app.
--
-- Scope: only the data layer's own tables. Legacy tables (invoices, customers,
-- ...) get SELECT for the role so read models can be built, and keep their
-- current RLS state; the wider rollout is still migration 006's job.
--
-- Additive and idempotent. Rollback: unset STARLANE_DB_TENANT_ROLE (nothing
-- else uses the role), then optionally
--   DROP POLICY tenant_isolation ON <each table below>;
--   DROP POLICY starlane_app_read ON invoices, customers, suppliers, products (one per table);
--   DROP ROLE starlane_app;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'starlane_app') THEN
    CREATE ROLE starlane_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  -- The connecting (migrating) user may switch to it with SET ROLE. A
  -- non-superuser migrator can only grant a role it administers: on Postgres
  -- 16 that is a role it created itself, so a starlane_app made earlier by
  -- another user (a second database on the same cluster, a dashboard user)
  -- cannot be granted from here. That must not stop the migration run: the
  -- role is only used when STARLANE_DB_TENANT_ROLE is set, and withTenant then
  -- fails closed ("permission denied to set role") until an admin runs
  --   GRANT starlane_app TO <app user>;
  IF NOT pg_has_role(current_user, 'starlane_app', 'MEMBER') THEN
    BEGIN
      EXECUTE format('GRANT starlane_app TO %I', current_user);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING 'starlane_app exists but % cannot be granted it. Leave STARLANE_DB_TENANT_ROLE unset until an admin runs: GRANT starlane_app TO %;', current_user, current_user;
    END;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO starlane_app;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA extensions TO starlane_app';
  END IF;
END $$;

-- Sources the read models, facts and search index are built from: read only,
-- and only the tenant's own rows. Some of these tables already have RLS on
-- (customers, keyed on auth.uid() for the API roles); this adds a separate
-- policy for starlane_app alone, so nothing changes for any other role. Where
-- RLS is still off, the policy is inert until it is turned on.
GRANT SELECT ON invoices, customers, suppliers, products TO starlane_app;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoices', 'customers', 'suppliers', 'products'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS starlane_app_read ON %I', t);
    EXECUTE format($p$CREATE POLICY starlane_app_read ON %I FOR SELECT TO starlane_app
                     USING (user_id::text = current_setting('app.user_id', true))$p$, t);
  END LOOP;
END $$;

-- Data-layer tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  starlane_cache, event_log, rm_receivables_tenant, rm_receivables_customer, rm_refresh_state,
  fact_invoices, fact_receivables_daily, fact_snapshot_days, search_entities
  TO starlane_app;
GRANT SELECT, UPDATE ON event_consumers TO starlane_app;
GRANT USAGE, SELECT ON SEQUENCE event_log_id_seq TO starlane_app;

-- One policy per tenant table: the row's tenant must be app.user_id, for reads
-- and for writes. An unset app.user_id matches nothing.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['event_log', 'rm_receivables_tenant', 'rm_receivables_customer', 'rm_refresh_state',
                           'fact_invoices', 'fact_receivables_daily', 'fact_snapshot_days', 'search_entities'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I FOR ALL TO starlane_app
                     USING (user_id::text = current_setting('app.user_id', true))
                     WITH CHECK (user_id::text = current_setting('app.user_id', true))$p$, t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS tenant_isolation ON starlane_cache;
CREATE POLICY tenant_isolation ON starlane_cache FOR ALL TO starlane_app
  USING (tenant_id = current_setting('app.user_id', true))
  WITH CHECK (tenant_id = current_setting('app.user_id', true));

-- Consumers have no tenant; the role may read and advance them.
DROP POLICY IF EXISTS app_consumers ON event_consumers;
CREATE POLICY app_consumers ON event_consumers FOR ALL TO starlane_app USING (true) WITH CHECK (true);

-- Partition creation needs CREATE on the schema, which starlane_app does not
-- get. Run these as their owner instead, with a fixed search_path.
ALTER FUNCTION starlane_ensure_month_partition(date) SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION starlane_lock_down_table(text) SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION starlane_ensure_month_partition(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION starlane_ensure_month_partition(date) TO starlane_app;
REVOKE ALL ON FUNCTION starlane_lock_down_table(text) FROM PUBLIC;
-- Supabase grants new functions to its API roles by default; these two must
-- never be callable through the API.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION starlane_ensure_month_partition(date) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION starlane_lock_down_table(text) FROM %I', r);
    END IF;
  END LOOP;
END $$;
