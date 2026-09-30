// Admin access cannot be obtained by signing up with a case variant of an
// admin email, and needs a verified account. Real server, real database.
import { createRequire } from 'node:module';
import { makeChecker, openPool, deleteUsers, startServer } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { check, done } = makeChecker();
const PORT = 3943;

async function main() {
  const pool = openPool();
  const adminId = randomUUID();
  const tag = adminId.slice(0, 8);
  const adminEmail = `founder-${tag}@test.starlane.invalid`;
  const ids = [adminId];
  let server;
  try {
    await pool.query(`INSERT INTO users (id, email, password_hash, business_name, email_verified) VALUES ($1,$2,'x','Founder',true)`, [adminId, adminEmail]);
    server = await startServer(PORT, { ADMIN_EMAILS: adminEmail, ACCESS_APPLY_LIMIT_PER_HOUR: '100' });
    const call = async (method, p, token, body) => {
      const r = await fetch(`${server.base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const adminToken = jwt.sign({ userId: adminId, email: adminEmail }, process.env.JWT_SECRET, { expiresIn: '10m' });
    check('the verified admin reaches an admin route', (await call('GET', '/api/admin/access/applications', adminToken)).status === 200);

    const variant = adminEmail.toUpperCase();
    const signup = await call('POST', '/api/auth/signup', null, { email: variant, phone: '9810000099', business_name: 'Impostor', password: 'correct-horse-9' });
    check('signing up with a case variant of an existing email is refused (409)', signup.status === 409, signup);

    // Even if such an account existed (legacy data), it is not admin.
    const impostorId = randomUUID();
    ids.push(impostorId);
    await pool.query(`INSERT INTO users (id, email, password_hash, business_name, email_verified) VALUES ($1,$2,'x','Impostor',true)`, [impostorId, variant]);
    const impostorToken = jwt.sign({ userId: impostorId, email: variant }, process.env.JWT_SECRET, { expiresIn: '10m' });
    check('a legacy case-variant account is not admin (403)', (await call('GET', '/api/admin/access/applications', impostorToken)).status === 403);
    check('it cannot flip the outbound global stop (403)', [401, 403].includes((await call('POST', '/api/outreach/admin/global-stop', impostorToken, { stopped: false })).status));

    // An unverified account with the exact admin address is not admin either.
    await pool.query('UPDATE users SET email_verified = false WHERE id = $1', [adminId]);
    check('an unverified account with the exact admin email is not admin (403)', (await call('GET', '/api/admin/access/applications', adminToken)).status === 403);

    const fresh = `new-${tag}@test.starlane.invalid`;
    const s2 = await call('POST', '/api/auth/signup', null, { email: `  New-${tag}@Test.Starlane.Invalid `, phone: '9810000098', business_name: 'New Co', password: 'correct-horse-9' });
    const row = (await pool.query('SELECT id, email FROM users WHERE lower(email) = $1', [fresh])).rows;
    if (row[0]) ids.push(row[0].id);
    check('signup stores the email trimmed and lower-cased', s2.status === 200 && row.length === 1 && row[0].email === fresh, { s2, row });
    const login = await call('POST', '/api/auth/login', null, { email: `NEW-${tag}@test.starlane.invalid`, password: 'correct-horse-9' });
    check('login finds the account whatever case is typed', login.status === 200 && login.body.user?.email === fresh, login.body);
  } finally {
    if (server) server.stop();
    await deleteUsers(pool, ids);
    await pool.end();
  }
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
