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
// ── Why this parses instead of grepping ────────────────────────────────────
// The first version of this check used regexes and could be defeated five ways,
// each of which let a genuinely missing table pass:
//   - a trailing `// CREATE TABLE foo` comment (stripping was anchored to line start)
//   - a dead string constant containing CREATE TABLE, never executed
//   - `.from(\n  'foo'\n)` split across lines by any reformat
//   - `.from(`foo_${ENV}`)` and `.from(TBL)` — non-literal arguments
// It also ate legitimate SQL when a string value happened to contain `/*`.
// So DDL is now taken only from string arguments to an actual `.query()` call,
// table references only from real `.from()` call nodes, and SQL comments are
// stripped by a scanner that understands quoting. Non-literal `.from()`
// arguments cannot be resolved statically and are reported rather than ignored.
//
// ── What counts as provisioned ─────────────────────────────────────────────
// A table being creatable somewhere in the repo is not the same as it existing:
//   applied   — created by a .sql file scripts/setup-fresh-database.js runs.
//               The list is read from that script so the two cannot drift.
//   boot-only — created by DDL inside server.js, which runs through pgPool and
//               therefore only when DATABASE_URL is set. Reported, not failed.
//   unapplied — defined in a .sql file setup:database never runs. This FAILS:
//               a file nobody runs provisions nothing, and treating it as
//               provisioning is what let error_events look fine.
//
// Table-level only, on purpose. A column-level version produced false positives
// that a regex window could not avoid, and columns are better checked against a
// live database than against source.
//
// Usage:
//   node scripts/check-schema-drift.js
//   npm run security:schema-drift

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let acorn;
try {
  acorn = require('acorn');
} catch {
  console.error('[SCHEMA] Cannot load the `acorn` parser (it ships with eslint).');
  console.error('         Run `npm ci` first. This check does not fall back to regex parsing:');
  console.error('         the regex version passed five different genuinely-missing tables.');
  process.exit(1);
}

// Tables known to be missing and tracked separately. Each records what it breaks
// so the cost of leaving it stays visible on every run. As of the schema change
// that added orders/workers/expenses/business_vocabulary/brain_rules/attendance/
// dunning_logs and renamed billing_records to billing_history, this list is
// empty — kept as an array (not deleted) because the next genuinely-missing
// table belongs here, not silently in the passing case.
const KNOWN_MISSING = [];

// ── SQL comment stripping that understands quoting ──────────────────────────
// A naive /\/\*[\s\S]*?\*\//g deletes everything between a `/*` that happens to
// sit inside a string literal and the next real block comment. That silently
// removed sixteen CREATE TABLEs from this repo's own schema in testing.
function stripSqlComments(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "'" || c === '"') {                       // string / quoted identifier
      const q = c;
      out += c; i++;
      while (i < n) {
        if (sql[i] === q && sql[i + 1] === q) { out += q + q; i += 2; continue; }
        if (sql[i] === q) { out += q; i++; break; }
        out += sql[i]; i++;
      }
      continue;
    }
    if (c === '$') {                                     // dollar quoting: $$ or $tag$
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        // Recurse: a dollar-quoted body is nearly always a DO block or function
        // body, i.e. code whose own -- comments are still comments. Copying it
        // verbatim let a comment inside a DO block register a table named
        // "carries", from the phrase "CREATE TABLE carries this constraint".
        out += stripSqlComments(sql.slice(i + tag.length, stop - tag.length));
        i = stop;
        continue;
      }
    }
    if (c === '-' && next === '-') {                     // -- to end of line
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (c === '/' && next === '*') {                     // /* ... */, nestable in Postgres
      let depth = 1; i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; continue; }
        if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; continue; }
        i++;
      }
      out += ' ';
      continue;
    }
    out += c; i++;
  }
  return out;
}

function tablesInSql(sql) {
  const clean = stripSqlComments(sql);
  const out = new Set();
  for (const m of clean.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) out.add(m[1].toLowerCase());
  // A view satisfies a read the same way a table does.
  for (const m of clean.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) out.add(m[1].toLowerCase());
  return out;
}

// ── JS AST helpers ──────────────────────────────────────────────────────────
function parse(src, file) {
  try {
    return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowHashBang: true });
  } catch (err) {
    console.error(`[SCHEMA] Could not parse ${file}: ${err.message}`);
    process.exit(1);
  }
}

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range') continue;
    const child = node[key];
    if (Array.isArray(child)) child.forEach(c => c && typeof c.type === 'string' && walk(c, visit));
    else if (child && typeof child.type === 'string') walk(child, visit);
  }
}

// A string we can resolve at parse time: a literal, or a template with no
// interpolation. Anything else is genuinely unknowable without running the code.
function staticString(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis.map(q => q.value.cooked).join('');
  return null;
}

function isMemberCall(node, name) {
  return node.type === 'CallExpression'
    && node.callee.type === 'MemberExpression'
    && !node.callee.computed
    && node.callee.property.type === 'Identifier'
    && node.callee.property.name === name;
}

function walkJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function readOrDie(p, why) {
  if (!fs.existsSync(p)) {
    console.error(`[SCHEMA] Required file missing: ${path.relative(ROOT, p)} (${why}).`);
    process.exit(1);
  }
  return fs.readFileSync(p, 'utf8');
}

// ── applied: the SQL setup:database actually runs ───────────────────────────
const setupRel = path.join('scripts', 'setup-fresh-database.js');
const setupSrc = readOrDie(path.join(ROOT, setupRel), 'defines the applied-file list');

