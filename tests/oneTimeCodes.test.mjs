// Sign-in and sign-up codes work whichever server instance checks them:
// with a database they are stored in one_time_codes, single-use, and burned
// after too many wrong guesses. Without one they stay in memory.
import { createRequire } from 'module';
import { makeChecker, openPool } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
const { check, done } = makeChecker();
const modulePath = require.resolve('../lib/auth/oneTimeCodes');

// Each call gives a separate copy of the module, like a separate server.
function freshInstance() {
  delete require.cache[modulePath];
  return require(modulePath);
}

async function main() {
  {
    const codes = freshInstance();
    await codes.issue('m:a', '123456', { userId: 'u1' }, 60000);
    check('memory: the right code works once', (await codes.consume('m:a', '123456'))?.userId === 'u1' && (await codes.consume('m:a', '123456')) === null);
    await codes.issue('m:b', '123456', { userId: 'u1' }, -1);
    check('memory: an expired code fails', (await codes.consume('m:b', '123456')) === null);
  }

  if (!process.env.DATABASE_URL) {
    console.log('SKIP database-backed codes: DATABASE_URL not set');
  } else {
    const pool = openPool();
    try {
      const a = freshInstance();
      a.useDatabase(() => pool);
      const b = freshInstance();
      b.useDatabase(() => pool);
      const key = `test:${Date.now()}`;

      await a.issue(key, '111111', { userId: 'u9' }, 60000);
      const { rows } = await pool.query('SELECT hash FROM one_time_codes WHERE key = $1', [key]);
      check('only a hash of the code is stored', rows.length === 1 && rows[0].hash !== '111111', rows);
      check('a code issued on one server is accepted on another', (await b.consume(key, '111111'))?.userId === 'u9');
      check('and only once', (await a.consume(key, '111111')) === null);

      await a.issue(key, '222222', { userId: 'u9' }, 60000);
      const both = await Promise.all([a.consume(key, '222222'), b.consume(key, '222222')]);
      check('two servers racing on one code: exactly one wins', both.filter(Boolean).length === 1, both);

      await a.issue(key, '333333', { userId: 'u9' }, 60000);
      for (let i = 0; i < 3; i++) await b.consume(key, '000000', { maxAttempts: 3 });
      check('too many wrong guesses burn the code', (await a.consume(key, '333333', { maxAttempts: 3 })) === null);

      await a.issue(key, '444444', { userId: 'u9' }, -1000);
      check('an expired code fails', (await b.consume(key, '444444')) === null);

      await a.issue(key, '555555', { userId: 'u9' }, 60000);
      await a.issue(key, '666666', { userId: 'u9' }, 60000);
      check('resending replaces the old code', (await b.consume(key, '555555')) === null && (await b.consume(key, '666666'))?.userId === 'u9');

      await pool.query('DELETE FROM one_time_codes WHERE key = $1', [key]);
    } finally {
      await pool.end();
    }
  }
  done();
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
