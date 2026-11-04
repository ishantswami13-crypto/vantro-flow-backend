#!/usr/bin/env node
// FILE: scripts/outreach-preflight.js
// `npm run outreach:preflight` — is the outbound engine ready to START?
//
//   DATABASE  MIGRATIONS  QUEUE  SCHEDULER  WORKERS  RATE LIMITER
//   GLOBAL STOP  SENDING MODE  GMAIL  TARGETING  SUPPRESSION  RETRY
//   EVENT INGESTION  TENANCY
//
// Default: READ-ONLY. Every check is a SELECT (plus, with --user and a
// connected Gmail account, one authenticated profile read). Safe to run
// against production from a machine that can reach it.
//
//   node scripts/outreach-preflight.js [--user <uuid>] [--mode SHADOW|TEST|LIVE] [--json]
//
// --exercise additionally runs the whole pipeline on fixture tenants
// (import, verify, draft, review, queue, send to the sink, bounce, opt-out,
// 429, retries, crash recovery, duplicate races, stops, tenancy) by running
// the outbound test suites. It writes to the database, so it refuses a
// non-local DATABASE_URL unless --allow-remote-db is passed (never for
// production). External sending is forced off for it.
//
// A check is PASS only when it was verified. Missing configuration is
// BLOCKED with the reason. Exit code 1 when anything critical is not PASS.

require('dotenv').config();
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i !== -1 ? args[i + 1] : null; };

function isLocalDb(url) {
  try { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname); } catch { return false; }
}

function table(rows) {
  const w = Math.max(...rows.map((r) => r.name.length));
  return rows.map((r) => `${r.name.padEnd(w)}  ${r.status.padEnd(8)}  ${r.detail}`).join('\n');
}

async function readOnly() {
  const { getPool } = require('../lib/db/pg');
  const { runPreflight } = require('../lib/domain/outbound/preflight');
  const pool = getPool();
  try {
    const userId = opt('user');
    const mode = opt('mode') ? String(opt('mode')).toUpperCase() : null;
    return await runPreflight(pool, { userId, mode });
  } finally {
    await pool.end();
  }
}

function exercise() {
  const files = ['tests/outbound.unit.test.js', 'tests/outbound.engine.test.js', 'tests/outbound.http.test.js'];
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', ...files], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED: 'false', OUTBOUND_FIXTURE_MODE: 'true', NODE_ENV: 'test', OUTBOUND_ENGINE_ENABLED: 'false' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  });
  const out = `${r.stdout || ''}`;
  const rows = [];
  // Top-level TAP results only ("ok N - name" at column 0).
  for (const line of out.split('\n')) {
    const m = line.match(/^(not ok|ok) \d+ - (.*?)( # SKIP.*)?$/);
    if (!m) continue;
    rows.push({ name: m[2].slice(0, 90), status: m[3] ? 'SKIPPED' : (m[1] === 'ok' ? 'PASS' : 'FAIL'), detail: m[3] ? m[3].replace(/^ # SKIP ?/, '') : '' });
  }
  if (!rows.length) rows.push({ name: 'exercise', status: 'FAIL', detail: `test run produced no results (exit ${r.status}): ${(r.stderr || '').slice(-400)}` });
  return { rows, exit: r.status, raw: out };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('DATABASE  BLOCKED  DATABASE_URL is not set\n\nVERDICT: NOT READY');
    process.exit(1);
  }
  const host = new URL(process.env.DATABASE_URL).hostname;
  const pre = await readOnly();
  const rows = pre.checks.map((c) => ({ name: c.name, status: c.status, detail: `${c.detail}${c.critical ? '' : ' (advisory)'}` }));
  let exerciseResult = null;
  if (flag('exercise')) {
    if (!isLocalDb(process.env.DATABASE_URL) && !flag('allow-remote-db')) {
      exerciseResult = { rows: [{ name: 'EXERCISE', status: 'BLOCKED', detail: 'the exercise writes fixture tenants, so it only runs on a local database (or a staging one with --allow-remote-db; never production)' }], exit: 1 };
    } else if (!process.env.JWT_SECRET) {
      exerciseResult = { rows: [{ name: 'EXERCISE', status: 'BLOCKED', detail: 'JWT_SECRET is not set' }], exit: 1 };
    } else {
      exerciseResult = exercise();
    }
  }
  const exerciseOk = !exerciseResult || exerciseResult.rows.every((r) => r.status === 'PASS');
  const verdict = pre.ready && exerciseOk ? (exerciseResult ? 'READY (pipeline exercised on fixtures)' : 'READY TO START (read-only checks; run --exercise on a local copy to exercise the pipeline)') : pre.verdict.startsWith('NOT READY') ? pre.verdict : 'NOT READY: pipeline exercise failed';

  if (flag('json')) {
    console.log(JSON.stringify({ at: new Date().toISOString(), host, preflight: pre, exercise: exerciseResult && exerciseResult.rows, verdict }, null, 2));
  } else {
    const lines = [
      'STARLANE OUTREACH PREFLIGHT',
      `run at ${new Date().toISOString()} against ${host}${opt('user') ? ` for tenant ${opt('user')}` : ' (all tenants; tenant-specific checks skipped, pass --user <id>)'}`,
      '',
      table(rows),
    ];
    if (exerciseResult) lines.push('', 'PIPELINE EXERCISE (fixture tenants, sink provider, *.invalid prospects)', '', table(exerciseResult.rows));
    lines.push('', `VERDICT: ${verdict}`);
    console.log(lines.join('\n'));
  }
  process.exit(pre.ready && exerciseOk ? 0 : 1);
}

main().catch((err) => { console.error(`preflight crashed: ${err.stack || err.message}`); process.exit(1); });
