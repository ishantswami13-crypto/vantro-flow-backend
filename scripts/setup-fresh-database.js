'use strict';
// scripts/setup-fresh-database.js
// One-command bootstrap for a FRESH (free-tier) Supabase project.
//
// What it does, in order:
//   1. Applies every pending schema migration via scripts/migrate.js (ledgered,
//      transactional, stops on the first failure)
//   2. Creates the owner login account directly (no OTP needed)
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
const { buildSanitizedPgConfig } = require('../lib/db/pgConfig');
const bcrypt = require('bcryptjs');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// Schema order and the applied-migrations ledger live in scripts/migrate.js —
// the single source of truth. This file used to keep its own hand-maintained
// list, which drifted (046-048 were missing) and swallowed failures.
const { run: runMigrations } = require('./migrate');

async function main() {
  if (!process.env.DATABASE_URL || /your-|replace-/.test(process.env.DATABASE_URL)) {
    console.error('❌ DATABASE_URL is missing or still a placeholder. Fill .env first (Supabase → Settings → Database → Connection string).');
    process.exit(1);
  }

  const email = arg('email');
  const password = arg('password');
  const business = arg('business', 'My Business');
  const phone = arg('phone', '');

  await runMigrations({ mode: 'apply' });

  const client = new Client(buildSanitizedPgConfig(process.env.DATABASE_URL));
  await client.connect();
  console.log('✅ Connected to database.');

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
