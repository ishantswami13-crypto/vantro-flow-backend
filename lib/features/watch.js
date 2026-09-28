'use strict';
// lib/features/watch.js — WATCH: what changed in the business that needs
// attention, as durable events with a state.
//
// detect() is pure: given the company's current records it returns the
// conditions that are true right now, each with a stable dedupe key.
// refresh() reconciles those with watch_events:
//   - a new condition inserts one event (state 'open'); re-detection only
//     bumps last_seen_at — never a duplicate, never a second push
//   - a condition that stopped being true resolves its event with a reason
//     (paid, moved to the next overdue band, sync recovered)
//   - an owner-dismissed event stays dismissed
// High and critical new events notify (canonical notification + push);
// push text carries no customer names or amounts.

const { fact, evidence, n, OPEN_SQL, OPEN_AMOUNT_SQL, withLiveOverdue, billLabel } = require('./core');

const OVERDUE_STEPS = Object.freeze([
  { from: 1, to: 7, band: '1', severity: 'low', label: 'is overdue' },
  { from: 8, to: 30, band: '8', severity: 'normal', label: 'is more than a week overdue' },
  { from: 31, to: 90, band: '31', severity: 'high', label: 'is more than 30 days overdue' },
  { from: 91, to: Infinity, band: '91', severity: 'critical', label: 'is more than 90 days overdue' },
]);
const STALE_SYNC_MS = 24 * 3600 * 1000;
const PUSH_BURST = 3;
const AUTO_RESOLVING = new Set(['invoice_overdue', 'sync_failed', 'sync_stale', 'promise_broken']);
const inr = (v) => `₹${Math.round(n(v)).toLocaleString('en-IN')}`;

function detect({ invoices = [], connectors = [], triggeredWatches = [], brokenPromises = [], now = Date.now() }) {
  const out = [];
  for (const inv of invoices) {
    const d = n(inv.days_overdue);
    if (d < 1 || inv.dunning_paused) continue;
    const step = OVERDUE_STEPS.find((s) => d >= s.from && d <= s.to);
    const who = inv.customer_name || 'A customer';
    out.push({
      kind: 'invoice_overdue',
      dedupe_key: `invoice_overdue:${inv.id}:${step.band}`,
      severity: step.severity,
      title: `${who}: invoice ${inv.invoice_number ? `${billLabel(inv.invoice_number)} ` : ''}${step.label}`,
      detail: `${inr(inv.invoice_amount)} outstanding, ${d} days past due.`,
      entity_type: 'invoice', entity_id: String(inv.id),
      evidence: evidence({
        summary: `Due ${inv.due_date || 'date not recorded'}; ${d} days overdue today.`,
        facts: [
          fact('Customer', who, { source: 'invoices', ids: [inv.id] }),
          fact('Amount outstanding', n(inv.invoice_amount), { unit: 'INR', source: 'invoices', ids: [inv.id] }),
          fact('Due date', inv.due_date || null, { source: 'invoices', ids: [inv.id] }),
          fact('Days overdue', d, { kind: 'calculated', source: 'invoices', ids: [inv.id], note: 'Today minus the due date (or the invoice date when no due date was recorded).' }),
          ...(inv.source_type ? [fact('Came from', inv.source_type, { source: 'invoices', ids: [inv.id] })] : []),
        ],
        sources: ['invoices'],
        method: `Overdue band ${step.from}${step.to === Infinity ? '+' : `–${step.to}`} days`,
      }),
      push: step.severity === 'high' || step.severity === 'critical'
        ? { title: step.severity === 'critical' ? 'An invoice passed 90 days overdue' : 'An invoice passed 30 days overdue', body: 'Open Starlane to see who and what to do.' }
        : null,
    });
  }
  for (const c of connectors) {
    if (c.availability !== 'available' || c.authType === 'public_feed') continue;
    const last = c.state?.lastAttempt;
    if (c.state?.health === 'error' && last?.status === 'failed') {
      out.push({
        kind: 'sync_failed', dedupe_key: `sync_failed:${c.id}:${last.id}`, severity: 'high',
        title: `${c.name} sync failed`, detail: last.error ? String(last.error).slice(0, 240) : 'The latest sync did not complete.',
        entity_type: 'connector', entity_id: c.id,
        evidence: evidence({ summary: 'The latest sync attempt ended in failure.', facts: [
          fact('Attempt started', last.startedAt, { source: 'connector_sync_runs', ids: [last.id] }),
          fact('Error', last.error || null, { source: 'connector_sync_runs', ids: [last.id] }),
        ], sources: ['connector_sync_runs'] }),
        push: { title: `${c.name} sync failed`, body: 'Starlane is working from older data until it syncs again.' },
      });
    }
    const lastOk = c.state?.lastSuccessAt ? Date.parse(c.state.lastSuccessAt) : null;
    if (lastOk && now - lastOk > STALE_SYNC_MS && c.authType === 'local_bridge') {
      const day = new Date(lastOk).toISOString().slice(0, 10);
      out.push({
        kind: 'sync_stale', dedupe_key: `sync_stale:${c.id}:${day}`, severity: 'normal',
        title: `${c.name} has not synced since ${day}`, detail: 'Figures may be behind your books. Open the Starlane app on the computer that runs Tally.',
        entity_type: 'connector', entity_id: c.id,
        evidence: evidence({ summary: 'Last successful sync is more than 24 hours old.', facts: [
          fact('Last successful sync', c.state.lastSuccessAt, { source: 'connector_sync_runs' }),
        ], sources: ['connector_sync_runs'] }),
        push: null,
      });
    }
  }
  for (const w of triggeredWatches) {
    out.push({
      kind: 'watch_triggered', dedupe_key: `watch_triggered:${w.watch_id}:${w.evaluation_id}`,
      severity: ['high', 'critical'].includes(w.severity) ? w.severity : w.severity === 'low' ? 'low' : 'normal',
      title: `Condition met: ${w.name}`, detail: w.description || null,
      entity_type: 'watch', entity_id: String(w.watch_id),
      evidence: evidence({ summary: 'A condition you set was met when it was last checked.', facts: [
        fact('Checked at', w.evaluated_at, { source: 'watch_evaluations', ids: [w.evaluation_id] }),
        fact('Value found', w.result_value ?? null, { source: 'watch_evaluations', ids: [w.evaluation_id] }),
      ], sources: ['watch_evaluations'] }),
      push: ['high', 'critical'].includes(w.severity) ? { title: 'A condition you watch was met', body: 'Open Starlane to see it.' } : null,
    });
  }
  for (const p of brokenPromises) {
    out.push({
      kind: 'promise_broken', dedupe_key: `promise_broken:${p.id}`, severity: 'high',
      title: `${p.customer_name || 'A customer'} missed a payment promise`,
      detail: `Promised ${p.promised_amount ? inr(p.promised_amount) : 'a payment'} by ${String(p.promised_date).slice(0, 10)}.`,
      entity_type: 'promise', entity_id: String(p.id),
      evidence: evidence({ summary: 'The promised date passed with the promise still open.', facts: [
        fact('Promised date', String(p.promised_date).slice(0, 10), { source: 'promises', ids: [p.id] }),
        fact('Promised amount', p.promised_amount != null ? n(p.promised_amount) : null, { unit: 'INR', source: 'promises', ids: [p.id] }),
      ], sources: ['promises'] }),
      push: { title: 'A customer missed a payment promise', body: 'Open Starlane to see who.' },
    });
  }
  return out;
}

