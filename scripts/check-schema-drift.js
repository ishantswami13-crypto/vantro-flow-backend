'use strict';
// scripts/check-schema-drift.js
//
// Fails when the code queries a table that nothing in this repo provisions.
//
// This exists because the failure mode is silent. Supabase returns an ordinary
// error object for an unknown relation, and most handlers here either discard it
// or map it to a generic 500, so a table that was never created looks like an
// intermittent backend fault rather than a missing migration. `bills` was queried
// by ten call sites across eight endpoints and created nowhere; the only visible
// symptom was that GST billing "didn't work".
//
// A table being creatable somewhere in the repo is not the same as it existing,
// so this separates three ways that can be true:
//
//   applied     — created by a .sql file scripts/setup-fresh-database.js runs.
//                 The list is read from that script, not duplicated here, so the
//                 two cannot drift apart.
//   boot-only   — created by DDL inside server.js. All of it runs through pgPool,
//                 which is only constructed when DATABASE_URL is set, and that is
//                 a different variable from the SUPABASE_* ones the app otherwise
//                 needs. Without it these tables do not exist at all.
//   unapplied   — defined in a .sql file that setup:database does not run (the
//                 rollout/rollback/index files). Present in git, absent from the
//                 database until someone runs it by hand.
//
// Only the first counts as provisioned. Treating all three alike is what let this
// go unnoticed.
//
// Comments are stripped before any DDL is extracted. A prose comment in server.js
// that merely mentions CREATE TABLE was otherwise enough to mark a table as
// created — the same false-negative a previous check here shipped with.
//
// Table-level only, on purpose. A column-level version produced false positives:
// a regex window around .from('users') picked up keys from an adjacent insert on
// a different table and reported four columns as missing that no query
// references. Tables can be extracted exactly, so that is what this asserts.
//
// Usage:
//   node scripts/check-schema-drift.js
//   npm run security:schema-drift

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Tables known to be missing and tracked separately. Each records what it breaks
// so the cost of leaving it stays visible on every run.
const KNOWN_MISSING = [
  { table: 'orders',              breaks: 'order endpoints 500' },
  { table: 'workers',             breaks: 'staff endpoints 500' },
  { table: 'expenses',            breaks: 'expense tracking 500' },
  { table: 'business_vocabulary', breaks: 'onboarding upsert throws after the users update has committed' },
  { table: 'brain_rules',         breaks: 'rules engine reads return empty' },
  { table: 'attendance',          breaks: 'attendance endpoints 500' },
  { table: 'billing_history',     breaks: 'billing page 500 — may be billing_records renamed on one side' },
  { table: 'dunning_logs',        breaks: 'dunning log write discarded' },
  { table: 'error_events',        breaks: 'defined in supabase-error-events-rollout.sql, which setup:database does not run — error tracking writes are discarded until it is applied by hand' },
];

// ── helpers ─────────────────────────────────────────────────────────────────
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // /* block */
    .replace(/^\s*\/\/.*$/gm, ' ')       // // line
    .replace(/^\s*--.*$/gm, ' ');        // -- sql line
}

function tablesIn(src) {
  const sql = stripComments(src);
  const out = new Set();
  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) out.add(m[1].toLowerCase());
  // A view satisfies a read the same way a table does.
  for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) out.add(m[1].toLowerCase());
  return out;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const allFiles = walk(ROOT);

