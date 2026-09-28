// FILE: lib/domain/decisions/sourceHealth.js
// What Starlane knows about its own inputs: how fresh the receivables data
// is, which connectors are healthy, how complete the ledger is, how well
// calibrated past predictions were, and what it is allowed to do. Each is a
// separate dimension; there is deliberately no single 0-100 score.

async function receivablesFreshness(pool, userId, defs) {
  const res = await pool.query(
    `SELECT
       (SELECT MAX(GREATEST(COALESCE(updated_at, created_at), created_at)) FROM invoices WHERE user_id = $1) AS last_invoice_change,
       (SELECT MAX(last_sync_at) FROM data_connections WHERE user_id = $1) AS last_sync,
       (SELECT MAX(completed_at) FROM import_batches WHERE user_id = $1) AS last_import,
       (SELECT COUNT(*)::int FROM invoices WHERE user_id = $1) AS invoice_count`,
    [userId]
  );
  const r = res.rows[0];
  const candidates = [r.last_invoice_change, r.last_sync, r.last_import].filter(Boolean).map((d) => new Date(d).getTime());
  if (!candidates.length) {
    return { status: 'UNKNOWN', lastUpdateAt: null, ageHours: null, invoiceCount: r.invoice_count, detail: 'No receivables have been imported yet' };
  }
  const last = Math.max(...candidates);
  const ageHours = Math.round(((Date.now() - last) / 3600000) * 10) / 10;
  const status = ageHours <= defs.receivables_fresh_hours ? 'FRESH' : ageHours <= defs.receivables_stale_hours ? 'AGING' : 'STALE';
  return {
    status,
    lastUpdateAt: new Date(last).toISOString(),
    ageHours,
    invoiceCount: r.invoice_count,
    requirementHours: defs.receivables_fresh_hours,
    detail: `Receivables last changed ${humanAge(ageHours)} ago (fresh within ${defs.receivables_fresh_hours}h)`,
  };
}

function humanAge(hours) {
  if (hours == null) return 'never';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.floor(hours)}h ${Math.round((hours % 1) * 60)}m`;
  return `${Math.round(hours / 24)} days`;
}

async function connectorHealth(pool, userId, defs) {
  const res = await pool.query('SELECT source_type, status, last_sync_at, last_sync_error FROM data_connections WHERE user_id = $1 ORDER BY source_type', [userId]);
  return res.rows.map((c) => {
    const ageHours = c.last_sync_at ? (Date.now() - new Date(c.last_sync_at).getTime()) / 3600000 : null;
    let health;
    if (c.last_sync_error && /401|403|unauthori[sz]ed|forbidden/i.test(c.last_sync_error)) health = 'UNAUTHORIZED';
    else if (c.last_sync_error && /429|rate/i.test(c.last_sync_error)) health = 'RATE_LIMITED';
    else if (c.last_sync_error) health = 'FAILED';
    else if (ageHours == null) health = 'NOT_SYNCED';
    else if (ageHours > defs.receivables_stale_hours) health = 'STALE';
    else if (ageHours > defs.receivables_fresh_hours) health = 'DEGRADED';
    else health = 'CONNECTED';
    return { source: c.source_type, status: c.status, health, lastSyncAt: c.last_sync_at, ageHours: ageHours == null ? null : Math.round(ageHours * 10) / 10, lastError: c.last_sync_error ? String(c.last_sync_error).slice(0, 200) : null };
  });
}

async function calibrationSummary(pool, userId) {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS resolved,
            COUNT(*) FILTER (WHERE coverage_hit)::int AS hits,
            COUNT(*) FILTER (WHERE coverage_hit IS NOT NULL)::int AS with_interval,
            AVG(actual_value - point_estimate) AS bias,
            AVG(absolute_error) AS mae
     FROM predictions WHERE user_id = $1 AND evaluation_status = 'RESOLVED' AND entity_type = 'decision_contract'`,
    [userId]
  );
  const r = res.rows[0];
  const pending = await pool.query(`SELECT COUNT(*)::int AS n FROM predictions WHERE user_id = $1 AND entity_type = 'decision_contract' AND evaluation_status IS DISTINCT FROM 'RESOLVED' AND superseded_by_id IS NULL`, [userId]);
  return {
    resolvedPredictions: r.resolved,
    pendingPredictions: pending.rows[0].n,
    intervalCoverage: r.with_interval ? Math.round((r.hits / r.with_interval) * 1000) / 1000 : null,
    nominalCoverage: 0.8,
    meanBias: r.bias == null ? null : Math.round(Number(r.bias)),
    meanAbsoluteError: r.mae == null ? null : Math.round(Number(r.mae)),
    status: r.resolved === 0 ? 'NO_RESOLVED_PREDICTIONS_YET' : r.resolved < 10 ? 'TOO_FEW_TO_JUDGE' : 'MEASURED',
  };
}

