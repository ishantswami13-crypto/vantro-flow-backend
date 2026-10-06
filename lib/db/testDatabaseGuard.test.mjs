// The test-database guard: local databases only, unless explicitly allowed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { testDatabaseProblem } = require('./testDatabaseGuard');
const { checkDb } = require('../health/deepReadiness');

const saved = process.env.ALLOW_REMOTE_TEST_DATABASE;
delete process.env.ALLOW_REMOTE_TEST_DATABASE;
assert.equal(testDatabaseProblem('postgres://u:p@127.0.0.1/starlane_test'), null);
assert.equal(testDatabaseProblem('postgres://u:p@localhost:5432/x'), null);
assert.equal(testDatabaseProblem('postgres://u:p@[::1]/x'), null);
assert.match(testDatabaseProblem('postgres://u:p@ep-x-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require'), /non-local database \(ep-x-pooler/);
assert.ok(!/u:p/.test(testDatabaseProblem('postgres://u:p@db.example.com/x')), 'never echoes credentials');
assert.match(testDatabaseProblem('not a url'), /not a valid URL/);
process.env.ALLOW_REMOTE_TEST_DATABASE = '1';
assert.equal(testDatabaseProblem('postgres://u:p@db.example.com/x'), null);
if (saved === undefined) delete process.env.ALLOW_REMOTE_TEST_DATABASE; else process.env.ALLOW_REMOTE_TEST_DATABASE = saved;

// Deep health fails when the core table does not resolve (wrong search_path), not only when the DB is down.
assert.equal(await checkDb({ query: async () => ({ rows: [{ ok: true }] }) }), 'ok');
assert.equal(await checkDb({ query: async () => ({ rows: [{ ok: false }] }) }), 'fail');
assert.equal(await checkDb({ query: async () => { throw new Error('down'); } }), 'fail');
assert.equal(await checkDb(null), 'skipped');
console.log('PASS test database guard + deep health table check');
