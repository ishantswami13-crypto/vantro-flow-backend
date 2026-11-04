import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { trimBaselineEvidence } = require('../lib/routes/scenarios.js');

test('a large baseline keeps 50 evidence rows and reports the full count', () => {
  const evidence = Array.from({ length: 10000 }, (_, i) => ({ table: 'invoices', id: String(i), amount: i }));
  const baseline = { status: 'PROJECTED', totalOverdue: 5, projection: { label: 'x', evidence } };
  const out = trimBaselineEvidence(baseline);
  assert.equal(out.projection.evidence.length, 50);
  assert.equal(out.projection.evidence[0].id, '0');
  assert.equal(out.projection.evidenceCount, 10000);
  assert.equal(out.projection.evidenceTruncated, true);
  assert.equal(out.totalOverdue, 5);
  assert.equal(baseline.projection.evidence.length, 10000, 'the baseline itself is not changed');
});

test('a small baseline is returned as is', () => {
  const baseline = { projection: { evidence: [{ id: '1' }] } };
  assert.equal(trimBaselineEvidence(baseline), baseline);
  assert.equal(trimBaselineEvidence({ status: 'NO_DATA' }).status, 'NO_DATA');
});
