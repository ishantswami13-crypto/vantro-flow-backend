'use strict';
// scripts/db-preflight.js — READ-ONLY production baseline preflight.
//
// Answers one question: is it safe to start using scripts/migrate.js's ledger
// on this database, and exactly which files should be recorded as already
// applied?
//
// It never writes: the whole inspection runs inside
// `BEGIN TRANSACTION READ ONLY` and ends with ROLLBACK. It prints no
// connection string or credential.
//
// For every migration file (in runner order) it derives a *signature* from
// the SQL — the tables it creates, the columns it adds, the indexes it
// creates — and checks each object against the live catalog:
//   present  every object the file creates exists
//   absent   none of them exist
//   partial  some exist, some don't  -> FAIL (a human must look)
//   n/a      the file creates nothing checkable (seed data, constraints only)
//
// The plan:
//   RECORD    the leading run of present/n-a files -> recorded without running
//   APPLY     everything after -> run by migrate.js
// and it FAILS when applying would re-run a file that is not known to be
// re-runnable (see REAPPLY_SAFE_FROM), or when a present file sits after a gap
// before that point.
//
// Usage:
//   node scripts/db-preflight.js            human report, exit 0 PASS / 1 FAIL
//   node scripts/db-preflight.js --json     machine-readable report
//
// Also exported for scripts/db-baseline.js, which re-runs it before writing.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { buildSanitizedPgConfig } = require('../lib/db/pgConfig');
const { orderedMigrationFiles } = require('./migrate');
const { LEDGER_TABLE, locateLedger } = require('../lib/db/migrationLedger');

const ROOT = path.join(__dirname, '..');

// Files at or after this one were verified (2026-09-27, see
// docs/STARLANE_OPERATIONS.md) to re-apply cleanly on a schema that already
// has them. Earlier files are NOT all re-runnable (015 adds constraints
// without IF NOT EXISTS), so the plan may never re-apply one of them.
const REAPPLY_SAFE_FROM = 'migrations/020_payment_allocations.sql';

// Objects that later migrations intentionally drop/rename, so their absence
// is not evidence that the creating migration never ran.
const IGNORED_OBJECTS = new Set([]);

// A file is safe to run out of order (after later files were already applied by
// hand) only if every statement in it is a no-op when its object exists:
// CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, COMMENT.
// Anything else — constraints, data, DROP, function bodies — is not assumed safe.
function isIdempotent(sql) {
  const s = stripSql(sql);
  if (s.includes('$$')) return false;
  const safe = [
    /^CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\b/i,
    /^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+IF\s+NOT\s+EXISTS\b/i,
    /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?IF\s+NOT\s+EXISTS\b/i,
    /^CREATE\s+OR\s+REPLACE\s+(?:VIEW|FUNCTION)\b/i,
    /^COMMENT\s+ON\b/i,
    // Access policies on the file's own new table: enabling RLS is idempotent and
    // each policy is dropped IF EXISTS before it is created.
    /^ALTER\s+TABLE\s+\S+\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY$/i,
    /^DROP\s+POLICY\s+IF\s+EXISTS\b/i,
    /^CREATE\s+POLICY\b/i,
  ];
  const addsOnly = (st) => /^ALTER\s+TABLE\b/i.test(st)
    && st.replace(/^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?\S+\s+/i, '').split(/,(?![^()]*\))/)
      .every((part) => /^\s*ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/i.test(part));
  return s.split(';').map((x) => x.trim()).filter(Boolean).every((st) => safe.some((re) => re.test(st)) || addsOnly(st));
}

// A hand-migrated database can hold PART of a file: its CREATE TABLE ran but a
// later CREATE INDEX did not, or a whole run of base tables was never created.
// Such a file cannot be re-run as a whole when it also swaps constraints, toggles
// RLS or carries guarded DO blocks. Its additive statements can: CREATE
// TABLE/INDEX/EXTENSION IF NOT EXISTS and ALTER TABLE ... ADD COLUMN IF NOT
// EXISTS, in file order, outside any $$ block. Those only create what is
// missing, never alter or drop what exists, and never touch data, RLS or
// constraints. db-baseline runs them for each partial file it records.
const ADDITIVE = [
  /^CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\b/i,
  /^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+IF\s+NOT\s+EXISTS\b/i,
  /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?IF\s+NOT\s+EXISTS\b/i,
];
function additiveStatements(sql) {
  const s = stripSql(sql).replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, ' ');
  return s.split(';').map((x) => x.trim()).filter(Boolean).filter((st) => {
    if (/^DO\b/i.test(st)) return false;
    if (ADDITIVE.some((re) => re.test(st))) return true;
    return /^ALTER\s+TABLE\b/i.test(st)
      && st.replace(/^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?\S+\s+/i, '').split(/,(?![^()]*\))/)
        .every((part) => /^\s*ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/i.test(part));
  });
}

