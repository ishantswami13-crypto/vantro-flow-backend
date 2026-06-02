#!/usr/bin/env node
// FILE: cortex-lab/run.js
// Cortex Harness X — mode dispatcher.
// Modes: static | dry-run | live | red-team | all
//
// Safety model:
//   - static and red-team modes never touch any DB or network.
//   - dry-run and live modes go through sandboxGuard before any write.
//   - secrets are scrubbed from every report and console line.

'use strict';

const { load }     = require('./config');
const reporter     = require('./reporter');
const scorecard    = require('./scorecard');

async function runMode(cfg, mode) {
  const startedAt = new Date().toISOString();
  const record    = scorecard.newRecord();
  const scenarios = [];

  let runner;
  switch (mode) {
    case 'static':   runner = require('./modes/staticRunner');   break;
    case 'red-team': runner = require('./modes/redTeamRunner');  break;
    case 'dry-run':  runner = require('./modes/dryRunRunner');   break;
    case 'live':     runner = require('./modes/liveRunner');     break;
    default: throw new Error(`Unknown mode: ${mode}`);
  }

  try {
    await runner.run({ cfg, record, scenarios });
  } catch (err) {
    if (process.env.CORTEX_HARNESS_VERBOSE === 'true') console.error(`[harness] ${mode} runner crashed:`, err && err.stack);
    scorecard.add(record, 'orchestration', { ok: false, reason: 'runner_crashed', detail: { error: err.message, stack: err.stack && err.stack.split('\n').slice(0, 5).join(' | ') } }, `runner:${mode}`);
  }

  const summary = scorecard.summarise(record);
  return {
    runId:        cfg.runId,
    mode,
    startedAt,
    finishedAt:   new Date().toISOString(),
    environment:  {
      nodeEnv:           cfg.env.nodeEnv,
      hasTestBaseUrl:    !!cfg.env.testBaseUrl,
      hasTestSupabase:   !!cfg.env.testSupabaseUrl,
      hasOwnerATok:      !!cfg.env.ownerAToken,
      hasOwnerBTok:      !!cfg.env.ownerBToken,
      externalSendFlag:  cfg.env.externalSendEnabled,
      allowWrite:        cfg.env.allowWrite,
      requireNonProd:    cfg.env.requireNonProd,
      allowProd:         cfg.env.allowProd,
    },
    scenarios,
    scorecard: summary,
  };
}

async function main() {
  const cfg = load(process.argv);
  const modes = cfg.args.mode === 'all'
    ? ['static', 'red-team', 'dry-run', 'live']
    : [cfg.args.mode];

  const results = [];
  let overallPass = true;

  for (const m of modes) {
    const result = await runMode(cfg, m);
    results.push(result);
    reporter.printConsole(result);
    reporter.writeResults(cfg, result);
    if (!result.scorecard.pass) overallPass = false;
  }

  // When running --mode=all, also write a combined latest snapshot.
  if (modes.length > 1) {
    const combined = {
      runId:      cfg.runId,
      mode:       'all',
      startedAt:  results[0].startedAt,
      finishedAt: results[results.length - 1].finishedAt,
      environment: results[0].environment,
      results,
      scorecard: {
        pass:        overallPass,
        overall:     null,
        perCategory: {},
        critical:    results.flatMap(r => r.scorecard.critical),
        warnings:    results.flatMap(r => r.scorecard.warnings),
        gates:       {},
      },
      scenarios: results.flatMap(r => r.scenarios),
    };
    reporter.writeResults(cfg, combined);
  }

  process.exit(overallPass ? 0 : 1);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[harness] fatal:', err && err.stack || err);
    process.exit(2);
  });
}

module.exports = { runMode };
