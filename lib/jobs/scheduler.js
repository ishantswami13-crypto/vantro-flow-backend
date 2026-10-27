// FILE: lib/jobs/scheduler.js
// node-cron with three guarantees the bare library does not give:
//
//   1. Once per firing across all instances. Every replica runs the same
//      schedules, so each firing is claimed with an INSERT into cron_runs;
//      only the instance whose insert lands runs the job. Without a database
//      (or if the claim itself fails) the job runs, which is the old
//      single-instance behaviour.
//   2. No overlap inside one instance. A run that is still going when the
//      next firing comes (a 15-minute sweep that took 20) makes that firing
//      a logged skip instead of a second concurrent run.
//   3. A switch. CRON_ENABLED=false keeps an instance from running any
//      scheduled job, for web-only replicas.
//
// A job's key is its schedule plus a hash of its source, so it is the same on
// every replica of one build and needs no hand-kept names.

const crypto = require('crypto');
const os = require('os');

const INSTANCE = process.env.RAILWAY_REPLICA_ID || `${os.hostname()}:${process.pid}`;
const RETENTION_DAYS = 14;

function jobKey(expression, fn, name) {
  if (name) return name;
  const hash = crypto.createHash('sha1').update(String(fn)).digest('hex').slice(0, 12);
  return `${expression}:${hash}`;
}

// The firing a run belongs to: the current minute. Replicas fire within the
// same second or two, so they compute the same slot.
function currentSlot(now = Date.now()) {
  return new Date(Math.floor(now / 60000) * 60000);
}

function createScheduler({ cron, getPool, hasDatabase, log = console, enabled = process.env.CRON_ENABLED !== 'false' } = {}) {
  const running = new Set();
  let ensured = null;
  let lastPrune = 0;

  // migrations/067 creates the table; this covers a deploy that runs before
  // the migration. Two instances creating it at the same moment can collide
  // on the catalog, so a failure is retried once after the other has won.
  function ensureTable(pool) {
    if (!ensured) {
      const create = () => pool.query(`
        CREATE TABLE IF NOT EXISTS cron_runs (
          job_key TEXT NOT NULL, slot TIMESTAMPTZ NOT NULL, instance TEXT,
          claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ, error TEXT,
          PRIMARY KEY (job_key, slot));
        ALTER TABLE IF EXISTS cron_runs ENABLE ROW LEVEL SECURITY;`);
      ensured = pool.query(`SELECT to_regclass('public.cron_runs') IS NOT NULL AS present`)
        .then(({ rows }) => (rows[0]?.present ? null : create().catch(() => new Promise((r) => setTimeout(r, 250)).then(create))))
        .catch((err) => { ensured = null; throw err; });
    }
    return ensured;
  }

  // true: this instance owns the firing. false: another instance does.
  // null: no database or the claim failed, so run as a single instance would.
  async function claim(key, slot) {
    if (!hasDatabase()) return null;
    try {
      const pool = getPool();
      await ensureTable(pool);
      const { rowCount } = await pool.query(
        'INSERT INTO cron_runs (job_key, slot, instance) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [key, slot, INSTANCE]);
      if (Date.now() - lastPrune > 86400000) {
        lastPrune = Date.now();
        pool.query(`DELETE FROM cron_runs WHERE claimed_at < now() - interval '${RETENTION_DAYS} days'`).catch(() => {});
      }
      return rowCount === 1;
    } catch (err) {
      log.warn(`[scheduler] could not claim ${key}; running without the cross-instance lock: ${err.message}`);
      return null;
    }
  }

  function finish(key, slot, error) {
    if (!hasDatabase()) return;
    try {
      getPool().query('UPDATE cron_runs SET finished_at = now(), error = $3 WHERE job_key = $1 AND slot = $2',
        [key, slot, error ? String(error).slice(0, 500) : null]).catch(() => {});
    } catch { /* best effort */ }
  }

  function schedule(expression, fn, options = {}) {
    const { name, ...cronOptions } = options;
    const key = jobKey(expression, fn, name);
    const run = async () => {
      if (!enabled) return;
      if (running.has(key)) {
        log.warn(`[scheduler] ${key} skipped: the previous run is still going`);
        return;
      }
      running.add(key);
      const slot = currentSlot();
      let claimed = null;
      let failure = null;
      try {
        claimed = await claim(key, slot);
        if (claimed === false) return;
        await fn();
      } catch (err) {
        failure = err;
        log.error(`[scheduler] ${key} failed: ${err && err.message}`);
      } finally {
        running.delete(key);
        if (claimed) finish(key, slot, failure && failure.message);
      }
    };
    return cron.schedule(expression, run, cronOptions);
  }

  return { schedule, jobKey, currentSlot };
}

module.exports = { createScheduler, jobKey, currentSlot };
