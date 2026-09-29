#!/usr/bin/env node
// FILE: scripts/pilot-readiness.js
// One command that says whether Starlane is ready to put in front of a pilot
// business, by running the real loop over HTTP against a real Postgres:
//
//   DB  AUTH  TENANCY  INGEST  STATE  EVIDENCE  SIGNALS  DECISION
//   SIMULATE  CONTROL  AUDIT  FRONTEND
//
// Each check is PASS only when it was actually exercised and verified.
// Anything not exercised is SKIPPED or BLOCKED with the reason; nothing is
// green by default. Fixture tenants live on the reserved .invalid domain,
// every customer name ends in "(Fixture)", and they are deleted at the end.
//
// Usage:
//   DATABASE_URL=... JWT_SECRET=... node scripts/pilot-readiness.js [--frontend-url URL] [--out FILE] [--keep]
//
// Safety: this starts its own backend process and writes fixture tenants to
// DATABASE_URL, so it refuses to run against a non-local database unless
// --allow-remote-db is passed (never pass it for production).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { dbReady, createTenant, deleteTenant, startServer, client, tokenFor, todayIso } = require('../tests/helpers/decisionHarness');
const { slippingCustomerCsv, healthyCsv, noDueDatesCsv, confirmedOptions } = require('../tests/fixtures/pilotLedgers');
const { buildGoldenReceivables } = require('../tests/fixtures/goldenReceivables');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i !== -1 ? args[i + 1] : null; };

const CHECKS = ['DB', 'AUTH', 'TENANCY', 'INGEST', 'STATE', 'EVIDENCE', 'SIGNALS', 'DECISION', 'SIMULATE', 'CONTROL', 'AUDIT', 'FRONTEND'];
const results = Object.fromEntries(CHECKS.map((c) => [c, { status: 'NOT_RUN', detail: 'not reached' }]));
const transcript = [];

function set(check, status, detail) {
  results[check] = { status, detail };
}

function isLocalDb(url) {
  try {
    const host = new URL(url).hostname;
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
  } catch {
    return false;
  }
}

async function upload(server, user, kind, csv, options) {
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'pilot-fixture-ledger.csv');
  if (options) form.append('options', JSON.stringify(options));
  const r = await fetch(`${server.base}/api/decisions/import/${kind}`, { method: 'POST', headers: { Authorization: `Bearer ${tokenFor(user)}` }, body: form });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// Independent arithmetic: expected totals straight from the fixture rows,
// without the importer or the engine.
function expectedTotals(asOfIso) {
  const fx = buildGoldenReceivables(asOfIso);
  const asOf = Date.parse(`${asOfIso}T00:00:00Z`);
  let open = 0;
  let overdue = 0;
  let sharmaOverdue = 0;
  for (const i of fx.raw.invoices) {
    if (i.customer_name.startsWith('Rao') || i.payment_status === 'Paid') continue;
    open += i.invoice_amount;
    if (Date.parse(`${i.due_date}T00:00:00Z`) < asOf) {
      overdue += i.invoice_amount;
      if (i.customer_name.startsWith('Sharma')) sharmaOverdue += i.invoice_amount;
    }
  }
  return { open, overdue, sharmaOverdue };
}

