// FILE: cortex-lab/dbClient.js
// Read/cleanup against the *test* Supabase project only. Refuses to construct
// a client whose URL matches the product Supabase URL or any prod denylist.

'use strict';

const { createClient } = require('@supabase/supabase-js');

function safeBuild({ url, key, prodHostDenylist = [], productUrl = null }) {
  if (!url || !key) return { client: null, reason: 'missing_url_or_key' };
  if (productUrl && url === productUrl) return { client: null, reason: 'test_url_equals_product_url' };
  const lower = url.toLowerCase();
  if (prodHostDenylist.some(p => lower.includes(p.toLowerCase()))) {
    return { client: null, reason: 'test_url_matches_prod_denylist' };
  }
  return { client: createClient(url, key), reason: null };
}

/**
 * Read recent rows for a table, scoped to the test run.
 * Filter is best-effort — different tables stamp the run ID in different fields.
 */
async function findRecent(client, table, { runId, userId, limit = 50, since }) {
  let q = client.from(table).select('*').order('created_at', { ascending: false }).limit(limit);
  if (userId) q = q.eq('user_id', userId);
  if (since)  q = q.gte('created_at', since);
  const { data, error } = await q;
  if (error) return { ok: false, error: error.message, rows: [] };
  // Best-effort run-ID filter — accept rows whose cortex_test_run_id field or
  // notes/reason_json contain the run ID. This is heuristic by design; cleanup
  // uses the same filter to avoid hitting non-test rows.
  const filtered = (data || []).filter(r => rowMatchesRun(r, runId));
  return { ok: true, rows: filtered, allRows: data || [] };
}

function rowMatchesRun(row, runId) {
  if (!runId) return false;
  const blobs = [
    row.cortex_test_run_id,
    row.notes,
    row.description,
    row.title,
    typeof row.reason_json === 'object' ? JSON.stringify(row.reason_json) : row.reason_json,
    typeof row.payload_json === 'object' ? JSON.stringify(row.payload_json) : row.payload_json,
    row.cortex_notes,
  ].filter(Boolean);
  return blobs.some(b => String(b).includes(runId));
}

async function deleteIds(client, table, ids) {
  if (!ids.length) return { ok: true, deleted: 0 };
  const { error } = await client.from(table).delete().in('id', ids);
  if (error) return { ok: false, deleted: 0, error: error.message };
  return { ok: true, deleted: ids.length };
}

module.exports = { safeBuild, findRecent, deleteIds, rowMatchesRun };
