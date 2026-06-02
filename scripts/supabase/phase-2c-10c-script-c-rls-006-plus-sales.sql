-- ============================================================
-- RLS Migration 006 -- Vantro Cortex X + sales
-- Source: migrations/006_cortex_rls.sql + sales added.
-- Supabase staging ONLY (bbkbgnhycmfqosageqxa).
-- DO NOT apply to Railway Postgres -- auth.uid() is Supabase-specific.
-- Service role bypasses RLS entirely: zero backend impact.
-- Policies activate only if anon/user JWT role is ever used directly.
-- ============================================================

ALTER TABLE public.customers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_actions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_plans           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tool_calls         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.policy_decisions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promises           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.followups          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_scores    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cashflow_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_memory    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales              ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'customers', 'business_events', 'ai_actions', 'ai_plans', 'tool_calls',
    'policy_decisions', 'audit_logs', 'promises', 'followups',
    'customer_scores', 'cashflow_events', 'business_memory', 'tasks',
    'workflow_runs', 'sales'
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

SELECT 'RLS 006 + sales applied' AS status;
