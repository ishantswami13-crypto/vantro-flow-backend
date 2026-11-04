// Scheduled jobs run once per firing across every server instance, never
// overlap inside one instance, and stop when CRON_ENABLED=false. Unit checks
// use a fake cron; the cross-instance check uses the real database when
// DATABASE_URL is set.
import { createRequire } from 'module';
import { makeChecker, openPool } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
const { createScheduler } = require('../lib/jobs/scheduler');
const { check, done } = makeChecker();

const quiet = { warn() {}, error() {}, log() {} };
function fakeCron() {
  const jobs = [];
  return { jobs, schedule: (expr, fn, opts) => { jobs.push({ expr, fn, opts }); return { stop() {} }; } };
}

async function main() {
  // No database: behaves like plain node-cron, but without overlap.
  {
    const cron = fakeCron();
    const s = createScheduler({ cron, getPool: () => { throw new Error('no db'); }, hasDatabase: () => false, log: quiet });
    let runs = 0;
    let release;
    s.schedule('*/15 * * * *', () => { runs++; return runs === 1 ? new Promise((r) => { release = r; }) : undefined; }, { timezone: 'UTC' });
    check('options other than name reach node-cron', cron.jobs[0].opts.timezone === 'UTC');
    const first = cron.jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    await cron.jobs[0].fn();
    check('a firing while the previous run is still going is skipped', runs === 1, runs);
    release();
    await first;
    await cron.jobs[0].fn();
    check('the next firing after the run finishes runs', runs === 2, runs);
  }

  {
    const cron = fakeCron();
    const s = createScheduler({ cron, getPool: () => null, hasDatabase: () => false, log: quiet, enabled: false });
    let runs = 0;
    s.schedule('0 6 * * *', () => { runs++; });
    await cron.jobs[0].fn();
    check('CRON_ENABLED=false runs nothing', runs === 0, runs);
  }

  {
    const cron = fakeCron();
    const s = createScheduler({ cron, getPool: () => ({ query: async () => { throw new Error('connection refused'); } }), hasDatabase: () => true, log: quiet });
    let runs = 0;
    s.schedule('0 6 * * *', () => { runs++; });
    await cron.jobs[0].fn();
    check('a failed claim runs the job (single-instance behaviour), not skips it', runs === 1, runs);
  }

  {
    const s = createScheduler({ cron: fakeCron(), getPool: () => null, hasDatabase: () => false, log: quiet });
    const a = s.jobKey('0 6 * * *', async () => 1);
    const b = s.jobKey('0 6 * * *', async () => 1);
    const c = s.jobKey('0 6 * * *', async () => 2);
    check('a job key is the same for the same schedule and code (every replica agrees)', a === b);
    check('different code on the same schedule gets a different key', a !== c);
  }

  if (!process.env.DATABASE_URL) {
    console.log('SKIP cross-instance claim: DATABASE_URL not set');
  } else {
    const pool = openPool();
    try {
      const name = `test-job-${Date.now()}`;
      let runs = 0;
      const instances = [1, 2, 3].map(() => {
        const cron = fakeCron();
        const s = createScheduler({ cron, getPool: () => pool, hasDatabase: () => true, log: quiet });
        s.schedule('0 6 * * *', async () => { runs++; }, { name });
        return cron.jobs[0].fn;
      });
      await Promise.all(instances.map((fire) => fire()));
      check('three instances firing the same minute run the job once', runs === 1, runs);
      const { rows } = await pool.query('SELECT finished_at FROM cron_runs WHERE job_key = $1', [name]);
      await new Promise((r) => setTimeout(r, 100));
      const after = await pool.query('SELECT finished_at, error FROM cron_runs WHERE job_key = $1', [name]);
      check('one claim row is written for the firing', rows.length === 1, rows.length);
      check('the claim is marked finished without an error', after.rows[0]?.finished_at && !after.rows[0]?.error, after.rows[0]);
      await pool.query('DELETE FROM cron_runs WHERE job_key = $1', [name]);
    } finally {
      await pool.end();
    }
  }
  done();
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
