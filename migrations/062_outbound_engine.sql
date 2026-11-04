-- Migration 062: Outbound engine (queue-driven, rate-limited email outreach)
--
-- NOT APPLIED to any shared database. Additive only: every object is new and
-- prefixed outbound_. No existing table is altered. Safe to re-run
-- (IF NOT EXISTS throughout). Rollback = drop the outbound_* tables; nothing
-- else references them.
--
-- Pipeline and the table each stage writes:
--   discovery      outbound_companies, outbound_contacts (verification metadata)
--   campaign       outbound_campaigns, outbound_enrollments, outbound_experiments
--   content        outbound_messages (versioned, evidence, validation, review)
--   queue          outbound_send_jobs (lease/heartbeat/idempotency/priority)
--   sender         outbound_send_attempts, outbound_provider_accounts
--   rate limiter   outbound_rate_policies, outbound_rate_buckets, outbound_rate_windows
--   events         outbound_delivery_events (deduped), outbound_replies
--   safety         outbound_suppressions, outbound_tenant_state, outbound_alerts
--   coordination   outbound_locks (scheduler leader lease), outbound_audit, outbound_costs
--
-- Tenancy: user_id scopes every tenant row (REFERENCES users ON DELETE
-- CASCADE). RLS is enabled, but the backend role bypasses it, so every query
-- in lib/domain/outbound filters by user_id taken from the verified JWT.
-- Rows with user_id NULL exist only in outbound_rate_policies (operator-wide
-- defaults) and outbound_locks/outbound_alerts (system scope).