// ── applied: the SQL setup:database actually runs ───────────────────────────
const setupRel = path.join('scripts', 'setup-fresh-database.js');
const setupSrc = fs.readFileSync(path.join(ROOT, setupRel), 'utf8');
const listMatch = setupSrc.match(/\[\s*((?:\s*'[^']+\.sql',?\s*)+)\]/);
if (!listMatch) {
  console.error(`[SCHEMA] Could not read the applied-file list from ${setupRel}.`);
  console.error('         The array literal this check looks for has moved — update the check rather than deleting it.');
  process.exit(1);
}
const appliedFiles = [...listMatch[1].matchAll(/'([^']+\.sql)'/g)].map(m => m[1]);

const applied = new Set();
for (const rel of appliedFiles) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) {
    console.error(`[SCHEMA] ${setupRel} applies ${rel}, which does not exist.`);
    process.exit(1);
  }
  for (const t of tablesIn(fs.readFileSync(p, 'utf8'))) applied.add(t);
}

// ── boot-only: DDL inside server.js, gated on DATABASE_URL ──────────────────
const bootOnly = new Set();
for (const t of tablesIn(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'))) {
  if (!applied.has(t)) bootOnly.add(t);
}

// ── unapplied: .sql files setup:database never runs ─────────────────────────
const appliedSet = new Set(appliedFiles.map(f => path.join(ROOT, f)));
const unapplied = new Map(); // table -> defining file
for (const f of allFiles.filter(f => f.endsWith('.sql'))) {
  if (appliedSet.has(f)) continue;
  for (const t of tablesIn(fs.readFileSync(f, 'utf8'))) {
    if (!applied.has(t) && !bootOnly.has(t) && !unapplied.has(t)) unapplied.set(t, path.relative(ROOT, f));
  }
}

// ── what the code queries ───────────────────────────────────────────────────
const referenced = new Map(); // table -> Set("relative/path:line")
for (const file of allFiles.filter(f => f.endsWith('.js'))) {
  if (file === __filename) continue;
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*|--)/.test(line)) return;
    for (const m of line.matchAll(/\.from\(\s*['"`]([a-z_][a-z0-9_]*)['"`]\s*\)/g)) {
      const t = m[1].toLowerCase();
      if (!referenced.has(t)) referenced.set(t, new Set());
      referenced.get(t).add(`${path.relative(ROOT, file)}:${i + 1}`);
    }
  });
}

// ── diff ────────────────────────────────────────────────────────────────────
const knownMissing = new Map(KNOWN_MISSING.map(k => [k.table, k]));
const missing = [];
const acknowledged = [];
const conditional = [];
const unappliedHits = [];

for (const [table, siteSet] of [...referenced].sort()) {
  if (applied.has(table)) continue;
  const sites = [...siteSet];
  if (bootOnly.has(table)) conditional.push({ table, sites });
  else if (knownMissing.has(table)) (unapplied.has(table) ? unappliedHits : acknowledged).push({ table, sites });
  else if (unapplied.has(table)) unappliedHits.push({ table, sites });
  else missing.push({ table, sites });
}

console.log('[SCHEMA] Checking every queried table against the SQL this repo actually applies...');
console.log(`  ${appliedFiles.length} SQL file(s) run by setup:database → ${applied.size} tables/views.`);
console.log(`  ${referenced.size} distinct tables queried by the code.`);

if (conditional.length) {
  const total = conditional.reduce((n, c) => n + c.sites.length, 0);
  console.log(`\n  ${conditional.length} table(s) created only by DDL inside server.js — ${total} call sites.`);
  console.log('  That DDL runs through pgPool, which does not exist without DATABASE_URL:');
  conditional.forEach(c => console.log(`    ${c.table.padEnd(22)} ${String(c.sites.length).padStart(2)} call site(s)`));
}

if (unappliedHits.length) {
  console.log(`\n  ${unappliedHits.length} table(s) defined in a .sql file setup:database does not run:`);
  unappliedHits.forEach(u => console.log(`    ${u.table.padEnd(22)} ${String(u.sites.length).padStart(2)} call site(s) — ${unapplied.get(u.table)}`));
}

if (acknowledged.length) {
  console.log(`\n  ${acknowledged.length} table(s) known missing and tracked — not fixed, not forgotten:`);
  acknowledged.forEach(a => console.log(`    ${a.table.padEnd(22)} ${String(a.sites.length).padStart(2)} call site(s) — ${knownMissing.get(a.table).breaks}`));
}

// An entry for a table that is now applied means the migration landed and the
// exception should go, otherwise this list rots the way the schema did.
const stale = KNOWN_MISSING.filter(k => applied.has(k.table));
if (stale.length) {
  console.log(`\n  ${stale.length} KNOWN_MISSING entry(ies) now applied — remove them from this file:`);
  stale.forEach(s => console.log(`    ${s.table}`));
}

if (missing.length === 0) {
  console.log('\n[SCHEMA] Schema Drift Check Passed: no new tables queried without being provisioned.');
  process.exit(0);
}

console.error(`\n[SCHEMA] Schema Drift Check FAILED — ${missing.length} table(s) queried but never provisioned:\n`);
for (const m of missing) {
  console.error(`  ${m.table} — ${m.sites.length} call site(s)`);
  m.sites.slice(0, 6).forEach(s => console.error(`    ${s}`));
  if (m.sites.length > 6) console.error(`    ... and ${m.sites.length - 6} more`);
  console.error('');
}
console.error('Add the table to supabase-schema.sql, or to KNOWN_MISSING in this file with the');
console.error('call sites it breaks if it is being tracked separately.\n');
process.exit(1);
