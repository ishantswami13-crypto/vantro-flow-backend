// The general API budget is per signed-in user, not per IP: two people behind
// one office IP each get their own budget, and anonymous callers keep the
// tighter per-IP budget. Real server, real database.
import { makeChecker, openPool, seedUser, deleteUsers, startServer } from './helpers/httpHarness.mjs';

const { check, done } = makeChecker();
const PORT = 3941;

async function main() {
  const pool = openPool();
  const a = await seedUser(pool, 'ratelimit-a');
  const b = await seedUser(pool, 'ratelimit-b');
  let server;
  try {
    server = await startServer(PORT, { API_RATE_LIMIT_PER_USER_PER_MINUTE: '30', API_RATE_LIMIT_PER_IP_PER_MINUTE: '10' });
    const hit = async (token) => (await fetch(`${server.base}/api/decisions/today`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })).status;
    const run = async (token, n) => { const out = []; for (let i = 0; i < n; i++) out.push(await hit(token)); return out; };

    const aCodes = await run(a.token, 25);
    check('user A: 25 requests from one IP stay within the per-user budget', aCodes.every((c) => c !== 429), aCodes);
    const bCodes = await run(b.token, 25);
    check('user B on the same IP has its own budget', bCodes.every((c) => c !== 429), bCodes);
    const aMore = await run(a.token, 10);
    check('user A is limited once past its own budget', aMore.includes(429), aMore);
    const anon = await run(null, 15);
    check('anonymous callers keep the per-IP budget', anon.includes(429) && anon.slice(0, 5).every((c) => c === 401), anon);
    const forged = await run('not-a-jwt', 3);
    check('a forged token is budgeted by IP, not as a user (already over)', forged.every((c) => c === 429), forged);
  } finally {
    if (server) server.stop();
    await deleteUsers(pool, [a.id, b.id]);
    await pool.end();
  }
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
