// FILE: cortex-lab/cleanup.js
// Best-effort cleanup of test rows. Only deletes rows that carry the run-ID
// marker. Reports residue when something can't be deleted.

'use strict';

const dbClient = require('./dbClient');

const CLEANUP_TABLES = [
  'ai_actions',
  'business_events',
  'invoices',
  'sales',
  'payments',
  'cashflow_events',
  'audit_logs',
  'policy_decisions',
  'promises',
  'tool_calls',
  'business_memory',
];

async function cleanup({ client, runId, userIds = [] }) {
  if (!client) return { ok: false, reason: 'no_client', perTable: {} };
  const perTable = {};
  let totalDeleted = 0;
  let residue = 0;

  for (const table of CLEANUP_TABLES) {
    perTable[table] = { matched: 0, deleted: 0, residue: 0, error: null };
    let matched = [];
    for (const uid of (userIds.length ? userIds : [null])) {
      const found = await dbClient.findRecent(client, table, { runId, userId: uid, limit: 500 });
      if (!found.ok) { perTable[table].error = found.error; continue; }
      matched = matched.concat(found.rows);
    }
    // De-duplicate
    const seen = new Set(); matched = matched.filter(r => (r.id && !seen.has(r.id) && seen.add(r.id)));
    perTable[table].matched = matched.length;
    if (!matched.length) continue;

    const ids = matched.map(r => r.id).filter(Boolean);
    const del = await dbClient.deleteIds(client, table, ids);
    if (!del.ok) {
      perTable[table].error = del.error;
      perTable[table].residue = ids.length;
      residue += ids.length;
      continue;
    }
    perTable[table].deleted = del.deleted;
    totalDeleted += del.deleted;
  }

  return { ok: residue === 0, totalDeleted, residue, perTable };
}

module.exports = { cleanup, CLEANUP_TABLES };
