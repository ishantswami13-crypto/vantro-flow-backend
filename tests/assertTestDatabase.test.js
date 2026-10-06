'use strict';
// Tests must never run against a real company's database (6 Oct 2026 incident).
const assert = require('assert/strict');
const { testDatabaseProblem } = require('../lib/testing/assertTestDatabase');

const ok = (url, env = {}) => assert.equal(testDatabaseProblem(url, env), null, url);
const refused = (url, env = {}) => assert.match(testDatabaseProblem(url, env) || '', /not a test database|not a valid URL/, url);

// CI and local databases.
ok('postgres://postgres:postgres@127.0.0.1:5432/starlane_test');
ok('postgresql://postgres:postgres@localhost:5432/outbound_ci');
ok('postgres://postgres:postgres@localhost:5432/vantro_harness');
ok('postgres://u:p@[::1]:5432/anything');
ok('postgres://u:p@db.localhost/anything');
// A remote database that says it is for tests.
ok('postgres://u:p@ep-x.us-east-1.aws.neon.tech/starlane_test?sslmode=require');
// No database at all: DB tests skip themselves.
ok('');

// Production-shaped URLs are refused.
refused('postgres://neondb_owner:p@ep-x-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require');
refused('postgres://postgres:p@containers.railway.app:5432/railway');
refused('not a url');
// Unless the exact database name is confirmed.
ok('postgres://u:p@ep-x.neon.tech/scratch_copy', {});
refused('postgres://u:p@ep-x.neon.tech/neondb', { TEST_DATABASE_CONFIRM: 'other' });
ok('postgres://u:p@ep-x.neon.tech/neondb', { TEST_DATABASE_CONFIRM: 'neondb' });

console.log('PASS test database guard');
