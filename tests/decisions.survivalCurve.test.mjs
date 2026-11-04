import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { samplePaymentDay, survivalCurve, firstPaymentDay } = require('../lib/domain/decisions/behavior.js');
const { mulberry32 } = require('../lib/domain/decisions/rng.js');

test('a cached survival curve gives the same payment day as walking the horizon', () => {
  const rand = mulberry32(7);
  for (let t = 0; t < 300; t++) {
    const daily = Float64Array.from({ length: t % 5 === 0 ? 20 : 400 }, () => rand() * (t % 3 === 0 ? 0.4 : 0.05));
    const age = Math.floor(rand() * 250);
    const horizon = [30, 60, 90][t % 3];
    const mult = 0.5 + rand() * 1.5;
    const offset = t % 4 === 0 ? 7 : 0;
    const shock = 0.5 + rand();
    const curve = survivalCurve(daily, age, horizon, mult, offset, shock);
    for (let k = 0; k < 20; k++) {
      const u = rand();
      assert.equal(firstPaymentDay(curve, u), samplePaymentDay(daily, age, horizon, u, mult, offset, shock));
    }
  }
});

test('a curve that never drops below the draw means not paid in the horizon', () => {
  const curve = survivalCurve(new Float64Array(60), 10, 90);
  assert.equal(firstPaymentDay(curve, 0.5), -1);
});