// Which of a partial file's missing objects its additive statements create.
// Two cases need a closer look, both about a table the repair itself creates
// (so it is new and empty): its columns come from its CREATE TABLE body, not
// from ADD COLUMN statements; and an index the file only builds inside a
// guarded block (because on a populated table it could fail) is safe to build
// on the empty table, so that one statement is taken out of the block.
function repairPlan(file, missing) {
  const sql = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const stmts = additiveStatements(sql);
  const sig = signatureOf(stmts.join(';\n') + ';');
  const covered = new Set([
    ...sig.tables.map((x) => `table ${x}`), ...sig.columns.map((x) => `column ${x}`), ...sig.indexes.map((x) => `index ${x}`),
  ]);
  const newTables = new Set(missing.filter((m) => m.startsWith('table ') && covered.has(m)).map((m) => m.slice(6)));
  const bodyOf = (t) => {
    const st = stmts.find((x) => new RegExp(String.raw`^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+IF\s+NOT\s+EXISTS\s+(?:public\.)?"?${t}"?\s*\(`, 'i').test(x));
    return st ? st.slice(st.indexOf('(')) : '';
  };
  const extra = [];
  for (const m of missing) {
    if (covered.has(m)) continue;
    const [kind, name] = m.split(' ');
    if (kind === 'column') {
      const [t, c] = name.split('.');
      if (newTables.has(t) && new RegExp(String.raw`[(,]\s*"?${c}"?\s+[A-Za-z]`, 'i').test(bodyOf(t))) covered.add(m);
    } else if (kind === 'index') {
      const found = stripSql(sql).match(new RegExp(String.raw`CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"?${name}"?\s+ON\s+(?:public\.)?"?([a-zA-Z_]\w*)"?([^;]*);`, 'i'));
      if (found && newTables.has(found[2].toLowerCase())) {
        extra.push(`CREATE ${found[1] || ''}INDEX IF NOT EXISTS ${name} ON ${found[2]}${found[3]}`);
        covered.add(m);
      }
    }
  }
  return { file, statements: [...stmts, ...extra], creates: missing.filter((m) => covered.has(m)), uncovered: missing.filter((m) => !covered.has(m)) };
}

