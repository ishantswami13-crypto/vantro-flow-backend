'use strict';
// scripts/check-tenant-isolation.js
//
// Fails if an agent or orchestrator service reads a tenant-owned table without
// filtering on a tenant column.
//
// Why this needs enforcing: the backend talks to Supabase with the
// service_role key, which bypasses Row Level Security entirely (see
// SUPABASE_RLS_ROLLOUT_PLAN.md). There is no database-level backstop, so an
// application-level user_id filter is the only thing separating one business's
// invoices, customers and actions from another's. A single missing .eq() is a
// cross-tenant data leak with nothing behind it.
//
// Usage:
//   node scripts/check-tenant-isolation.js
//   npm run security:tenant-isolation
//
// Exits non-zero on any unscoped read.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Directories whose queries always run on behalf of one user.
const SCAN_DIRS = [
  'lib/services/agents',
  'lib/services/orchestrator',
  'lib/cortex',
];

// Columns that scope a row to a single tenant.
const TENANT_COLUMNS = ['user_id', 'business_id'];

// Tables that are not tenant-owned — global config, catalogues, and tables
// keyed only by their own id. Reads against these do not need a tenant filter.
const GLOBAL_TABLES = new Set([
  'feature_flags',
  'plans',
  'industries',
  'migrations',
  'schema_migrations',
]);

// How many lines of a query chain to consider when looking for filters.
const CHAIN_LINES = 12;

function walk(dir) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full)
    .filter(f => f.endsWith('.js'))
    .map(f => path.join(dir, f));
}

// Returns { violations, scanned } so callers can report how much was actually
// inspected — "0 violations" means nothing if nothing was scanned.
function scan() {
  const violations = [];
  let scanned = 0;

  for (const dir of SCAN_DIRS) {
    for (const rel of walk(dir)) {
      const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');

      lines.forEach((line, i) => {
        const m = /\.from\('([a-z_]+)'\)/.exec(line);
        if (!m) return;

        const table = m[1];
        if (GLOBAL_TABLES.has(table)) return;

        // Consider the query chain up to its first statement terminator.
        const chain = lines.slice(i, i + CHAIN_LINES).join('\n').split(';')[0];

        // Only reads. Writes carry the tenant in the row payload, not a filter.
        if (!/\.select\(/.test(chain)) return;
        if (/\.(insert|upsert|update|delete)\(/.test(chain)) return;

        scanned++;

        // An explicit opt-out for the rare intentional cross-tenant read.
        if (/tenant-isolation-exempt/.test(chain)) return;

        if (TENANT_COLUMNS.some(col => chain.includes(col))) return;

        violations.push({ file: rel, line: i + 1, table, source: line.trim() });
      });
    }
  }

  return { violations, scanned };
}

function main() {
  console.log('[SECURITY] Checking tenant isolation on agent/orchestrator reads...');


  const { violations, scanned } = scan();

  if (violations.length === 0) {
    console.log(`[SECURITY] Tenant Isolation Passed: ${scanned} reads scanned, all tenant-scoped.`);
    return;
  }

  console.error(`\n[SECURITY] Tenant Isolation FAILED — ${violations.length} unscoped read(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    table: ${v.table}`);
    console.error(`    ${v.source}`);
    console.error('');
  }
  console.error('Add .eq(\'user_id\', <owner>) to the query, or annotate the chain with');
  console.error('a "tenant-isolation-exempt" comment explaining why it is safe.\n');
  process.exit(1);
}

// Exported so cortex-lab can report business isolation as a real result rather
// than "N/A". Only self-executes when run directly.
module.exports = { scan };

if (require.main === module) main();
