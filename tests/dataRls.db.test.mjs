// Row-level security on the data-layer path (migration 095) against a real
// Postgres (DATABASE_URL, local only, migrations applied). With the tenant
// role on, Postgres itself keeps tenants apart, even for queries that forget
// the tenant filter.
import { createRequire } from 'module';
import { randomUUID } from 'crypto';
import { makeChecker } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
require('../lib/db/testDatabaseGuard').assertTestDatabase(process.env.DATABASE_URL);
const { Pool } = require('pg');
const { buildSanitizedPgConfig } = require('../lib/db/pgConfig');
const { withTenant } = require('../lib/data/tenantDb');
const { appendEvent } = require('../lib/data/events');
const { check, done } = makeChecker();

const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

async function main() {
  if (!process.env.DATABASE_URL) { console.log('SKIP data-layer RLS checks: DATABASE_URL not set'); return done(); }
  const pool = new Pool({ ...buildSanitizedPgConfig(process.env.DATABASE_URL), max: 1 });
  const role = { pool, role: 'starlane_app' };
  const a = randomUUID();
  const b = randomUUID();
  try {
    const r = await pool.query("SELECT rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'starlane_app'");
    check('starlane_app exists, cannot log in and cannot bypass RLS', r.rows[0] && !r.rows[0].rolbypassrls && !r.rows[0].rolcanlogin, r.rows);

    for (const [uid, n] of [[a, 2], [b, 1]]) {
      for (let i = 0; i < n; i += 1) await withTenant(uid, (db) => appendEvent(db, { stream: 's', type: 'test.rls.event', payload: { i } }), role);
    }
    const who = await withTenant(a, (db) => db.query('SELECT current_user AS u'), role);
    check('withTenant runs as starlane_app when the role is set', who.rows[0].u === 'starlane_app', who.rows[0]);
    const after = await pool.query('SELECT current_user AS u');
    check('the role does not outlive the transaction on the pooled connection', after.rows[0].u !== 'starlane_app', after.rows[0]);

    const sloppy = await withTenant(a, (db) => db.query("SELECT user_id::text AS u FROM event_log WHERE event_type = 'test.rls.event'"), role);
    check("a query with no tenant filter still sees only the tenant's own rows", sloppy.rows.length === 2 && sloppy.rows.every((x) => x.u === a), sloppy.rows);
    const owner = await pool.query("SELECT count(*)::int AS n FROM event_log WHERE event_type = 'test.rls.event'");
    check('(the owner, outside withTenant, sees all 3: the policy is what filtered)', owner.rows[0].n === 3);

    const forged = await rejects(withTenant(a, (db) => db.query(
      "INSERT INTO event_log (user_id, stream, event_type) VALUES ($1, 's', 'test.rls.forged')", [b]
    ), role));
    check("writing a row for another tenant is refused by Postgres", forged && /row-level security/i.test(forged.message), forged && forged.message);
    const moved = await withTenant(a, (db) => db.query("UPDATE event_log SET user_id = $1 WHERE event_type = 'test.rls.event' RETURNING id", [b]).catch((e) => e), role);
    check('moving a row to another tenant is refused', moved instanceof Error && /row-level security/i.test(moved.message), moved && moved.message);
    const del = await withTenant(a, (db) => db.query("DELETE FROM event_log WHERE user_id = $1", [b]), role);
    check("deleting another tenant's rows deletes nothing", del.rowCount === 0);

    const cache = await withTenant(a, async (db) => {
      await db.query("INSERT INTO starlane_cache (cache_key, tenant_id, value, expires_at) VALUES ($1, $2, '1', now() + interval '1 minute')", [`rls:${a}:k`, a]);
      return db.query("INSERT INTO starlane_cache (cache_key, tenant_id, value, expires_at) VALUES ($1, $2, '1', now() + interval '1 minute')", [`rls:${b}:k`, b]).then(() => null, (e) => e);
    }, role);
    check('the cache table is tenant-checked too', cache && /row-level security/i.test(cache.message), cache && cache.message);
    const legacy = await rejects(withTenant(a, (db) => db.query("UPDATE invoices SET notes = 'x' WHERE false"), role));
    check('the role can read source tables but not write them', legacy && /permission denied/i.test(legacy.message), legacy && legacy.message);
    const noTenant = await rejects(withTenant(a, async (db) => {
      await db.query("SELECT set_config('app.user_id', '', true)");
      const rows = await db.query("SELECT count(*)::int AS n FROM event_log WHERE event_type = 'test.rls.event'");
      if (rows.rows[0].n !== 0) throw new Error(`saw ${rows.rows[0].n}`);
    }, role));
    check('with no tenant set, nothing is visible', noTenant === null, noTenant && noTenant.message);
    const part = await withTenant(a, (db) => db.query("SELECT starlane_ensure_month_partition('2031-01-15'::date) AS p"), role);
    check('the role can still trigger partition creation through the owner-run function', part.rows[0].p === 'fact_receivables_daily_203101');
    check('a bad role name is refused before reaching SQL', !!(await rejects(withTenant(a, () => 1, { pool, role: 'x"; drop' }))));
  } finally {
    await pool.query("DELETE FROM event_log WHERE event_type LIKE 'test.rls.%'").catch(() => {});
    await pool.query("DELETE FROM starlane_cache WHERE cache_key LIKE 'rls:%'").catch(() => {});
    await pool.query('DROP TABLE IF EXISTS fact_receivables_daily_203101').catch(() => {});
    await pool.end();
  }
  done();
}

main().catch((err) => { console.error(err); process.exit(1); });
