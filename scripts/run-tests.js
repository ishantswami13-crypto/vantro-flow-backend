'use strict';
// scripts/run-tests.js — `npm test`. Runs every *.test.mjs / *.test.js under
// lib/ and tests/ as its own process (the suites are standalone scripts that
// exit non-zero on failure, not a shared framework) and prints one summary.
//
// Honesty rules:
//   - A file that needs a database (references DATABASE_URL) is reported as
//     SKIPPED — never PASS — when DATABASE_URL is not set.
//   - A file that exits 0 but printed "SKIP" lines is reported as PASS with the
//     skip count shown, so "green" never hides "didn't actually run".
//
// Local DB: `PGSSLMODE=disable DATABASE_URL=postgres://postgres@127.0.0.1/starlane_test
//            node scripts/migrate.js && npm test`

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TIMEOUT_MS = Number(process.env.TEST_FILE_TIMEOUT_MS || 180000);
const filter = process.argv[2] || '';

function findTests(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...findTests(full));
    } else if (/\.test\.(mjs|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = ['lib', 'tests']
  .flatMap((d) => findTests(path.join(ROOT, d)))
  .map((f) => path.relative(ROOT, f))
  .filter((f) => f.includes(filter))
  .sort();

const hasDb = !!process.env.DATABASE_URL;
const dbProblem = require('../lib/testing/assertTestDatabase').testDatabaseProblem();
if (dbProblem) {
  console.error(`REFUSED: ${dbProblem}`);
  process.exit(2);
}
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = require('crypto').randomBytes(32).toString('hex');

const results = [];
for (const file of files) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const needsDb = /DATABASE_URL/.test(src);
  if (needsDb && !hasDb) { results.push({ file, status: 'SKIPPED', note: 'needs DATABASE_URL' }); continue; }

  const started = Date.now();
  const r = spawnSync(process.execPath, [file], { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: TIMEOUT_MS });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  const skips = (output.match(/^\s*SKIP\b/gm) || []).length;
  const ms = Date.now() - started;
  if (r.status === 0) results.push({ file, status: 'PASS', note: skips ? `${skips} check(s) skipped` : '', ms });
  else {
    results.push({ file, status: 'FAIL', note: r.error ? r.error.message : `exit ${r.status}`, ms });
    process.stdout.write(`\n── ${file} (failed) ──\n${output.split('\n').slice(-40).join('\n')}\n`);
  }
}

console.log('\nTest files:');
for (const r of results) {
  console.log(`  ${r.status.padEnd(7)} ${r.file}${r.ms != null ? ` (${r.ms}ms)` : ''}${r.note ? ` — ${r.note}` : ''}`);
}
const count = (s) => results.filter((r) => r.status === s).length;
console.log(`\n${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIPPED')} skipped (of ${results.length})`);
process.exit(count('FAIL') ? 1 : 0);
