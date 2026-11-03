'use strict';
// The Vault: what this company has given Starlane, as files and folders.
// Everything comes from rows a real import, sync or run wrote, for this
// tenant only:
//   Uploaded files   file_import_batches (one row per spreadsheet upload)
//   Customer ledgers invoices grouped by customer (one ledger per customer)
//   Agent outputs    agent_runs that finished with an output
// Nothing is stored as a blob, so sizes are what is real: rows for a
// spreadsheet, invoices for a ledger, bytes of the stored output for a run.

const CATEGORY = {
  ledger_import: 'Receivables ledger',
  file_import: 'Invoice export',
  tally: 'Tally export',
};

// 'starlane.working_capital' -> 'Working capital'
const agentName = (key) => {
  const k = String(key || 'agent').split('.').pop().replace(/[_-]+/g, ' ').trim();
  return k.charAt(0).toUpperCase() + k.slice(1);
};

async function optional(promise) {
  try { return (await promise).rows; } catch (err) { if (err.code === '42P01' || err.code === '42703') return []; throw err; }
}

async function vaultFiles(pool, userId) {
  if (!userId) throw new Error('vaultFiles: userId required');
  const [uploads, ledgers, runs] = await Promise.all([
    optional(pool.query(
      `SELECT id, source_system, filename, file_type, mapping_profile, status, rows_total, rows_accepted, rows_rejected,
              COALESCE(completed_at, started_at) AS modified_at
         FROM file_import_batches WHERE user_id = $1
        ORDER BY COALESCE(completed_at, started_at) DESC LIMIT 200`, [userId])),
    optional(pool.query(
      `SELECT customer_name AS name, COUNT(*)::int AS invoices,
              COALESCE(SUM(CASE WHEN LOWER(COALESCE(payment_status, '')) <> 'paid'
                                THEN invoice_amount - COALESCE(payment_amount, 0) ELSE 0 END), 0)::float AS outstanding,
              COUNT(*) FILTER (WHERE LOWER(COALESCE(payment_status, '')) <> 'paid' AND COALESCE(days_overdue, 0) > 0)::int AS overdue,
              MAX(COALESCE(updated_at, created_at)) AS modified_at
         FROM invoices WHERE user_id = $1
        GROUP BY customer_name ORDER BY MAX(COALESCE(updated_at, created_at)) DESC NULLS LAST LIMIT 500`, [userId])),
    optional(pool.query(
      `SELECT id, agent_key, status, finished_at AS modified_at, pg_column_size(output_json)::int AS bytes
         FROM agent_runs WHERE user_id = $1 AND status = 'completed' AND output_json IS NOT NULL
        ORDER BY finished_at DESC LIMIT 100`, [userId])),
  ]);

  const stamp = (rows) => rows.reduce((m, r) => (r.modified_at && (!m || new Date(r.modified_at) > new Date(m)) ? r.modified_at : m), null);
  return {
    folders: [
      {
        id: 'uploads', name: 'Uploaded files', modified_at: stamp(uploads), count: uploads.length,
        items: uploads.map((u) => ({
          id: u.id, name: u.filename || 'Untitled upload', category: CATEGORY[u.source_system] || 'Spreadsheet',
          type: u.file_type || 'File', status: u.status, modified_at: u.modified_at,
          size: { rows: u.rows_accepted ?? u.rows_total ?? 0 }, rows_rejected: u.rows_rejected || 0,
        })),
      },
      {
        id: 'customers', name: 'Customer ledgers', modified_at: stamp(ledgers), count: ledgers.length,
        items: ledgers.map((c) => ({
          id: c.name, name: c.name, category: c.overdue > 0 ? 'Overdue' : c.outstanding > 0 ? 'Open' : 'Settled',
          type: 'Ledger', modified_at: c.modified_at, size: { invoices: c.invoices },
          outstanding: c.outstanding, overdue: c.overdue,
        })),
      },
      {
        id: 'agents', name: 'Agent outputs', modified_at: stamp(runs), count: runs.length,
        items: runs.map((r) => ({
          id: r.id, name: `${agentName(r.agent_key)} output.json`, agent_key: r.agent_key, category: 'Agent output',
          type: 'JSON', modified_at: r.modified_at, size: { bytes: r.bytes || 0 },
        })),
      },
    ],
    last_synced_at: stamp([...uploads, ...ledgers, ...runs]),
  };
}

module.exports = { vaultFiles };
