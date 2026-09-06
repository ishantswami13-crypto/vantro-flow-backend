require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const files = [
  'supabase-schema.sql',
  'migrations/001_cortex_foundation.sql',
  'migrations/002_cortex_extension.sql',
  'migrations/003_evaluation.sql',
  'migrations/004_schema_repair.sql',
  'migrations/005_cortex_x_extensions.sql',
  'migrations/006_cortex_rls.sql',
  'migrations/007_agent_registry.sql',
  'supabase-phase2c32-schema.sql',
  'migrations/013_orders_and_workers.sql',
  'scripts/supabase/phase-2c-18-users-schema-align.sql',
];

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('Connected.');
  for (const f of files) {
    const p = path.join(__dirname, '..', f);
    if (!fs.existsSync(p)) { console.log('SKIP (missing):', f); continue; }
    const sql = fs.readFileSync(p, 'utf-8');
    try {
      await client.query(sql);
      console.log('OK:', f);
    } catch (err) {
      console.log('ERROR in', f, ':', err.message);
    }
  }
  await client.end();
  console.log('Done.');
}

run();