async function run() {
  const started = Date.now();
  if (!process.env.DATABASE_URL) { set('DB', 'BLOCKED', 'DATABASE_URL is not set'); return; }
  if (!isLocalDb(process.env.DATABASE_URL) && !flag('allow-remote-db')) {
    set('DB', 'BLOCKED', 'DATABASE_URL is not a local database. This check writes fixture tenants, so it only runs locally (or with --allow-remote-db on a staging database).');
    return;
  }
  if (!process.env.JWT_SECRET) { set('DB', 'BLOCKED', 'JWT_SECRET is not set'); return; }

  const env = await dbReady();
  if (!env.ok) { set('DB', 'FAIL', env.reason); return; }
  const tables = await env.pool.query(`SELECT to_regclass('public.decisions') d, to_regclass('public.decision_events') e, to_regclass('public.file_import_batches') f, to_regclass('public.decision_contracts') c`);
  const missing = Object.entries(tables.rows[0]).filter(([, v]) => !v).map(([k]) => ({ d: 'decisions', e: 'decision_events', f: 'file_import_batches', c: 'decision_contracts' }[k]));
  if (missing.length) { set('DB', 'FAIL', `missing tables: ${missing.join(', ')}`); await env.pool.end(); return; }
  set('DB', 'PASS', 'connected; decision, audit, contract and import tables present');

  const tenants = [];
  let server;
  try {
    server = await startServer({ FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED: 'false', STARLANE_GLOBAL_STOP: '' });
    const mk = async (label) => { const t = await createTenant(env.pool, `pilot-${label}`); tenants.push(t); return t; };
    const a = await mk('slipping');
    const b = await mk('intruder');
    const h = await mk('healthy');
    const n = await mk('nodue');
    const ca = client(server.base, a);
    const cb = client(server.base, b);
    const today = todayIso();

    // AUTH: the API refuses missing and forged tokens and accepts a real one.
    {
      const none = await fetch(`${server.base}/api/decisions/today`);
      const forged = await fetch(`${server.base}/api/decisions/today`, { headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ4In0.bad' } });
      const ok = await ca.get('/api/decisions/today');
      let login = 'password login not exercised: it reads users through Supabase, which is not configured here';
      if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) login = 'Supabase configured; password login not exercised by this script';
      if (none.status === 401 && forged.status === 401 && ok.status === 200) set('AUTH', 'PASS', `no token -> 401, forged token -> 401, valid token -> 200. Note: ${login}`);
      else set('AUTH', 'FAIL', `no token ${none.status}, forged ${forged.status}, valid ${ok.status}`);
    }

    // INGEST: preview writes nothing; commit imports; the same file again is a no-op.
    const csv = slippingCustomerCsv(today);
    let first;
    {
      const pre = await upload(server, a, 'preview', csv);
      const before = (await env.pool.query('SELECT COUNT(*)::int n FROM invoices WHERE user_id = $1', [a.id])).rows[0].n;
      first = await upload(server, a, 'commit', csv, confirmedOptions());
      const again = await upload(server, a, 'commit', csv, confirmedOptions());
      const after = (await env.pool.query('SELECT COUNT(*)::int n FROM invoices WHERE user_id = $1', [a.id])).rows[0].n;
      const rows = csv.trim().split('\n').length - 1;
      if (pre.status === 200 && before === 0 && first.status === 200 && first.body.import.counts.inserted === rows && again.body.import?.alreadyImported === true && after === rows) {
        set('INGEST', 'PASS', `${rows}-row CSV (DD/MM/YYYY, Indian digit grouping): preview wrote nothing, commit inserted ${rows}, re-upload was a no-op`);
      } else {
        set('INGEST', 'FAIL', `preview ${pre.status}, commit ${first.status} ${JSON.stringify(first.body.import?.counts || first.body).slice(0, 300)}, re-upload ${JSON.stringify(again.body.import || again.body).slice(0, 200)}, rows ${after}/${rows}`);
      }
      transcript.push({ step: 'First look after import (fixture data)', lines: first.body.firstLook?.lines || [] });
    }

    // STATE: the numbers Starlane shows equal the independently computed ones.
    {
      const exp = expectedTotals(today);
      const prof = await ca.get('/api/decisions/data-profile');
      const td = await ca.get('/api/decisions/today');
      const p = prof.body.byCurrency?.INR || {};
      const t = td.body.receivables?.totalsByCurrency?.INR || {};
      const same = p.open === exp.open && p.overdue === exp.overdue && t.open === exp.open && t.overdue === exp.overdue;
      set('STATE', same ? 'PASS' : 'FAIL', `expected open ₹${exp.open}, overdue ₹${exp.overdue}; data profile open ₹${p.open}, overdue ₹${p.overdue}; Today open ₹${t.open}, overdue ₹${t.overdue}`);
    }

    // DECISION: exactly one material decision, complete.
    let decision = null;
    {
      const exp = expectedTotals(today);
      const top = first.body.firstLook?.top || [];
      if (top.length) decision = (await ca.get(`/api/decisions/${top[0].id}`)).body.decision;
      const problems = [];
      if (top.length !== 1) problems.push(`expected 1 decision, got ${top.length}`);
      if (decision) {
        if (!/Sharma Traders \(Fixture\)/.test(decision.title)) problems.push(`wrong subject: ${decision.title}`);
        if (decision.materiality?.exposure !== exp.sharmaOverdue) problems.push(`exposure ${decision.materiality?.exposure} != ${exp.sharmaOverdue}`);
        if (!decision.options?.some((o) => o.key === 'do_nothing' && o.isDoNothing)) problems.push('no do-nothing option');
        if ((decision.options || []).length < 3) problems.push('fewer than 3 options');
        if (!decision.window?.latestSafeAt) problems.push('no decision window');
        if (!decision.confidence?.band) problems.push('no confidence band');
        if (!Array.isArray(decision.unknowns)) problems.push('no unknowns list');
        if (decision.status !== 'OPEN') problems.push(`status ${decision.status}`);
        transcript.push({
          step: 'Decision (fixture data)',
          lines: [
            decision.title,
            ...(decision.whyNow || []).map((w) => `Why now: ${typeof w === 'string' ? w : JSON.stringify(w)}`),
            `Window: latest safe ${decision.window?.latestSafeAt}`,
            `Confidence: ${decision.confidence?.band}`,
            `Recommendation: ${decision.recommendation?.label}`,
            ...decision.options.map((o) => `Option ${o.label}${o.valid === false ? ' (invalid)' : ''}: 60-day cash p10–p90 ₹${Math.round(o.futures?.cash60?.p10 || 0)}–₹${Math.round(o.futures?.cash60?.p90 || 0)}`),
            ...(decision.unknowns || []).slice(0, 3).map((u) => `Unknown: ${u.label || u.question || JSON.stringify(u)}`),
          ],
        });
      }
      set('DECISION', problems.length ? 'FAIL' : 'PASS', problems.length ? problems.join('; ') : `one decision: "${decision.title}", ${decision.options.length} options incl. do-nothing, deadline ${decision.window.latestSafeAt}, confidence ${decision.confidence.band}`);
    }

    // EVIDENCE: every cited invoice belongs to this tenant and the overdue ones add up.
    if (decision) {
      const ev = await ca.get(`/api/decisions/${decision.id}/evidence`);
      const own = new Set((await env.pool.query('SELECT id::text FROM invoices WHERE user_id = $1', [a.id])).rows.map((r) => r.id));
      const invIds = (decision.affectedEntities || []).filter((e) => e.type === 'invoice').map((e) => e.id);
      const sum = (await env.pool.query('SELECT COALESCE(SUM(invoice_amount),0)::float s FROM invoices WHERE user_id = $1 AND id = ANY($2::uuid[])', [a.id, invIds])).rows[0].s;
      const observed = (decision.evidence || []).filter((e) => e.kind === 'OBSERVED_FACT' && e.source?.table === 'invoices').length;
      const ok = ev.status === 200 && invIds.length > 0 && invIds.every((id) => own.has(id)) && sum === decision.materiality.exposure && observed > 0;
      set('EVIDENCE', ok ? 'PASS' : 'FAIL', `${invIds.length} invoices cited, all owned by the tenant: ${invIds.every((id) => own.has(id))}; they sum to ₹${sum} vs exposure ₹${decision.materiality.exposure}; ${observed} observed facts point at the invoices table`);
    } else set('EVIDENCE', 'FAIL', 'no decision to inspect');

    // SIGNALS: no false alarm on healthy data; no guessing without due dates.
    {
      const hh = await upload(server, h, 'commit', healthyCsv(today), confirmedOptions());
      const nn = await upload(server, n, 'commit', noDueDatesCsv(today), confirmedOptions({ dueDate: false }));
      const healthyQuiet = hh.status === 200 && hh.body.firstLook.needYou === 0;
      const noDueHonest = nn.status === 200 && nn.body.firstLook.needYou === 0 && nn.body.firstLook.insufficientInformation === true && nn.body.profile.limitations.some((l) => l.key === 'noDueDates' && l.severity === 'blocking');
      transcript.push({ step: 'Healthy business (fixture)', lines: hh.body.firstLook?.lines || [] });
      transcript.push({ step: 'Ledger without due dates (fixture)', lines: nn.body.firstLook?.lines || [] });
      set('SIGNALS', healthyQuiet && noDueHonest ? 'PASS' : 'FAIL', `healthy ledger -> ${hh.body.firstLook?.needYou} decisions ("${(hh.body.firstLook?.lines || []).slice(-1)[0]}"); no-due-date ledger -> ${nn.body.firstLook?.needYou} decisions, blocking limitation shown: ${noDueHonest}`);
    }

    // SIMULATE: what-if runs, is read-only, and do-nothing is always there.
    if (decision) {
      const sim = await ca.post(`/api/decisions/${decision.id}/simulate`, { paymentSpeed: 0.5 });
      const dn = sim.body.options?.find((o) => o.key === 'do_nothing');
      const base = decision.options.find((o) => o.key === 'do_nothing');
      const ok = sim.status === 200 && sim.body.persisted === false && dn && dn.futures.cash60.mean < base.futures.cash60.mean && decision.analysis?.stress && decision.analysis?.sensitivity;
      set('SIMULATE', ok ? 'PASS' : 'FAIL', `what-if (customers pay 50% slower): do-nothing 60-day expected cash ₹${Math.round(base?.futures.cash60.mean || 0)} -> ₹${Math.round(dn?.futures.cash60.mean || 0)}; not persisted: ${sim.body.persisted === false}; stress + sensitivity stored: ${!!(decision.analysis?.stress && decision.analysis?.sensitivity)}`);
    } else set('SIMULATE', 'FAIL', 'no decision to simulate');

    // TENANCY: tenant B cannot read, act on, or see tenant A's data.
    if (decision) {
      const r1 = await cb.get(`/api/decisions/${decision.id}`);
      const r2 = await cb.post(`/api/decisions/${decision.id}/select`, { optionKey: 'do_nothing' });
      const r3 = await cb.post(`/api/decisions/${decision.id}/feedback`, { kind: 'WRONG' });
      const r4 = await cb.get(`/api/decisions/${decision.id}/evidence`);
      const r5 = await cb.get('/api/decisions/data-profile');
      const r6 = await cb.get('/api/decisions');
      const ok = [r1, r2, r3, r4].every((r) => r.status === 404) && r5.body.counts?.invoices === 0 && (r6.body.decisions || []).length === 0;
      set('TENANCY', ok ? 'PASS' : 'FAIL', `B -> A's decision: read ${r1.status}, select ${r2.status}, feedback ${r3.status}, evidence ${r4.status}; B sees ${r5.body.counts?.invoices} invoices and ${(r6.body.decisions || []).length} decisions`);
    } else set('TENANCY', 'FAIL', 'no decision to attack');

    // CONTROL: shadow by default; order enforced; kill switch blocks for real.
    if (decision) {
      const problems = [];
      const tdy = await ca.get('/api/decisions/today');
      if (tdy.body.pilotMode !== 'SHADOW') problems.push(`new tenant pilot mode ${tdy.body.pilotMode}`);
      if ((await ca.post(`/api/decisions/${decision.id}/execute`)).status !== 409) problems.push('executed before approval');
      const sel = await ca.post(`/api/decisions/${decision.id}/select`, { optionKey: decision.recommendation.key, note: 'pilot readiness' });
      if (sel.status !== 200) problems.push(`select ${sel.status}`);
      const contract = sel.body.contract || {};
      for (const k of ['expected_outcomes', 'success_criteria', 'abort_conditions', 'rollback_plan']) if (!contract[k] || !contract[k].length) problems.push(`contract has no ${k}`);
      if ((await ca.post(`/api/decisions/${decision.id}/approve`, { note: 'pilot readiness' })).status !== 200) problems.push('approve failed');
      await ca.post('/api/decisions/controls', { scope: 'TENANT', stopped: true, reason: 'pilot readiness' });
      const blocked = await ca.post(`/api/decisions/${decision.id}/execute`);
      if (blocked.status !== 423) problems.push(`tenant kill switch did not block execution (${blocked.status})`);
      await ca.post('/api/decisions/controls', { scope: 'TENANT', stopped: false });
      const ex = await ca.post(`/api/decisions/${decision.id}/execute`);
      if (ex.status !== 200 || ex.body.mode !== 'SHADOW' || ex.body.status !== 'SHADOWED') problems.push(`shadow execute ${ex.status} ${ex.body.mode} ${ex.body.status}`);
      const sent = (await env.pool.query('SELECT COUNT(*)::int n FROM ai_actions WHERE user_id = $1 AND decision_id = $2', [a.id, decision.id])).rows[0].n;
      if (sent !== 0) problems.push(`${sent} actions prepared in shadow mode`);
      const again = await ca.post(`/api/decisions/${decision.id}/execute`);
      if (again.status !== 409) problems.push(`second execute returned ${again.status}`);
      if (ex.body.runs) transcript.push({ step: 'Shadow execution (fixture data)', lines: ex.body.runs.map((r) => `Would have: ${typeof r.would_have === 'string' ? r.would_have : JSON.stringify(r.would_have).slice(0, 200)}`) });
      set('CONTROL', problems.length ? 'FAIL' : 'PASS', problems.length ? problems.join('; ') : 'new tenant starts in SHADOW; execute before approval refused; contract has outcomes, success/abort criteria and rollback; tenant kill switch returned 423; shadow run changed nothing and prepared no messages; second execute refused');
    } else set('CONTROL', 'FAIL', 'no decision to control');

    // AUDIT: who did what, in order, append-only, including feedback.
    if (decision) {
      await ca.post(`/api/decisions/${decision.id}/feedback`, { kind: 'USEFUL', note: 'pilot readiness' });
      const audit = await ca.get(`/api/decisions/${decision.id}/audit`);
      const types = (audit.body.events || []).map((e) => e.event_type);
      const need = ['DISCOVERED', 'OPTION_SELECTED', 'APPROVED', 'EXECUTION_STARTED', 'SHADOW_RECORDED', 'HUMAN_FEEDBACK'];
      const missingTypes = need.filter((t) => !types.includes(t));
      const humanApproval = (audit.body.events || []).find((e) => e.event_type === 'APPROVED');
      let immutable = false;
      try { await env.pool.query(`UPDATE decision_events SET event_type = 'TAMPERED' WHERE decision_id = $1`, [decision.id]); } catch { immutable = true; }
      const ok = !missingTypes.length && humanApproval?.actor_type === 'human' && humanApproval?.actor_id === a.id && immutable;
      set('AUDIT', ok ? 'PASS' : 'FAIL', `${types.length} events; missing: ${missingTypes.join(', ') || 'none'}; approval attributed to the human: ${humanApproval?.actor_type === 'human' && humanApproval?.actor_id === a.id}; tamper attempt rejected: ${immutable}`);
    } else set('AUDIT', 'FAIL', 'no decision to audit');

    // FRONTEND: only checked when a URL is given; reachable is all this proves.
    const fe = opt('frontend-url') || process.env.PILOT_FRONTEND_URL;
    if (!fe) set('FRONTEND', 'SKIPPED', 'no --frontend-url given; run with the deployed or local frontend URL to check the pages respond');
    else {
      const pages = ['/login', '/today', '/decisions', '/decisions/import'];
      const codes = [];
      for (const p of pages) {
        try { const r = await fetch(`${fe.replace(/\/$/, '')}${p}`, { redirect: 'manual' }); codes.push(`${p} ${r.status}`); } catch (err) { codes.push(`${p} ERR ${err.message}`); }
      }
      const ok = codes.every((c) => / (200|307|308)$/.test(c));
      set('FRONTEND', ok ? 'PASS' : 'FAIL', `${codes.join(', ')} (reachability only; signed-in pages redirect to login)`);
    }
  } catch (err) {
    const first = CHECKS.find((c) => results[c].status === 'NOT_RUN');
    if (first) set(first, 'FAIL', `crashed: ${err.message}`);
    if (server) transcript.push({ step: 'Server log tail', lines: server.log().split('\n').slice(-15) });
  } finally {
    if (server) await server.stop();
    if (!flag('keep')) {
      for (const t of tenants) {
        await env.pool.query('DELETE FROM file_import_batches WHERE user_id = $1', [t.id]).catch(() => {});
        await deleteTenant(env.pool, t.id).catch(() => {});
      }
    }
    await env.pool.end();
    transcript.push({ step: 'Duration', lines: [`${Math.round((Date.now() - started) / 100) / 10}s`] });
  }
}

function report() {
  const width = Math.max(...CHECKS.map((c) => c.length));
  const lines = CHECKS.map((c) => `${c.padEnd(width)}  ${results[c].status.padEnd(8)}  ${results[c].detail}`);
  const counts = CHECKS.reduce((acc, c) => { acc[results[c].status] = (acc[results[c].status] || 0) + 1; return acc; }, {});
  const verdict = CHECKS.every((c) => ['PASS', 'SKIPPED'].includes(results[c].status)) ? (counts.SKIPPED ? 'READY FOR A FIXTURE-DATA DEMO (some checks skipped)' : 'READY FOR A FIXTURE-DATA DEMO') : 'NOT READY';
  const text = [
    'STARLANE PILOT READINESS',
    `run at ${new Date().toISOString()} against ${process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : 'no database'}`,
    '',
    ...lines,
    '',
    `VERDICT: ${verdict}`,
    'This proves the loop on fixture data only. It says nothing about any real business until a real dataset has been run.',
    '',
    ...transcript.flatMap((t) => [`— ${t.step}`, ...t.lines.map((l) => `  ${l}`), '']),
  ].join('\n');
  console.log(text);
  const out = opt('out');
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), results, verdict, transcript }, null, 2));
  }
  process.exit(verdict === 'NOT READY' ? 1 : 0);
}

run().then(report, (err) => { console.error(err); set('DB', 'FAIL', err.message); report(); });
