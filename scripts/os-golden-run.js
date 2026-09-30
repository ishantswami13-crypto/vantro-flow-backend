#!/usr/bin/env node
// FILE: scripts/os-golden-run.js
// Runs the seven-surface loop once over HTTP against a real Postgres and
// prints what Starlane answers to the pilot questions:
//
//   What is changing? What is inefficient? What can be automated?
//   What opportunity exists? What decision exists? What can Starlane handle?
//
// By default it uses the generated fixture ledger (every name ends in
// "(Fixture)") in a throwaway tenant on the reserved .invalid domain, which
// is deleted at the end. With --file it uses a real receivables CSV instead,
// still in a throwaway local tenant, still in shadow mode: nothing is sent.
//
// Usage:
//   DATABASE_URL=... JWT_SECRET=... node scripts/os-golden-run.js [--file ledger.csv --options mapping.json] [--out report.md] [--keep]
// Refuses a non-local DATABASE_URL.

require('dotenv').config();
const fs = require('fs');
const { dbReady, createTenant, deleteTenant, startServer, client, tokenFor, todayIso } = require('../tests/helpers/decisionHarness');
const { buildOperatingSystemLedger } = require('../tests/fixtures/operatingSystemLedger');

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i !== -1 ? args[i + 1] : null; };
const flag = (n) => args.includes(`--${n}`);

const FIXTURE_OPTIONS = {
  mapping: { customer: 'Party Name', invoice_number: 'Bill No', invoice_date: 'Bill Date', due_date: 'Due Date', amount: 'Bill Amount', status: 'Status', payment_date: 'Payment Date' },
  dateOrders: { 'Bill Date': 'DMY', 'Due Date': 'DMY', 'Payment Date': 'DMY' },
  currency: 'INR',
};

function isLocal(url) {
  try { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname); } catch { return false; }
}

const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;

