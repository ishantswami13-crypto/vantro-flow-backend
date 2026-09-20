'use strict';
// scripts/setup-fresh-database.js
// One-command bootstrap for a FRESH (free-tier) Supabase project.
//
// What it does, in order:
//   1. Runs the full base schema  (supabase-schema.sql — idempotent)
//   2. Runs cortex migrations     (migrations/001..005 — idempotent)
//   3. Runs phase 2C.32 additions (supabase-phase2c32-schema.sql — idempotent)
//   4. Creates the owner login account directly (no OTP needed)
//
// The remaining tables (sales, purchases, suppliers, khata_entries) are
// created automatically by server.js's runAutoMigrations() on first boot.
//
// Usage:
//   1. Fill .env with the new project's values:
//        SUPABASE_URL=https://<ref>.supabase.co
//        SUPABASE_SERVICE_ROLE_KEY=<service_role key>
//        DATABASE_URL=<Connection string from Supabase: Settings -> Database>
//        JWT_SECRET=<any long random string>
//   2. node scripts/setup-fresh-database.js --email chacha@example.com --password <8+ chars> --business "Chacha Traders" --phone 91XXXXXXXXXX
//
// Safe to re-run: schema files are IF NOT EXISTS; an existing owner account
// with the same email is left untouched.

require('dotenv').config();
const { Client } = require('pg');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SQL_FILES = [
  'supabase-schema.sql',
  'migrations/001_cortex_foundation.sql',
  'migrations/002_cortex_extension.sql',
  'migrations/003_evaluation.sql',
  'migrations/004_schema_repair.sql',
  'migrations/005_cortex_x_extensions.sql',
  'supabase-phase2c32-schema.sql',
  // Was written, reviewed, and never wired in here — error_events existed only
  // on paper. GET/PATCH /api/admin/error-events and the error-tracking helpers
  // in lib/observability and lib/cortex all queried a table nothing created.
  // It is self-contained (creates its own extension, indexes, and RLS policies)
  // and already denies anon/authenticated access, matching how every write here
  // goes through the service_role client, which bypasses RLS regardless.
  'supabase-error-events-rollout.sql',
  // Promotes DDL that used to run only inside runAutoMigrations() in
  // server.js, which is gated on DATABASE_URL — a variable separate from the
  // SUPABASE_* ones the rest of the app needs, and easy to leave unset.
  // khata_entries, purchases, sales, inventory, purchase_orders and
  // notifications existed nowhere without it. Must run last: it alters
  // customers and ai_actions, which only exist after
  // migrations/001_cortex_foundation.sql.
  'migrations/006_boot_migration_promoted.sql',
  'migrations/006_cortex_rls.sql',
  'migrations/007_agent_registry.sql',
  'migrations/008_purchases_sales_bootstrap.sql',
  'migrations/011_customer_score_history.sql',
  'migrations/013_orders_and_workers.sql',
  'migrations/014_receivables_execution.sql',
  'migrations/015_world_intelligence_core.sql',
  'migrations/016_world_transmission_channels_seed.sql',
  'migrations/017_business_exposure_phase2.sql',
  'migrations/018_business_exposure_registry_phase3a.sql',
  'migrations/019_ai_actions_suggested_by_widen.sql',
  'migrations/020_payment_allocations.sql',
  'migrations/021_organizations.sql',
  'migrations/022_entity_geo_currency_context.sql',
  'migrations/023_entity_state_history.sql',
  'migrations/024_product_supplier_purchase_lines.sql',
  'migrations/025_predictions.sql',
  'migrations/026_belief_revision.sql',
  'migrations/027_tenant_review_checkpoints.sql',
  'migrations/028_temporal_intelligence.sql',
  'migrations/029_reality_acquisition_observations.sql',
  'migrations/030_import_batches.sql',
  'migrations/031_data_connections.sql',
  'migrations/040_supply_chain_dependency.sql',
  'migrations/041_execution_records_supply_chain_channel.sql',
  'migrations/042_investigations.sql',
  'migrations/043_agent_runs.sql',
  'migrations/044_world_sources_registry_semantics.sql',
  'migrations/045_action_execution_loop.sql',
];

async function main() {
  if (!process.env.DATABASE_URL || /your-|replace-/.test(process.env.DATABASE_URL)) {
    console.error('❌ DATABASE_URL is missing or still a placeholder. Fill .env first (Supabase → Settings → Database → Connection string).');
    process.exit(1);
  }

  const email = arg('email');
  const password = arg('password');
  const business = arg('business', 'My Business');
  const phone = arg('phone', '');

  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('✅ Connected to database.');

  const root = path.join(__dirname, '..');
  for (const f of SQL_FILES) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) { console.log(`⚠️  ${f} not found — skipped.`); continue; }
    process.stdout.write(`📄 Running ${f} ... `);
    try {
      await client.query(fs.readFileSync(p, 'utf-8'));
      console.log('ok.');
    } catch (e) {
      // Idempotent-by-convention files can still trip on pre-existing objects
      // with slightly different shapes — report and continue, don't abort.
      console.log(`warning (continuing): ${e.message.split('\n')[0]}`);
    }
  }

  if (email && password) {
    if (password.length < 8) { console.error('❌ Password must be at least 8 characters.'); process.exit(1); }
    const { rows } = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (rows.length) {
      console.log(`👤 Owner account ${email} already exists — left untouched.`);
    } else {
      const hash = await bcrypt.hash(password, 12);
      const { rows: created } = await client.query(
        `INSERT INTO users (email, phone, business_name, password_hash, plan, created_at)
         VALUES ($1, $2, $3, $4, 'free', NOW()) RETURNING id`,
        [email, phone, business, hash]
      );
      console.log(`👤 Owner account created: ${email} (id ${created[0].id})`);
    }
  } else {
    console.log('ℹ️  No --email/--password given — skipped owner account creation.');
  }

  await client.end();
  console.log('\n🎉 Database ready. Start the backend (node server.js) — it auto-creates the last few tables on boot — then log in from the app with the owner email/password.');
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
