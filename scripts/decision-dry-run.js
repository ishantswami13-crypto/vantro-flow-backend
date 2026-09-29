#!/usr/bin/env node
// FILE: scripts/decision-dry-run.js
// "What would Starlane find in this business?" against a real tenant,
// strictly read-only, so it cannot write to the database even by mistake:
// no decisions are persisted, no agent run is recorded, nothing is sent.
// (Every connection is opened with default_transaction_read_only=on, so
// Postgres itself refuses any write.)
//
// It runs the same code as live discovery (snapshot -> contradictions ->
// receivables and process detectors) and prints, without cherry-picking:
// the data profile, every limitation, every decision it would open, and
// everything it would only watch.
//
// Usage (from a machine that can reach the database):
//   DATABASE_URL=... node scripts/decision-dry-run.js --email owner@business.com [--json out.json]
//   DATABASE_URL=... node scripts/decision-dry-run.js --list          # tenants with invoices, counts only

require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');
const { buildSanitizedPgConfig } = require('../lib/db/pgConfig');
const { loadRawReceivables } = require('../lib/domain/decisions/discovery');
const { deriveReceivablesState } = require('../lib/domain/decisions/snapshot');
const { discoverReceivableDecisions } = require('../lib/domain/decisions/detectors/receivables');
const { discoverProcessDecisions } = require('../lib/domain/decisions/detectors/process');
const { detectDecisionContradictions } = require('../lib/domain/decisions/contradictions');
const { receivablesFreshness } = require('../lib/domain/decisions/sourceHealth');
const { effectiveDefinitions } = require('../lib/domain/decisions/definitions');
const { profileLedger } = require('../lib/domain/decisions/ledgerImport');

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i !== -1 ? args[i + 1] : null; };

function inr(n, cur = 'INR') {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return `${cur === 'INR' ? '₹' : `${cur} `}${Math.round(Number(n)).toLocaleString('en-IN')}`;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const pool = new Pool({ ...buildSanitizedPgConfig(process.env.DATABASE_URL), max: 4, options: '-c default_transaction_read_only=on' });
  const client = pool;
  try {
    const ro = await client.query('SHOW default_transaction_read_only');
    if (ro.rows[0].default_transaction_read_only !== 'on') throw new Error('could not open a read-only connection; refusing to run');
    if (args.includes('--list')) {
      const r = await client.query(`SELECT u.email, COUNT(i.id)::int AS invoices, MIN(i.invoice_date) AS first, MAX(i.invoice_date) AS last
                                     FROM users u JOIN invoices i ON i.user_id = u.id GROUP BY u.email ORDER BY invoices DESC LIMIT 50`);
      console.table(r.rows);
      return;
    }
    const email = opt('email');
    if (!email) throw new Error('pass --email <tenant login email> (or --list)');
    const u = await client.query('SELECT id, business_name FROM users WHERE lower(email) = lower($1)', [email]);
    if (!u.rows[0]) throw new Error(`no user with email ${email}`);
    const userId = u.rows[0].id;
    const overrides = await client.query('SELECT definitions FROM starlane_tenant_settings WHERE user_id = $1', [userId]).catch(() => ({ rows: [] }));
    const defs = effectiveDefinitions(overrides.rows[0]?.definitions || {});
    const asOf = new Date().toISOString();

    const raw = await loadRawReceivables(client, userId);
    const state = deriveReceivablesState(raw, asOf, { mode: 'live', baseCurrency: defs.base_currency });
    const freshness = await receivablesFreshness(client, userId, defs);
    const reminders = (await client.query(
      `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE outcome = 'effective')::int AS effective FROM ai_actions
       WHERE user_id = $1 AND action_type IN ('SEND_FIRM_REMINDER','ESCALATE_COLLECTION','ESCALATE_COLLECTION_CALL') AND outcome IN ('effective','ineffective')`, [userId]
    ).catch(() => ({ rows: [{ n: 0, effective: 0 }] }))).rows[0];
    const contradictionsByInvoice = detectDecisionContradictions(state);
    const rec = discoverReceivableDecisions(state, defs, { externalSendEnabled: false, freshness, contradictionsByInvoice, reminderEvidence: reminders });
    const proc = discoverProcessDecisions(state, defs);
    const profile = profileLedger(raw.invoices, { baseCurrency: defs.base_currency });
    const drafts = [...rec.drafts, ...proc.drafts];
    const watched = [...rec.watched, ...proc.watched];

    const out = {
      tenant: { business: u.rows[0].business_name || null },
      asOf,
      mode: 'READ-ONLY DRY RUN: nothing was written',
      profile,
      freshness,
      quality: state.quality,
      totalsByCurrency: state.totalsByCurrency,
      notEvaluated: ['supply-chain stockout (needs product, supplier and signal data)'],
      decisions: drafts.map((d) => ({
        title: d.title,
        description: d.description,
        whyNow: d.whyNow,
        deadline: d.window?.latestSafeAt || null,
        exposure: d.materiality?.exposure ?? null,
        confidence: d.confidence?.band || null,
        recommendation: d.recommendation?.label || null,
        options: (d.options || []).map((o) => ({ label: o.label, valid: o.valid, invalidReason: o.invalidReason || null, cash60: o.futures?.cash60 || null })),
        unknowns: (d.unknowns || []).map((x) => x.label),
        contradictions: (d.contradictions || []).map((c) => c.detail || c.label),
        evidenceInvoices: (d.affectedEntities || []).filter((e) => e.type === 'invoice').map((e) => e.number || e.id),
      })),
      watched,
    };

    console.log(`STARLANE DRY RUN (read-only) — ${out.tenant.business || 'tenant'} — ${asOf}`);
    console.log(`Data: ${profile.counts.invoices} invoices, ${profile.counts.customers} customers, ${profile.period.historyDays} days (${profile.period.from} to ${profile.period.to}); freshness ${freshness.status}`);
    for (const [cur, t] of Object.entries(state.totalsByCurrency)) console.log(`Open ${inr(t.open, cur)} (${t.openCount}), overdue ${inr(t.overdue, cur)} (${t.overdueCount})`);
    for (const l of profile.limitations) console.log(`[${l.severity}] ${l.message}`);
    console.log(`\n${drafts.length} decision(s) Starlane would open:`);
    for (const d of out.decisions) {
      console.log(`\n• ${d.title}\n  ${d.description || ''}\n  Why now: ${(d.whyNow || []).join('; ')}\n  Decide by ${d.deadline} · confidence ${d.confidence} · suggests: ${d.recommendation}`);
      for (const o of d.options) console.log(`   - ${o.label}${o.valid ? '' : ` (invalid: ${o.invalidReason})`}: 60-day cash ${o.cash60 ? `${inr(o.cash60.p10)}–${inr(o.cash60.p90)}, expected ${inr(o.cash60.mean)}` : 'n/a'}`);
      if (d.unknowns.length) console.log(`  Unknown: ${d.unknowns.join('; ')}`);
      if (d.contradictions.length) console.log(`  Contradictions: ${d.contradictions.join('; ')}`);
      console.log(`  Evidence invoices: ${d.evidenceInvoices.join(', ')}`);
    }
    console.log(`\nWatching (${watched.length}):`);
    for (const w of watched) console.log(`  - ${w.customer || w.process}: ${w.reason}`);
    if (opt('json')) { fs.writeFileSync(opt('json'), JSON.stringify(out, null, 2)); console.log(`\nWrote ${opt('json')}`); }
  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error(`dry run failed: ${err.message}`); process.exit(1); });
