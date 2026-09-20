'use strict';
// scripts/check-dependency-audit.js
//
// Fails on any high or critical advisory in the production dependency tree,
// except ones explicitly allowlisted below with a reason.
//
// This replaces a bare `npm audit --audit-level=high` running under
// continue-on-error, which reported problems and then passed regardless — so a
// high-severity finding in a shipped dependency looked identical to a clean
// run. An exception that is written down and printed on every run is worth more
// than a gate that never fires.
//
// Dev dependencies are excluded on purpose: they do not ship, and the eslint
// toolchain generates enough advisory noise to bury anything real.
//
// Usage:
//   node scripts/check-dependency-audit.js
//   npm run security:audit-gate

const { execFileSync } = require('child_process');

// Advisories that cannot currently be fixed. Each needs a reason and the
// condition that would let it be removed — not just an ID.
const ALLOWLIST = [
  {
    id: 'GHSA-4r6h-8v6p-xvw6',
    package: 'xlsx',
    title: 'Prototype pollution in SheetJS',
    reason:
      'Fixed in xlsx >= 0.19.3, but SheetJS stopped publishing to the npm registry after ' +
      '0.18.5 — the registry\'s "latest" is the vulnerable version, so npm cannot resolve a ' +
      'fix and reports fixAvailable: false. Newer builds are distributed only from ' +
      'cdn.sheetjs.com.',
    reachable:
      'Yes. XLSX.read() runs on user-uploaded buffers at POST /api/import/excel and POST ' +
      '/api/bank/transactions/import. Both require authentication and are capped at 5001 ' +
      'rows by the sheetRows option, and both now sit behind the upload rate limiter — the ' +
      'bank import did not until it was added to the uploadLimiter list, having previously ' +
      'fallen through to the general 120/min limit. Narrowed, not removed.',
    removeWhen:
      'A fixed build becomes installable from an environment that can reach cdn.sheetjs.com. ' +
      'Migrating to exceljs was assessed and rejected: it cannot read legacy BIFF .xls at ' +
      'all, which is what Tally and Indian bank portals export and which ' +
      'ALLOWED_UPLOAD_EXTENSIONS still accepts, and workbook.xlsx.load() has no row cap, so ' +
      'it would materialise an unbounded sheet before any size guard could run.',
  },
  {
    id: 'GHSA-5pgg-2g8v-p4x9',
    package: 'xlsx',
    title: 'SheetJS regular expression denial of service',
    reason: 'Same package and same distribution problem as the entry above — fixed in >= 0.20.2, unavailable on npm.',
    reachable:
      'Yes, via the same two upload paths, with the same 5001-row cap and upload rate limit. ' +
      'This is the advisory the rate limit matters most for: a ReDoS is cheap to trigger ' +
      'repeatedly, which is why the bank import falling outside the upload limiter was worth ' +
      'fixing on its own.',
    removeWhen: 'Same as above.',
  },
];

const BLOCKING_SEVERITIES = new Set(['high', 'critical']);

function runAudit() {
  try {
    // npm audit exits non-zero when it finds anything, so the throw is expected
    // and the JSON we want is on stdout either way.
    const out = execFileSync('npm', ['audit', '--omit=dev', '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    return JSON.parse(out);
  } catch (err) {
    if (err.stdout) {
      try { return JSON.parse(err.stdout); } catch { /* fall through */ }
    }
    console.error('[SECURITY] Could not run npm audit:', err.message);
    process.exit(1);
  }
}

// Wraps a labelled paragraph to a readable width. Naive truncation to the first
// sentence cuts version numbers in half ("fixed in >= 0.").
function wrap(text, label, indent, width = 84) {
  const pad = ' '.repeat(indent);
  const head = `${pad}${label}: `;
  const cont = ' '.repeat(head.length);
  const out = [];
  let line = head;
  for (const word of text.split(/\s+/)) {
    if (line.length + word.length + 1 > width && line.trim() !== label + ':') {
      out.push(line);
      line = cont + word;
    } else {
      line += (line === head || line === cont ? '' : ' ') + word;
    }
  }
  out.push(line);
  return out.join('\n');
}

function main() {
  console.log('[SECURITY] Auditing production dependencies...');

  const report = runAudit();
  const allowed = new Set(ALLOWLIST.map(a => a.id));

  const blocking = [];
  const acknowledged = [];

  for (const [pkg, v] of Object.entries(report.vulnerabilities || {})) {
    if (!BLOCKING_SEVERITIES.has(v.severity)) continue;
    for (const via of (v.via || [])) {
      if (typeof via !== 'object') continue;
      const id = (via.url || '').split('/').pop();
      if (allowed.has(id)) acknowledged.push({ pkg, id, title: via.title });
      else blocking.push({ pkg, id, title: via.title, severity: v.severity, url: via.url });
    }
  }

  if (acknowledged.length) {
    console.log(`\n  ${acknowledged.length} known, unfixable advisory(ies) — allowlisted, not ignored:`);
    for (const a of acknowledged) {
      const entry = ALLOWLIST.find(e => e.id === a.id);
      console.log(`    ${a.pkg} ${a.id} — ${a.title}`);
      console.log(wrap(entry.reason, 'why it stays', 6));
      console.log(wrap(entry.reachable, 'reachable', 6));
    }
  }

  // An allowlist entry for something no longer reported means the problem is
  // gone and the exception should be deleted rather than left to rot.
  const reported = new Set(acknowledged.map(a => a.id));
  const stale = ALLOWLIST.filter(a => !reported.has(a.id));
  if (stale.length) {
    console.log(`\n  ${stale.length} allowlist entry(ies) no longer reported — remove them:`);
    stale.forEach(s => console.log(`    ${s.package} ${s.id}`));
  }

  if (blocking.length === 0) {
    console.log(`\n[SECURITY] Dependency Audit Passed: no unreviewed high or critical advisories.`);
    return;
  }

  console.error(`\n[SECURITY] Dependency Audit FAILED — ${blocking.length} unreviewed advisory(ies):\n`);
  for (const b of blocking) {
    console.error(`  ${b.pkg} [${b.severity}] ${b.id}`);
    console.error(`    ${b.title}`);
    console.error(`    ${b.url}`);
    console.error('');
  }
  console.error('Upgrade the dependency, or add the advisory to ALLOWLIST in this file with a');
  console.error('reason, a reachability assessment, and the condition that would remove it.\n');
  process.exit(1);
}

main();
