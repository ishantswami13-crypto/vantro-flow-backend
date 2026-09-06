// Real-DB proof that pgSupabaseShim's QueryBuilder.not() works correctly.
// Runs against process.env.DATABASE_URL (the real local-dev Postgres/Neon DB this
// shim is actually used against) — never NEON_READONLY_URL, never production.
// Seeds synthetic rows into stock_movements (tagged with a unique marker so they
// can never collide with real data), exercises .not() in the exact shapes used by
// the 7 live server.js call sites, and deletes every synthetic row in a finally block.
//
// Run: node lib/config/pgSupabaseShim.test.mjs
import 'dotenv/config';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { makeShim } = require('./pgSupabaseShim.js');
const { randomUUID } = require('crypto');

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(got)}${ok ? '' : ' (expected ' + JSON.stringify(want) + ')'}`);
  ok ? pass++ : fail++;
}

if (!process.env.DATABASE_URL) {
  console.error('FAIL: DATABASE_URL is not set. This test requires the real local-dev DB connection string.');
  process.exit(1);
}
if (/NEON_READONLY/i.test(process.env.DATABASE_URL) || process.env.NEON_READONLY_URL === process.env.DATABASE_URL) {
  console.error('FAIL: refusing to run against what looks like a readonly/production URL.');
  process.exit(1);
}

const MARKER = `__not_test_${randomUUID().slice(0, 8)}__`;
const supabase = makeShim(process.env.DATABASE_URL);

async function seed() {
  const rows = [
    { id: randomUUID(), movement_type: MARKER, quantity: 1, reference: 'REF-A' },
    { id: randomUUID(), movement_type: MARKER, quantity: 2, reference: 'REF-B' },
    { id: randomUUID(), movement_type: MARKER, quantity: 3, reference: null },
    { id: randomUUID(), movement_type: MARKER, quantity: 4, reference: null },
    { id: randomUUID(), movement_type: MARKER + '_OTHER', quantity: 5, reference: 'REF-C' },
  ];
  const { error } = await supabase.from('stock_movements').insert(rows);
  if (error) throw error;
  return rows;
}

async function cleanup() {
  await supabase.from('stock_movements').delete().like('movement_type', MARKER + '%');
}

async function run() {
  await seed();

  // 1. .not(col, 'is', null) excludes nulls, includes non-null rows.
  {
    const { data, error } = await supabase.from('stock_movements')
      .select('*')
      .eq('movement_type', MARKER)
      .not('reference', 'is', null);
    check('not(is,null) returns no error', !!error, false);
    const refs = (data || []).map(r => r.reference).sort();
    check('not(is,null) excludes nulls, includes non-null rows', refs, ['REF-A', 'REF-B']);
  }

  // 2. .not(col, 'eq', value) excludes the matching value, includes the rest.
  {
    const { data, error } = await supabase.from('stock_movements')
      .select('*')
      .eq('movement_type', MARKER)
      .not('reference', 'eq', 'REF-A');
    check('not(eq,value) returns no error', !!error, false);
    const refs = (data || []).map(r => r.reference).sort();
    // Postgres NULL <> 'REF-A' is unknown, not true, so NULL rows are correctly excluded too
    // (matches real Postgres/Supabase semantics for <>, not a shim bug).
    check('not(eq,value) excludes matching row, keeps other non-null rows', refs, ['REF-B']);
  }

  // 3. .not() combined with a preceding .eq() applies both filters (AND semantics).
  {
    const { data, error } = await supabase.from('stock_movements')
      .select('*')
      .eq('movement_type', MARKER + '_OTHER')
      .not('reference', 'is', null);
    check('eq + not chain returns no error', !!error, false);
    check('eq + not chain applies both filters together', (data || []).length, 1);
    check('eq + not chain returns the correct row', (data || [])[0]?.reference, 'REF-C');
  }

  // 4. Another operator variant for generality: .not(col, 'in', [...]).
  // Real call sites only use 'is' and 'eq', but the mission requires the implementation
  // not claim generality it hasn't proven, so this exercises the 'in' path directly.
  {
    const { data, error } = await supabase.from('stock_movements')
      .select('*')
      .eq('movement_type', MARKER)
      .not('reference', 'in', ['REF-A', 'REF-B']);
    check('not(in,[...]) returns no error', !!error, false);
    const refs = (data || []).map(r => r.reference).sort();
    check('not(in,[...]) excludes listed values (nulls also excluded, matching SQL NOT IN-with-NULL semantics of = ANY)', refs, []);
  }

  // 5. Unsupported operator degrades with a clear thrown error, not silent wrong SQL.
  {
    let threw = null;
    try {
      supabase.from('stock_movements').not('reference', 'sw', 'REF');
    } catch (e) {
      threw = e;
    }
    check('unsupported operator throws a clear error instead of silently misbehaving', !!threw, true);
  }

  // 6. Regression: existing .eq()/.is() methods are unaffected by the addition.
  {
    const { data, error } = await supabase.from('stock_movements')
      .select('*')
      .eq('movement_type', MARKER)
      .is('reference', null);
    check('existing .is(null) still works unaffected', !!error, false);
    check('existing .is(null) returns correct count', (data || []).length, 2);
  }
}

run()
  .catch(err => {
    console.error('FAIL: unexpected exception:', err);
    fail++;
  })
  .finally(async () => {
    await cleanup();
    // Verify zero residue.
    const { data } = await supabase.from('stock_movements').select('id').like('movement_type', MARKER + '%');
    check('cleanup leaves zero residual synthetic rows', (data || []).length, 0);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
