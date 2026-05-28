-- ============================================================
-- VANTRO CORTEX — Foundation Migration 001
-- Safe to run multiple times (uses IF NOT EXISTS everywhere)
-- Tenant key: user_id (matches existing schema; business_id rename in migration 004)
-- Run: Supabase Dashboard → SQL Editor → paste and execute
-- ============================================================

-- ─── CUSTOMERS (master party table) ─────────────────────────
-- Derived from denormalized customer_name across invoices/sales.
-- Backfill via: node scripts/backfill-customers.js
CREATE TABLE IF NOT EXISTS customers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  phone           TEXT,
  email           TEXT,
  gstin           TEXT,
  address         TEXT,
  tags            JSONB DEFAULT '[]',
  is_active       BOOLEAN DEFAULT TRUE,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_customers_user_id ON customers(user_id);
CREATE INDEX IF NOT EXISTS idx_customers_name    ON customers(user_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_user_name_phone ON customers(user_id, lower(name), COALESCE(lower(phone), ''));

-- ─── BUSINESS EVENTS (immutable event log) ───────────────────
-- Every meaningful business action becomes an event here.
-- Never update or delete rows — append only.
-- event_type values: SALE_CREATED, PURCHASE_CREATED, RECEIVABLE_CREATED,
--   PAYMENT_RECEIVED, PROMISE_CREATED, PROMISE_BROKEN, FOLLOWUP_CREATED,
--   FOLLOWUP_SENT, STOCK_REDUCED, STOCK_INCREASED, LOW_STOCK_DETECTED,
--   CASHFLOW_UPDATED, AI_ACTION_CREATED, AI_ACTION_APPROVED, AI_ACTION_REJECTED,
--   CUSTOMER_RISK_UPDATED, CREDIT_HOLD_SUGGESTED, SALE_UPDATED, SALE_CANCELLED,
--   PURCHASE_UPDATED, INVENTORY_UPDATED, PAYABLE_CREATED
CREATE TABLE IF NOT EXISTS business_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  entity_type     TEXT,
  entity_id       TEXT,
  actor_type      TEXT NOT NULL DEFAULT 'user',  -- user | system | ai
  actor_id        TEXT,
  payload_json    JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bevents_user_id    ON business_events(user_id);
CREATE INDEX IF NOT EXISTS idx_bevents_event_type ON business_events(user_id, event_type);
CREATE INDEX IF NOT EXISTS idx_bevents_entity     ON business_events(user_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_bevents_created_at ON business_events(user_id, created_at DESC);

-- ─── AI ACTIONS (owner action queue) ─────────────────────────
-- Every AI/rule-generated action the owner needs to review or act on.
-- status: pending | approved | rejected | done | expired | system_blocked
-- priority: low | medium | high | urgent
-- suggested_by: rule | ai | system
-- action_type values: CHASE_CUSTOMER, SEND_POLITE_REMINDER, SEND_FIRM_REMINDER,
--   CALL_CUSTOMER, ASK_PARTIAL_PAYMENT, ESCALATE_TO_OWNER, STOP_CREDIT_WARNING,
--   RESOLVE_DISPUTE, LOW_STOCK_ALERT, PURCHASE_SUGGESTION, SUPPLIER_PAYMENT_DUE,
--   CASHFLOW_RISK, DAILY_OWNER_BRIEFING
CREATE TABLE IF NOT EXISTS ai_actions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_type           TEXT NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT,
  priority              TEXT NOT NULL DEFAULT 'medium'
                          CHECK (priority IN ('low','medium','high','urgent')),
  related_entity_type   TEXT,
  related_entity_id     TEXT,
  customer_id           UUID REFERENCES customers(id) ON DELETE SET NULL,
  supplier_id           UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','approved','rejected','done','expired','system_blocked')),
  suggested_by          TEXT NOT NULL DEFAULT 'rule'
                          CHECK (suggested_by IN ('rule','ai','system')),
  reason_json           JSONB,
  recommended_message   TEXT,
  risk_level            TEXT NOT NULL DEFAULT 'low'
                          CHECK (risk_level IN ('low','medium','high')),
  requires_approval     BOOLEAN DEFAULT FALSE,
  block_reason          TEXT,
  approved_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at           TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_actions_user_id    ON ai_actions(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_actions_status     ON ai_actions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_ai_actions_priority   ON ai_actions(user_id, priority, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_actions_customer   ON ai_actions(user_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_ai_actions_action_type ON ai_actions(user_id, action_type);

-- ─── AUDIT LOGS (typed immutable audit trail) ────────────────
-- Every user/system action on financial data is logged here.
-- Distinct from business_events: audit_logs are about WHO changed WHAT.
-- business_events are about WHAT business moment happened.
CREATE TABLE IF NOT EXISTS audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action          TEXT NOT NULL,
  entity_type     TEXT,
  entity_id       TEXT,
  old_value_json  JSONB,
  new_value_json  JSONB,
  ip_address      TEXT,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id    ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity     ON audit_logs(user_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(user_id, created_at DESC);

-- ─── PROMISES (payment promise lifecycle) ────────────────────
-- Replaces promised_payment_date / promised_amount columns on call_logs.
-- status: active | kept | broken | rescheduled
CREATE TABLE IF NOT EXISTS promises (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  receivable_id   UUID REFERENCES invoices(id) ON DELETE SET NULL,
  promised_amount NUMERIC(14,2),
  promised_date   DATE NOT NULL,
  promise_note    TEXT,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','kept','broken','rescheduled')),
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_promises_user_id    ON promises(user_id);
CREATE INDEX IF NOT EXISTS idx_promises_customer   ON promises(user_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_promises_date       ON promises(user_id, promised_date);
CREATE INDEX IF NOT EXISTS idx_promises_status     ON promises(user_id, status);

-- ─── FOLLOWUPS (unified contact history) ─────────────────────
-- Replaces scattered call_logs, dunning_logs, WhatsApp send records.
-- followup_type: whatsapp | call | email | in_person | note
-- tone: soft | professional | firm | escalation
-- status: sent | delivered | read | responded | failed | pending
CREATE TABLE IF NOT EXISTS followups (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id       UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  receivable_id     UUID REFERENCES invoices(id) ON DELETE SET NULL,
  followup_type     TEXT NOT NULL DEFAULT 'note'
                      CHECK (followup_type IN ('whatsapp','call','email','in_person','note')),
  tone              TEXT NOT NULL DEFAULT 'professional'
                      CHECK (tone IN ('soft','professional','firm','escalation')),
  message_text      TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('sent','delivered','read','responded','failed','pending')),
  response_received BOOLEAN DEFAULT FALSE,
  response_note     TEXT,
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_followups_user_id  ON followups(user_id);
CREATE INDEX IF NOT EXISTS idx_followups_customer ON followups(user_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_followups_created  ON followups(user_id, created_at DESC);

-- ─── CUSTOMER SCORES (behavioral intelligence per customer) ──
-- Recalculated on every payment, promise, or overdue event.
-- All scores 0–100. credit_risk_score: higher = riskier.
CREATE TABLE IF NOT EXISTS customer_scores (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id                UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  average_delay_days         NUMERIC(6,1) DEFAULT 0,
  max_delay_days             INTEGER DEFAULT 0,
  overdue_frequency          INTEGER DEFAULT 0,
  promise_reliability_score  NUMERIC(5,1) DEFAULT 100,
  broken_promise_count       INTEGER DEFAULT 0,
  response_time_score        NUMERIC(5,1) DEFAULT 50,
  dispute_score              NUMERIC(5,1) DEFAULT 0,
  partial_payment_score      NUMERIC(5,1) DEFAULT 0,
  recovery_probability       NUMERIC(5,1) DEFAULT 50,
  owner_call_dependency_score NUMERIC(5,1) DEFAULT 50,
  customer_value_score       NUMERIC(5,1) DEFAULT 50,
  credit_risk_score          NUMERIC(5,1) DEFAULT 0,
  collection_priority_score  NUMERIC(5,1) DEFAULT 0,
  score_reason_json          JSONB DEFAULT '{}',
  last_calculated_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_cscores_user_id   ON customer_scores(user_id);
CREATE INDEX IF NOT EXISTS idx_cscores_risk      ON customer_scores(user_id, credit_risk_score DESC);
CREATE INDEX IF NOT EXISTS idx_cscores_priority  ON customer_scores(user_id, collection_priority_score DESC);

-- ─── CASHFLOW EVENTS (expected vs actual money movement) ─────
-- source_type: sale | purchase | invoice | manual | bank_transaction
-- event_type: expected_inflow | expected_outflow | actual_inflow | actual_outflow
-- status: expected | confirmed | cancelled
CREATE TABLE IF NOT EXISTS cashflow_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL
                    CHECK (event_type IN ('expected_inflow','expected_outflow','actual_inflow','actual_outflow')),
  source_type     TEXT,
  source_id       TEXT,
  amount          NUMERIC(14,2) NOT NULL DEFAULT 0,
  expected_date   DATE,
  actual_date     DATE,
  status          TEXT NOT NULL DEFAULT 'expected'
                    CHECK (status IN ('expected','confirmed','cancelled')),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cashflow_user_id  ON cashflow_events(user_id);
CREATE INDEX IF NOT EXISTS idx_cashflow_dates    ON cashflow_events(user_id, expected_date);
CREATE INDEX IF NOT EXISTS idx_cashflow_type     ON cashflow_events(user_id, event_type, status);

-- ─── TASKS (owner/staff action items) ────────────────────────
-- priority: low | medium | high | urgent
-- status: open | in_progress | done | cancelled
CREATE TABLE IF NOT EXISTS tasks (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  description         TEXT,
  assigned_to         UUID REFERENCES users(id) ON DELETE SET NULL,
  related_entity_type TEXT,
  related_entity_id   TEXT,
  priority            TEXT NOT NULL DEFAULT 'medium'
                        CHECK (priority IN ('low','medium','high','urgent')),
  status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','in_progress','done','cancelled')),
  due_date            DATE,
  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tasks_user_id  ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(user_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(user_id, due_date);

-- ─── IDEMPOTENCY KEYS (prevent duplicate creates) ────────────
-- Keyed by (user_id, idempotency_key). Response cached for 24h.
-- Caller sends: Idempotency-Key header on POST requests.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idem_key        TEXT NOT NULL,
  response_json   JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_idem_user_key ON idempotency_keys(user_id, idem_key);

-- ─── RLS (disabled to match existing schema; enable in migration 004) ──────
-- All tenancy enforced at app level via user_id filtering.
-- TODO migration 004: enable RLS with: auth.uid()::text = user_id::text
ALTER TABLE customers          DISABLE ROW LEVEL SECURITY;
ALTER TABLE business_events    DISABLE ROW LEVEL SECURITY;
ALTER TABLE ai_actions         DISABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs         DISABLE ROW LEVEL SECURITY;
ALTER TABLE promises           DISABLE ROW LEVEL SECURITY;
ALTER TABLE followups          DISABLE ROW LEVEL SECURITY;
ALTER TABLE customer_scores    DISABLE ROW LEVEL SECURITY;
ALTER TABLE cashflow_events    DISABLE ROW LEVEL SECURITY;
ALTER TABLE tasks              DISABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys   DISABLE ROW LEVEL SECURITY;

SELECT 'Migration 001_cortex_foundation complete' AS status;
