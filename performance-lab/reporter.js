'use strict';

// FILE: performance-lab/reporter.js
// Writes performance-lab/results/latest.json + performance-lab/reports/latest.md
// and prints crisp console summary. Never logs token or raw response body.

const fs   = require('fs');
const path = require('path');

const RESULTS_DIR = path.join(__dirname, 'results');
const REPORTS_DIR = path.join(__dirname, 'reports');

function ensureDirs() {
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function printConsole(summary) {
  const W    = 62;
  const line = '─'.repeat(W);
  console.log('\n' + line);
  console.log('  Vantro Performance Lab');
  console.log(`  Mode:     ${summary.mode}`);
  console.log(`  Rust URL: ${summary.rustBaseUrl  ? 'configured' : 'not configured'}`);
  console.log(`  Node URL: ${summary.nodeBaseUrl  ? 'configured' : 'not configured'}`);
  console.log(line);

  for (const r of summary.results) {
    const tag  = r.skipped ? 'SKIP' : r.pass ? 'PASS' : 'FAIL';
    const dur  = r.skipped ? '---           ' :
                 (r.p50_ms != null ? `${r.p50_ms}ms p50`.padEnd(14) : `${r.durationMs}ms`.padEnd(14));
    const kb   = r.skipped ? '---   ' : `${((r.payloadBytes || 0) / 1024).toFixed(1)}KB`.padEnd(6);
    const note = r.skipped ? (r.skip_reason || '') : (r.budget_note || '');
    console.log(`  ${tag.padEnd(4)}  ${r.name.padEnd(38)}  ${dur}  ${kb}  ${note}`);
  }

  console.log(line);
  console.log(`  Tests Run: ${summary.total}   Passed: ${summary.passed}   Failed: ${summary.failed}   Skipped: ${summary.skipped}   Critical: ${summary.critical_failures}`);
  console.log(`  safe_to_enable_rust: ${summary.safe_to_enable_rust}`);
  console.log(line + '\n');
}

function writeReports(summary) {
  ensureDirs();

  // ── JSON ──────────────────────────────────────────────────────────────────
  fs.writeFileSync(
    path.join(RESULTS_DIR, 'latest.json'),
    JSON.stringify(summary, null, 2)
  );

  // ── Markdown ──────────────────────────────────────────────────────────────
  const header = `| Test | Status | p50 | p95 | Payload | Note |
|------|--------|-----|-----|---------|------|`;

  const rows = summary.results.map(r => {
    if (r.skipped) {
      return `| ${r.name} | SKIP | — | — | — | ${r.skip_reason || ''} |`;
    }
    const badge = r.pass ? '✅' : '❌';
    const p50   = r.p50_ms  != null ? `${r.p50_ms}ms`  : `${r.durationMs}ms`;
    const p95   = r.p95_ms  != null ? `${r.p95_ms}ms`  : '—';
    const kb    = `${((r.payloadBytes || 0) / 1024).toFixed(1)} KB`;
    return `| ${r.name} | ${badge} | ${p50} | ${p95} | ${kb} | ${r.budget_note || ''} |`;
  }).join('\n');

  const recs = summary.recommendations.length
    ? summary.recommendations.map(s => `- ${s}`).join('\n')
    : '- None';

  const md = `# Vantro Performance Lab Report
Generated: ${summary.timestamp}
Run ID: ${summary.run_id}
Mode: ${summary.mode}

## Environment
| Key | Value |
|-----|-------|
| Rust URL | ${summary.rustBaseUrl || '_(not configured)_'} |
| Node URL | ${summary.nodeBaseUrl || '_(not configured)_'} |
| Live mode | ${summary.runLive ? 'YES' : 'NO (offline / CI)'} |
| Iterations | ${summary.iterations} |

## Results

${header}
${rows}

## Summary
| Metric | Value |
|--------|-------|
| Tests run | ${summary.total} |
| Passed | ${summary.passed} |
| Failed | ${summary.failed} |
| Skipped | ${summary.skipped} |
| Critical failures | ${summary.critical_failures} |
| **safe_to_enable_rust** | **${summary.safe_to_enable_rust}** |

## Recommendations
${recs}

## Skipped tests — what is needed to run them
${summary.skip_explanations.length
  ? summary.skip_explanations.map(e => `- **${e.test}**: ${e.reason}`).join('\n')
  : '- None skipped.'}
`;

  fs.writeFileSync(path.join(REPORTS_DIR, 'latest.md'), md);
  console.log(`  Report → performance-lab/reports/latest.md`);
  console.log(`  Data   → performance-lab/results/latest.json\n`);
}

module.exports = { printConsole, writeReports };