// Why an auto-resolving event stopped being true.
function resolutionFor(event, stillOpenInvoiceIds) {
  if (event.kind === 'invoice_overdue') return stillOpenInvoiceIds.has(event.entity_id) ? 'moved_to_next_band' : 'paid_or_removed';
  if (event.kind === 'sync_failed') return 'sync_recovered';
  if (event.kind === 'sync_stale') return 'sync_recovered';
  if (event.kind === 'promise_broken') return 'promise_closed';
  return 'cleared';
}

const TRANSITIONS = Object.freeze({
  open: ['acknowledged', 'dismissed', 'resolved'],
  acknowledged: ['dismissed', 'resolved', 'open'],
  resolved: [],
  dismissed: ['open'],
});
const canMove = (from, to) => (TRANSITIONS[from] || []).includes(to);

async function gather(pool, userId) {
  const q = (sql, p) => pool.query(sql, p).then((r) => r.rows).catch(() => null);
  // Days overdue come from the due date (the stored column goes stale).
  const invoices = withLiveOverdue(await q(
    `SELECT id, customer_name, invoice_number, ${OPEN_AMOUNT_SQL} AS invoice_amount, days_overdue, due_date, dunning_paused, source_type
       FROM invoices WHERE user_id = $1 AND ${OPEN_SQL}`, [userId]));
  const { getConnectorStates } = require('../connectors/state');
  const connectors = await getConnectorStates(pool, userId).catch(() => null);
  const triggeredWatches = await q(
    `SELECT DISTINCT ON (w.id) w.id AS watch_id, w.name, w.description, w.severity, e.id AS evaluation_id, e.evaluated_at, e.result_value
       FROM watch_evaluations e JOIN watches w ON w.id = e.watch_id
      WHERE e.user_id = $1 AND w.user_id = $1 AND w.status = 'active' AND e.triggered
      ORDER BY w.id, e.evaluated_at DESC`, [userId]);
  const brokenPromises = await q(
    `SELECT p.id, p.promised_amount, p.promised_date, c.name AS customer_name
       FROM promises p LEFT JOIN customers c ON c.id = p.customer_id AND c.user_id = p.user_id
      WHERE p.user_id = $1 AND (p.status = 'broken' OR (p.status = 'active' AND p.promised_date < CURRENT_DATE))`, [userId]);
  return { invoices, connectors, triggeredWatches, brokenPromises };
}

/**
 * Reconcile detected conditions with stored events. Parts that failed to load
 * are skipped entirely (neither created nor resolved), so a failed read never
 * looks like "everything got paid".
 */
