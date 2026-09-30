// One global stop covers every business send: WhatsApp, voice and push are
// refused while STARLANE_GLOBAL_STOP or the admin 'global_stop' row is on,
// even with external sending enabled. Unit-level (guards) plus the DB switch.
import { createRequire } from 'node:module';
import { makeChecker, openPool } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
// Feature flags are read when lib/featureFlags loads, so set them first.
process.env.FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED = 'true';
process.env.FEATURE_PUSH_NOTIFICATIONS_ENABLED = 'true';
const guards = require('../lib/safety/externalSend');
const { check, done } = makeChecker();

async function main() {
  delete process.env.STARLANE_GLOBAL_STOP;
  delete process.env.OUTBOUND_GLOBAL_STOP;
  check('with sending on and no stop, WhatsApp may send', guards.guardExternalSend('whatsapp') === null);
  process.env.STARLANE_GLOBAL_STOP = 'true';
  check('STARLANE_GLOBAL_STOP blocks WhatsApp', guards.guardExternalSend('whatsapp')?.reason === 'global_stop');
  check('STARLANE_GLOBAL_STOP blocks voice', guards.guardExternalSend('voice')?.reason === 'global_stop');
  check('STARLANE_GLOBAL_STOP blocks push', guards.guardPush('expo')?.reason === 'global_stop');
  check('owner OTP delivery is not a business send and still works', guards.guardExternalSend('whatsapp', { transactional: true }) === null);
  delete process.env.STARLANE_GLOBAL_STOP;

  if (process.env.DATABASE_URL) {
    const pool = openPool();
    try {
      const prev = (await pool.query("SELECT enabled FROM outbound_system_controls WHERE key = 'global_stop'")).rows[0];
      await pool.query(`INSERT INTO outbound_system_controls (key, enabled, reason, set_by, set_at) VALUES ('global_stop', true, 'test', 'test', NOW())
                        ON CONFLICT (key) DO UPDATE SET enabled = true`);
      await guards.refreshGlobalStop(pool);
      check('the admin DB switch blocks WhatsApp too', guards.guardExternalSend('whatsapp')?.reason === 'global_stop');
      await pool.query("UPDATE outbound_system_controls SET enabled = $1 WHERE key = 'global_stop'", [prev?.enabled === true]);
      await guards.refreshGlobalStop(pool);
      check('turning it off lets sending resume', guards.guardExternalSend('whatsapp') === null || prev?.enabled === true);
    } finally { await pool.end(); }
  } else {
    console.log('  SKIP DB switch checks (no DATABASE_URL)');
  }
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
