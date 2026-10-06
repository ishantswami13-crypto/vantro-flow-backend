// Fixes from the master completion pass, over HTTP against a real server:
//   - Control > Audit shows decision steps (who, agent, model, result), per tenant
//   - Simulate's invoice list works out days overdue from the due date, not the stale column
//   - CRM prospects load through the pg shim (embedded prospect_notes select)
//   - Ask Starlane without a configured model answers 503 with a clear reason, not 500
import { createRequire } from 'node:module';
import { makeChecker } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const { createTenant, deleteTenant, seedGolden, startServer, client, todayIso } = require('./helpers/decisionHarness');
const { check, done } = makeChecker();

async function main() {
  if (!process.env.DATABASE_URL) { console.log('  SKIP needs DATABASE_URL'); return done(); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const tenants = [];
  let server;
  try {
    const a = await createTenant(pool, 'mc-a'); tenants.push(a);
    const b = await createTenant(pool, 'mc-b'); tenants.push(b);
    await seedGolden(pool, a.id, todayIso());
    // The stored column goes stale after import: pretend it was never refreshed.
    await pool.query(`UPDATE invoices SET days_overdue = 0 WHERE user_id = $1`, [a.id]);
    server = await startServer({ GROQ_API_KEY: '', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', SUPABASE_URL: '', SUPABASE_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '' });
    const A = client(server.base, a);
    const B = client(server.base, b);

    const disc = await A.post('/api/decisions/discover');
    check('decision discovery runs', disc.status === 200, disc.body);
    const audit = await A.get('/api/audit');
    const steps = (audit.body.events || []).filter((e) => e.source === 'decision');
    check('audit lists decision steps', audit.status === 200 && steps.length > 0, audit.body);
    check('each decision step names its actor and links its decision', steps.every((e) => e.actor && e.entity_id), steps[0]);
    check('an agent step names the model it used', steps.some((e) => e.actor_type === 'agent' && e.model), steps.map((e) => [e.actor_type, e.model]));
    const otherAudit = await B.get('/api/audit');
    check('another tenant sees none of it', otherAudit.status === 200 && otherAudit.body.events.length === 0, otherAudit.body);

    const inv = await A.get(`/api/intelligence/scenarios/${a.id}/invoices`);
    const { rows: [oldest] } = await pool.query(
      `SELECT (now() AT TIME ZONE 'UTC')::date - due_date::date AS d FROM invoices
        WHERE user_id = $1 AND payment_status <> 'Paid' AND due_date IS NOT NULL ORDER BY due_date ASC LIMIT 1`, [a.id]);
    check('Simulate lists the oldest invoice with its real days overdue', inv.status === 200 && inv.body.invoices[0]?.days_overdue === Math.max(0, oldest.d), { got: inv.body.invoices?.[0], want: oldest.d });

    const prospects = await A.get(`/api/prospects/${a.id}`);
    check('CRM prospects load', prospects.status === 200 && Array.isArray(prospects.body.prospects), prospects.body);

    const chat = await A.post('/api/ai-chat', { messages: [{ role: 'user', content: 'who owes us the most?' }] });
    check('chat without a model says so (503, AI_NO_PROVIDER)', chat.status === 503 && chat.body.code === 'AI_NO_PROVIDER' && /No AI model/.test(chat.body.error), chat);
    const health = await A.get('/api/ai/health');
    check('AI health lists no configured provider and never a key', health.status === 200 && health.body.configured.length === 0 && !/sk-|gsk_|AIza/.test(JSON.stringify(health.body)), health.body);
  } finally {
    if (server) await server.stop();
    for (const t of tenants) await deleteTenant(pool, t.id);
    await pool.end();
  }
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
