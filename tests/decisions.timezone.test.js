// FILE: tests/decisions.timezone.test.js
// The supplier-delay workflow must give the same answer whatever timezone the
// server runs in. node-pg turns a Postgres DATE (order_line_items.needed_by,
// purchase_line_receipts.received_on) into a JS Date at LOCAL midnight; reading
// that with toISOString() moved every promised date one day earlier on a
// server east of UTC (India: 2 Dec became 1 Dec), which changed slip days,
// the dates quoted in customer drafts, and could flip an order between on
// time and late.
//
// This file (1) checks the DATE helper directly and (2) re-runs the three
// end-to-end supplier-delay suites (including decision reconciliation) with the process (test runner + spawned
// server) in timezones east and west of UTC. Needs DATABASE_URL; the runner
// reports it SKIPPED without one.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const { pgDateDay } = require('../lib/domain/decisions/dates');

const ROOT = path.join(__dirname, '..');

test('pgDateDay reads a node-pg DATE as its calendar day in any timezone', () => {
  // What node-pg builds for DATE '2026-12-02': local midnight.
  assert.equal(pgDateDay(new Date(2026, 11, 2)), '2026-12-02');
  assert.equal(pgDateDay(new Date(2026, 0, 1)), '2026-01-01');
  assert.equal(pgDateDay('2026-12-02'), '2026-12-02');
  assert.equal(pgDateDay('2026-12-02T00:00:00.000Z'), '2026-12-02');
  assert.equal(pgDateDay(null), null);
  assert.equal(pgDateDay(''), null);
  assert.equal(pgDateDay(new Date('invalid')), null);
});

for (const tz of ['Asia/Kolkata', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
  test(`supplier-delay suites pass with the server in ${tz}`, { skip: !process.env.DATABASE_URL && 'needs DATABASE_URL' }, () => {
    const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'tests/decisions.supplierDelay.test.js', 'tests/operations.realData.test.js', 'tests/decisions.delayReconcile.test.js'], {
      cwd: ROOT,
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
      timeout: 170000,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const failed = out.split('\n').filter((l) => /^not ok/.test(l));
    assert.equal(r.status, 0, `TZ=${tz}: ${failed.join('; ') || out.slice(-2000)}`);
    assert.match(out, /^# fail 0$/m);
    assert.doesNotMatch(out, /^# skipped [1-9]/m, 'a suite skipped its checks');
  });
}
