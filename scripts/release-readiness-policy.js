'use strict';

// Pure assessments shared by the live probe and its regression tests.
function validInstaller(inst) {
  return !!inst && typeof inst.filename === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.exe$/i.test(inst.filename) &&
    /^[a-f0-9]{64}$/i.test(inst.sha256 || '') &&
    Number.isSafeInteger(inst.size) && inst.size > 0;
}

function freshHealthyConnector(connector, now = Date.now()) {
  const state = connector?.state;
  if (state?.health !== 'healthy' || !state.lastSuccessAt) return false;
  const age = now - Date.parse(state.lastSuccessAt);
  return Number.isFinite(age) && age >= 0 && age < 48 * 3600e3;
}

function downloadResult(got, installer) {
  if (typeof got === 'string') return { status: 'FAIL', detail: got };
  if (!validInstaller(installer)) return { status: 'EXTERNAL VALIDATION REQUIRED', detail: 'binary downloaded, but no valid published manifest is available to verify it' };
  if (got.sha.toLowerCase() !== installer.sha256.toLowerCase() || got.size !== installer.size) {
    return { status: 'FAIL', detail: 'download SHA-256/size do not match the manifest' };
  }
  // Redirect URLs can contain expiring credentials. Report identity, not URLs.
  return { status: 'PASS', detail: `${got.size} bytes, sha256 ${got.sha}, matches manifest` };
}

function assessVerdict(checks, results) {
  const missing = checks.filter((c) => results[c]?.status !== 'PASS');
  if (missing.length) return { verdict: 'NOT READY', why: `${missing.join(', ')} not passing` };
  // These probes do not prove installation, Tally correctness, a shadow mission,
  // runtime tenant isolation, or monitoring/support. Manifest booleans and an
  // owner-declared pilot count cannot substitute for those acceptance tests.
  return { verdict: 'NOT READY', why: 'Automated smoke checks pass; pilot/production readiness still requires independently verified real-PC installation, Tally sync, end-to-end shadow mission, runtime tenant isolation, and the remaining product acceptance gates. This probe cannot certify those outcomes.' };
}

module.exports = { validInstaller, freshHealthyConnector, downloadResult, assessVerdict };
