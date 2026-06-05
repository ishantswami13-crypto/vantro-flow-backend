#!/usr/bin/env node
'use strict';
/*
 * Phase 2C.19 — STAGING-ONLY Neon -> Cortex loader (reusable).
 * ─────────────────────────────────────────────────────────────────────────────
 * Extract real app data from Neon (READ-ONLY) -> resolve tenant via the explicit,
 * human-verified neon_org_map seed -> idempotent UPSERT into the *staging* Cortex
 * Supabase DB via the REST API (service role), every row tagged with one
 * sync_batch_id so the whole run is reversible.
 *
 * THIS IS A MANUAL OPERATOR SCRIPT. It is NOT wired into the app, NOT a migration,
 * and assumes NO deploy. No feature flag enables it; it only runs when invoked by
 * hand with explicit modes/confirmation below.
 *
 * SAFETY (enforced by construction):
 *   - Neon: opened with `BEGIN TRANSACTION READ ONLY`; SELECT only. NEVER writes to Neon.
 *   - Cortex: writes ONLY to the staging Supabase project via REST. The staging
 *     connection ref is checked against the production Supabase ref + `vantro.in`
 *     and ABORTS if it looks like production (mirrors apply-sql-file.js / staging-migrate.js).
 *   - Tenant resolution is an EXACT integer org_id -> seed lookup. No fuzzy matching.
 *     Unmapped orgs / orphan children are rejected + counted (fail-closed).
 *   - Persistent (non-reversible) load is FAIL-CLOSED: requires BOTH
 *     `--mode=persistent`, env `ALLOW_PERSISTENT_STAGING_LOAD=true`, and `--confirm=PERSIST`.
 *   - Prints COUNTS / BOOLEANS only. NEVER prints PII (names/phones/emails/amounts/
 *     invoice numbers) or any secret (keys, connection strings, refs, tokens).
 *
 * MODES:
 *   dry-run     Read Neon read-only, resolve+normalize in memory, print counts. NO Cortex writes.
 *   proof       (DEFAULT) Reversible proof: open batch -> load -> partial-unique enforcement
 *               probe (dup insert must 409) -> idempotency re-run (0 net new) -> tenant
 *               isolation -> close batch -> ROLLBACK by batch -> verify staging clean.
 *   persistent  Open batch -> idempotent load -> close batch. Leaves data in staging.
 *               FAIL-CLOSED (see above). Still idempotent (safe to re-run).
 *   rollback    Delete one batch's rows + ledger from staging Cortex. Needs --batch=<uuid>.
 *
 * USAGE:
 *   node scripts/phase-2c-19-neon-cortex-load.js --mode=dry-run
 *   node scripts/phase-2c-19-neon-cortex-load.js --mode=proof
 *   ALLOW_PERSISTENT_STAGING_LOAD=true node scripts/phase-2c-19-neon-cortex-load.js --mode=persistent --confirm=PERSIST
 *   node scripts/phase-2c-19-neon-cortex-load.js --mode=rollback --batch=<sync_batch_id>
 *
 * ENV (gitignored — referenced by NAME only, never printed):
 *   NEON_READONLY_URL           (.env)          least-privilege read-only Neon
 *   STAGING_DATABASE_URL        (.env.staging)  used only to derive the staging project ref + prod-block check
 *   SUPABASE_SERVICE_ROLE_KEY   (.env.staging)  staging REST auth (or SUPABASE_KEY)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');

// ── env loading (process.env wins; then the named gitignored file) ───────────
function fileVar(file, key) {
  const fp = path.join(ROOT, file);
  if (!fs.existsSync(fp)) return null;
  for (const line of fs.readFileSync(fp, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] === key) { let v = m[2]; if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return v; }
  }
  return null;
}
const envOf = (key, file) => process.env[key] || fileVar(file, key);

const NEON_URL = envOf('NEON_READONLY_URL', '.env');
const DB_URL = envOf('STAGING_DATABASE_URL', '.env.staging');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || fileVar('.env.staging', 'SUPABASE_SERVICE_ROLE_KEY') || fileVar('.env.staging', 'SUPABASE_KEY');

// ── CLI args ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argOf = (name, def) => { const a = argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split('=').slice(1).join('=') : def; };
const MODE = (argOf('mode', argv.find((x) => !x.startsWith('--')) || 'proof')).toLowerCase();
const BATCH_ARG = argOf('batch', null);
const CONFIRM = argOf('confirm', null);

// ── safety constants ─────────────────────────────────────────────────────────
const PROD_SUPABASE_ID = 'alepdpyqesevldobjxbo'; // production Supabase project ref — BLOCK
const scrub = (s) => String(s == null ? '' : s)
  .replace(/postgres(ql)?:\/\/[^\s'"]+/gi, 'postgres://[REDACTED]')
  .replace(/:\/\/[^@\s]+@/g, '://[REDACTED]@')
  .replace(/[a-z0-9]{20}\.supabase\.co/gi, '[redacted-host]')
  .replace(/eyJ[A-Za-z0-9_\-.]+/g, '[redacted-jwt]');

const out = { mode: MODE, batch_id: null, prod_blocked_ok: true, owner_a_exists: null,
  resolved: null, pre_counts: null, load: null, after_load: null, index_enforcing: null,
  index_probe_status: null, idempotent: null, isolation: null, batch_closed: null,
  rollback: null, final_clean: null, persisted: false, error: null, rolled_back: false };

function done() { console.log('RESULT_JSON:' + JSON.stringify(out, null, 1)); }
function fail(msg) { out.error = scrub(msg); done(); process.exit(1); }

// ── seed (explicit, human-verified, exact-match) ─────────────────────────────
const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'phase-2c-19-neon-org-map.staging.json'), 'utf8'));
const ORG_TO_USER = new Map((seed.entries || []).filter((e) => e.active === true).map((e) => [Number(e.neon_org_id), e.cortex_user_id]));

// ── preflight guards ─────────────────────────────────────────────────────────
if (!['dry-run', 'proof', 'persistent', 'rollback'].includes(MODE)) fail(`unknown --mode=${MODE}`);
if (MODE !== 'dry-run') {
  if (!DB_URL || !KEY) fail('staging STAGING_DATABASE_URL / service key not set');
  if (DB_URL.includes(PROD_SUPABASE_ID) || /vantro\.in/i.test(DB_URL)) { out.prod_blocked_ok = false; fail('BLOCKED: staging connection references the PRODUCTION Supabase ref'); }
}
if (MODE !== 'rollback' && !NEON_URL) fail('NEON_READONLY_URL not set');
if (MODE === 'rollback' && !BATCH_ARG) fail('--mode=rollback requires --batch=<sync_batch_id>');
if (MODE === 'persistent') {
  const ok = process.env.ALLOW_PERSISTENT_STAGING_LOAD === 'true' && CONFIRM === 'PERSIST';
  if (!ok) fail('persistent load is FAIL-CLOSED: set env ALLOW_PERSISTENT_STAGING_LOAD=true AND pass --confirm=PERSIST');
}

let HOST = null;
if (MODE !== 'dry-run') {
  const m = DB_URL.match(/db\.([a-z0-9]{20})\.supabase\.co/i) || DB_URL.match(/@([a-z0-9]{20})\.supabase\.co/i) || DB_URL.match(/postgres\.([a-z0-9]{20})/i);
  if (!m) fail('cannot derive staging project ref from STAGING_DATABASE_URL');
  HOST = `${m[1]}.supabase.co`;
}
const OWNER_BY_ORG = ORG_TO_USER; // for clarity

// ── REST helpers (staging Cortex only) ───────────────────────────────────────
function rest(method, p, body, extra) {
  return new Promise((resolve) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = Object.assign({ apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: 'application/json' }, extra || {});
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const r = https.request({ host: HOST, path: '/rest/v1' + p, method, headers, timeout: 20000 }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, headers: res.headers, body: b, json: j }); });
    });
    r.on('error', (e) => resolve({ status: 0, body: '', err: e.code }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: '', err: 'TIMEOUT' }); });
    if (data) r.write(data); r.end();
  });
}
const gp = (p) => rest('GET', p);
const post = (p, body) => rest('POST', p, body, { Prefer: 'return=representation' });
const patch = (p, body) => rest('PATCH', p, body, { Prefer: 'return=representation' });
const del = (p) => rest('DELETE', p, null, { Prefer: 'return=representation' });
async function countF(table, filter) { // HEAD: count only, never fetches a row body (no PII)
  const r = await rest('HEAD', `/${table}${filter ? '?' + filter : ''}`, null, { Prefer: 'count=exact', Range: '0-0', 'Range-Unit': 'items' });
  const cr = (r.headers && r.headers['content-range']) || ''; const m = cr.match(/\/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : ('ERR' + (r.status || r.err));
}
const enc = encodeURIComponent;
const toDateStr = (d) => d == null ? null : (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const NEON = 'sync_source=eq.neon';

// ── field mapping (conservative: core fields + provenance; enums/derived default) ──
const FIRST_USER = ORG_TO_USER.get(1); // the seeded staging-test owner (OWNER_A)
const userOf = (orgId) => ORG_TO_USER.get(Number(orgId)) || null;
const buildCustomer = (c, u, b) => ({ user_id: u, name: c.name, phone: c.phone ?? null, email: c.email ?? null, source_type: 'customer', source_id: String(c.id), sync_source: 'neon', sync_batch_id: b });
const buildInvoice = (i, u, b, custUuid) => ({ user_id: u, customer_id: custUuid, invoice_amount: i.amount, amount_paid: i.amount_paid, invoice_number: i.invoice_number ?? null, due_date: toDateStr(i.due_date), source_type: 'invoice', source_id: String(i.id), sync_source: 'neon', sync_batch_id: b });
const buildFollowup = (f, u, b, custUuid, invUuid) => ({ user_id: u, customer_id: custUuid, receivable_id: invUuid, source_type: 'followup', source_id: String(f.id), sync_source: 'neon', sync_batch_id: b });

async function upsert(table, sourceType, sourceId, userId, fields) {
  const found = await gp(`/${table}?user_id=eq.${userId}&sync_source=eq.neon&source_type=eq.${sourceType}&source_id=eq.${enc(sourceId)}&select=id`);
  if (found.status === 200 && Array.isArray(found.json) && found.json.length > 0) {
    const id = found.json[0].id;
    const u = await patch(`/${table}?id=eq.${id}`, fields);
    if (u.status >= 200 && u.status < 300) return { id, action: 'updated' };
    throw new Error(`PATCH ${table} ${u.status} ${scrub(u.body)}`);
  }
  const ins = await post(`/${table}`, fields);
  if (ins.status >= 200 && ins.status < 300 && Array.isArray(ins.json) && ins.json.length > 0) return { id: ins.json[0].id, action: 'inserted' };
  throw new Error(`POST ${table} ${ins.status} ${scrub(ins.body)}`);
}

// ── Neon read-only extract + tenant resolution ───────────────────────────────
async function extractNeon() {
  const client = new Client({ connectionString: NEON_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 15000, query_timeout: 20000, connectionTimeoutMillis: 15000 });
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION READ ONLY');
    const customers = (await client.query('select id, organization_id, name, phone, email, status, created_at from public.customers order by id')).rows;
    const invoices = (await client.query('select id, organization_id, customer_id, invoice_number, amount, amount_paid, status, due_date, created_at, updated_at from public.invoices order by id')).rows;
    const followups = (await client.query('select id, organization_id, customer_id, invoice_id, activity_type, performed_at, created_at from public.follow_ups order by id')).rows;
    await client.query('ROLLBACK');
    return { customers, invoices, followups };
  } finally { try { await client.end(); } catch (e) {} }
}

function resolveAndValidate(neon) {
  const custIds = new Set(neon.customers.map((c) => Number(c.id)));
  const stats = { customers: { extracted: 0, resolved: 0, rejected_org: 0 }, invoices: { extracted: 0, resolved: 0, rejected_org: 0, orphan: 0 }, followups: { extracted: 0, resolved: 0, rejected_org: 0, orphan: 0 } };
  const work = { customers: [], invoices: [], followups: [] };
  for (const c of neon.customers) { stats.customers.extracted++; const u = userOf(c.organization_id); if (!u) { stats.customers.rejected_org++; continue; } stats.customers.resolved++; work.customers.push({ row: c, user: u }); }
  for (const i of neon.invoices) { stats.invoices.extracted++; const u = userOf(i.organization_id); if (!u) { stats.invoices.rejected_org++; continue; } if (!custIds.has(Number(i.customer_id))) { stats.invoices.orphan++; continue; } stats.invoices.resolved++; work.invoices.push({ row: i, user: u }); }
  for (const f of neon.followups) { stats.followups.extracted++; const u = userOf(f.organization_id); if (!u) { stats.followups.rejected_org++; continue; } if (!custIds.has(Number(f.customer_id))) { stats.followups.orphan++; continue; } stats.followups.resolved++; work.followups.push({ row: f, user: u }); }
  return { stats, work };
}

async function loadPass(work, batch) {
  const custMap = new Map(), invMap = new Map();
  const r = { customers: { inserted: 0, updated: 0 }, invoices: { inserted: 0, updated: 0 }, followups: { inserted: 0, updated: 0 } };
  for (const { row: c, user: u } of work.customers) { const x = await upsert('customers', 'customer', String(c.id), u, buildCustomer(c, u, batch)); r.customers[x.action]++; custMap.set(Number(c.id), x.id); }
  for (const { row: i, user: u } of work.invoices) { const cu = custMap.get(Number(i.customer_id)); const x = await upsert('invoices', 'invoice', String(i.id), u, buildInvoice(i, u, batch, cu)); r.invoices[x.action]++; invMap.set(Number(i.id), x.id); }
  for (const { row: f, user: u } of work.followups) { const cu = custMap.get(Number(f.customer_id)); const iv = f.invoice_id == null ? null : (invMap.get(Number(f.invoice_id)) || null); const x = await upsert('followups', 'followup', String(f.id), u, buildFollowup(f, u, batch, cu, iv)); r.followups[x.action]++; }
  return { r, custMap, invMap, work };
}

const counts3 = async () => ({ customers: await countF('customers', NEON), invoices: await countF('invoices', NEON), followups: await countF('followups', NEON) });
const tagged3 = async (b) => ({ customers: await countF('customers', `sync_batch_id=eq.${b}`), invoices: await countF('invoices', `sync_batch_id=eq.${b}`), followups: await countF('followups', `sync_batch_id=eq.${b}`) });

async function rollbackBatch(batch) {
  const d = {};
  d.followups = (await del(`/followups?sync_batch_id=eq.${batch}`)).json?.length ?? 'ERR';
  d.invoices = (await del(`/invoices?sync_batch_id=eq.${batch}`)).json?.length ?? 'ERR';
  d.customers = (await del(`/customers?sync_batch_id=eq.${batch}`)).json?.length ?? 'ERR';
  d.sync_batches = (await del(`/sync_batches?sync_batch_id=eq.${batch}`)).json?.length ?? 'ERR';
  out.rolled_back = true;
  return d;
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    if (MODE === 'rollback') {
      const d = await rollbackBatch(BATCH_ARG);
      out.batch_id = BATCH_ARG; out.rollback = d; out.final_clean = { neon: await counts3() };
      return;
    }

    const neon = await extractNeon();
    const { stats, work } = resolveAndValidate(neon);
    out.resolved = stats;

    if (MODE === 'dry-run') { // NO Cortex writes
      out.load = { note: 'dry-run: no Cortex writes', normalized: { customers: work.customers.length, invoices: work.invoices.length, followups: work.followups.length } };
      return;
    }

    // proof | persistent
    if (!FIRST_USER) throw new Error('seed has no active org->user mapping');
    const ua = await gp(`/users?id=eq.${FIRST_USER}&select=id`);
    out.owner_a_exists = ua.status === 200 && Array.isArray(ua.json) && ua.json.length === 1;
    if (!out.owner_a_exists) throw new Error('seeded owner not present in staging users — aborting before any write');

    out.pre_counts = await counts3();
    if (MODE === 'proof' && (out.pre_counts.customers || out.pre_counts.invoices || out.pre_counts.followups)) {
      throw new Error('proof mode requires a clean staging (sync_source=neon rows already exist) — aborting');
    }

    const batch = crypto.randomUUID(); out.batch_id = batch;
    const ob = await post('/sync_batches', { sync_batch_id: batch, sync_source: 'neon', user_id: FIRST_USER, status: 'running', counts: {} });
    out.batch_opened = ob.status >= 200 && ob.status < 300;
    if (!out.batch_opened) throw new Error(`open batch ${ob.status} ${scrub(ob.body)}`);

    const pass1 = await loadPass(work, batch);
    out.load = { customers: pass1.r.customers, invoices: pass1.r.invoices, followups: pass1.r.followups, rejected_org: stats.customers.rejected_org + stats.invoices.rejected_org + stats.followups.rejected_org, orphan: stats.invoices.orphan + stats.followups.orphan };
    out.after_load = { neon: await counts3(), batch_tagged: await tagged3(batch) };

    if (MODE === 'proof') {
      const probe = await post('/customers', buildCustomer(work.customers[0].row, work.customers[0].user, batch));
      out.index_probe_status = probe.status; out.index_enforcing = probe.status === 409;

      const pass2 = await loadPass(work, batch);
      const after2 = await counts3();
      out.idempotent = { pass2_inserts: { customers: pass2.r.customers.inserted, invoices: pass2.r.invoices.inserted, followups: pass2.r.followups.inserted }, net_new_zero: pass2.r.customers.inserted === 0 && pass2.r.invoices.inserted === 0 && pass2.r.followups.inserted === 0, counts_stable: JSON.stringify(after2) === JSON.stringify(out.after_load.neon) };

      const foreign = { customers: await countF('customers', `${NEON}&user_id=neq.${FIRST_USER}`), invoices: await countF('invoices', `${NEON}&user_id=neq.${FIRST_USER}`), followups: await countF('followups', `${NEON}&user_id=neq.${FIRST_USER}`) };
      out.isolation = { foreign_rows: foreign, all_zero_foreign: foreign.customers === 0 && foreign.invoices === 0 && foreign.followups === 0 };

      const cb = await patch(`/sync_batches?sync_batch_id=eq.${batch}`, { status: 'succeeded', finished_at: new Date().toISOString(), counts: out.after_load.batch_tagged });
      out.batch_closed = cb.status >= 200 && cb.status < 300;

      out.rollback = await rollbackBatch(batch);
      out.final_clean = { neon: await counts3() };
    } else { // persistent
      const cb = await patch(`/sync_batches?sync_batch_id=eq.${batch}`, { status: 'succeeded', finished_at: new Date().toISOString(), counts: out.after_load.batch_tagged });
      out.batch_closed = cb.status >= 200 && cb.status < 300;
      out.persisted = true; // data intentionally left in staging
    }
  } catch (e) {
    out.error = scrub(e.message);
    if (out.batch_id && MODE === 'proof' && !out.rolled_back) { try { out.rollback = await rollbackBatch(out.batch_id); out.final_clean = { neon: await counts3() }; } catch (e2) { out.rollback_error = scrub(e2.message); } }
    process.exitCode = 1;
  } finally { done(); }
})();
