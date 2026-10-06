'use strict';
// Tests write rows, create and drop scratch databases and schemas, and some
// change session settings. Through a transaction-mode pooler (Neon, PgBouncer)
// a session setting such as `SET search_path` sticks to a shared server
// connection and every other client on it inherits it — on 6 Oct 2026 one test
// run against production made every desktop sign-in fail with
// `relation "users" does not exist` until the pooler recycled the connection.
//
// So a test only runs against a database that is plainly a test database:
//   - on this machine (localhost, 127.0.0.1, ::1, *.localhost), or
//   - whose database name says so (test, _ci, harness, scratch), or
//   - when TEST_DATABASE_CONFIRM is set to that exact database name.
// Anything else (for example neondb on *.neon.tech) is refused before a query.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const TEST_NAME = /(test|_ci$|^ci_|harness|scratch)/i;

function describe(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const database = decodeURIComponent(u.pathname.replace(/^\//, '')) || '(default)';
    return { host, database };
  } catch {
    return null;
  }
}

// Returns null when the URL is safe for tests, otherwise a sentence saying why not.
function testDatabaseProblem(url = process.env.DATABASE_URL, env = process.env) {
  if (!url) return null; // no database: DB tests skip themselves
  const d = describe(url);
  if (!d) return 'DATABASE_URL is not a valid URL, so it cannot be confirmed as a test database.';
  if (LOCAL_HOSTS.has(d.host) || d.host.endsWith('.localhost')) return null;
  if (TEST_NAME.test(d.database)) return null;
  if (env.TEST_DATABASE_CONFIRM && env.TEST_DATABASE_CONFIRM === d.database) return null;
  return `DATABASE_URL points at database "${d.database}" on ${d.host}, which is not a test database. `
    + 'Tests write and drop data and can leave pooled connections broken. Use a local or *_test database, '
    + `or set TEST_DATABASE_CONFIRM=${d.database} if this really is a throwaway database.`;
}

function assertTestDatabase(url = process.env.DATABASE_URL) {
  const problem = testDatabaseProblem(url);
  if (problem) {
    console.error(`REFUSED: ${problem}`);
    process.exit(2);
  }
}

module.exports = { testDatabaseProblem, assertTestDatabase };