function stripSql(sql) {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

const ident = String.raw`(?:"?([a-zA-Z_][\w]*)"?\.)?"?([a-zA-Z_][\w]*)"?`;

function signatureOf(sql) {
  const s = stripSql(sql);
  const tables = new Set();
  const columns = new Set();
  const indexes = new Set();
  for (const m of s.matchAll(new RegExp(String.raw`CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${ident}`, 'gi'))) {
    if (!m[1] || m[1].toLowerCase() === 'public') tables.add(m[2].toLowerCase());
  }
  for (const m of s.matchAll(new RegExp(String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${ident}\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-zA-Z_]\w*)"?`, 'gi'))) {
    if (!m[1] || m[1].toLowerCase() === 'public') columns.add(`${m[2].toLowerCase()}.${m[3].toLowerCase()}`);
  }
  for (const m of s.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?([a-zA-Z_]\w*)"?\s+ON/gi)) {
    indexes.add(m[1].toLowerCase());
  }
  return { tables: [...tables], columns: [...columns], indexes: [...indexes] };
}

async function catalog(client) {
  // Sequential: one pg Client runs one query at a time.
  const t = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
  const c = await client.query(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public'`);
  const i = await client.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`);
  // Constraint- and policy-level facts that table shapes cannot show.
  const k = await client.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname IN ('ai_actions_suggested_by_check')`);
  const r = await client.query(`SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity`);
  // 050-053 enable row-level security on their new tables; the backend reads them
  // through this same connection, which must own them or bypass RLS.
  const who = (await client.query(`SELECT r.rolsuper OR r.rolbypassrls AS bypass,
      EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'invoices' AND pg_get_userbyid(c.relowner) = current_user) AS owns
    FROM pg_roles r WHERE r.rolname = current_user`)).rows[0] || {};
  return {
    tables: new Set(t.rows.map((r) => r.table_name.toLowerCase())),
    columns: new Map(c.rows.map((r) => [`${r.table_name}.${r.column_name}`.toLowerCase(), r.data_type])),
    indexes: new Set(i.rows.map((r) => r.indexname.toLowerCase())),
    constraints: new Map(k.rows.map((x) => [x.conname, x.def])),
    rlsTables: r.rows.map((x) => x.relname),
    role: { bypass: !!who.bypass, ownsTables: !!who.owns },
  };
}

// Targeted checks for the known hazards, reported separately so the operator
// sees them even when signatures look fine.
function hazardChecks(cat) {
  const col = (k) => cat.columns.get(k) || null;
  return [
    { id: 'suppliers.id type', value: col('suppliers.id'), note: '020/024 adapt to this type (bigint in the base schema, uuid on some dev DBs)' },
    { id: 'payment_allocations', value: cat.tables.has('payment_allocations') ? 'present' : 'absent', note: 'created by 020; absent on DBs bootstrapped by the old script' },
    { id: 'product_suppliers', value: cat.tables.has('product_suppliers') ? 'present' : 'absent', note: 'created by 024' },
    { id: 'purchase_line_items', value: cat.tables.has('purchase_line_items') ? 'present' : 'absent', note: 'created by 024' },
    { id: 'invoices.customer_id', value: col('invoices.customer_id') || 'absent', note: '049 adds it as uuid; a non-uuid existing column is left alone (no FK)' },
    { id: 'access_applications', value: cat.tables.has('access_applications') ? 'present' : 'absent', note: 'created by 050' },
    { id: 'connector_devices', value: cat.tables.has('connector_devices') ? 'present' : 'absent', note: 'created by 047; Tally pairing depends on it' },
    { id: 'suggested_by check', value: suggestedByState(cat), note: '019 widens it; mission proposals insert suggested_by = collections_agent' },
    { id: 'row-level security', value: cat.rlsTables.length ? `${cat.rlsTables.length} tables` : 'off', note: '006 enables it (needs Supabase auth); the app enforces tenancy in queries either way' },
    { id: 'schema_migrations', value: !cat.tables.has('schema_migrations') ? 'absent' : cat.columns.has('schema_migrations.filename') ? 'earlier ledger' : 'other tool', note: 'the ledger is starlane_migrations; a schema_migrations table from another tool is never read or written' },
    { id: 'connection role', value: cat.role.bypass ? 'bypasses' : cat.role.ownsTables ? 'owner' : 'LIMITED', note: 'new tables (050-053) have RLS on; this role must own them or bypass RLS, or the new features read nothing' },
  ];
}

function suggestedByState(cat) {
  const def = cat.constraints.get('ai_actions_suggested_by_check');
  if (!def) return 'none';
  return /'collections_agent'/.test(def) ? 'allows' : 'BLOCKS';
}

async function inspect(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    const cat = await catalog(client);
    // The ledger is starlane_migrations (or, on a copy migrated by this
    // branch's first revision, schema_migrations with a filename column). An
    // unrelated schema_migrations table from another tool is not a ledger.
    const ledgerTable = await locateLedger(client);
    const ledgerExists = !!ledgerTable;
    const ledger = ledgerExists
      ? new Map((await client.query(`SELECT filename, checksum FROM ${ledgerTable}`)).rows.map((r) => [r.filename, r.checksum]))
      : new Map();

    const files = orderedMigrationFiles().map((file) => {
      const sig = signatureOf(fs.readFileSync(path.join(ROOT, file), 'utf8'));
      const objects = [
        ...sig.tables.map((x) => ({ kind: 'table', name: x, ok: cat.tables.has(x) })),
        ...sig.columns.map((x) => ({ kind: 'column', name: x, ok: cat.columns.has(x) })),
        ...sig.indexes.map((x) => ({ kind: 'index', name: x, ok: cat.indexes.has(x) })),
      ].filter((o) => !IGNORED_OBJECTS.has(o.name));
      const present = objects.filter((o) => o.ok).length;
      const state = !objects.length ? 'n/a' : present === objects.length ? 'present' : present === 0 ? 'absent' : 'partial';
      const idempotent = isIdempotent(fs.readFileSync(path.join(ROOT, file), 'utf8'));
      return { file, state, idempotent, objects: objects.length, missing: objects.filter((o) => !o.ok).map((o) => `${o.kind} ${o.name}`), inLedger: ledger.has(file) };
    });

    return { cat, ledgerExists, ledgerRows: ledger.size, files, hazards: hazardChecks(cat), repairOf: (f) => repairPlan(f.file, f.missing) };
  } finally {
    await client.query('ROLLBACK');
  }
}

