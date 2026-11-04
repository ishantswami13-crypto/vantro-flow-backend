'use strict';
// lib/db/migrationLedger.js — where scripts/migrate.js records applied files.
//
// The ledger is its own table, starlane_migrations. Production already has an
// unrelated `schema_migrations` table (version, checksum, applied_at,
// applied_by; empty) that was created outside this repository, and this
// branch's first revision used that same name, so preflight crashed on it
// ("column filename does not exist"). That table is never read or written
// here; whatever made it keeps it.
//
// A database migrated by the first revision (a dev or rehearsal copy) has its
// ledger under the old name. adoptEarlierLedger() renames it once, and only
// when it is recognisably ours (it has a `filename` column) and the new table
// does not exist yet.

const LEDGER_TABLE = 'starlane_migrations';
const EARLIER_NAME = 'schema_migrations';

const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
    filename   TEXT PRIMARY KEY,
    checksum   TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

async function tableColumns(client, table) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`, [table]);
  return new Set(rows.map((r) => r.column_name));
}

// Read-only: which table holds this database's ledger right now, if any.
async function locateLedger(client) {
  if ((await tableColumns(client, LEDGER_TABLE)).size) return LEDGER_TABLE;
  if ((await tableColumns(client, EARLIER_NAME)).has('filename')) return EARLIER_NAME;
  return null;
}

async function adoptEarlierLedger(client) {
  if (await locateLedger(client) === EARLIER_NAME) {
    await client.query(`ALTER TABLE ${EARLIER_NAME} RENAME TO ${LEDGER_TABLE}`);
    return true;
  }
  return false;
}

module.exports = { LEDGER_TABLE, EARLIER_NAME, LEDGER_DDL, locateLedger, adoptEarlierLedger };
