'use strict';
// lib/data/boot.js — start the data layer's background work, behind a flag.
//
// STARLANE_DATA_LAYER_ENABLED=true starts, in this process:
//   - the event dispatcher (cache invalidation on every server, read-model
//     rebuilds once across servers), woken by LISTEN when
//     EVENT_LISTEN_DATABASE_URL names a session-mode or direct connection
//   - a sweep every READ_MODEL_SWEEP_MS (default 5 min) that rebuilds read
//     models whose invoices changed without an event
// Off (the default) starts nothing. The /api/data routes still answer
// correctly when on but nothing is running, because readers rebuild stale
// models themselves.

const { getPool } = require('../db/pg');
const { getCache } = require('./cache');
const { createDispatcher, cacheInvalidationConsumer } = require('./events');
const { receivablesConsumer, sweepStale } = require('./readModels');
const { buildSanitizedPgConfig } = require('../db/pgConfig');

function isDataLayerEnabled(env = process.env) {
  return String(env.STARLANE_DATA_LAYER_ENABLED || '').toLowerCase() === 'true';
}

let running = null;

async function startFromEnv({ env = process.env, log = () => {} } = {}) {
  if (running) return running;
  if (!isDataLayerEnabled(env) || !env.DATABASE_URL) return null;
  const pool = getPool();
  const listen = env.EVENT_LISTEN_DATABASE_URL ? buildSanitizedPgConfig(env.EVENT_LISTEN_DATABASE_URL) : null;
  const dispatcher = createDispatcher({
    pool,
    listen,
    log,
    consumers: [cacheInvalidationConsumer(getCache()), receivablesConsumer()],
  });
  await dispatcher.start();
  const sweepMs = Math.max(30000, Number(env.READ_MODEL_SWEEP_MS) || 5 * 60 * 1000);
  let sweeping = false;
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const r = await sweepStale(pool);
      if (r.failed.length) log('warn', '[data] read-model sweep had failures', { failed: r.failed.length });
    } catch (err) {
      log('warn', '[data] read-model sweep failed', { error: err.message });
    } finally {
      sweeping = false;
    }
  };
  const timer = setInterval(sweep, sweepMs);
  timer.unref();
  sweep();
  running = {
    dispatcher,
    async stop() { clearInterval(timer); await dispatcher.stop(); running = null; },
    status: () => ({ listening: dispatcher.isListening(), consumers: dispatcher.stats(), cache: getCache().stats() }),
  };
  return running;
}

function status() {
  return running ? running.status() : null;
}

module.exports = { startFromEnv, status, isDataLayerEnabled };