function buildPlan(report) {
  const { files, ledgerExists, ledgerRows } = report;
  const failures = [];
  const warnings = [];
  const safeIdx = files.findIndex((f) => f.file === REAPPLY_SAFE_FROM);

  if (ledgerExists && ledgerRows > 0) {
    warnings.push(`${LEDGER_TABLE} already has ${ledgerRows} row(s): this database is already on the ledger — use \`node scripts/migrate.js --status\`, not a baseline.`);
  }
  if (files.length && files[0].state === 'absent') {
    failures.push('The base schema (supabase-schema.sql) is not present. This is not an existing Starlane database — use `node scripts/migrate.js` on an empty one instead.');
  }

  // The cut: the last file before REAPPLY_SAFE_FROM that is present. Files up to it
  // were applied by hand and are recorded without running; files after it run.
  // Earlier files are not all safe to re-run, so nothing before the cut may run —
  // except a file that is absent AND idempotent, which can run out of order.
  const limit = safeIdx >= 0 ? safeIdx : files.length;
  let cut = -1;
  for (let i = 0; i < limit; i++) if (files[i].state === 'present') cut = i;
  // Files right after the cut that create nothing checkable (constraints, seeds)
  // are taken as applied with their neighbours; the hazard checks cover the one
  // the new code depends on (019's suggested_by constraint).
  while (cut >= 0 && cut + 1 < limit && files[cut + 1].state === 'n/a') cut++;
  // If the leading run reaches the safe point, keep going through it as before.
  if (cut === limit - 1 || cut < 0) {
    for (let i = Math.max(cut, 0); i < files.length; i++) {
      if (files[i].state === 'present' || files[i].state === 'n/a') cut = i; else break;
    }
  }
  const outOfOrder = [];
  for (let i = 0; i <= cut; i++) {
    const f = files[i];
    if (f.state !== 'absent') continue;
    if (f.idempotent) outOfOrder.push(f);
    else failures.push(`${f.file} is absent, but later files are present, and it is not safe to run out of order (it does more than CREATE/ADD … IF NOT EXISTS). A human must reconcile.`);
  }
  for (const f of outOfOrder) warnings.push(`${f.file} was never applied although later files were; it only creates missing objects IF NOT EXISTS, so it runs out of order.`);
  const unverified = files.slice(0, cut + 1).filter((f) => f.state === 'n/a').map((f) => path.basename(f.file));
  if (unverified.length) warnings.push(`Recorded without verification (they change constraints, policies or seed data, which the catalog check cannot see): ${unverified.join(', ')}. See the hazard lines above.`);
  const role = report.hazards.find((h) => h.id === 'connection role');
  if (role && role.value === 'LIMITED') failures.push('The connecting role neither owns the tables nor bypasses row-level security. Run the migrations and the backend with the database owner role (Supabase: the postgres user in the connection string), or the new tables will read as empty.');
  const sb = report.hazards.find((h) => h.id === 'suggested_by check');
  if (sb && sb.value === 'BLOCKS') failures.push('ai_actions_suggested_by_check does not allow collections_agent, so 019 was not applied; mission proposals would fail. Apply 019 by hand (it drops and re-adds the constraint) and re-run this preflight.');
  const firstApply = cut + 1;
  const later = files.slice(firstApply).filter((f) => f.state !== 'absent' && files.indexOf(f) < limit);
  if (later.length) failures.push(`Files before ${REAPPLY_SAFE_FROM} would be re-run although present (${later.map((f) => f.file).join(', ')}). A human must reconcile.`);
  if (firstApply < limit && !later.length && firstApply < files.length) {
    warnings.push(`${limit - firstApply} pre-020 file(s) from ${files[firstApply].file} onward would run for the first time. Confirm this database really never had them.`);
  }

  const record = files.slice(0, firstApply).filter((f) => !outOfOrder.includes(f)).map((f) => f.file);

  // Partial files. One that will run anyway (after the cut, where every file is
  // written to be re-run) needs nothing extra. One that is recorded gets its
  // additive statements run by the baseline, and only if they create every
  // missing object; anything else still needs a human.
  const repair = [];
  for (const f of files) {
    if (f.state !== 'partial') continue;
    if (!record.includes(f.file)) {
      if (files.indexOf(f) < limit) failures.push(`${f.file} is PARTIALLY present and would be re-run before ${REAPPLY_SAFE_FROM}. A human must reconcile.`);
      else warnings.push(`${f.file} is partially present; it runs again as planned and creates what is missing (${f.missing.length}: ${f.missing.slice(0, 4).join(', ')}${f.missing.length > 4 ? ', …' : ''}).`);
      continue;
    }
    const r = report.repairOf ? report.repairOf(f) : { file: f.file, statements: [], creates: [], uncovered: f.missing };
    if (r.uncovered.length) {
      failures.push(`${f.file} is PARTIALLY present and ${r.uncovered.length} missing object(s) are only created inside guarded or non-additive statements (${r.uncovered.slice(0, 6).join(', ')}${r.uncovered.length > 6 ? ', …' : ''}). A human must reconcile.`);
    } else {
      repair.push({ file: f.file, statements: r.statements, creates: r.creates });
      warnings.push(`${f.file} is partially present: the baseline creates its ${r.creates.length} missing object(s) (${r.creates.slice(0, 4).join(', ')}${r.creates.length > 4 ? ', …' : ''}) with its ${r.statements.length} CREATE/ADD … IF NOT EXISTS statement(s) only. No existing table, column, constraint, policy or row is changed.`);
    }
  }
  const apply = [...outOfOrder, ...files.slice(firstApply)].map((f) => ({ file: f.file, state: f.state, outOfOrder: outOfOrder.includes(f) }));
  return {
    pass: failures.length === 0 && !(ledgerExists && ledgerRows > 0),
    failures,
    warnings,
    baselineThrough: record.length ? record[record.length - 1] : null,
    record,
    repair,
    apply,
  };
}

