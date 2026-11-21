'use strict';
// Verifies the per-organization hash chain on platform_audit_events
// (migration 075). Each row's hash is SHA-256(prev_hash | canonical row), and
// prev_hash is the hash of the organization's previous chained row.
//
// What verification proves: no chained row was edited, and no row between the
// first and the last was removed. What it cannot prove on its own: that rows
// were not cut off the end. For that, keep the `head` (latest hash and count)
// this returns somewhere outside Starlane, such as an auditor's evidence
// folder, and compare it later.

const BATCH = 5000;

async function verify(db, organizationId) {
  const pre = await db.query('SELECT COUNT(*)::int AS n FROM platform_audit_events WHERE organization_id = $1 AND hash IS NULL', [organizationId]);
  let lastId = 0;
  let prevHash = null;
  let checked = 0;
  let first = null;
  const problems = [];
  for (;;) {
    const { rows } = await db.query(
      `SELECT e.id, e.prev_hash, e.hash, e.created_at,
              encode(sha256(convert_to(e.prev_hash || '|' || platform_audit_canonical(e), 'UTF8')), 'hex') AS expected
         FROM platform_audit_events e
        WHERE e.organization_id = $1 AND e.hash IS NOT NULL AND e.id > $2
        ORDER BY e.id ASC LIMIT $3`,
      [organizationId, lastId, BATCH],
    );
    for (const r of rows) {
      if (!first) {
        first = { id: String(r.id), at: r.created_at };
        if (r.prev_hash !== 'genesis') problems.push({ id: String(r.id), problem: 'The first chained event does not start the chain; earlier events may have been removed.' });
      } else if (r.prev_hash !== prevHash) {
        problems.push({ id: String(r.id), problem: 'This event does not follow the one before it; an event between them was removed or changed.' });
      }
      if (r.expected !== r.hash) problems.push({ id: String(r.id), problem: 'This event was changed after it was written.' });
      prevHash = r.hash;
      lastId = Number(r.id);
      checked += 1;
      if (problems.length >= 50) break;
    }
    if (rows.length < BATCH || problems.length >= 50) break;
  }
  return {
    intact: problems.length === 0,
    checked,
    beforeChain: pre.rows[0].n,
    head: checked ? { id: String(lastId), hash: prevHash, count: checked } : null,
    firstChained: first,
    problems,
    verifiedAt: new Date().toISOString(),
  };
}

/** Audit events as JSON Lines for an auditor, oldest first, with hashes. */
async function exportEvents(db, organizationId, { from = null, to = null, limit = 50000 } = {}) {
  const { rows } = await db.query(
    `SELECT id, actor_hash, actor_kind, action, resource_type, resource_id, detail, created_at, prev_hash, hash
       FROM platform_audit_events
      WHERE organization_id = $1 AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3)
      ORDER BY id ASC LIMIT $4`,
    [organizationId, from, to, Math.min(Math.max(Number(limit) || 50000, 1), 100000)],
  );
  return rows.map((r) => JSON.stringify({ ...r, id: String(r.id) })).join('\n');
}

module.exports = { verify, exportEvents };
