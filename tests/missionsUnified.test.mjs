// A collection mission started from Watch or Scan (table `missions`) shows in
// the one Missions list the web reads, linked to its own page, and only for
// its own tenant.
import { createRequire } from 'node:module';
import { makeChecker, openPool, seedUser, deleteUsers } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
const { listMissions } = require('../lib/domain/os/missions');
const { check, done } = makeChecker();

async function main() {
  if (!process.env.DATABASE_URL) { console.log('  SKIP needs DATABASE_URL'); return done(); }
  const pool = openPool();
  const users = [];
  try {
    const a = await seedUser(pool, 'missions-a'); users.push(a.id);
    const b = await seedUser(pool, 'missions-b'); users.push(b.id);
    const { rows } = await pool.query(
      `INSERT INTO missions (user_id, type, status, title, objective, target, horizon_days) VALUES ($1, 'collections', 'active', 'Collect from Sharma', 'Collect 1L in 14 days', '{"amount":100000}', 14) RETURNING id`,
      [a.id]);
    const mine = await listMissions(pool, a.id);
    const m = mine.missions.find((x) => x.sourceId === rows[0].id);
    check('the collection mission is in the list', !!m);
    check('it is shown as running and links to its own page', m?.state === 'RUNNING' && m?.href === `/missions/${rows[0].id}` && m?.source === 'COLLECTION', m);
    check('the counts include it', mine.byState.RUNNING >= 1, mine.byState);
    const theirs = await listMissions(pool, b.id);
    check('another tenant does not see it', !theirs.missions.some((x) => x.sourceId === rows[0].id));
  } finally {
    await deleteUsers(pool, users);
    await pool.end();
  }
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