async function refresh(pool, userId, { notifyFn = null, now = Date.now() } = {}) {
  const data = await gather(pool, userId);
  const loaded = {
    invoice_overdue: data.invoices !== null,
    sync_failed: data.connectors !== null, sync_stale: data.connectors !== null,
    watch_triggered: data.triggeredWatches !== null, promise_broken: data.brokenPromises !== null,
  };
  const found = detect({
    invoices: data.invoices || [], connectors: data.connectors || [],
    triggeredWatches: data.triggeredWatches || [], brokenPromises: data.brokenPromises || [], now,
  });
  let created = 0, resolved = 0;
  const toPush = [];
  // Set-based upsert in chunks: one statement per 500 conditions, not one per
  // invoice. Unchanged, recently seen events are not rewritten.
  const byKey = new Map(found.map((c) => [c.dedupe_key, c]));
  for (let i = 0; i < found.length; i += 500) {
    const chunk = found.slice(i, i + 500).map((c) => ({
      kind: c.kind, dedupe_key: c.dedupe_key, severity: c.severity, title: c.title.slice(0, 200), detail: c.detail,
      entity_type: c.entity_type, entity_id: c.entity_id, evidence: c.evidence,
    }));
    const { rows } = await pool.query(
      `INSERT INTO watch_events (user_id, kind, dedupe_key, severity, title, detail, entity_type, entity_id, evidence)
       SELECT $1, r.kind, r.dedupe_key, r.severity, r.title, r.detail, r.entity_type, r.entity_id, r.evidence
         FROM jsonb_to_recordset($2::jsonb) AS r(kind text, dedupe_key text, severity text, title text, detail text, entity_type text, entity_id text, evidence jsonb)
       ON CONFLICT (user_id, dedupe_key) DO UPDATE SET last_seen_at = now(), evidence = EXCLUDED.evidence, detail = EXCLUDED.detail
         WHERE watch_events.detail IS DISTINCT FROM EXCLUDED.detail OR watch_events.last_seen_at < now() - interval '1 hour'
       RETURNING id, dedupe_key, (xmax = 0) AS inserted`,
      [userId, JSON.stringify(chunk)]);
    for (const r of rows) {
      if (!r.inserted) continue;
      created++;
      const c = byKey.get(r.dedupe_key);
      if (c?.push) toPush.push({ c, id: r.id });
    }
  }
  // A first sync of an older business can surface dozens of conditions at
  // once; that becomes one summary notification, not a burst of pushes.
  if (notifyFn && toPush.length > PUSH_BURST) {
    await notifyFn({
      type: 'business_change', severity: toPush.some((p) => p.c.severity === 'critical') ? 'critical' : 'high',
      title: `${toPush.length} things need attention`, body: 'Open Watch in Starlane to see them.',
      entity: null, route: '/watch', dedupeKey: `watch:burst:${new Date(now).toISOString().slice(0, 13)}`,
    }).catch(() => null);
  } else if (notifyFn) {
    for (const { c, id } of toPush) {
      await notifyFn({
        type: c.kind.startsWith('sync_') ? 'connector_error' : 'business_change',
        severity: c.severity === 'critical' ? 'critical' : 'high',
        title: c.push.title, body: c.push.body,
        entity: { type: 'watch_event', id }, route: `/watch/${id}`,
        dedupeKey: `watch:${c.dedupe_key}`,
      }).catch(() => null);
    }
  }
  const current = new Set(found.map((c) => c.dedupe_key));
  const openInvoiceIds = new Set((data.invoices || []).map((i) => String(i.id)));
  const { rows: live } = await pool.query(
    `SELECT id, kind, dedupe_key, entity_id FROM watch_events WHERE user_id = $1 AND state IN ('open','acknowledged')`, [userId]);
  const gone = live.filter((e) => AUTO_RESOLVING.has(e.kind) && loaded[e.kind] && !current.has(e.dedupe_key));
  if (gone.length) {
    await pool.query(
      `UPDATE watch_events w SET state = 'resolved', resolved_at = now(), resolution = g.resolution
         FROM unnest($2::uuid[], $3::text[]) AS g(id, resolution)
        WHERE w.id = g.id AND w.user_id = $1 AND w.state IN ('open','acknowledged')`,
      [userId, gone.map((e) => e.id), gone.map((e) => resolutionFor(e, openInvoiceIds))]);
    resolved = gone.length;
  }
  return { detected: found.length, created, resolved, pushed: notifyFn ? Math.min(toPush.length, toPush.length > PUSH_BURST ? 1 : toPush.length) : 0, partial: Object.values(loaded).some((v) => !v) };
}

function shapeEvent(r) {
  return {
    id: r.id, kind: r.kind, severity: r.severity, state: r.state, title: r.title, detail: r.detail,
    entity: r.entity_type ? { type: r.entity_type, id: r.entity_id } : null,
    evidence: r.evidence, missionId: r.mission_id || null,
    firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, acknowledgedAt: r.acknowledged_at,
    resolvedAt: r.resolved_at, resolution: r.resolution,
  };
}

module.exports = { PUSH_BURST, detect, refresh, shapeEvent, canMove, TRANSITIONS, OVERDUE_STEPS, resolutionFor };
