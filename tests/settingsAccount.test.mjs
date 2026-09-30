// Settings: change password needs the current one; delivery status reports
// what really delivers instead of fixed "Active" badges. Real DB, real HTTP.
import { createRequire } from 'node:module';
import { makeChecker, openPool, seedUser, deleteUsers, startServer } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');
const { check, done } = makeChecker();

async function main() {
  if (!process.env.DATABASE_URL) { console.log('  SKIP needs DATABASE_URL'); return done(); }
  const pool = openPool();
  const users = [];
  let server;
  try {
    const u = await seedUser(pool, 'settings'); users.push(u.id);
    await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [u.id, await bcrypt.hash('old-password-1', 4)]);
    server = await startServer(8931, { FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED: 'false', TWILIO_WHATSAPP_NUMBER: '', RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '', FEATURE_PUSH_NOTIFICATIONS_ENABLED: 'false', STARLANE_GLOBAL_STOP: '' });
    const call = (path, body, method = 'POST') => fetch(server.base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.token}` }, body: body ? JSON.stringify(body) : undefined });

    let r = await call('/api/auth/change-password', { current_password: 'wrong-one', new_password: 'new-password-2' });
    check('a wrong current password is refused', r.status === 400, r.status);
    r = await call('/api/auth/change-password', { current_password: 'old-password-1', new_password: 'short' });
    check('a short new password is refused', r.status === 400, r.status);
    let hash = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [u.id])).rows[0].password_hash;
    check('refused attempts leave the password unchanged', await bcrypt.compare('old-password-1', hash));
    r = await call('/api/auth/change-password', { current_password: 'old-password-1', new_password: 'new-password-2' });
    check('the right current password changes it', r.status === 200, r.status);
    hash = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [u.id])).rows[0].password_hash;
    check('the new password is what is stored', await bcrypt.compare('new-password-2', hash));
    r = await fetch(server.base + '/api/auth/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check('it needs a session', r.status === 401, r.status);

    r = await call('/api/settings/delivery-status', null, 'GET');
    const s = await r.json();
    check('delivery status answers', r.status === 200, r.status);
    check('WhatsApp is not shown active when sending is off', s.whatsapp?.active === false && /switched off/.test(s.whatsapp.reason), s.whatsapp);
    check('payment links are not shown active without Razorpay', s.paymentLinks?.active === false, s.paymentLinks);
    check('dunning is not shown active when nothing can be sent', s.dunning?.active === false && !!s.dunning.reason, s.dunning);
    check('push is not shown active when it is off', s.push?.active === false, s.push);
  } finally {
    if (server) server.stop();
    await deleteUsers(pool, users);
    await pool.end();
  }
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
