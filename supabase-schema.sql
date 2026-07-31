-- ============================================================
-- VANTRO FLOW — Complete Supabase Schema
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- Safe to run multiple times (uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)
-- ============================================================

-- ─── USERS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  phone         TEXT,
  business_name TEXT,
  password_hash TEXT,
  plan          TEXT DEFAULT 'free',
  gstin         TEXT,
  address       TEXT,
  logo_url      TEXT,
  whatsapp_phone TEXT,
  whatsapp_token TEXT,
  industry      TEXT,
  language      TEXT DEFAULT 'hinglish',
  contact_time  TEXT DEFAULT 'morning',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Add missing columns to existing users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS business_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'free';
ALTER TABLE users ADD COLUMN IF NOT EXISTS gstin TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS industry TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'hinglish';
ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_time TEXT DEFAULT 'morning';
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Columns the application reads and writes that this file never created. Found
-- by extracting every users column referenced in server.js and diffing it
-- against information_schema on a database built from this file — 26 of them
-- existed only in the code. GET /api/settings survives because it catches the
-- missing-column error and retries with a core-column list, but PATCH
-- /api/settings has no such fallback: it writes business_address, owner_name and
-- city directly, so saving business or voice settings returned 500 on every
-- database provisioned from this schema. Onboarding (feature_flags,
-- business_size, onboarding_done) failed the same way, which is why the feature
-- flags it computes never took effect.
--
-- sells_on_credit and primary_pain are deliberately absent: onboarding accepts
-- them in the request body but only feeds them to buildFeatureFlags, and never
-- persists them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS owner_name          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS city                TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS business_address    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS business_size       TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS business_type       TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS gst_registered      BOOLEAN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS has_workers         BOOLEAN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_done     BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified      BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified      BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS automation_enabled  BOOLEAN DEFAULT FALSE;
-- Written by POST /api/billing/verify immediately after the Razorpay signature
-- checks out. Without it that update throws and the handler returns 500, so the
-- customer has paid, the signature verified, and the plan is never applied.
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_updated_at     TIMESTAMPTZ;

-- buildFeatureFlags() returns an object and the row is written with it directly,
-- so this has to be JSONB — a TEXT column would coerce it to "[object Object]"
-- and every flag lookup would read undefined.
ALTER TABLE users ADD COLUMN IF NOT EXISTS feature_flags       JSONB DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS push_subscription   JSONB;

ALTER TABLE users ADD COLUMN IF NOT EXISTS voice_style         TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_persona          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS upi_id              TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invoice_prefix      TEXT;

-- Per-tenant integration credentials. These are stored in plaintext, which is
-- how the application already treats them: GET /api/settings masks
-- interakt_api_key and wati_token on the way out, so the values are only ever
-- read server-side. Creating the columns does not change that exposure, but it
-- does mean the service_role key now guards real secrets — worth encrypting at
-- rest before this table grows.
ALTER TABLE users ADD COLUMN IF NOT EXISTS wa_provider         TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wati_api_url        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wati_token          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS interakt_api_key    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS twilio_account_sid  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS twilio_auth_token   TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS twilio_phone_number TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS razorpay_key_id     TEXT;
-- Written by POST /api/settings/razorpay. The comment on GET /api/settings
-- claiming this is "never stored per-user" is wrong — it is stored. It is not
-- in that endpoint's column list, so it is never returned to the client.
ALTER TABLE users ADD COLUMN IF NOT EXISTS razorpay_key_secret TEXT;

-- ─── PASSWORD RESET TOKENS ───────────────────────────────────
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL,
  otp        TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── INVOICES ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  customer_name   TEXT NOT NULL,
  customer_phone  TEXT,
  invoice_amount  NUMERIC NOT NULL DEFAULT 0,
  payment_status  TEXT DEFAULT 'Pending',
  days_overdue    INTEGER DEFAULT 0,
  invoice_date    TEXT,
  due_date        TEXT,
  payment_date    TEXT,
  payment_amount  NUMERIC,
  payment_method  TEXT,
  payment_notes   TEXT,
  priority_score  NUMERIC,
  urgency         TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Add missing columns to existing invoices table
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_phone TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS due_date TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_date TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_amount NUMERIC;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_notes TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS priority_score NUMERIC;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS urgency TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- ─── CALL LOGS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS call_logs (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID REFERENCES users(id) ON DELETE CASCADE,
  invoice_id             UUID REFERENCES invoices(id) ON DELETE SET NULL,
  customer_name          TEXT NOT NULL,
  customer_phone         TEXT,
  amount                 NUMERIC,
  notes                  TEXT,
  call_duration_minutes  INTEGER,
  did_pick_up            BOOLEAN,
  promised_payment_date  TEXT,
  promised_amount        NUMERIC,
  called_at              TIMESTAMPTZ DEFAULT NOW()
);

