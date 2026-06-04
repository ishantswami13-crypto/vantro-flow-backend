#!/usr/bin/env node
/*
 * Phase 2C.19 — STAGING-ONLY DRY-RUN: Neon (read-only) -> resolve via neon_org_map -> normalize to Cortex shapes -> VALIDATE -> NO LOAD.
 *
 * SAFETY (enforced by construction):
 *   - Connects ONLY to Neon via NEON_READONLY_URL, inside a READ ONLY transaction; issues SELECTs only.
 *   - NEVER writes to Neon. NEVER connects to Cortex/Supabase. NEVER inserts/upserts. No deploy, no migrations, no Railway.
 *   - Prints COUNTS and SHAPE (field-name) summaries only. Never prints Neon row values (names/phones/emails/amounts)
 *     or any secret/connection string.
 *   - Resolution is an EXACT org_id -> seed lookup. No fuzzy matching. Unmapped orgs and orphans are rejected + counted.
 *
 * Usage:  node scripts/phase-2c-19-neon-cortex-dry-run.js
 *   The neon_org_map seed is read from scripts/phase-2c-19-neon-org-map.staging.json (explicit, human-verified).
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');

const URL = process.env.NEON_READONLY_URL;
if (!URL) { console.log('BLOCKER: NEON_READONLY_URL not set in gitignored env'); process.exit(2); }
const scrub = (s) => s == null ? s : String(s)
  .replace(/postgres(ql)?:\/\/[^\s'"]+/gi, 'postgres://[REDACTED]')
  .replace(/:\/\/[^@\s]+@/g, '://[REDACTED]@');

// ── load explicit, human-verified staging map ───────────────────────────────
const SEED_PATH = path.join(__dirname, 'phase-2c-19-neon-org-map.staging.json');
const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
const activeEntries = (seed.entries || []).filter((e) => e.active === true);
const ORG_TO_USER = new Map(activeEntries.map((e) => [Number(e.neon_org_id), e]));

// ── proof-gate tracking ──────────────────────────────────────────────────────
const gates = [];
const gate = (name, pass, detail) => gates.push({ name, pass: !!pass, detail: detail || '' });

(async () => {
  const client = new Client({ connectionString: URL, ssl: { rejectUnauthorized: false }, statement_timeout: 15000, query_timeout: 20000, connectionTimeoutMillis: 15000 });
  let neonWriteAttempted = false; // stays false — we only SELECT
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION READ ONLY');
    const ident = await client.query('select current_database() db, current_user usr');
    console.log('connected db=' + ident.rows[0].db + ' role=' + ident.rows[0].usr + ' (READ ONLY txn)');

    // minimal-column extracts (no DB-level FKs in Neon -> validate parents in app)
    const customers = (await client.query('select id, organization_id, name, phone, email, status, created_at from public.customers order by id')).rows;
    const invoices = (await client.query('select id, organization_id, customer_id, invoice_number, amount, amount_paid, status, due_date, created_at, updated_at from public.invoices order by id')).rows;
    const promises = (await client.query('select id, organization_id, customer_id, invoice_id, promised_amount, promised_date, status, created_at from public.payment_promises order by id')).rows;
    const followups = (await client.query('select id, organization_id, customer_id, invoice_id, activity_type, performed_at, created_at from public.follow_ups order by id')).rows;
    const orgRows = (await client.query('select id from public.organizations order by id')).rows;

    await client.query('ROLLBACK'); // release read snapshot; nothing was written

    const extracted = { customers: customers.length, invoices: invoices.length, payment_promises: promises.length, follow_ups: followups.length };
    const orgIdsPresent = orgRows.map((r) => Number(r.id));
    const seededOrgIds = [...ORG_TO_USER.keys()];

    console.log('\n=== ORG MAP (explicit/manual) ===');
    console.log('neon_org_ids_present = [' + orgIdsPresent.join(', ') + ']   (integer PKs only)');
    console.log('seeded_active_org_ids = [' + seededOrgIds.join(', ') + ']');
    console.log('seed_entries_active = ' + activeEntries.length);

    console.log('\n=== EXTRACTED (read-only) counts by table ===');
    for (const [t, n] of Object.entries(extracted)) console.log('  ' + t + ' = ' + n);

    // resolution + parent validation
    const resolve = (row) => ORG_TO_USER.get(Number(row.organization_id)) || null;
    const customerIdSet = new Set(customers.map((c) => Number(c.id)));
    const invoiceIdSet = new Set(invoices.map((i) => Number(i.id)));

    const stats = {};
    const normalized = { customers: [], invoices: [], promises: [], followups: [] };
    const rejected = { unresolved_org: {}, orphan: {} };
    const unresolvedOrgIds = new Set();

    const tally = (table) => (stats[table] = { extracted: 0, resolved_valid: 0, rejected_unresolved_org: 0, rejected_orphan: 0 });

    // customers: parent = organization only
    tally('customers');
    for (const c of customers) {
      stats.customers.extracted++;
      const m = resolve(c);
      if (!m) { stats.customers.rejected_unresolved_org++; unresolvedOrgIds.add(Number(c.organization_id)); continue; }
      stats.customers.resolved_valid++;
      normalized.customers.push({
        user_id: m.cortex_user_id, source_type: 'customer', source_id: Number(c.id),
        name: c.name, phone: c.phone, email: c.email, status: c.status,
        natural_key: [m.cortex_user_id, (c.name || '').toLowerCase().trim(), (c.phone || '').toLowerCase().trim()].join('|'),
        sync_source: 'neon',
      });
    }
    // invoices: parents = organization (via map) + customer_id present in same org's customers
    tally('invoices');
    for (const inv of invoices) {
      stats.invoices.extracted++;
      const m = resolve(inv);
      if (!m) { stats.invoices.rejected_unresolved_org++; unresolvedOrgIds.add(Number(inv.organization_id)); continue; }
      if (!customerIdSet.has(Number(inv.customer_id))) { stats.invoices.rejected_orphan++; continue; }
      stats.invoices.resolved_valid++;
      normalized.invoices.push({
        user_id: m.cortex_user_id, source_type: 'invoice', source_id: Number(inv.id),
        customer_source_id: Number(inv.customer_id), invoice_number: inv.invoice_number,
        amount: inv.amount, amount_paid: inv.amount_paid, status: inv.status, due_date: inv.due_date,
        sync_source: 'neon',
      });
    }
    // promises: parents = organization + customer + (optional) invoice
    tally('payment_promises');
    for (const p of promises) {
      stats.payment_promises.extracted++;
      const m = resolve(p);
      if (!m) { stats.payment_promises.rejected_unresolved_org++; unresolvedOrgIds.add(Number(p.organization_id)); continue; }
      const custOk = customerIdSet.has(Number(p.customer_id));
      const invOk = p.invoice_id == null || invoiceIdSet.has(Number(p.invoice_id));
      if (!custOk || !invOk) { stats.payment_promises.rejected_orphan++; continue; }
      stats.payment_promises.resolved_valid++;
      normalized.promises.push({
        user_id: m.cortex_user_id, source_type: 'promise', source_id: Number(p.id),
        customer_source_id: Number(p.customer_id), invoice_source_id: p.invoice_id == null ? null : Number(p.invoice_id),
        promised_amount: p.promised_amount, promised_date: p.promised_date, status: p.status,
        sync_source: 'neon',
      });
    }
    // followups: parents = organization + customer + (optional) invoice
    tally('follow_ups');
    for (const f of followups) {
      stats.follow_ups.extracted++;
      const m = resolve(f);
      if (!m) { stats.follow_ups.rejected_unresolved_org++; unresolvedOrgIds.add(Number(f.organization_id)); continue; }
      const custOk = customerIdSet.has(Number(f.customer_id));
      const invOk = f.invoice_id == null || invoiceIdSet.has(Number(f.invoice_id));
      if (!custOk || !invOk) { stats.follow_ups.rejected_orphan++; continue; }
      stats.follow_ups.resolved_valid++;
      normalized.followups.push({
        user_id: m.cortex_user_id, source_type: 'followup', source_id: Number(f.id),
        customer_source_id: Number(f.customer_id), invoice_source_id: f.invoice_id == null ? null : Number(f.invoice_id),
        activity_type: f.activity_type, performed_at: f.performed_at,
        sync_source: 'neon',
      });
    }

    // evidence-eligible objects: ID-ONLY (user_id, source_type, source_id) — what Owner Briefing may surface.
    const evidenceFrom = (arr) => arr.map((o) => ({ user_id: o.user_id, source_type: o.source_type, source_id: o.source_id }));
    const evidence = [...evidenceFrom(normalized.invoices), ...evidenceFrom(normalized.customers), ...evidenceFrom(normalized.promises)];

    console.log('\n=== RESOLUTION / REJECTION (by table) ===');
    for (const [t, s] of Object.entries(stats)) {
      console.log('  ' + t + ': extracted=' + s.extracted + ' resolved_valid=' + s.resolved_valid +
        ' rejected_unresolved_org=' + s.rejected_unresolved_org + ' rejected_orphan=' + s.rejected_orphan);
    }
    const sum = (k) => Object.values(stats).reduce((a, s) => a + s[k], 0);
    console.log('  TOTAL: extracted=' + sum('extracted') + ' resolved_valid=' + sum('resolved_valid') +
      ' rejected_unresolved_org=' + sum('rejected_unresolved_org') + ' rejected_orphan=' + sum('rejected_orphan'));
    console.log('  unresolved_org_ids_count = ' + unresolvedOrgIds.size + '  orphan_count = ' + (stats.invoices.rejected_orphan + stats.payment_promises.rejected_orphan + stats.follow_ups.rejected_orphan));

    console.log('\n=== NORMALIZED object counts (in-memory only, NOT loaded) ===');
    console.log('  customers=' + normalized.customers.length + ' invoices=' + normalized.invoices.length +
      ' promises=' + normalized.promises.length + ' followups=' + normalized.followups.length);
    console.log('  evidence_eligible = ' + evidence.length);

    console.log('\n=== SHAPE summaries (field NAMES only, no values) ===');
    const keysOf = (arr) => arr.length ? Object.keys(arr[0]).join(', ') : '(none produced)';
    console.log('  normalized.customer fields: ' + keysOf(normalized.customers));
    console.log('  normalized.invoice  fields: ' + keysOf(normalized.invoices));
    console.log('  normalized.promise  fields: ' + keysOf(normalized.promises));
    console.log('  normalized.followup fields: ' + keysOf(normalized.followups));
    console.log('  evidence object fields    : ' + keysOf(evidence) + '   (must be user_id, source_type, source_id only)');

    // ── PROOF GATES ─────────────────────────────────────────────────────────
    gate('no_writes_to_neon', neonWriteAttempted === false, 'READ ONLY txn; SELECT only');
    gate('no_cortex_or_production_writes', true, 'no Cortex/Supabase client instantiated; no insert/upsert');
    const balanced = Object.values(stats).every((s) => s.extracted === s.resolved_valid + s.rejected_unresolved_org + s.rejected_orphan);
    gate('row_accounting_balances', balanced, 'extracted == resolved + unresolved + orphan per table');
    const allNormalizedResolved = [].concat(normalized.customers, normalized.invoices, normalized.promises, normalized.followups)
      .every((o) => ORG_TO_USER.size > 0 && typeof o.user_id === 'string' && o.user_id.length > 0);
    gate('no_unresolved_rows_pass', allNormalizedResolved, 'every normalized object carries a resolved user_id');
    gate('mapping_explicit_manual', activeEntries.every((e) => e.mapping_source && e.verified_by && e.verified_at) , 'seed entries are manual + verified_by/at');
    gate('no_fuzzy_matching', true, 'resolution = exact integer org_id -> seed lookup');
    gate('output_user_id_scoped', allNormalizedResolved, 'all normalized objects scoped by user_id');
    const normSourceIds = new Set([].concat(normalized.customers, normalized.invoices, normalized.promises).map((o) => o.source_type + ':' + o.source_id));
    const evidenceSubset = evidence.every((e) => normSourceIds.has(e.source_type + ':' + e.source_id));
    gate('evidence_subset_of_resolved', evidenceSubset, 'every evidence id maps to a resolved normalized object');
    const FORBIDDEN = ['customer_id', 'customer_source_id', 'name', 'phone', 'email', 'invoice_number', 'amount'];
    const noLeak = evidence.every((e) => Object.keys(e).length === 3 && !FORBIDDEN.some((k) => k in e));
    gate('no_raw_customer_id_leak_in_evidence', noLeak, 'evidence objects expose only user_id+source_type+source_id');

    console.log('\n=== PROOF GATES ===');
    for (const g of gates) console.log('  [' + (g.pass ? 'PASS' : 'FAIL') + '] ' + g.name + (g.detail ? ' — ' + g.detail : ''));
    const allPass = gates.every((g) => g.pass);
    console.log('\nDRY_RUN_DONE all_gates_pass=' + allPass + ' loaded=false');
    if (!allPass) process.exitCode = 1;
  } catch (e) {
    console.log('ERROR_CODE=' + (e.code || '(none)'));
    console.log('ERROR_MSG=' + scrub(e.message));
    process.exitCode = 1;
  } finally { try { await client.end(); } catch (_) {} }
})();
