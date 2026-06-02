// FILE: cortex-lab/reporter.js
// Writes results/<run-id>.json + results/latest.json, plus reports/latest.md.
// Every string is run through scrubSecrets() before persistence.

'use strict';

const fs   = require('fs');
const path = require('path');

const SECRET_PATTERNS = [
  // JWTs
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Supabase service-role / anon keys (long JWT-like — covered above) and api keys
  /\bsbp_[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk_(test|live)_[A-Za-z0-9_]{20,}\b/g,
  // Anthropic
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  // Postgres connection strings
  /postgres(?:ql)?:\/\/[^\s'"`]+/gi,
  // Bearer / Authorization headers in serialised text
  /(authorization\s*:\s*bearer\s+)[A-Za-z0-9._-]+/gi,
  // Twilio / Razorpay
  /\bAC[a-f0-9]{32}\b/g,
  /\brzp_(test|live)_[A-Za-z0-9]{14,}\b/g,
];

const SECRET_ENV_KEYS = [
  'JWT_SECRET', 'SUPABASE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL',
  'ANTHROPIC_API_KEY', 'TWILIO_AUTH_TOKEN', 'RAZORPAY_KEY_SECRET',
  'METRICS_TOKEN', 'PUBLIC_LINK_SECRET', 'VOICE_WEBHOOK_SECRET',
  'CORTEX_TEST_TOKEN_OWNER_A', 'CORTEX_TEST_TOKEN_STAFF_A', 'CORTEX_TEST_TOKEN_OWNER_B',
  'CORTEX_TEST_SUPABASE_KEY',
];

function scrubString(s) {
  if (typeof s !== 'string') return s;
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  for (const k of SECRET_ENV_KEYS) {
    const v = process.env[k];
    if (v && v.length >= 8) out = out.split(v).join(`[${k}]`);
  }
  return out;
}

function scrubDeep(value) {
  if (value == null) return value;
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_ENV_KEYS.includes(k.toUpperCase())) { out[k] = '[REDACTED]'; continue; }
      out[k] = scrubDeep(v);
    }
    return out;
  }
  return value;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeResults(cfg, payload) {
  ensureDir(cfg.resultsDir);
  ensureDir(cfg.reportsDir);

  const clean = scrubDeep(payload);
  const json  = JSON.stringify(clean, null, 2);

  fs.writeFileSync(path.join(cfg.resultsDir, 'latest.json'), json);
  fs.writeFileSync(path.join(cfg.resultsDir, `${clean.runId}-${clean.mode}.json`), json);

  const md = renderMarkdown(clean);
  fs.writeFileSync(path.join(cfg.reportsDir, 'latest.md'), md);
  fs.writeFileSync(path.join(cfg.reportsDir, `${clean.runId}-${clean.mode}.md`), md);

  return { jsonPath: path.join(cfg.resultsDir, 'latest.json'), mdPath: path.join(cfg.reportsDir, 'latest.md') };
}

function renderMarkdown(p) {
  const s = p.scorecard || {};
  const cat = s.perCategory || {};
  const lines = [];
  lines.push(`# Vantro Cortex Harness X — Report`);
  lines.push('');
  lines.push(`- **Run ID:** \`${p.runId}\``);
  lines.push(`- **Mode:** \`${p.mode}\``);
  lines.push(`- **Started:** ${p.startedAt}`);
  lines.push(`- **Finished:** ${p.finishedAt}`);
  lines.push(`- **Result:** ${s.pass ? '✅ PASS' : '❌ FAIL'}`);
  if (s.overall != null) lines.push(`- **Overall Score:** ${s.overall} / 100  (gate ${p?.scorecard?.gates?.overall?.required || '?'})`);
  else                    lines.push(`- **Overall Score:** N/A (no numeric scores produced)`);
  lines.push('');
  lines.push('## Categories');
  lines.push('');
  lines.push('| Category | Score | Passed | Failed | Gate | Status |');
  lines.push('|---|---:|---:|---:|---:|:---:|');
  for (const [name, c] of Object.entries(cat)) {
    const gate = p?.scorecard?.gates?.[name];
    const score = c.score == null ? (c.na ? 'N/A' : '—') : `${c.score}%`;
    const gateStr = gate ? `${gate.required}%` : '—';
    const status = c.score == null
      ? (c.na ? '⚪ N/A' : '⚪')
      : (gate ? (gate.ok ? '✅' : '❌') : '✅');
    lines.push(`| ${name} | ${score} | ${c.passed} | ${c.failed} | ${gateStr} | ${status} |`);
  }
  lines.push('');

  if ((s.critical || []).length) {
    lines.push('## 🚨 Critical Failures');
    lines.push('');
    for (const f of s.critical) {
      lines.push(`- **[${f.category}]** ${f.label}${f.scenario ? ` _(scenario: ${f.scenario})_` : ''} — \`${f.reason}\``);
      if (f.detail) lines.push(`  - detail: \`${JSON.stringify(f.detail)}\``);
    }
    lines.push('');
  }

  if ((p.scenarios || []).length) {
    lines.push('## Scenarios Run');
    lines.push('');
    for (const sc of p.scenarios) {
      const icon = sc.failed ? '❌' : '✅';
      lines.push(`- ${icon} \`${sc.id}\` (${sc.mode || p.mode}) — ${sc.passed} passed, ${sc.failed} failed`);
    }
    lines.push('');
  }

  if ((s.warnings || []).length) {
    lines.push('## Warnings');
    lines.push('');
    for (const w of s.warnings) lines.push(`- ${w.message}`);
    lines.push('');
  }

  if (p.environment) {
    lines.push('## Environment');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(p.environment, null, 2));
    lines.push('```');
  }

  return lines.join('\n');
}

function printConsole(payload) {
  const bar = '─'.repeat(64);
  const s = payload.scorecard;
  console.log(bar);
  console.log(`  VANTRO CORTEX HARNESS X   mode=${payload.mode}   run=${payload.runId}`);
  console.log(bar);
  for (const [name, c] of Object.entries(s.perCategory)) {
    const score = c.score == null ? (c.na ? 'N/A   ' : '—     ') : (String(c.score).padStart(3) + '%  ');
    const gate  = payload.scorecard.gates[name];
    const flag  = c.score == null ? ' ' : (gate ? (gate.ok ? '✓' : '✗') : ' ');
    console.log(`  ${flag} ${name.padEnd(28)} ${score}  (${c.passed} pass / ${c.failed} fail)`);
  }
  console.log(bar);
  console.log(`  Overall: ${s.overall == null ? 'N/A' : (s.overall + '/100')}    Critical failures: ${s.critical.length}    Warnings: ${s.warnings.length}`);
  console.log(`  RESULT:  ${s.pass ? 'PASS ✅' : 'FAIL ❌'}`);
  console.log(bar);
}

module.exports = { writeResults, printConsole, scrubString, scrubDeep };