/**
 * Compact, multi-dimensional intelligence health for Today and Control.
 */
async function intelligenceHealth(pool, userId, defs, { quality, settings, stops, externalSendEnabled }) {
  const [freshness, connectors, calibration] = await Promise.all([
    receivablesFreshness(pool, userId, defs),
    connectorHealth(pool, userId, defs),
    calibrationSummary(pool, userId),
  ]);
  const dims = [];
  dims.push({ key: 'data_coverage', label: 'Data coverage', status: freshness.invoiceCount > 0 ? 'OK' : 'MISSING', detail: freshness.invoiceCount > 0 ? `${freshness.invoiceCount} invoices on record` : 'No invoices yet. Import from Tally, CSV or Excel to start.' });
  dims.push({ key: 'freshness', label: 'Freshness', status: freshness.status, detail: freshness.detail });
  if (quality) {
    const gaps = [];
    if (quality.unparseableDueDate) gaps.push(`${quality.unparseableDueDate} invoice(s) with no usable due date`);
    if (quality.paidWithoutDate) gaps.push(`${quality.paidWithoutDate} paid invoice(s) with no payment date`);
    if (quality.duplicateInvoiceNumbers) gaps.push(`${quality.duplicateInvoiceNumbers} possible duplicate invoice number(s)`);
    if (quality.currencyMissing) gaps.push(`${quality.currencyMissing} invoice(s) with no currency (treated as ${defs.base_currency})`);
    dims.push({ key: 'evidence_quality', label: 'Evidence quality', status: gaps.length ? 'GAPS' : 'OK', detail: gaps.length ? gaps.join('; ') : 'No gaps found in the ledger fields the engine uses' });
  }
  const badConnectors = connectors.filter((c) => !['CONNECTED'].includes(c.health));
  dims.push({ key: 'connectors', label: 'Connector health', status: connectors.length === 0 ? 'NONE' : badConnectors.length ? 'DEGRADED' : 'OK', detail: connectors.length === 0 ? 'No live connectors; data arrives by import' : badConnectors.length ? badConnectors.map((c) => `${c.source}: ${c.health.toLowerCase().replace('_', ' ')}`).join('; ') : `${connectors.length} connector(s) healthy` });
  dims.push({ key: 'calibration', label: 'Forecast calibration', status: calibration.status, detail: calibration.status === 'MEASURED' ? `${Math.round(calibration.intervalCoverage * 100)}% of outcomes landed inside the 80% range` : `${calibration.resolvedPredictions} resolved, ${calibration.pendingPredictions} waiting for their review date` });
  const actionDetail = [];
  actionDetail.push(settings.pilotMode === 'SHADOW' ? 'Shadow mode: nothing is executed, Starlane records what it would have done' : 'Live mode: approved internal actions execute');
  actionDetail.push(externalSendEnabled ? 'external messages can be sent after approval' : 'external messages are drafts only');
  if (!stops.allowed) actionDetail.push(`stopped by ${stops.blockedBy.map((b) => b.scope.toLowerCase()).join(', ')}`);
  dims.push({ key: 'action_availability', label: 'Action availability', status: !stops.allowed ? 'STOPPED' : settings.pilotMode, detail: actionDetail.join('; ') });
  return { dimensions: dims, freshness, connectors, calibration };
}

module.exports = { receivablesFreshness, connectorHealth, calibrationSummary, intelligenceHealth, humanAge };
