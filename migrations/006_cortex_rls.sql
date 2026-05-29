-- ============================================================
-- VANTRO CORTEX X — RLS Migration 006 (DOCUMENTED, DO NOT AUTO-APPLY)
-- ============================================================
--
-- READ THIS FIRST.
--
-- The Vantro backend currently authenticates via custom JWT + Supabase
-- SERVICE ROLE key. Service role bypasses RLS. Enabling RLS therefore does
-- NOT secure server-side queries (they already work) and does NOT break them
-- (service role bypass remains). RLS is only useful when:
--
--   (a) the frontend ever talks to Supabase directly using the ANON key, or
--   (b) we ever expose Supabase to third-party tools / Edge Functions.
--
-- Right now neither is true. So this migration is included as a
-- defence-in-depth artifact, BUT MUST BE APPLIED MANUALLY after:
--
--   1. Confirming `auth.uid()` is correctly mapped from the JWT (it is NOT
--      mapped from our custom token today — that needs a Supabase Auth bridge
--      or a `request.jwt.claims.user_id` shim).
--   2. Running on a Supabase shadow project first.
--   3. Verifying every Cortex query still works via the service role.
--
-- TENANT MODEL: user_id. Multi-user-per-business (business_id) deferred.
--
-- ============================================================

-- Helper: map our custom JWT's user_id claim to a runtime variable.
-- Until we adopt Supabase Auth this remains a no-op for non-anon connections.
-- (Service role bypasses RLS entirely, so no policy is required for the backend.)

-- ─── Enable RLS on Cortex tables ───────────────────────────
ALTER TABLE customers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_actions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_plans           ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_calls         ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_decisions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE promises           ENABLE ROW LEVEL SECURITY;
ALTER TABLE followups          ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_scores    ENABLE ROW LEVEL SECURITY;
ALTER TABLE cashflow_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_memory    ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks              ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs      ENABLE ROW LEVEL SECURITY;

-- ─── Policies: user_id must match auth.uid() ──────────────
-- Template (repeat per table). Drop-if-exists for re-apply safety.

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'customers','business_events','ai_actions','ai_plans','tool_calls',
    'policy_decisions','audit_logs','promises','followups',
    'customer_scores','cashflow_events','business_memory','tasks','workflow_runs'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_isolation_select ON %I', tbl, tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I_isolation_modify ON %I', tbl, tbl);

    EXECUTE format($f$
      CREATE POLICY %I_isolation_select ON %I
        FOR SELECT
        USING (user_id = auth.uid())
    $f$, tbl, tbl);

    EXECUTE format($f$
      CREATE POLICY %I_isolation_modify ON %I
        FOR ALL
        USING      (user_id = auth.uid())
        WITH CHECK (user_id = auth.uid())
    $f$, tbl, tbl);
  END LOOP;
END $$;

-- ============================================================
-- Manual smoke-test after applying (run in SQL editor as anon role):
--   SET ROLE anon;
--   SELECT count(*) FROM ai_actions;  -- must return 0 (no auth.uid())
--   RESET ROLE;
-- ============================================================
