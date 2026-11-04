// FILE: lib/domain/os/stats.js
// Small deterministic helpers shared by the operating-system modules.

const DAY = 86400000;

function quantile(values, q) {
  const v = values.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

function median(values) {
  return quantile(values, 0.5);
}

function round(n, dp = 0) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function mean(values) {
  const v = values.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

// Coefficient of variation; null when the mean is zero or there is one value.
function cv(values) {
  const m = mean(values);
  if (m == null || m === 0 || values.length < 2) return null;
  const variance = values.reduce((a, x) => a + (x - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance) / m;
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

module.exports = { DAY, quantile, median, round, mean, cv, clamp01 };