CREATE TABLE IF NOT EXISTS outbound_tenant_state (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  engine_status    TEXT NOT NULL DEFAULT 'STOPPED' CHECK (engine_status IN ('STOPPED','RUNNING','STOPPED_BY_OWNER','STOPPED_AUTOMATICALLY')),
  mode             TEXT NOT NULL DEFAULT 'SHADOW' CHECK (mode IN ('SHADOW','TEST','LIVE')),
  status_reason    TEXT,
  started_at       TIMESTAMPTZ,
  started_by       UUID,
  stopped_at       TIMESTAMPTZ,
  stopped_by       UUID,
  last_preflight   JSONB,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE IF EXISTS outbound_tenant_state ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS outbound_provider_accounts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL CHECK (provider IN ('gmail','outlook','sink')),
  from_address        TEXT NOT NULL,
  display_name        TEXT,
  status              TEXT NOT NULL DEFAULT 'HEALTHY' CHECK (status IN ('HEALTHY','THROTTLED','PAUSED','AUTH_REQUIRED','FAILED')),
  status_reason       TEXT,
  credentials_enc     TEXT,             -- AES-256-GCM, key from OUTBOUND_CREDENTIALS_KEY; never logged or returned
  daily_max           INTEGER NOT NULL DEFAULT 40 CHECK (daily_max BETWEEN 0 AND 2000),
  warmup_started_on   DATE,
  warmup_schedule     JSONB NOT NULL DEFAULT '[5,8,12,16,20,25,30,35,40]'::jsonb,
  throttle_factor     NUMERIC NOT NULL DEFAULT 1 CHECK (throttle_factor > 0 AND throttle_factor <= 1),
  consecutive_errors  INTEGER NOT NULL DEFAULT 0,
  last_success_at     TIMESTAMPTZ,
  last_error_at       TIMESTAMPTZ,
  last_poll_at        TIMESTAMPTZ,
  poll_cursor         TEXT,
  created_by          UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider, from_address)
);
ALTER TABLE IF EXISTS outbound_provider_accounts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS outbound_campaigns (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  goal                TEXT NOT NULL,
  goal_target         INTEGER,                       -- e.g. 5 qualified conversations (Missions view)
  target_profile      JSONB NOT NULL DEFAULT '{}'::jsonb,
  allowed_countries   TEXT[] NOT NULL DEFAULT '{}',
  send_window         JSONB NOT NULL DEFAULT '{"days":[1,2,3,4,5],"start":"09:00","end":"17:00"}'::jsonb,
  message_strategy    JSONB NOT NULL DEFAULT '{}'::jsonb,
  cta                 TEXT NOT NULL,
  daily_budget        INTEGER NOT NULL DEFAULT 20 CHECK (daily_budget BETWEEN 0 AND 2000),
  limits              JSONB NOT NULL DEFAULT '{}'::jsonb,
  followup_policy     JSONB NOT NULL DEFAULT '{"max":2,"afterDays":[3,7]}'::jsonb,
  cooldown_days       INTEGER NOT NULL DEFAULT 90 CHECK (cooldown_days BETWEEN 0 AND 3650),
  company_cooldown_days INTEGER NOT NULL DEFAULT 14 CHECK (company_cooldown_days BETWEEN 0 AND 3650),
  max_per_company     INTEGER NOT NULL DEFAULT 1 CHECK (max_per_company BETWEEN 1 AND 50),
  require_review      BOOLEAN NOT NULL DEFAULT TRUE,
  allow_unverified    BOOLEAN NOT NULL DEFAULT FALSE,
  provider_account_id UUID REFERENCES outbound_provider_accounts(id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','PAUSED','PAUSED_AUTOMATICALLY','STOPPED','COMPLETED')),
  status_reason       TEXT,
  created_by          UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_user ON outbound_campaigns(user_id, status);
ALTER TABLE IF EXISTS outbound_campaigns ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS outbound_companies (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  normalized_name     TEXT NOT NULL,
  domain              TEXT,
  industry            TEXT,
  country             TEXT,
  size_band           TEXT,
  erp                 TEXT,
  locations           INTEGER,
  fit_score           INTEGER CHECK (fit_score BETWEEN 0 AND 100),
  fit_dimensions      JSONB NOT NULL DEFAULT '{}'::jsonb,
  facts               JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{fact, source, retrievedAt}]
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_companies_domain ON outbound_companies(user_id, domain) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outbound_companies_name ON outbound_companies(user_id, normalized_name);
ALTER TABLE IF EXISTS outbound_companies ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS outbound_contacts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id           UUID REFERENCES outbound_companies(id) ON DELETE SET NULL,
  full_name            TEXT NOT NULL,
  normalized_name      TEXT NOT NULL,
  role_title           TEXT,
  email                TEXT NOT NULL,
  email_normalized     TEXT NOT NULL,
  email_domain         TEXT NOT NULL,
  country              TEXT,
  timezone             TEXT,
  state                TEXT NOT NULL DEFAULT 'NEW' CHECK (state IN ('NEW','RESEARCHED','VERIFIED','ELIGIBLE','QUEUED','SENT','DELIVERED','REPLIED','INTERESTED','MEETING','DECLINED','BOUNCED','BLOCKED','OPTED_OUT','SUPPRESSED')),
  email_verified       BOOLEAN NOT NULL DEFAULT FALSE,
  verification_source  TEXT,
  verification_method  TEXT,
  verified_at          TIMESTAMPTZ,
  confidence           TEXT CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
  role_verified_at     TIMESTAMPTZ,
  role_source          TEXT,
  unverified_approved_by UUID,
  source               TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, email_normalized)
);
CREATE INDEX IF NOT EXISTS idx_outbound_contacts_company ON outbound_contacts(user_id, company_id);
CREATE INDEX IF NOT EXISTS idx_outbound_contacts_person ON outbound_contacts(user_id, normalized_name, email_domain);
ALTER TABLE IF EXISTS outbound_contacts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS outbound_contact_state_history (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id  UUID NOT NULL REFERENCES outbound_contacts(id) ON DELETE CASCADE,
  from_state  TEXT,
  to_state    TEXT NOT NULL,
  reason      TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_outbound_contact_history ON outbound_contact_state_history(contact_id, at DESC);
ALTER TABLE IF EXISTS outbound_contact_state_history ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS outbound_experiments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id  UUID NOT NULL REFERENCES outbound_campaigns(id) ON DELETE CASCADE,
  variable     TEXT NOT NULL CHECK (variable IN ('subject','opening','cta','angle')),
  variants     JSONB NOT NULL,                 -- [{key, value}], exactly one variable changes
  status       TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CONCLUDED','CANCELLED')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_experiments_active ON outbound_experiments(campaign_id) WHERE status = 'ACTIVE';
ALTER TABLE IF EXISTS outbound_experiments ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS outbound_enrollments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id        UUID NOT NULL REFERENCES outbound_campaigns(id) ON DELETE CASCADE,
  contact_id         UUID NOT NULL REFERENCES outbound_contacts(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'ENROLLED' CHECK (status IN ('ENROLLED','DRAFTED','APPROVED','QUEUED','SENT','REPLIED','FINISHED','EXCLUDED','CANCELLED')),
  status_reason      TEXT,
  experiment_id      UUID REFERENCES outbound_experiments(id) ON DELETE SET NULL,
  variant_key        TEXT,
  step               INTEGER NOT NULL DEFAULT 0,       -- 0 = initial, 1.. = follow-ups sent
  last_sent_at       TIMESTAMPTZ,
  next_followup_at   TIMESTAMPTZ,
  thread_id          TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_outbound_enrollments_user ON outbound_enrollments(user_id, campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_outbound_enrollments_followup ON outbound_enrollments(next_followup_at) WHERE status = 'SENT';
ALTER TABLE IF EXISTS outbound_enrollments ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS outbound_messages (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id             UUID NOT NULL REFERENCES outbound_campaigns(id) ON DELETE CASCADE,
  contact_id              UUID NOT NULL REFERENCES outbound_contacts(id) ON DELETE CASCADE,
  enrollment_id           UUID NOT NULL REFERENCES outbound_enrollments(id) ON DELETE CASCADE,
  step                    INTEGER NOT NULL DEFAULT 0,
  version                 INTEGER NOT NULL DEFAULT 1,
  subject                 TEXT NOT NULL,
  subject_pattern         TEXT,
  body                    TEXT NOT NULL,
  template_version        TEXT NOT NULL,
  prompt_version          TEXT,
  model                   TEXT,
  personalization_inputs  JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence                JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{fact, source, retrievedAt}]
  validation              JSONB NOT NULL DEFAULT '{}'::jsonb,
  variant_key             TEXT,
  review_status           TEXT NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (review_status IN ('PENDING_REVIEW','APPROVED','REJECTED','SUPERSEDED','BLOCKED_BY_VALIDATION')),
  reviewed_by             UUID,
  reviewed_at             TIMESTAMPTZ,
  generated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (enrollment_id, step, version)
);
CREATE INDEX IF NOT EXISTS idx_outbound_messages_review ON outbound_messages(user_id, review_status);
ALTER TABLE IF EXISTS outbound_messages ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS outbound_send_jobs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id          UUID REFERENCES outbound_campaigns(id) ON DELETE CASCADE,
  contact_id           UUID NOT NULL REFERENCES outbound_contacts(id) ON DELETE CASCADE,
  enrollment_id        UUID REFERENCES outbound_enrollments(id) ON DELETE CASCADE,
  message_id           UUID NOT NULL REFERENCES outbound_messages(id) ON DELETE CASCADE,
  provider_account_id  UUID REFERENCES outbound_provider_accounts(id) ON DELETE SET NULL,
  idempotency_key      TEXT NOT NULL UNIQUE,     -- tenant:campaign:contact:step:message_version
  priority             SMALLINT NOT NULL DEFAULT 3 CHECK (priority BETWEEN 0 AND 3),
  status               TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RESERVED','SENDING','SENT','RETRY_WAIT','AMBIGUOUS','FAILED','CANCELLED')),
  mode                 TEXT NOT NULL DEFAULT 'SHADOW' CHECK (mode IN ('SHADOW','TEST','LIVE')),
  run_after            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts             INTEGER NOT NULL DEFAULT 0,
  max_attempts         INTEGER NOT NULL DEFAULT 4,
  lease_owner          TEXT,
  lease_expires_at     TIMESTAMPTZ,
  heartbeat_at         TIMESTAMPTZ,
  last_error           TEXT,
  failure_class        TEXT,
  provider_message_id  TEXT,
  provider_thread_id   TEXT,
  rfc822_message_id    TEXT,
  scheduled_by         TEXT NOT NULL,
  correlation_id       TEXT NOT NULL,
  sent_at              TIMESTAMPTZ,
  dead_lettered_at     TIMESTAMPTZ,
  cancelled_reason     TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_outbound_jobs_ready ON outbound_send_jobs(priority, run_after) WHERE status IN ('QUEUED','RETRY_WAIT');
CREATE INDEX IF NOT EXISTS idx_outbound_jobs_lease ON outbound_send_jobs(lease_expires_at) WHERE status IN ('RESERVED','SENDING');
CREATE INDEX IF NOT EXISTS idx_outbound_jobs_user ON outbound_send_jobs(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbound_jobs_contact ON outbound_send_jobs(user_id, contact_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_jobs_open_per_contact ON outbound_send_jobs(user_id, contact_id) WHERE status IN ('QUEUED','RESERVED','SENDING','RETRY_WAIT','AMBIGUOUS');
ALTER TABLE IF EXISTS outbound_send_jobs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS outbound_send_attempts (
  id                   BIGSERIAL PRIMARY KEY,
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id               UUID NOT NULL REFERENCES outbound_send_jobs(id) ON DELETE CASCADE,
  attempt_no           INTEGER NOT NULL,
  worker_id            TEXT NOT NULL,
  started_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at          TIMESTAMPTZ,
  outcome              TEXT CHECK (outcome IN ('SENT','RETRYABLE','RATE_LIMITED','PERMANENT','AUTH','AMBIGUOUS','RECONCILED_SENT')),
  http_status          INTEGER,
  error                TEXT,
  retry_after_ms       INTEGER,
  provider_message_id  TEXT,
  UNIQUE (job_id, attempt_no)
);
ALTER TABLE IF EXISTS outbound_send_attempts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS outbound_delivery_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id             UUID REFERENCES outbound_send_jobs(id) ON DELETE SET NULL,
  message_id         UUID REFERENCES outbound_messages(id) ON DELETE SET NULL,
  contact_id         UUID REFERENCES outbound_contacts(id) ON DELETE SET NULL,
  campaign_id        UUID REFERENCES outbound_campaigns(id) ON DELETE SET NULL,
  provider_account_id UUID REFERENCES outbound_provider_accounts(id) ON DELETE SET NULL,
  event_type         TEXT NOT NULL CHECK (event_type IN ('SENT','DELIVERED','DEFERRED','BOUNCED','BLOCKED','COMPLAINT','OPENED','CLICKED','REPLIED','UNSUBSCRIBED','PROVIDER_ERROR')),
  bounce_class       TEXT CHECK (bounce_class IN ('HARD','SOFT','BLOCK','UNKNOWN')),
  dedupe_key         TEXT NOT NULL,
  source             TEXT NOT NULL,
  detail             JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_outbound_events_campaign ON outbound_delivery_events(user_id, campaign_id, event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbound_events_account ON outbound_delivery_events(provider_account_id, event_type, occurred_at DESC);
ALTER TABLE IF EXISTS outbound_delivery_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS outbound_replies (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id           UUID REFERENCES outbound_contacts(id) ON DELETE SET NULL,
  campaign_id          UUID REFERENCES outbound_campaigns(id) ON DELETE SET NULL,
  message_id           UUID REFERENCES outbound_messages(id) ON DELETE SET NULL,
  job_id               UUID REFERENCES outbound_send_jobs(id) ON DELETE SET NULL,
  provider_message_id  TEXT NOT NULL,
  thread_id            TEXT,
  from_address         TEXT NOT NULL,
  subject              TEXT,
  snippet              TEXT,
  classification       TEXT NOT NULL CHECK (classification IN ('INTERESTED','MEETING','QUESTION','ROUTED_TO_OTHER_PERSON','NOT_NOW','DECLINED','OPT_OUT','AUTO_REPLY','OTHER')),
  classifier_version   TEXT NOT NULL,
  matched_rule         TEXT,
  needs_attention      BOOLEAN NOT NULL DEFAULT TRUE,
  handled_at           TIMESTAMPTZ,
  handled_by           UUID,
  received_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider_message_id)
);
CREATE INDEX IF NOT EXISTS idx_outbound_replies_attention ON outbound_replies(user_id, needs_attention, received_at DESC);
ALTER TABLE IF EXISTS outbound_replies ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS outbound_suppressions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_normalized  TEXT,
  domain            TEXT,
  reason            TEXT NOT NULL CHECK (reason IN ('UNSUBSCRIBED','HARD_BOUNCE','SPAM_COMPLAINT','BLOCKED','EXPLICIT_DO_NOT_CONTACT','LEGAL_SUPPRESSION','INVALID_ADDRESS','DECLINED')),
  hard              BOOLEAN NOT NULL DEFAULT TRUE,
  source            TEXT NOT NULL,
  note              TEXT,
  created_by        UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (email_normalized IS NOT NULL OR domain IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_suppress_email ON outbound_suppressions(user_id, email_normalized, reason) WHERE email_normalized IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_suppress_domain ON outbound_suppressions(user_id, domain, reason) WHERE email_normalized IS NULL;
ALTER TABLE IF EXISTS outbound_suppressions ENABLE ROW LEVEL SECURITY;

-- Rate limit registry. user_id NULL = operator-wide policy. Changed at
-- runtime through /api/outreach/rate-policies (tenant scope) or SQL (global);
-- no deploy needed. Unknown services fall back to conservative code defaults.
CREATE TABLE IF NOT EXISTS outbound_rate_policies (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID REFERENCES users(id) ON DELETE CASCADE,
  service        TEXT NOT NULL,          -- email | research | model | verification
  scope          TEXT NOT NULL CHECK (scope IN ('GLOBAL','PROVIDER','ACCOUNT','TENANT','CAMPAIGN','DOMAIN')),
  scope_key      TEXT NOT NULL DEFAULT '*',
  per_minute     NUMERIC,
  per_hour       INTEGER,
  per_day        INTEGER,
  burst          INTEGER,
  concurrency    INTEGER,
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by     UUID,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_rate_policy ON outbound_rate_policies(COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid), service, scope, scope_key);
ALTER TABLE IF EXISTS outbound_rate_policies ENABLE ROW LEVEL SECURITY;

-- Token buckets (central state so several workers/instances share them).
CREATE TABLE IF NOT EXISTS outbound_rate_buckets (
  bucket_key     TEXT PRIMARY KEY,
  tokens         DOUBLE PRECISION NOT NULL,
  capacity       DOUBLE PRECISION NOT NULL,
  refill_per_sec DOUBLE PRECISION NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fixed-window counters for hourly and daily ceilings.
CREATE TABLE IF NOT EXISTS outbound_rate_windows (
  bucket_key    TEXT NOT NULL,
  granularity   TEXT NOT NULL CHECK (granularity IN ('HOUR','DAY')),
  window_start  TIMESTAMPTZ NOT NULL,
  used          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, granularity, window_start)
);

-- Operator-wide switches (one row per key). 'global_stop' = STOP ALL
-- OUTBOUND for every tenant; set from the admin API or SQL, read by every
-- worker before every send. The env var OUTBOUND_GLOBAL_STOP=true is the
-- second, deploy-level switch; either one stops sending.
CREATE TABLE IF NOT EXISTS outbound_system_controls (
  key        TEXT PRIMARY KEY,
  enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  reason     TEXT,
  set_by     TEXT,
  set_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Leases for singleton roles (scheduler leader). Row-based rather than
-- advisory locks because the production pooler runs in transaction mode.
CREATE TABLE IF NOT EXISTS outbound_locks (
  name         TEXT PRIMARY KEY,
  owner        TEXT NOT NULL,
  acquired_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_tick    JSONB
);

CREATE TABLE IF NOT EXISTS outbound_audit (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  actor        TEXT NOT NULL,          -- user:<id> | scheduler:<owner> | worker:<id> | system
  action       TEXT NOT NULL,
  campaign_id  UUID,
  contact_id   UUID,
  job_id       UUID,
  message_id   UUID,
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id TEXT,
  at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_outbound_audit_user ON outbound_audit(user_id, at DESC);
ALTER TABLE IF EXISTS outbound_audit ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS outbound_alerts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  severity     TEXT NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  message      TEXT NOT NULL,
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_alerts_open ON outbound_alerts(COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid), dedupe_key) WHERE resolved_at IS NULL;
ALTER TABLE IF EXISTS outbound_alerts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS outbound_costs (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id  UUID REFERENCES outbound_campaigns(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('research','generation','verification','sending','classification')),
  units        NUMERIC NOT NULL DEFAULT 1,
  amount_usd   NUMERIC NOT NULL DEFAULT 0,
  model        TEXT,
  at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_outbound_costs_campaign ON outbound_costs(user_id, campaign_id, kind);
ALTER TABLE IF EXISTS outbound_costs ENABLE ROW LEVEL SECURITY;