-- Add missing columns to existing call_logs table
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS invoice_id UUID;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS customer_phone TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS call_duration_minutes INTEGER;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS did_pick_up BOOLEAN;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS promised_payment_date TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS promised_amount NUMERIC;

-- ─── PRODUCTS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  sku             TEXT,
  description     TEXT,
  unit_price      NUMERIC DEFAULT 0,
  unit            TEXT DEFAULT 'unit',
  current_stock   NUMERIC DEFAULT 0,
  low_stock_alert NUMERIC DEFAULT 10,
  category        TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── STOCK MOVEMENTS ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_movements (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID REFERENCES users(id) ON DELETE CASCADE,
  product_id     UUID REFERENCES products(id) ON DELETE CASCADE,
  movement_type  TEXT NOT NULL,
  quantity       NUMERIC NOT NULL,
  unit_cost      NUMERIC,
  reference      TEXT,
  notes          TEXT,
  moved_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ─── PROSPECTS / CRM ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prospects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  phone         TEXT,
  email         TEXT,
  business_type TEXT,
  status        TEXT DEFAULT 'new',
  amount_stuck  NUMERIC,
  location      TEXT,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── DUNNING RULES ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dunning_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  trigger_day INTEGER NOT NULL,
  action      TEXT NOT NULL DEFAULT 'whatsapp',
  tone        TEXT NOT NULL DEFAULT 'gentle',
  enabled     BOOLEAN DEFAULT TRUE,
  sent        INTEGER DEFAULT 0,
  paid        INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── BILLING HISTORY ──────────────────────────────────────────
-- Named billing_records here but billing_history everywhere it is actually
-- queried — POST /api/billing/verify, GET /api/billing/history, and the admin
-- MRR aggregate, three call sites total. Nothing in this repo ever queries
-- billing_records, so this was a naming mismatch, not two tables: renamed
-- rather than adding a duplicate. The DO block only fires on a database that
-- already ran an earlier version of this file and has billing_records sitting
-- under the old name — safe, because nothing ever wrote to it either.
DO $$
BEGIN
  IF to_regclass('billing_records') IS NOT NULL AND to_regclass('billing_history') IS NULL THEN
    ALTER TABLE billing_records RENAME TO billing_history;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS billing_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  plan        TEXT NOT NULL,
  period      TEXT,
  amount      NUMERIC,
  currency    TEXT DEFAULT 'INR',
  order_id    TEXT,
  payment_id  TEXT,
  status      TEXT DEFAULT 'pending',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Add missing columns to existing billing_history table
ALTER TABLE billing_history ADD COLUMN IF NOT EXISTS period TEXT;
ALTER TABLE billing_history ADD COLUMN IF NOT EXISTS amount NUMERIC;
ALTER TABLE billing_history ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'INR';
ALTER TABLE billing_history ADD COLUMN IF NOT EXISTS order_id TEXT;

-- ─── INDEXES for performance ─────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_invoices_user_id ON invoices(user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(payment_status);
CREATE INDEX IF NOT EXISTS idx_call_logs_user_id ON call_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_products_user_id ON products(user_id);
CREATE INDEX IF NOT EXISTS idx_prospects_user_id ON prospects(user_id);

-- ─── Row Level Security (disable for now, enable when ready) ─
ALTER TABLE users          DISABLE ROW LEVEL SECURITY;
ALTER TABLE invoices       DISABLE ROW LEVEL SECURITY;
ALTER TABLE call_logs      DISABLE ROW LEVEL SECURITY;
ALTER TABLE products       DISABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements DISABLE ROW LEVEL SECURITY;
ALTER TABLE prospects      DISABLE ROW LEVEL SECURITY;
ALTER TABLE dunning_rules  DISABLE ROW LEVEL SECURITY;
ALTER TABLE billing_history DISABLE ROW LEVEL SECURITY;

-- ─── PAYMENT PLANS (EMI / Installments) ─────────────────────
CREATE TABLE IF NOT EXISTS payment_plans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  invoice_id      UUID,
  customer_name   TEXT NOT NULL,
  customer_phone  TEXT,
  total_amount    NUMERIC NOT NULL,
  installments    JSONB DEFAULT '[]',
  status          TEXT DEFAULT 'active',
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_payment_plans_user_id ON payment_plans(user_id);

-- ─── DISPUTES ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS disputes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  invoice_id      UUID,
  customer_name   TEXT NOT NULL,
  customer_phone  TEXT,
  disputed_amount NUMERIC NOT NULL,
  reason          TEXT NOT NULL,
  notes           TEXT,
  status          TEXT DEFAULT 'open',
  resolution      TEXT,
  resolved_amount NUMERIC,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_disputes_user_id ON disputes(user_id);

-- Add dunning_paused column to invoices for dispute support
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS dunning_paused BOOLEAN DEFAULT FALSE;

-- ─── CA PARTNERS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ca_partners (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ca_user_id      UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  firm_name       TEXT NOT NULL,
  license_no      TEXT,
  city            TEXT,
  specialization  TEXT,
  referral_code   TEXT UNIQUE,
  status          TEXT DEFAULT 'active',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ca_partners_user_id ON ca_partners(ca_user_id);

-- ─── REFERRAL REWARDS ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referral_rewards (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  type            TEXT DEFAULT 'free_month',
  value           INTEGER DEFAULT 1,
  status          TEXT DEFAULT 'granted',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_referral_rewards_referrer ON referral_rewards(referrer_id);

-- ─── TEAM MEMBERS (multi-user roles) ─────────────────────────
CREATE TABLE IF NOT EXISTS team_members (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        UUID REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  phone           TEXT,
  email           TEXT,
  role            TEXT NOT NULL,
  permissions     JSONB DEFAULT '[]',
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_team_members_owner_id ON team_members(owner_id);

-- ─── BANK LEDGER / TRANSACTIONS ─────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID REFERENCES users(id) ON DELETE CASCADE,
  type             TEXT NOT NULL CHECK (type IN ('in','out')),
  category         TEXT NOT NULL,
  amount           NUMERIC(14,2) NOT NULL DEFAULT 0,
  description      TEXT,
  party_name       TEXT,
  transaction_date DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_method   TEXT DEFAULT 'UPI',
  reference        TEXT,
  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_txn_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(transaction_date DESC);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id             BIGSERIAL PRIMARY KEY,
  user_id        UUID REFERENCES users(id) ON DELETE CASCADE,
  bank_name      TEXT NOT NULL,
  account_last4  TEXT,
  account_type   TEXT DEFAULT 'current',
  nickname       TEXT,
  ifsc           TEXT,
  is_active      BOOLEAN DEFAULT TRUE,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_user ON bank_accounts(user_id);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  account_id    BIGINT REFERENCES bank_accounts(id) ON DELETE SET NULL,
  txn_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  description   TEXT,
  amount        NUMERIC(14,2) NOT NULL DEFAULT 0,
  type          TEXT NOT NULL CHECK (type IN ('credit','debit')),
  status        TEXT NOT NULL DEFAULT 'unmatched',
  matched_type  TEXT,
  matched_id    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_user ON bank_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_date ON bank_transactions(user_id, txn_date DESC);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_status ON bank_transactions(user_id, status);


-- ─── GST BILLS ───────────────────────────────────────────────
-- This table was queried by ten call sites across eight endpoints and created
-- nowhere: not here, not in migrations/, not in runAutoMigrations. On a database
-- provisioned by scripts/setup-fresh-database.js it simply did not exist, so
-- GET /api/bills returned an empty list through its missing-schema fallback
-- while every other bills endpoint returned 500.
--
-- The column set is derived from actual usage, and covers two vocabularies the
-- code uses for the same values: writes go through bill_date/total/cgst+sgst+igst
-- (POST /api/bills), while reads expect invoice_date/total_amount/tax_amount
-- (the public bill view and the GSTR-1 export). Those three are generated rather
-- than stored separately so the two vocabularies cannot drift apart — the
-- alternative, plain nullable columns, would leave them NULL forever, which
-- makes the GST report return nothing and the customer-facing invoice show zero.
--
-- To be precise about what that does and does not guarantee: total_amount always
-- equals total, and tax_amount always equals the sum of the three GST
-- components, because each is derived. It does NOT guarantee
-- subtotal + tax_amount = total_amount. Nothing enforces that, and it is already
-- violated on the happy path — POST /api/bills rounds cgst and sgst
-- independently but computes total from the unrounded tax, so a ₹100.06 line at
-- 18% lands a paisa out. A CHECK on that identity would fail against real rows
-- today; it is worth adding once the rounding in the handler is fixed, along
-- with CHECK (NOT is_interstate OR (cgst = 0 AND sgst = 0)), which nothing
-- currently enforces either.
CREATE TABLE IF NOT EXISTS bills (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bill_number      TEXT,
  customer_name    TEXT NOT NULL,
  customer_gstin   TEXT,
  customer_address TEXT,
  customer_phone   TEXT,
  customer_email   TEXT,
  items            JSONB,
  gst_rate         NUMERIC(6,2),
  subtotal         NUMERIC(14,2) DEFAULT 0,
  cgst             NUMERIC(14,2) DEFAULT 0,
  sgst             NUMERIC(14,2) DEFAULT 0,
  igst             NUMERIC(14,2) DEFAULT 0,
  total            NUMERIC(14,2) DEFAULT 0,
  is_interstate    BOOLEAN DEFAULT FALSE,
  bill_date        DATE,
  due_date         DATE,
  status           TEXT DEFAULT 'unpaid' CHECK (status IN ('unpaid','paid','cancelled')),
  paid_at          TIMESTAMPTZ,
  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),

  invoice_date     DATE          GENERATED ALWAYS AS (bill_date) STORED,
  tax_amount       NUMERIC(14,2) GENERATED ALWAYS AS
                     (COALESCE(cgst,0) + COALESCE(sgst,0) + COALESCE(igst,0)) STORED,
  total_amount     NUMERIC(14,2) GENERATED ALWAYS AS (total) STORED
);

-- Repair path for any database where bills was created by hand outside version
-- control: CREATE TABLE IF NOT EXISTS is a silent no-op there, so the columns
-- have to be added individually. Same pattern as the users block above.
--
-- Everything below this point is written to be non-destructive and to refuse
-- loudly rather than guess. An earlier version of this block normalised
-- non-conforming status values to 'unpaid' before adding the CHECK constraint.
-- On a table holding 'Paid', 'canceled', 'void' or 'overdue' that rewrote every
-- one of them: settled invoices came back as unpaid, and cancelled invoices
-- stopped matching the .neq('status','cancelled') filter in the GSTR-1 export,
-- so they were filed as live outward supplies. A schema file must not rewrite
-- financial records — it now reports what it found and leaves the data alone.
ALTER TABLE bills ADD COLUMN IF NOT EXISTS bill_number      TEXT;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS customer_name    TEXT;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS customer_gstin   TEXT;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS customer_address TEXT;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS customer_phone   TEXT;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS customer_email   TEXT;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS items            JSONB;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS gst_rate         NUMERIC(6,2);
ALTER TABLE bills ADD COLUMN IF NOT EXISTS subtotal         NUMERIC(14,2) DEFAULT 0;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS cgst             NUMERIC(14,2) DEFAULT 0;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS sgst             NUMERIC(14,2) DEFAULT 0;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS igst             NUMERIC(14,2) DEFAULT 0;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS total            NUMERIC(14,2) DEFAULT 0;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS is_interstate    BOOLEAN DEFAULT FALSE;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS bill_date        DATE;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS due_date         DATE;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS status           TEXT DEFAULT 'unpaid';
ALTER TABLE bills ADD COLUMN IF NOT EXISTS paid_at          TIMESTAMPTZ;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS notes            TEXT;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS created_at       TIMESTAMPTZ DEFAULT NOW();

-- The read side (invoice_date / tax_amount / total_amount) and the two
-- constraints, all guarded. Each guard exists because the unguarded version was
-- tested against a hand-made bills table and failed silently: the file has no
-- ON_ERROR_STOP and no surrounding transaction, so a mid-file error still ends
-- with exit 0 and "Schema migration complete".
--
-- Adding a STORED generated column rewrites the whole table under ACCESS
-- EXCLUSIVE, which blocks reads as well as writes. Measured at roughly 1s per
-- column per 300k rows, three columns, ~2x peak disk. On Supabase the SQL Editor
-- also applies a statement_timeout, so on a large existing bills table run this
-- in a maintenance window and raise the timeout first:
--   SET statement_timeout = '10min';
-- On a fresh database all of this is free — the columns come from CREATE TABLE.
DO $$
DECLARE
  src_type    TEXT;
  plain_cols  TEXT[] := '{}';
  bad_status  BIGINT;
  bad_values  TEXT;
  dup_numbers BIGINT;
BEGIN
  -- ── generated columns ────────────────────────────────────────────────────
  -- ADD COLUMN IF NOT EXISTS no-ops when the column already exists as a plain
  -- one, which is the likely shape of a hand-made table: it would keep the read
  -- vocabulary and never populate it again, so every new bill would show a blank
  -- date and zero total forever. That case is reported, not silently accepted.
  SELECT array_agg(column_name ORDER BY column_name) INTO plain_cols
  FROM information_schema.columns
  WHERE table_name = 'bills' AND is_generated = 'NEVER'
    AND column_name IN ('invoice_date','tax_amount','total_amount');

  IF plain_cols <> '{}' THEN
    RAISE WARNING 'bills: % already exist as plain columns, so they were left alone. '
                  'Nothing writes them, so they will stay stale. Migrate the data into '
                  'bill_date/total/cgst+sgst+igst, drop them, and re-run this file.',
                  array_to_string(plain_cols, ', ');
  ELSE
    -- The expressions are typed, so a source column of the wrong type aborts the
    -- whole block. bill_date as TEXT is the realistic case and was fatal before.
    SELECT data_type INTO src_type FROM information_schema.columns
    WHERE table_name = 'bills' AND column_name = 'bill_date';
    IF src_type IS DISTINCT FROM 'date' THEN
      RAISE WARNING 'bills.bill_date is %, expected date — skipping generated columns. '
                    'Fix the column type first; ALTER ... ADD COLUMN cannot repair it.', src_type;
    ELSE
      ALTER TABLE bills ADD COLUMN IF NOT EXISTS invoice_date DATE          GENERATED ALWAYS AS (bill_date) STORED;
      ALTER TABLE bills ADD COLUMN IF NOT EXISTS tax_amount   NUMERIC(14,2) GENERATED ALWAYS AS
        (COALESCE(cgst,0) + COALESCE(sgst,0) + COALESCE(igst,0)) STORED;
      ALTER TABLE bills ADD COLUMN IF NOT EXISTS total_amount NUMERIC(14,2) GENERATED ALWAYS AS (total) STORED;
    END IF;
  END IF;

  -- ── status CHECK ─────────────────────────────────────────────────────────
  -- CREATE TABLE carries this constraint; ADD COLUMN IF NOT EXISTS does not, and
  -- there is no ADD CONSTRAINT IF NOT EXISTS. It is only added when every
  -- existing row already satisfies it. Non-conforming rows are reported and left
  -- untouched — they are the operator's call, not this file's.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'bills'::regclass AND conname = 'bills_status_check') THEN
    SELECT count(*), string_agg(DISTINCT COALESCE(status, '<NULL>'), ', ')
      INTO bad_status, bad_values
    FROM bills WHERE status IS NULL OR status NOT IN ('unpaid','paid','cancelled');

    IF bad_status = 0 THEN
      ALTER TABLE bills ADD CONSTRAINT bills_status_check CHECK (status IN ('unpaid','paid','cancelled'));
    ELSE
      RAISE WARNING 'bills: % row(s) hold a status outside (unpaid, paid, cancelled) — [%]. '
                    'Constraint NOT added and no data was changed. Note the GSTR-1 export '
                    'excludes only the exact string ''cancelled'', so variants like ''canceled'' '
                    'or ''void'' are being filed as live supplies today.', bad_status, bad_values;
    END IF;
  END IF;

  -- ── unique bill_number per user ──────────────────────────────────────────
  -- GST requires unique invoice numbers per taxpayer, and the generator at
  -- POST /api/bills reads-then-increments, which races. Creating the index fails
  -- on exactly the databases that already have duplicates, so check first.
  IF to_regclass('idx_bills_user_number') IS NULL THEN
    SELECT count(*) INTO dup_numbers FROM (
      SELECT 1 FROM bills WHERE bill_number IS NOT NULL
      GROUP BY user_id, bill_number HAVING count(*) > 1
    ) d;

    IF dup_numbers = 0 THEN
      CREATE UNIQUE INDEX idx_bills_user_number ON bills(user_id, bill_number) WHERE bill_number IS NOT NULL;
    ELSE
      RAISE WARNING 'bills: % duplicate (user_id, bill_number) group(s) — unique index NOT created. '
                    'Duplicate invoice numbers are a GST filing defect; resolve them, then re-run.', dup_numbers;
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bills_user_created ON bills(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bills_user_date    ON bills(user_id, bill_date DESC);
CREATE INDEX IF NOT EXISTS idx_bills_user_status  ON bills(user_id, status);

-- ─── SUPPLIERS ───────────────────────────────────────────────
-- Defined here as well as in the boot migration in server.js, and the two
-- definitions must stay identical (id is BIGSERIAL, not UUID). It has to exist
-- by the time migrations/001_cortex_foundation.sql runs, because ai_actions
-- carries a foreign key to it. Until this was added, that migration failed with
-- `relation "suppliers" does not exist` and ai_actions — the table behind the AI
-- Action Center, with 43 query sites — was never created on any database. The
-- boot migration's CREATE TABLE IF NOT EXISTS then no-ops over this one, so
-- nothing changes for a deployment that already has it.
CREATE TABLE IF NOT EXISTS suppliers (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL,
  name          TEXT NOT NULL,
  phone         TEXT,
  email         TEXT,
  address       TEXT,
  payment_terms INTEGER DEFAULT 30,
  gstin         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_suppliers_user ON suppliers(user_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(user_id, name);

-- ─── WORKERS ─────────────────────────────────────────────────
-- 9 call sites (GET/POST/PATCH/DELETE /api/workers, salary PATCH, attendance,
-- the AI Brain context loader) queried a table this file never created.
-- Referenced by orders.worker_id and attendance.worker_id below, so it has to
-- come first.
CREATE TABLE IF NOT EXISTS workers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  phone           TEXT,
  role            TEXT DEFAULT 'delivery',
  is_active       BOOLEAN DEFAULT TRUE,
  monthly_salary  NUMERIC(14,2),
  advance_balance NUMERIC(14,2) DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workers_user   ON workers(user_id);
CREATE INDEX IF NOT EXISTS idx_workers_active ON workers(user_id, is_active);

-- ─── ORDERS ──────────────────────────────────────────────────
-- 10 call sites: the manual order form, the AI voice-call order extractor,
-- today's P&L summary, the AI Brain context loader, and search. status has no
-- CHECK — POST accepts whatever the AI extraction or the form sends and PATCH
-- validates nothing either, so constraining it here would just be a constraint
-- the application doesn't actually uphold.
CREATE TABLE IF NOT EXISTS orders (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_name        TEXT,
  customer_phone       TEXT,
  delivery_address     TEXT,
  items                JSONB DEFAULT '[]',
  total_amount         NUMERIC(14,2),
  delivery_time        TEXT,
  special_instructions TEXT,
  worker_id            UUID REFERENCES workers(id) ON DELETE SET NULL,
  call_recording_url   TEXT,
  call_transcript      TEXT,
  source               TEXT DEFAULT 'manual',
  status               TEXT DEFAULT 'new',
  order_date           DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_user_date   ON orders(user_id, order_date);
CREATE INDEX IF NOT EXISTS idx_orders_user_status ON orders(user_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_worker      ON orders(worker_id);

-- ─── ATTENDANCE ──────────────────────────────────────────────
-- 3 call sites. POST upserts on (worker_id, attendance_date) — the unique
-- index below is that ON CONFLICT target, not decoration; without it the
-- upsert itself fails at the database.
CREATE TABLE IF NOT EXISTS attendance (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  worker_id        UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  attendance_date  DATE NOT NULL,
  status           TEXT DEFAULT 'present',
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_worker_date ON attendance(worker_id, attendance_date);
CREATE INDEX IF NOT EXISTS idx_attendance_user_date ON attendance(user_id, attendance_date);

-- ─── EXPENSES ────────────────────────────────────────────────
-- 8 call sites (CRUD, today's P&L summary, the AI Brain context loader, an AI
-- tool-call insert). category is unconstrained for the same reason as
-- orders.status: EXPENSE_CATEGORIES in server.js is only used as an AI tool
-- schema enum, never validated against on POST or PATCH.
CREATE TABLE IF NOT EXISTS expenses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  description   TEXT NOT NULL,
  amount        NUMERIC(14,2) NOT NULL,
  category      TEXT DEFAULT 'misc',
  notes         TEXT,
  expense_date  DATE NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_expenses_user_date ON expenses(user_id, expense_date);

-- ─── BUSINESS VOCABULARY ─────────────────────────────────────
-- 7 call sites: the vocabulary CRUD endpoints, the industry seed list, the
-- voice-call and AI Brain context loaders, and onboarding's upsert on
-- (user_id, term) — again the ON CONFLICT target for a real upsert, not
-- optional. aliases is JSONB, matching how every other array-valued column in
-- this file is stored (items, permissions, installments), not a Postgres
-- TEXT[]; the code only ever reads it back as a JS array via supabase-js, so
-- either would work, but JSONB keeps the convention in one place.
CREATE TABLE IF NOT EXISTS business_vocabulary (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  term        TEXT NOT NULL,
  meaning     TEXT NOT NULL,
  category    TEXT DEFAULT 'product',
  aliases     JSONB DEFAULT '[]',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vocabulary_user_term ON business_vocabulary(user_id, term);

-- ─── BRAIN RULES ─────────────────────────────────────────────
-- 4 call sites: the rules CRUD endpoints and the AI Brain context loader that
-- feeds them into every AI response for the tenant.
CREATE TABLE IF NOT EXISTS brain_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule        TEXT NOT NULL,
  category    TEXT DEFAULT 'general',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_brain_rules_user ON brain_rules(user_id);

-- ─── DUNNING LOGS ────────────────────────────────────────────
-- 1 call site, already wrapped in .catch(() => {}) so a missing table failed
-- silently rather than 500ing — the write was simply discarded, which is why
-- this sat unnoticed despite being the audit trail for every automated
-- collections message the app sends on a tenant's behalf.
CREATE TABLE IF NOT EXISTS dunning_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id       UUID REFERENCES dunning_rules(id) ON DELETE SET NULL,
  invoice_id    UUID REFERENCES invoices(id) ON DELETE SET NULL,
  customer_name TEXT,
  action        TEXT,
  message       TEXT,
  whatsapp_url  TEXT,
  sent_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dunning_logs_user ON dunning_logs(user_id, sent_at DESC);

-- ─── RLS for new tables (disabled for now) ───────────────────
ALTER TABLE workers             DISABLE ROW LEVEL SECURITY;
ALTER TABLE orders              DISABLE ROW LEVEL SECURITY;
ALTER TABLE attendance          DISABLE ROW LEVEL SECURITY;
ALTER TABLE expenses            DISABLE ROW LEVEL SECURITY;
ALTER TABLE business_vocabulary DISABLE ROW LEVEL SECURITY;
ALTER TABLE brain_rules         DISABLE ROW LEVEL SECURITY;
ALTER TABLE dunning_logs        DISABLE ROW LEVEL SECURITY;
ALTER TABLE payment_plans  DISABLE ROW LEVEL SECURITY;
ALTER TABLE disputes       DISABLE ROW LEVEL SECURITY;
ALTER TABLE ca_partners    DISABLE ROW LEVEL SECURITY;
ALTER TABLE referral_rewards DISABLE ROW LEVEL SECURITY;
ALTER TABLE team_members   DISABLE ROW LEVEL SECURITY;
ALTER TABLE transactions   DISABLE ROW LEVEL SECURITY;
ALTER TABLE bank_accounts  DISABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions DISABLE ROW LEVEL SECURITY;
ALTER TABLE bills          DISABLE ROW LEVEL SECURITY;

-- Done! ✓
SELECT 'Schema migration complete' AS status;
