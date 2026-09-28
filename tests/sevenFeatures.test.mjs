// The seven features end to end over HTTP on a real database, following the
// golden flow: Bridge -> Watch overdue item -> Scan why -> collections
// Mission -> Simulate -> approve a mission action -> progress -> Memory ->
// Prepared. Plus: dedupe, auto-resolution, paused-mission approval hold (in
// the route AND in the database), and tenant isolation on every feature.
import { createRequire } from 'node:module';
import { makeChecker, openPool, deleteUsers, startServer } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { check, done } = makeChecker();
const PORT = 3931;

async function seedAccount(pool, label) {
  const id = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@test.starlane.invalid`;
  await pool.query(`INSERT INTO users (id, email, password_hash, business_name) VALUES ($1,$2,$3,$4)`, [id, email, await bcrypt.hash('correct-horse-9', 4), `${label} Traders`]);
  return { id, email };
}

async function main() {
  const pool = openPool();
  const users = [];
  let server;
  try {
    const a = await seedAccount(pool, 'seven-a'); users.push(a.id);
    const b = await seedAccount(pool, 'seven-b'); users.push(b.id);
    server = await startServer(PORT, { FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED: 'false', WATCH_FORCED_REFRESH_MIN_MS: '0' });
    const { base } = server;
    const call = (method, p, token, body) => fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const get = async (p, t) => { const r = await call('GET', p, t); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    const post = async (p, t, body = {}) => { const r = await call('POST', p, t, body); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    const login = async (u, client) => (await post('/api/auth/native/login', null, { email: u.email, password: 'correct-horse-9', client, platform: 'test' })).body.accessToken;
    const ta = await login(a, 'desktop');
    const tb = await login(b, 'mobile');
    // The website signs in with the ordinary web login and uses the same /api/client/* routes.
    const webLogin = async (u) => (await post('/api/auth/login', null, { email: u.email, password: 'correct-horse-9' })).body.token;
    const taWeb = await webLogin(a);
    const tbWeb = await webLogin(b);
    check('web sessions sign in', !!taWeb && !!tbWeb);

    console.log('— empty company');
    let br = await get('/api/client/bridge', ta);
    check('bridge on an empty company: no data, nothing invented', br.status === 200 && br.body.hasData === false && br.body.freshness === 'none' && br.body.state.openReceivables === 0 && br.body.attention.decisions === 0, br.body);
    const prepEmpty = await get('/api/client/prepared', ta);
    check('prepared on an empty company says it has no data', prepEmpty.body.horizons.every((h) => h.status === 'insufficient_data'));
    check('telemetry keeps optional auth (features router does not swallow /api/client/*)', (await post('/api/client/telemetry', null, { events: [{ name: 'client.app_started' }] })).status === 202);
    const ver = await get('/api/version');
    check('version: release, API level and migration level (this database is up to date)', ver.status === 200 && ver.body.release === '0.1.0' && ver.body.apiLevel && ver.body.migrations.expected === '053_seven_features.sql' && ver.body.migrations.upToDate === true, ver.body);
    check('features require sign-in',(await get('/api/client/bridge')).status === 401 && (await get('/api/client/missions')).status === 401);

    await pool.query(`INSERT INTO invoices (user_id, customer_name, customer_phone, invoice_number, invoice_amount, payment_status, days_overdue, due_date, source_type) VALUES
      ($1,'Mehta Hardware','9810000001','S/101',128500,'Pending',45, (CURRENT_DATE - 45)::text, 'tally'),
      ($1,'Mehta Hardware','9810000001','S/117',40000,'Pending',12, (CURRENT_DATE - 12)::text, 'tally'),
      ($1,'Kapoor & Co',NULL,'S/120',64000,'Pending',5, (CURRENT_DATE - 5)::text, 'tally'),
      ($1,'Singh Electricals','9810000003','S/131',15000,'Pending',0, (CURRENT_DATE + 3)::text, 'tally'),
      ($1,'Disputed Ltd','9810000004','S/090',20000,'Pending',20, (CURRENT_DATE - 20)::text, 'tally')`, [a.id]);
    await pool.query(`UPDATE invoices SET dunning_paused = true WHERE user_id = $1 AND customer_name = 'Disputed Ltd'`, [a.id]);
    for (const late of [6, 9, 8]) {
      await pool.query(`INSERT INTO invoices (user_id, customer_name, invoice_amount, payment_status, days_overdue, due_date, payment_date) VALUES ($1,'Mehta Hardware',10000,'Paid',0,(CURRENT_DATE - 90)::text,(CURRENT_DATE - 90 + $2::int)::text)`, [a.id, late]);
    }

    console.log('— bridge + watch');
    const w1 = await get('/api/client/watch?refresh=1', ta);
    const evs = w1.body.events;
    check('watch finds each overdue invoice once, disputed excluded', evs.filter((e) => e.kind === 'invoice_overdue').length === 3 && !evs.some((e) => /Disputed/.test(e.title)), evs.map((e) => e.title));
    check('most severe first (45 days = high)', evs[0].severity === 'high' && /Mehta/.test(evs[0].title));
    await get('/api/client/watch?refresh=1', ta);
    const w2 = await get('/api/client/watch?refresh=1', ta);
    check('re-detection creates no duplicates', w2.body.events.length === evs.length && w2.body.refreshed.created === 0);
    const push = (await pool.query(`SELECT count(*)::int n FROM notification_events WHERE user_id = $1 AND dedupe_key LIKE 'watch:%'`, [a.id])).rows[0].n;
    check('a high event notifies exactly once', push === 1, push);
    br = await get('/api/client/bridge', ta);
    check('bridge: receivables, ageing, top overdue customer, open watch count', br.body.hasData && br.body.state.openReceivables === 267500 && br.body.state.topOverdue[0].name === 'Mehta Hardware' && br.body.attention.watch.open === 3 && br.body.state.ageing.length === 5, br.body.state);
    check('bridge figures carry evidence', br.body.state.evidence.facts.length === 3);
    const ev = evs[0];
    const evd = await get(`/api/client/watch/${ev.id}`, ta);
    check('watch event links to Scan and to a new Mission', evd.body.next.scan === `/scan/invoice/${ev.entity.id}` && evd.body.next.mission.startsWith('/missions/new'));
    check('acknowledge', (await post(`/api/client/watch/${ev.id}/state`, ta, { state: 'acknowledged' })).body.event.state === 'acknowledged');
    check('resolved/invalid transitions refused', (await post(`/api/client/watch/${ev.id}/state`, ta, { state: 'resolved' })).status === 400);
    check('other tenant cannot see or change the event', (await get(`/api/client/watch/${ev.id}`, tb)).status === 404 && (await post(`/api/client/watch/${ev.id}/state`, tb, { state: 'dismissed' })).status === 404);

    console.log('— scan');
    const sc = await get(`/api/client/scan/invoice/${ev.entity.id}`, ta);
    check('scan invoice: headline + labelled evidence + customer context', /45 days overdue/.test(sc.body.scan.headline) && sc.body.scan.evidence.facts.some((f) => f.kind === 'calculated') && sc.body.scan.customer.invoices.length === 2, sc.body);
    check('scan says why, including learned payment timing', sc.body.scan.customer.why.some((w) => /usually pays about 8 days after/.test(w)), sc.body.scan.customer.why);
    const kap = await get('/api/client/scan/customer/Kapoor%20%26%20Co', ta);
    check('scan flags a missing phone number', kap.body.scan.why.some((w) => /No phone number/.test(w)));
    const s = await get('/api/client/scan/search?q=meh', ta);
    check('scan search finds the customer', s.body.customers[0]?.name === 'Mehta Hardware' && s.body.customers[0].openTotal === 168500);
    check('scan is tenant-scoped', (await get(`/api/client/scan/invoice/${ev.entity.id}`, tb)).status === 404 && (await get('/api/client/scan/search?q=meh', tb)).body.customers.length === 0);

    console.log('— missions');
    const prev = await post('/api/client/missions/preview', ta, { customer: 'Mehta Hardware', targetAmount: 100000, horizonDays: 14 });
    check('preview: draft + simulation against the target', prev.body.errors.length === 0 && prev.body.simulation.target.amount === 100000 && prev.body.simulation.estimate.expected.kind === 'estimate');
    check('invalid mission refused with a reason', (await post('/api/client/missions', ta, { customer: 'Mehta Hardware', targetAmount: 999999 })).status === 400);
    const created = await post('/api/client/missions', ta, { customer: 'Mehta Hardware', targetAmount: 100000, horizonDays: 14 });
    const mid = created.body.mission.id;
    check('mission created as DRAFT', created.status === 201 && created.body.mission.status === 'draft');
    check('draft cannot be paused', (await post(`/api/client/missions/${mid}/pause`, ta)).status === 409);
    const act = await post(`/api/client/missions/${mid}/activate`, ta);
    check('activate: ACTIVE, baseline frozen, one action proposed for the customer', act.body.mission.status === 'active' && act.body.mission.baseline.outstanding === 168500 && act.body.proposed.created === 1, act.body);
    const ma = act.body.mission.actions[0];
    check('mission action is a firm reminder (escalation not allowed), awaiting approval', ma.type === 'SEND_FIRM_REMINDER' && ma.lifecycle === 'APPROVAL_REQUIRED' && ma.missionId === mid && ma.draft);
    check('progress starts at zero with honest blockers', act.body.mission.progress.collected === 0 && act.body.mission.progress.blockers.some((x) => x.code === 'messaging_off'));
    check('activate twice refused', (await post(`/api/client/missions/${mid}/activate`, ta)).status === 409);

    console.log('— paused mission holds approvals');
    await post(`/api/client/missions/${mid}/pause`, ta);
    const held = await post(`/api/client/actions/${ma.id}/decision`, ta, { decision: 'approve' });
    check('approval refused while the mission is paused', held.status === 409 && held.body.code === 'MISSION_NOT_ACTIVE');
    let dbHeld = false;
    try { await pool.query(`UPDATE ai_actions SET status = 'approved' WHERE id = $1`, [ma.id]); } catch (e) { dbHeld = /mission_not_active/.test(e.message); }
    check('…and the database refuses it on any other path', dbHeld);
    await post(`/api/client/missions/${mid}/activate`, ta);

    console.log('— simulate');
    const sim = await post('/api/client/simulate', ta, { missionId: mid, horizonDays: 14, rates: { '31_90': 0.5 } });
    check('simulate the mission: owner rate used, target = what is left', sim.body.scope === 'mission' && sim.body.simulation.assumptions.find((x) => x.band === '31_90').source === 'you' && sim.body.simulation.target.amount === 100000, sim.body);
    check('simulate on another tenant\'s mission -> 404', (await post('/api/client/simulate', tb, { missionId: mid })).status === 404);

    console.log('— approve (from the website) -> execute -> progress');
    check('web session reads the Bridge with the waiting step', (await get('/api/client/bridge', taWeb)).body.attention.topDecisions.some((x) => x.id === ma.id));
    const foreign = await post(`/api/client/actions/${ma.id}/decision`, tbWeb, { decision: 'approve', confirmHighRisk: true });
    check('another company\'s web session cannot decide this action (404)', foreign.status === 404, foreign);
    const dec = await post(`/api/client/actions/${ma.id}/decision`, taWeb, { decision: 'approve', confirmHighRisk: true, via: 'web' });
    check('approve from the web: executed honestly (sending off, nothing sent)', dec.body.status === 'done' && /nothing went to Mehta Hardware/.test(dec.body.message), dec.body);
    const detail = await get(`/api/client/actions/${ma.id}`, ta);
    check('action lifecycle is EXECUTED', detail.body.action.lifecycle === 'EXECUTED');
    await pool.query(`UPDATE invoices SET payment_status = 'Paid', payment_date = CURRENT_DATE::text WHERE user_id = $1 AND invoice_number = 'S/101'`, [a.id]);
    const md = await get(`/api/client/missions/${mid}`, ta);
    check('payment in the books -> mission COMPLETED with outcome', md.body.mission.status === 'completed' && md.body.mission.outcome.collected === 128500, md.body.mission);
    check('mission history records every transition', ['draft', 'active', 'paused', 'active', 'completed'].every((e, i) => md.body.mission.history[i]?.event === e), md.body.mission.history);
    const w3 = await get('/api/client/watch?state=closed&refresh=1', ta);
    check('the paid invoice\'s watch event resolved itself (paid)', w3.body.events.some((e) => e.id === ev.id && e.state === 'resolved' && e.resolution === 'paid_or_removed'));
    check('other tenant sees no missions', (await get('/api/client/missions', tb)).body.missions.length === 0 && (await get(`/api/client/missions/${mid}`, tb)).status === 404);

    console.log('— days overdue are live (the stored column goes stale)');
    await pool.query(`INSERT INTO invoices (user_id, customer_name, customer_phone, invoice_number, invoice_amount, payment_status, days_overdue, due_date, source_type)
      VALUES ($1,'Stale Traders','9810000009','T/1',50000,'Pending',3,(CURRENT_DATE - 40)::text,'tally')`, [b.id]);
    const brB = await get('/api/client/bridge', tb);
    const band = (id) => brB.body.state.ageing.find((x) => x.id === id);
    check('Bridge ages a stale invoice by its due date (40 days -> 31–90), not the stored 3', band('31_90').count === 1 && band('1_7').count === 0, brB.body.state.ageing);
    const wB = await get('/api/client/watch?refresh=1', tb);
    check('Watch raises it in the 31+ band', wB.body.events.some((e) => /Stale Traders/.test(e.title) && /30 days/.test(e.title)), wB.body.events.map((e) => e.title));

    console.log('— memory');
    const mem = await get('/api/client/memory', ta);
    const timing = mem.body.records.find((r) => r.topic === 'payment_timing');
    check('memory: inferred payment timing with provenance', !!timing && timing.status === 'inferred' && timing.provenance.sampleSize === 4 && timing.provenance.table === 'invoices', mem.body);
    check('memory: the mission result was remembered', mem.body.records.some((r) => r.topic === 'mission_result' && /reached its target/.test(r.statement)));
    const corr = await post(`/api/client/memory/${timing.id}/correct`, ta, { statement: 'Mehta pays after the 10th of the month.' });
    check('correct: owner words kept, original in provenance', corr.body.record.status === 'corrected' && corr.body.record.provenance.correctedFrom.includes('9 days after'));
    await get('/api/client/memory', ta); // triggers re-inference
    const after = (await get('/api/client/memory', ta)).body.records.find((r) => r.id === timing.id);
    check('re-inference never overwrites a correction', after.statement === 'Mehta pays after the 10th of the month.');
    await post(`/api/client/memory/${timing.id}/remove`, ta);
    check('removed records leave the list and stay removed', !(await get('/api/client/memory', ta)).body.records.some((r) => r.id === timing.id) && (await get('/api/client/memory?status=removed', ta)).body.records.some((r) => r.id === timing.id));
    check('owner note', (await post('/api/client/memory', ta, { subject: 'Kapoor & Co', statement: 'Call the accountant, not the owner.' })).body.record.status === 'confirmed');
    check('memory is tenant-scoped', (await get('/api/client/memory', tb)).body.records.length === 0 && (await post(`/api/client/memory/${timing.id}/confirm`, tb)).status === 404);

    console.log('— prepared');
    const prep = await get('/api/client/prepared', ta);
    const all = prep.body.horizons.flatMap((h) => h.items);
    check('prepared: Singh due in 3 days is in the 7-day horizon', prep.body.horizons.find((h) => h.horizon === '7d').items.some((i) => i.kind === 'invoices_due' && i.customers.includes('Singh Electricals')));
    check('prepared: every item has reason + source', all.length > 0 && all.every((i) => i.reason && i.source.ids.length));
    check('prepared is tenant-scoped', (await get('/api/client/prepared', tb)).body.horizons.every((h) => h.items.length === 0));
  } finally {
    await server?.stop();
    await deleteUsers(pool, users);
    await pool.end();
  }
  done();
}

main().catch((e) => { console.error(e); process.exit(1); });
