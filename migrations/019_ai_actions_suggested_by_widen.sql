-- FILE: migrations/019_ai_actions_suggested_by_widen.sql
-- Day 1 sprint (2026-09-07): fix a real, verified-live data-loss bug.
--
-- migrations/001_cortex_foundation.sql defined ai_actions.suggested_by with
-- CHECK (suggested_by IN ('rule','ai','system')) — but every bounded agent
-- wired into orchestrator.service.js's runAllAgents (briefingAgent,
-- cashflowAgent, collectionsAgent, creditRiskAgent, dataQualityAgent,
-- inventoryAgent, and now receivablesRiskAgent) has always set
-- suggested_by to its own descriptive name ('credit_risk_agent',
-- 'cashflow_agent', etc.), never one of the three allowed values.
--
-- Verified against the real local dev DB (2026-09-07): every insert from
-- these agents has been silently rejected by this constraint since it was
-- introduced — action.service.js::create() catches the Postgres error,
-- logs it, and returns null; orchestrator.service.js's runAllAgents counts
-- "created" from the agent's returned spec count, not from a successful
-- insert, so this failure has never surfaced anywhere. Confirmed live:
-- `select suggested_by, count(*) from ai_actions group by suggested_by`
-- returns only {rule: 2} — zero rows from any agent despite 7 agents being
-- "wired" per the Day 1 audit.
--
-- This migration widens the CHECK to include every suggested_by value the
-- codebase actually uses today (grep-verified against
-- lib/services/agents/*.js and lib/services/orchestrator/*.js), so agent
-- output starts actually persisting. It does not change application code
-- behavior or shape — purely a schema fix to match code that has existed
-- for multiple phases. Additive or widening only; no data is deleted, no
-- column dropped, no existing row can violate the new, larger allow-list.
ALTER TABLE ai_actions DROP CONSTRAINT IF EXISTS ai_actions_suggested_by_check;

ALTER TABLE ai_actions ADD CONSTRAINT ai_actions_suggested_by_check
  CHECK (suggested_by IN (
    'rule',
    'ai',
    'system',
    'agent',
    'briefing_agent',
    'cashflow_agent',
    'collections_agent',
    'credit_risk_agent',
    'data_quality_agent',
    'inventory_agent',
    'receivables_risk_agent'
  ));