async function main() {
  if (!isLocal(process.env.DATABASE_URL || '')) {
    console.error('Refusing: DATABASE_URL is not a local database. This script writes a throwaway tenant.');
    process.exit(2);
  }
  const env = await dbReady();
  if (!env.ok) { console.error(`BLOCKED: ${env.reason}`); process.exit(2); }
  const t61 = await env.pool.query(`SELECT to_regclass('public.starlane_workflows') AS t`);
  if (!t61.rows[0].t) { console.error('BLOCKED: migration 061_operating_system.sql not applied'); process.exit(2); }

  const realFile = opt('file');
  const csv = realFile ? fs.readFileSync(realFile, 'utf8') : buildOperatingSystemLedger(todayIso()).csv;
  const options = opt('options') ? JSON.parse(fs.readFileSync(opt('options'), 'utf8')) : FIXTURE_OPTIONS;
  const label = realFile ? 'REAL FILE (local, shadow mode)' : 'FIXTURE DATA (generated, not a real business)';

  const server = await startServer({ FEATURE_EXTERNAL_MESSAGE_SENDING_ENABLED: 'false', STARLANE_GLOBAL_STOP: '' });
  const user = await createTenant(env.pool, 'os-golden');
  const c = client(server.base, user);
  const out = [];
  const say = (s = '') => { out.push(s); console.log(s); };
  try {
    say(`# Starlane seven-surface run: ${label}`);
    say(`Run on ${new Date().toISOString()} against a local database. Pilot mode: shadow. Nothing was sent.`);
    say();

    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), realFile ? 'ledger.csv' : 'fixture-ledger.csv');
    form.append('options', JSON.stringify(options));
    const imp = await fetch(`${server.base}/api/decisions/import/commit`, { method: 'POST', headers: { Authorization: `Bearer ${tokenFor(user)}` }, body: form }).then((r) => r.json());
    if (!imp.import) throw new Error(`import failed: ${JSON.stringify(imp).slice(0, 400)}`);
    const bridge = (await c.get('/api/os/bridge')).body;
    say('## Bridge: what are we connected to?');
    for (const k of bridge.connectors) say(`- ${k.name}: ${k.health.toLowerCase().replace(/_/g, ' ')}; can read ${k.contract.READ.what.join(', ') || 'nothing'}; can do ${k.contract.EXECUTE.what.join(', ') || 'nothing on its own'}`);
    say(`- Understood: ${bridge.discovered.filter((d) => d.count).map((d) => `${d.count} ${d.entity}`).join(', ')}`);
    say(`- Missing: ${bridge.missing.join(' ')}`);
    say();

    const scan = (await c.post('/api/os/scan', {})).body;
    say('## Scan: what did Starlane discover?');
    for (const l of scan.summary) say(`> ${l}`);
    say();
    say('### What is inefficient?');
    const p = scan.process;
    if (p.status === 'RECONSTRUCTED') {
      if (p.bottleneck) say(`- Bottleneck: ${p.bottleneck.label}. ${p.bottleneck.why}`);
      if (p.documentedVsActual) say(`- Documented vs actual: ${p.documentedVsActual.documented.label}; ${p.documentedVsActual.actual.label.toLowerCase()} (gap ${p.documentedVsActual.gapDays} days).`);
      say(`- Paid by the due date: ${Math.round((p.sla.rate || 0) * 100)}% (${p.sla.met} of ${p.sla.met + p.sla.violated}).`);
    } else say(`- ${p.reason}`);
    say();
    say('### What can be automated?');
    if (!scan.automation.candidates.length) for (const x of scan.automation.considered) say(`- Not proposed: ${x.why}`);
    for (const a of scan.automation.candidates) {
      say(`- ${a.title} (score ${a.score}): ${a.summary}`);
      say(`  - Trigger: ${a.trigger.days}+ days overdue. ${a.trigger.why}`);
      say(`  - Baseline: ${a.baseline.label}`);
      say(`  - Past the trigger now: ${a.inScopeNow.customers} customers, ${inr(a.inScopeNow.amount)}.`);
    }
    say();
    say('### What opportunity exists?');
    if (!scan.opportunities.length) say('- None found in this data.');
    for (const o of scan.opportunities) say(`- ${o.title}: ${inr(o.value)} ${o.valueLabel}. ${o.detail}`);
    say(`- Constraint: ${scan.constraint.constraint ? `${scan.constraint.label}. ${scan.constraint.why}` : scan.constraint.why}`);
    say();

    const obj = (await c.post('/api/os/objectives', { templateKey: 'COLLECTIONS_AUTOPILOT', metricKey: 'overdue_share_pct', operator: '<=', target: 15, autopilotMode: 'EXECUTE_WITH_APPROVAL' })).body;
    say('## Watch: what is changing?');
    say(`- Objective "overdue share at most 15%": ${obj.evaluation.health.replace('_', ' ').toLowerCase()}. ${obj.evaluation.explanation}`);
    say(`- Confidence ${obj.evaluation.confidence.level.toLowerCase()}${obj.evaluation.confidence.reasons.length ? `: ${obj.evaluation.confidence.reasons.join('; ')}` : ''}.`);
    say();

    const decisions = (await c.get('/api/decisions')).body.decisions;
    say('## Simulate + Prepared: what decision exists?');
    if (!decisions.length) say('- No material decision found.');
    for (const d of decisions.slice(0, 3)) {
      const full = (await c.get(`/api/decisions/${d.id}`)).body.decision;
      say(`- ${full.title} Recommendation: ${full.recommendation?.label || 'none'}.`);
      for (const o of full.options.slice(0, 5)) {
        const f = o.futures?.cash60 || o.futures?.value;
        const what = o.futures?.cash60 ? '60-day expected cash' : 'expected value';
        say(`  - ${o.isDoNothing ? 'Do nothing' : o.label}${f ? `: ${what} ${inr(f.mean)} (P10 ${inr(f.p10)}, P90 ${inr(f.p90)})` : ''}`);
      }
    }
    say();

    say('## Missions: what can Starlane handle?');
    const wfId = scan.proposals[0]?.workflowId;
    if (!wfId) say('- Nothing to handle: no workflow was proposed.');
    else {
      const sim = (await c.post(`/api/os/workflows/${wfId}/simulate`, {})).body.simulation;
      say(`- Replayed on the last ${sim.lookbackDays} days (${sim.replays} weekly replays, leakage ${sim.leakage}): the follow-up would have fired ${sim.episodes} times, ${sim.perMonth} a month; ${sim.paidWithinWindowWithoutAction} of those customers paid within 7 days on their own.`);
      await c.post(`/api/os/workflows/${wfId}/deploy`, { mode: 'WITH_APPROVAL' });
      const run = (await c.post(`/api/os/workflows/${wfId}/run`)).body;
      say(`- Deployed with approval and ran: ${run.run.counts.created} reminders prepared for approval; ${run.run.counts.excluded.disputed || 0} disputed and ${run.run.counts.excluded.belowMinimum || 0} small balances left out.`);
      const first = run.items[0];
      if (first) {
        say('- First reminder prepared (in shadow mode approving it records what would have been sent):');
        say('');
        say('```');
        say(first.draft.text);
        say('```');
        const ap = (await c.post(`/api/os/workflows/items/${first.id}/approve`)).body.item;
        say(`- Approved -> ${ap.status}. Outcome checked on ${ap.verifyAfter}: payment received within 7 days (the model expects ${Math.round((ap.expectedOutcome.baselineProbability || 0) * 100)}% without any reminder).`);
      }
    }
    say();
    say('## Memory: what have we learned?');
    const mem = (await c.get('/api/os/memory')).body;
    say(mem.outcomes.length ? `- ${JSON.stringify(mem.outcomes)}` : '- No outcome is due yet: the first verification date is 7 days after the first approval. Nothing is claimed before then.');
    fs.writeFileSync(opt('out') || 'os-golden-run.md', `${out.join('\n')}\n`);
  } finally {
    if (!flag('keep')) await deleteTenant(env.pool, user.id).catch(() => {});
    await server.stop();
    await env.pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
