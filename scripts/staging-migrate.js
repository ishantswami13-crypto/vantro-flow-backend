'use strict';
// scripts/staging-migrate.js
// Applies base schema + suppliers stub + migrations 001-005 to staging Postgres.
// Skips migration 006 (uses auth.uid() — Supabase-only, not compatible with Railway Postgres).
//
// Safety guards:
//   - Blocks if DATABASE_URL looks like Supabase (supabase.co in the host).
//   - Blocks if NODE_ENV=production and STAGING_MIGRATE_ALLOW_PROD is not set.
//   - Idempotent: all DDL uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
//
// Usage:
//   DATABASE_URL=<staging-postgres-url> node scripts/staging-migrate.js

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DB_URL = process.env.DATABASE_URL;

if (!DB_URL) {
  console.error('[staging-migrate] ERROR: DATABASE_URL is not set.');
  console.error('  Set DATABASE_URL to the staging Postgres URL from Railway.');
  process.exit(1);
}

// Block production Supabase URL — identified by the known production project ID.
// Non-prod Supabase projects are allowed; only the production project is blocked.
const PROD_SUPABASE_ID = 'alepdpyqesevldobjxbo';
if (DB_URL.includes(PROD_SUPABASE_ID)) {
  console.error('[staging-migrate] BLOCKED: DATABASE_URL contains the production Supabase project ID.');
  console.error('  Use a non-prod Supabase project or Railway staging Postgres, not the production DB.');
  process.exit(1);
}

if (/vantro\.in/i.test(DB_URL)) {
  console.error('[staging-migrate] BLOCKED: DATABASE_URL looks like production (vantro.in).');
  process.exit(1);
}

const REPO_ROOT = path.resolve(__dirname, '..');

// Base schema (minimal, mirrors db/sqlx-test-schema.sql for the tables that
// Cortex migrations FK into). Migrations 001-005 reference users, invoices,
// suppliers, purchases, products, call_logs as FK targets — they must exist first.
const BASE_SCHEMA = `
-- staging base schema: FK targets for Cortex migrations
-- These tables mirror the production schema columns needed by Rust queries.
-- Staging-only: NOT a production migration.

CREATE TABLE IF NOT EXISTS users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT UNIQUE NOT NULL,
  name       TEXT,
  password   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- suppliers stub: needed as FK target for ai_actions.supplier_id in migration 001.
-- Only id is required; other columns added when production supplier schema is tracked.
CREATE TABLE IF NOT EXISTS suppliers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoices (
  id             UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id    UUID,
  invoice_amount NUMERIC NOT NULL DEFAULT 0,
  total_amount   NUMERIC,
  amount_paid    NUMERIC,
  payment_status TEXT    NOT NULL DEFAULT 'Pending',
  days_overdue   INTEGER NOT NULL DEFAULT 0,
  due_date       TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchases (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount     NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  current_stock   NUMERIC NOT NULL DEFAULT 0,
  low_stock_alert NUMERIC,
  reorder_level   NUMERIC,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS call_logs (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id UUID,
  did_pick_up BOOLEAN,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

// Ordered migrations to apply. 006 is excluded (Supabase auth.uid() — not plain Postgres).
const MIGRATIONS = [
  '001_cortex_foundation.sql',
  '002_cortex_extension.sql',
  '003_evaluation.sql',
  '004_schema_repair.sql',
  '005_cortex_x_extensions.sql',
  // 006_cortex_rls.sql — SKIP: uses auth.uid() which is Supabase-specific.
  // Plain Railway Postgres does not have this function.
  '007_agent_registry.sql', // Atlas Agent Mesh 216 registry table
];

async function run() {
  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    console.log('[staging-migrate] Connected to staging Postgres.');

    // Verify this is not the Supabase production DB by checking for Supabase-specific tables
    const check = await client.query(`
      SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'auth'
    `);
    // Supabase has an auth schema with users table; plain Railway Postgres does not
    const supabaseAuthCheck = await client.query(`
      SELECT COUNT(*) AS n FROM information_schema.schemata WHERE schema_name = 'auth'
    `);
    if (parseInt(supabaseAuthCheck.rows[0].n, 10) > 0) {
      console.error('[staging-migrate] BLOCKED: database has a Supabase "auth" schema.');
      console.error('  This looks like the Supabase production database. Aborting.');
      process.exit(1);
    }

    // Apply base schema
    console.log('\n[staging-migrate] Applying base schema (FK target tables)...');
    await client.query(BASE_SCHEMA);
    console.log('[staging-migrate] Base schema: OK');

    // Apply migrations 001-005 in order
    for (const filename of MIGRATIONS) {
      const filepath = path.join(REPO_ROOT, 'migrations', filename);
      const sql = fs.readFileSync(filepath, 'utf8');

      console.log(`\n[staging-migrate] Applying ${filename}...`);
      try {
        await client.query(sql);
        console.log(`[staging-migrate] ${filename}: OK`);
      } catch (err) {
        console.error(`[staging-migrate] FAILED: ${filename}`);
        console.error(`  Error: ${err.message}`);
        console.error('\n  Classification:');
        if (/already exists/i.test(err.message)) {
          console.error('  D. Duplicate object — migration may have been partially applied. Check manually.');
        } else if (/does not exist/i.test(err.message)) {
          console.error('  B/C. Missing table dependency or stale FK. Check base schema.');
        } else if (/type/i.test(err.message)) {
          console.error('  E. Type mismatch.');
        } else {
          console.error('  Unknown — see full error above.');
        }
        console.error('\n  Rollback with: DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
        process.exit(1);
      }
    }

    // Verify key tables exist
    console.log('\n[staging-migrate] Verifying key tables...');
    const tables = ['customers', 'business_events', 'ai_actions', 'promises',
                    'business_memory', 'ai_plans', 'agent_run_log',
                    'activity_logs', 'workflow_runs'];
    for (const t of tables) {
      const r = await client.query(
        `SELECT COUNT(*) AS n FROM information_schema.tables
         WHERE table_schema='public' AND table_name=$1`, [t]
      );
      const exists = parseInt(r.rows[0].n, 10) > 0;
      console.log(`  ${exists ? '✓' : '✗'} ${t}`);
      if (!exists) { console.error(`[staging-migrate] Table ${t} missing after migration!`); process.exit(1); }
    }

    console.log('\n[staging-migrate] All migrations applied successfully.');
    console.log('  Migration 006 (RLS) skipped — Supabase-specific (auth.uid() not available on Railway Postgres).');
    console.log('\n  Next: node scripts/staging-seed.js');
  } catch (err) {
    console.error('[staging-migrate] Fatal:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
