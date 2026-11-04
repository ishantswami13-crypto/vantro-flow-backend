// FILE: lib/db/testDatabaseGuard.js
// Tests create and drop schemas, tables and rows. They must never run against
// a real database: on 6 Oct 2026 a test run against production through Neon's
// pooler left a SET search_path on a shared server connection, and production
// could not find its tables until that connection was recycled.
//
// A test database is one on this machine (localhost / 127.0.0.1 / ::1), which
// is what local runs and every CI workflow use. Anything else is refused unless
// ALLOW_REMOTE_TEST_DATABASE=1 is set deliberately for a disposable database.
'use strict';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function testDatabaseProblem(url = process.env.DATABASE_URL) {
  if (!url) return null;
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return 'DATABASE_URL is not a valid URL'; }
  if (LOOPBACK.has(host)) return null;
  if (process.env.ALLOW_REMOTE_TEST_DATABASE === '1') return null;
  return `refusing to run tests against a non-local database (${host}). Tests create and drop schemas and rows; point DATABASE_URL at a local test database, or set ALLOW_REMOTE_TEST_DATABASE=1 only for a disposable one.`;
}

function assertTestDatabase(url) {
  const problem = testDatabaseProblem(url);
  if (problem) { console.error(`FATAL ${problem}`); process.exit(2); }
}

module.exports = { testDatabaseProblem, assertTestDatabase };
