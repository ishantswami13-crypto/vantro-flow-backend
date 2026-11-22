#!/usr/bin/env node
'use strict';
// npm run security:deps — fails when a production dependency has a high or
// critical advisory that is not on the reviewed list below. Moderate and low
// advisories are printed but do not fail the build.
//
// A package goes on ACCEPTED only with a reason and a review date, and comes
// off as soon as a fix exists. Never add one to make CI green without that.

const { execFileSync } = require('child_process');

const ACCEPTED = {
  xlsx: {
    reason: 'SheetJS no longer publishes fixes to npm. Used only to read spreadsheets a signed-in user uploads in import routes (invoices, bank statements, ledgers). Replace with the SheetJS CDN build or another parser.',
    reviewed: '2026-11-22',
  },
};

let raw;
try {
  raw = execFileSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
} catch (err) {
  raw = err.stdout; // npm audit exits non-zero when it finds anything
  if (!raw) { console.error('[deps] npm audit could not run:', err.message); process.exit(2); }
}

let report;
try { report = JSON.parse(raw); } catch { console.error('[deps] npm audit returned no JSON'); process.exit(2); }
if (report.error) { console.error('[deps] npm audit failed:', report.error.summary || report.error.code); process.exit(2); }

const blocking = [];
const accepted = [];
const minor = [];
for (const [name, v] of Object.entries(report.vulnerabilities || {})) {
  const titles = (v.via || []).filter((x) => typeof x === 'object').map((x) => `${x.title} (${x.url})`);
  const line = `${name} [${v.severity}] ${v.range}${titles.length ? ` — ${titles.join('; ')}` : ` — via ${(v.via || []).join(', ')}`}`;
  if (v.severity === 'high' || v.severity === 'critical') {
    (ACCEPTED[name] ? accepted : blocking).push(line);
  } else {
    minor.push(line);
  }
}

console.log('[deps] Production dependency audit');
for (const l of minor) console.log(`  note     ${l}`);
for (const l of accepted) console.log(`  accepted ${l}\n           reason: ${ACCEPTED[l.split(' ')[0]].reason}`);
for (const l of blocking) console.log(`  BLOCKING ${l}`);
if (blocking.length) {
  console.error(`\n[deps] FAIL: ${blocking.length} high or critical advisory(ies) without a reviewed exception.`);
  process.exit(1);
}
console.log(`\n[deps] PASS (${accepted.length} reviewed exception(s), ${minor.length} moderate/low note(s))`);
