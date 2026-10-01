'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validInstaller, freshHealthyConnector, downloadResult, assessVerdict } = require('../scripts/release-readiness-policy');

const installer = { filename: 'Starlane_0.1.2_x64-setup.exe', sha256: 'a'.repeat(64), size: 100 };
test('installer identity must include safe filename, SHA-256 and positive byte count', () => {
  assert.equal(validInstaller(installer), true);
  for (const bad of [null, {}, { ...installer, filename: '../installer.exe' }, { ...installer, sha256: 'bad' }, { ...installer, size: 0 }, { ...installer, size: '100' }]) {
    assert.equal(validInstaller(bad), false);
  }
});
test('a downloaded executable cannot pass without a valid manifest', () => {
  assert.equal(downloadResult({ sha: installer.sha256, size: 100 }, null).status, 'BLOCKED');
  assert.equal(downloadResult({ sha: installer.sha256, size: 100 }, installer).status, 'PASS');
  assert.equal(downloadResult({ sha: 'b'.repeat(64), size: 100 }, installer).status, 'FAIL');
  assert.equal(downloadResult({ sha: installer.sha256, size: 101 }, installer).status, 'FAIL');
  assert.equal(downloadResult('not a Windows executable', installer).status, 'FAIL');
});
test('signed redirect query parameters are never included in download evidence', () => {
  const result = downloadResult({ sha: installer.sha256, size: 100, final: 'https://example.test/file?sig=sensitive-value' }, installer);
  assert.equal(JSON.stringify(result).includes('sensitive-value'), false);
});
test('fresh connector success must also be healthy and not future-dated', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  const connector = (age, health = 'healthy') => ({ state: { health, lastSuccessAt: new Date(now - age).toISOString() } });
  assert.equal(freshHealthyConnector(connector(1000), now), true);
  assert.equal(freshHealthyConnector(connector(0), now), true);
  for (const bad of [connector(-1), connector(48 * 3600e3), connector(1000, 'error'), connector(1000, 'delayed'), {}, { state: { health: 'healthy', lastSuccessAt: 'invalid' } }]) {
    assert.equal(freshHealthyConnector(bad, now), false);
  }
});
test('smoke passes alone never certify a pilot or production launch', () => {
  const result = assessVerdict(['AUTH', 'MISSIONS'], { AUTH: { status: 'PASS' }, MISSIONS: { status: 'PASS' } });
  assert.equal(result.verdict, 'NOT READY');
  assert.match(result.why, /shadow mission/);
});
test('blocked, failed and missing checks remain visible in the verdict', () => {
  const result = assessVerdict(['AUTH', 'MISSIONS', 'BRIDGE'], { AUTH: { status: 'BLOCKED' }, MISSIONS: { status: 'FAIL' } });
  assert.equal(result.verdict, 'NOT READY');
  assert.equal(result.why, 'AUTH, MISSIONS, BRIDGE not passing');
});
