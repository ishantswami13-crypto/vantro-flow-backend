#!/usr/bin/env node
'use strict';
// scripts/rotate-credentials-key.js — re-encrypt every stored credential under
// the current OUTBOUND_CREDENTIALS_KEY.
//
// Procedure:
//   1. Generate a new key: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//   2. In the server environment set OUTBOUND_CREDENTIALS_KEY=<new> and
//      OUTBOUND_CREDENTIALS_KEY_PREVIOUS=<old>, and deploy. Old values still
//      decrypt (credentials.js tries the previous key second).
//   3. Run: DATABASE_URL=... OUTBOUND_CREDENTIALS_KEY=<new> OUTBOUND_CREDENTIALS_KEY_PREVIOUS=<old> \
//        node scripts/rotate-credentials-key.js            (dry run: counts only)
//        node scripts/rotate-credentials-key.js --apply    (re-encrypts)
//   4. When it reports 0 values on the previous key, remove
//      OUTBOUND_CREDENTIALS_KEY_PREVIOUS and deploy.
//
// It never prints a decrypted value. Values no key can open are counted and
// left alone (they were already unusable).

require('dotenv').config();
const creds = require('../lib/domain/outbound/credentials');
const { getPool } = require('../lib/db/pg');

const COLUMNS = [
  ['outbound_provider_accounts', 'credentials_enc'],
  ['starlane_connections', 'secret_enc'],
  ['app_connector_accounts', 'credentials_enc'],
  ['platform_app_connections', 'credentials_enc'],
  ['platform_oauth_states', 'code_verifier_enc'],
];

async function rotate(pool, { apply = false } = {}) {
  if (!creds.available()) throw new Error('OUTBOUND_CREDENTIALS_KEY is not set or not 32 bytes');
  const report = [];
  for (const [table, column] of COLUMNS) {
    const exists = await pool.query('SELECT to_regclass($1) AS t', [`public.${table}`]);
    if (!exists.rows[0].t) { report.push({ table, column, skipped: 'table not present' }); continue; }
    const pk = table === 'platform_oauth_states' ? 'state_hash' : 'id';
    const { rows } = await pool.query(`SELECT ${pk} AS k, ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`);
    const counts = { current: 0, previous: 0, unreadable: 0, reencrypted: 0 };
    for (const r of rows) {
      const status = creds.keyStatus(r.v);
      counts[status] += 1;
      if (status === 'previous' && apply) {
        const value = creds.decrypt(r.v);
        await pool.query(`UPDATE ${table} SET ${column} = $2 WHERE ${pk} = $1 AND ${column} = $3`, [r.k, creds.encrypt(value), r.v]);
        counts.reencrypted += 1;
      }
    }
    report.push({ table, column, ...counts });
  }
  return report;
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  const pool = getPool();
  rotate(pool, { apply })
    .then((report) => {
      console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', report }, null, 2));
      return pool.end();
    })
    .catch((err) => { console.error(`FAILED ${err.message}`); process.exit(1); });
}

module.exports = { rotate, COLUMNS };