// Anchored to the identifier: an unanchored first-match found an unrelated
// earlier array of .sql strings and validated the wrong list while reporting
// confidence, including telling the reader to delete a still-valid exception.
const setupAst = parse(setupSrc, setupRel);
let appliedFiles = null;
walk(setupAst, node => {
  if (appliedFiles) return;
  if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === 'SQL_FILES'
      && node.init && node.init.type === 'ArrayExpression') {
    const vals = node.init.elements.map(staticString);
    if (vals.every(v => typeof v === 'string')) appliedFiles = vals;
  }
});
if (!appliedFiles) {
  console.error(`[SCHEMA] Could not read the SQL_FILES array from ${setupRel}.`);
  console.error('         It must be a const array of string literals. Update this check rather than deleting it.');
  process.exit(1);
}

const applied = new Set();
for (const rel of appliedFiles) {
  const sql = readOrDie(path.join(ROOT, rel), `listed in ${setupRel}`);
  for (const t of tablesInSql(sql)) applied.add(t);
}

// ── boot-only: DDL passed to an actual .query() call in server.js ───────────
const serverRel = 'server.js';
const serverSrc = readOrDie(path.join(ROOT, serverRel), 'contains the boot migration');
const serverAst = parse(serverSrc, serverRel);
const bootOnly = new Set();
walk(serverAst, node => {
  if (!isMemberCall(node, 'query')) return;
  for (const arg of node.arguments) {
    const sql = staticString(arg);
    if (!sql) continue;
    for (const t of tablesInSql(sql)) if (!applied.has(t)) bootOnly.add(t);
  }
});

// ── unapplied: .sql files setup:database never runs ─────────────────────────
const appliedPaths = new Set(appliedFiles.map(f => path.resolve(ROOT, f)));
const unapplied = new Map(); // table -> defining file
(function collectSql(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { collectSql(full); continue; }
    if (!entry.name.endsWith('.sql') || appliedPaths.has(path.resolve(full))) continue;
    for (const t of tablesInSql(fs.readFileSync(full, 'utf8'))) {
      if (!applied.has(t) && !bootOnly.has(t) && !unapplied.has(t)) unapplied.set(t, path.relative(ROOT, full));
    }
  }
})(ROOT);

// ── what the code queries ───────────────────────────────────────────────────
const referenced = new Map();   // table -> Set("relative/path:line")
const unresolved = [];          // .from(<non-literal>) — cannot be checked statically
for (const file of walkJsFiles(ROOT)) {
  if (path.resolve(file) === path.resolve(__filename)) continue;
  const rel = path.relative(ROOT, file);
  const ast = parse(fs.readFileSync(file, 'utf8'), rel);
  walk(ast, node => {
    if (!isMemberCall(node, 'from')) return;
    // Array.from / Buffer.from are not table reads.
    const obj = node.callee.object;
    if (obj.type === 'Identifier' && (obj.name === 'Array' || obj.name === 'Buffer')) return;
    const arg = node.arguments[0];
    const name = staticString(arg);
    const where = `${rel}:${node.loc.start.line}`;
    if (name === null) {
      if (arg) unresolved.push(where);
      return;
    }
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) { unresolved.push(where); return; }
    const t = name.toLowerCase();
    if (!referenced.has(t)) referenced.set(t, new Set());
    referenced.get(t).add(where);
  });
}

// ── diff ────────────────────────────────────────────────────────────────────
const knownMissing = new Map(KNOWN_MISSING.map(k => [k.table, k]));
const missing = [];
const acknowledged = [];
const conditional = [];

for (const [table, siteSet] of [...referenced].sort()) {
  if (applied.has(table)) continue;
  const sites = [...siteSet];
  if (bootOnly.has(table)) conditional.push({ table, sites });
  else if (knownMissing.has(table)) acknowledged.push({ table, sites, from: unapplied.get(table) });
  else missing.push({ table, sites, from: unapplied.get(table) });
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

if (acknowledged.length) {
  console.log(`\n  ${acknowledged.length} table(s) known missing and tracked — not fixed, not forgotten:`);
  acknowledged.forEach(a => console.log(`    ${a.table.padEnd(22)} ${String(a.sites.length).padStart(2)} call site(s) — ${knownMissing.get(a.table).breaks}`));
}

if (unresolved.length) {
  console.log(`\n  ${unresolved.length} .from() call(s) with a non-literal argument — not checkable statically:`);
  unresolved.slice(0, 10).forEach(u => console.log(`    ${u}`));
  if (unresolved.length > 10) console.log(`    ... and ${unresolved.length - 10} more`);
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

console.error(`\n[SCHEMA] Schema Drift Check FAILED — ${missing.length} table(s) queried but not provisioned:\n`);
for (const m of missing) {
  console.error(`  ${m.table} — ${m.sites.length} call site(s)`);
  if (m.from) console.error(`    defined in ${m.from}, which setup:database does not run`);
  m.sites.slice(0, 6).forEach(s => console.error(`    ${s}`));
  if (m.sites.length > 6) console.error(`    ... and ${m.sites.length - 6} more`);
  console.error('');
}
console.error('Add the table to supabase-schema.sql (or to the SQL_FILES list if it has its own');
console.error('file), or to KNOWN_MISSING in this file with what it breaks.\n');
process.exit(1);
