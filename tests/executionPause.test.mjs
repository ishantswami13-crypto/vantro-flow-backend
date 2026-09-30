// Pilot emergency stop: with ACTION_EXECUTION_PAUSED=true an owner can still
// approve (the decision is recorded and the action stays APPROVED), but nothing
// is carried out — the executor is never reached, so no message, call,
// purchase order or payout. Real database, real server.
import { createRequire } from 'node:module';
import { makeChecker, openPool, deleteUsers, startServer } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { check, done } = makeChecker();
const PORT = 3937;

async function main() {
  const pool = openPool();
  const id = randomUUID();
  const email = `pause-${id.slice(0, 8)}@test.starlane.invalid`;
  let server;
  try {
    await pool.query(`INSERT INTO users (id, email, password_hash, business_name) VALUES ($1,$2,$3,'Pause Traders')`, [id, email, await bcrypt.hash('correct-horse-9', 4)]);
    const inv = (await pool.query(`INSERT INTO invoices (user_id, customer_name, customer_phone, invoice_number, invoice_amount, payment_status, days_overdue, due_date)
      VALUES ($1,'Mehta Hardware','9810000001','S/1',40000,'Pending',12,(CURRENT_DATE - 12)::text) RETURNING id`, [id])).rows[0];
    const act = (await pool.query(`INSERT INTO ai_actions (user_id, action_type, title, status, suggested_by, risk_level, requires_approval, related_entity_type, related_entity_id, recommended_message)
      VALUES ($1,'SEND_FIRM_REMINDER','Firm reminder: Mehta Hardware','pending','collections_agent','medium',true,'invoice',$2,'Mehta ji, please pay') RETURNING id`, [id, String(inv.id)])).rows[0];

    server = await startServer(PORT, { ACTION_EXECUTION_PAUSED: 'true', FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED: 'false' });
    const call = async (method, p, token, body) => {
      const r = await fetch(`${server.base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const token = (await call('POST', '/api/auth/native/login', null, { email, password: 'correct-horse-9', client: 'desktop', platform: 'test' })).body.accessToken;

    const dec = await call('POST', `/api/client/actions/${act.id}/decision`, token, { decision: 'approve' });
    check('approving while paused answers "approved" and says nothing was carried out', dec.status === 200 && dec.body.status === 'approved' && /paused/.test(dec.body.message), dec.body);
    const row = (await pool.query('SELECT status, approved_by FROM ai_actions WHERE id = $1', [act.id])).rows[0];
    check('the decision is recorded: status approved, approved_by the owner', row.status === 'approved' && row.approved_by === id, row);
    const logs = (await pool.query('SELECT action FROM activity_logs WHERE user_id = $1', [id])).rows.map((r) => r.action);
    check('the executor never ran: logged as paused, never as executed or failed',
      logs.includes('ai_action_approved_execution_paused') && !logs.includes('ai_action_approved_and_executed') && !logs.includes('ai_action_execution_failed'), logs);
    const inv2 = (await pool.query('SELECT last_reminder_sent, reminder_count FROM invoices WHERE id = $1', [inv.id])).rows[0];
    check('the invoice was not marked as reminded', !inv2.last_reminder_sent && !inv2.reminder_count, inv2);
    const detail = await call('GET', `/api/client/actions/${act.id}`, token);
    check('the app shows the action as Approved (not Done)', detail.body.action?.lifecycle === 'APPROVED', detail.body.action?.lifecycle);
    const again = await call('POST', `/api/client/actions/${act.id}/decision`, token, { decision: 'approve' });
    check('a second approval is still refused (one decision per action)', again.status === 409);
  } finally {
    if (server) await server.stop();
    await deleteUsers(pool, [id]);
    await pool.end();
  }
  done();
}

main().catch((e) => { console.error(e); process.exit(1); });