async function preflight(client) {
  const report = await inspect(client);
  return { ...report, plan: buildPlan(report) };
}

function printReport(r, log = console.log) {
  log('Starlane database baseline preflight (read-only)\n');
  log('Known hazards:');
  for (const h of r.hazards) log(`  ${h.id.padEnd(22)} ${String(h.value).padEnd(10)} ${h.note}`);
  log(`\nLedger: ${r.ledgerExists ? `${LEDGER_TABLE} exists (${r.ledgerRows} rows)` : 'none yet'}\n`);
  log('Per-file state (objects the file creates vs the live catalog):');
  for (const f of r.files) {
    const action = r.plan.record.includes(f.file) ? 'RECORD' : 'APPLY ';
    log(`  ${action} ${f.state.padEnd(8)} ${f.file}${f.missing.length && f.state !== 'absent' ? `  (missing ${f.missing.length})` : ''}`);
  }
  for (const w of r.plan.warnings) log(`\n  ! ${w}`);
  for (const e of r.plan.failures) log(`\n  ✖ ${e}`);
  log(`\nRESULT: ${r.plan.pass ? 'PASS' : 'FAIL'}`);
  if (r.plan.pass) {
    log(`\nPlan (not executed):`);
    log(`  1. node scripts/db-baseline.js --execute --through=${r.plan.baselineThrough}`);
    log(`     records ${r.plan.record.length} file(s) as applied without running them`);
    for (const x of r.plan.repair) log(`     and first creates ${x.creates.length} missing object(s) from ${x.file} (additive statements only)`);
    log(`  2. node scripts/migrate.js`);
    log(`     applies ${r.plan.apply.length} file(s): ${r.plan.apply.map((a) => path.basename(a.file)).join(', ') || 'none'}`);
  }
}

if (require.main === module) {
  (async () => {
    const cfg = buildSanitizedPgConfig(process.env.DATABASE_URL);
    if (!cfg) { console.error('DATABASE_URL is not set'); process.exit(2); }
    const client = new Client(cfg);
    await client.connect();
    try {
      const r = await preflight(client);
      if (process.argv.includes('--json')) {
        const { cat, repairOf, ...rest } = r;
        console.log(JSON.stringify(rest, null, 2));
      } else printReport(r);
      process.exitCode = r.plan.pass ? 0 : 1;
    } finally { await client.end(); }
  })().catch((e) => { console.error(`preflight error: ${String(e.message).split('\n')[0]}`); process.exit(2); });
}

module.exports = { preflight, signatureOf, printReport, REAPPLY_SAFE_FROM, isIdempotent, buildPlan, additiveStatements };
