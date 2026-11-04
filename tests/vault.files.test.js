'use strict';
// Vault: every query is scoped to the caller, sizes are real counts, and a
// missing table (migration not applied) reads as an empty folder, not a 500.
const test = require('node:test');
const assert = require('node:assert');
const { vaultFiles } = require('../lib/domain/vault/files');

test('builds three tenant-scoped folders from real rows', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('file_import_batches')) return { rows: [{ id: 'b1', source_system: 'ledger_import', filename: 'ledger.xlsx', file_type: 'XLSX', status: 'COMPLETED', rows_total: 30, rows_accepted: 29, rows_rejected: 1, modified_at: '2026-11-01T00:00:00Z' }] };
    if (sql.includes('FROM invoices')) return { rows: [{ name: 'Kaveri Pumps', invoices: 3, outstanding: 639800, overdue: 3, modified_at: '2026-11-02T00:00:00Z' }] };
    const e = new Error('relation "agent_runs" does not exist'); e.code = '42P01'; throw e;
  } };
  const v = await vaultFiles(pool, 'u1');
  assert.ok(calls.every((c) => c.params[0] === 'u1' && /user_id = \$1/.test(c.sql)));
  const [uploads, ledgers, agents] = v.folders;
  assert.deepStrictEqual(uploads.items[0].size, { rows: 29 });
  assert.strictEqual(uploads.items[0].category, 'Receivables ledger');
  assert.strictEqual(ledgers.items[0].category, 'Overdue');
  assert.deepStrictEqual(ledgers.items[0].size, { invoices: 3 });
  assert.strictEqual(agents.count, 0);
  assert.strictEqual(v.last_synced_at, '2026-11-02T00:00:00Z');
});

test('refuses without a user', async () => {
  await assert.rejects(vaultFiles({ query: async () => ({ rows: [] }) }, null), /userId required/);
});
