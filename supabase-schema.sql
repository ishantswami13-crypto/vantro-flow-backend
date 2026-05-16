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

-- ─── BILLING RECORDS ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_records (
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

-- Add missing columns to existing billing_records table
ALTER TABLE billing_records ADD COLUMN IF NOT EXISTS period TEXT;
ALTER TABLE billing_records ADD COLUMN IF NOT EXISTS amount NUMERIC;
ALTER TABLE billing_records ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'INR';
ALTER TABLE billing_records ADD COLUMN IF NOT EXISTS order_id TEXT;

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
ALTER TABLE billing_records DISABLE ROW LEVEL SECURITY;

-- Done! ✓
SELECT 'Schema migration complete' AS status;
