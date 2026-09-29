'use strict';
// One release identity across the backend and the apps (desktop, phone and the
// shared contracts package carry the same version). Bump together.
const fs = require('fs');
const path = require('path');

const RELEASE = '0.1.0';
// The /api/client/* contract the apps are built against. Raise it only on a
// breaking change; apps older than MIN_CLIENT are told to update.
const API_LEVEL = 'client-1';
const MIN_CLIENT = '0.1.0';

// Railway sets RAILWAY_GIT_COMMIT_SHA on deploys from GitHub; GIT_SHA for anything else.
const gitSha = () => (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || '').slice(0, 12) || null;

// The newest migration this code expects the database to have.
let expected = null;
function expectedMigration() {
  if (expected === null) {
    try {
      expected = fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter((f) => /^\d+_.*\.sql$/.test(f)).sort().pop() || '';
    } catch { expected = ''; }
  }
  return expected || null;
}

async function appliedMigration(pool) {
  if (!pool) return null;
  try {
    // The ledger stores paths like 'migrations/053_x.sql' and also records the
    // bootstrap schema file; only the numbered migrations say how far we are.
    const { rows } = await pool.query(`SELECT filename FROM starlane_migrations WHERE filename ~ '(^|/)[0-9]+_[^/]*\\.sql$' ORDER BY filename DESC LIMIT 1`);
    return rows[0] ? path.basename(rows[0].filename) : null;
  } catch { return null; } // no ledger yet (database not baselined)
}

const startedAt = new Date().toISOString();

async function versionReport(pool) {
  const applied = await appliedMigration(pool);
  const want = expectedMigration();
  return {
    release: RELEASE, apiLevel: API_LEVEL, minClient: MIN_CLIENT, gitSha: gitSha(), startedAt,
    migrations: { expected: want, applied, upToDate: !!applied && applied === want },
  };
}

module.exports = { RELEASE, API_LEVEL, MIN_CLIENT, versionReport, expectedMigration, gitSha };
