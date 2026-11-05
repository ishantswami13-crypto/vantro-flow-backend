'use strict';
// lib/connectors/apps/sync.js — read an app and write what it says into
// Starlane's invoices and customers.
//
// One sync = one connector_sync_runs row that ends 'succeeded' or 'failed'
// with counts, so the Sources page reports what really happened. The read
// goes through the connector SDK runtime (retries with backoff, honours
// Retry-After, never retries a refused key, rejects records missing a
// required field with a reason).
//
// Writing follows the ledger import's rules (lib/domain/decisions/ledgerImport.js):
//   - keyed on (user_id, source_type = the app id, source_id = the app's own
//     invoice id), so a re-sync updates the same rows and never duplicates;
//   - an invoice already present from another source (Tally, a file) with
//     the same customer and number is left alone and counted as skipped;
//   - paid / balance come from the app's own numbers, never inferred.
// Nothing is ever written back to the app.

const { createRuntime } = require('../sdk');
const { closeRun, closeStaleRuns, SYNC_RUN_TIMEOUT_MS } = require('../syncRuns');
const creds = require('../../domain/outbound/credentials');
const { parseBusinessDate, daysBetween, startOfUtcDay } = require('../../domain/decisions/dates');
const { normalizeName } = require('../../domain/decisions/snapshot');
const { provider, isLive, APP_IDS } = require('./index');
const accounts = require('./accounts');
const { safeLog } = require('../../observability/logger');

const LABEL = { zoho_books: 'Zoho Books', quickbooks: 'QuickBooks Online', razorpay: 'Razorpay', whatsapp_business: 'WhatsApp Business' };

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

const phoneOf = (p) => (p ? String(p).replace(/\D/g, '').slice(-10) || null : null);
const money = (n) => Math.round(Number(n) * 100) / 100;

async function ensureCustomer(client, userId, name, contact, cache) {
  const key = normalizeName(name);
  if (cache.has(key)) return cache.get(key);
  let id = (await client.query('SELECT id FROM customers WHERE user_id = $1 AND lower(name) = lower($2) ORDER BY created_at LIMIT 1', [userId, name])).rows[0]?.id;
  let created = false;
  if (!id) {
    const ins = await client.query(
      'INSERT INTO customers (user_id, name, phone, email, gstin) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',
      [userId, name, phoneOf(contact?.phone), contact?.email || null, contact?.gstin || null]
    );
    id = ins.rows[0]?.id || (await client.query('SELECT id FROM customers WHERE user_id = $1 AND lower(name) = lower($2) LIMIT 1', [userId, name])).rows[0]?.id || null;
    created = !!ins.rows[0];
  } else if (contact && (contact.phone || contact.email)) {
    // Fill gaps only; a number or address the owner typed is never replaced.
    await client.query('UPDATE customers SET phone = COALESCE(phone, $3), email = COALESCE(email, $4), updated_at = now() WHERE id = $1 AND user_id = $2',
      [id, userId, phoneOf(contact.phone), contact.email || null]);
  }
  const out = { id, created };
  cache.set(key, out);
  return out;
}

/** Pure: an app invoice record → the invoices row values. */
function toRow(rec, { asOf = Date.now() } = {}) {
  const amount = money(rec.amount);
  const balance = rec.balance === null || rec.balance === undefined ? amount : Math.max(0, money(rec.balance));
  const paid = Math.max(0, money(amount - balance));
  const fullyPaid = balance <= 0.005;
  const overdue = rec.dueOn && !fullyPaid ? Math.max(0, daysBetween(parseBusinessDate(rec.dueOn), startOfUtcDay(asOf))) : 0;
  return {
    invoice_number: rec.number || null,
    customer_name: String(rec.customerName || '').trim().replace(/\s+/g, ' '),
    invoice_amount: amount,
    payment_status: fullyPaid ? 'Paid' : 'Pending',
    payment_amount: paid > 0 ? paid : null,
    invoice_date: rec.issuedOn,
    due_date: rec.dueOn || null,
    payment_date: fullyPaid ? rec.paidOn || null : null,
    currency: rec.currency,
    days_overdue: overdue,
  };
}

async function writeInvoices(pool, userId, appId, records, customers, { asOf = Date.now() } = {}) {
  const contacts = new Map(customers.map((c) => [String(c.sourceId), c]));
  const counts = { inserted: 0, updated: 0, unchanged: 0, skippedOtherSource: 0, rejected: 0, customersCreated: 0, customersMatched: 0 };
  const rejected = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = new Map((await client.query(
      `SELECT id, source_id, invoice_amount, payment_status, payment_amount, payment_date::text AS payment_date, due_date::text AS due_date, invoice_date::text AS invoice_date, invoice_number
         FROM invoices WHERE user_id = $1 AND source_type = $2 AND source_id = ANY($3)`,
      [userId, appId, records.map((r) => r.sourceId)])).rows.map((r) => [r.source_id, r]));
    const numbers = records.filter((r) => r.number && !existing.has(r.sourceId)).map((r) => String(r.number).toLowerCase());
    const other = new Set(numbers.length ? (await client.query(
      `SELECT lower(customer_name) AS c, lower(invoice_number) AS n FROM invoices
        WHERE user_id = $1 AND COALESCE(source_type,'') <> $2 AND invoice_number IS NOT NULL AND lower(invoice_number) = ANY($3)`,
      [userId, appId, numbers])).rows.map((r) => `${normalizeName(r.c)}|${r.n}`) : []);
    const cache = new Map();
    for (const rec of records) {
      const contact = rec.customerRef ? contacts.get(String(rec.customerRef)) : null;
      const name = rec.customerName || contact?.name;
      if (!name) { counts.rejected++; rejected.push({ sourceId: rec.sourceId, reason: 'no customer name' }); continue; }
      if (!rec.issuedOn) { counts.rejected++; rejected.push({ sourceId: rec.sourceId, reason: 'no invoice date' }); continue; }
      const row = toRow({ ...rec, customerName: name }, { asOf });
      const prev = existing.get(rec.sourceId);
      if (!prev && row.invoice_number && other.has(`${normalizeName(row.customer_name)}|${row.invoice_number.toLowerCase()}`)) { counts.skippedOtherSource++; continue; }
      const cust = await ensureCustomer(client, userId, row.customer_name, contact || { phone: rec.customerPhone, email: rec.customerEmail }, cache);
      if (prev) {
        const same = Number(prev.invoice_amount) === row.invoice_amount && prev.payment_status === row.payment_status
          && Number(prev.payment_amount || 0) === Number(row.payment_amount || 0) && (prev.payment_date || null) === row.payment_date
          && (prev.due_date || null) === row.due_date && prev.invoice_date === row.invoice_date && (prev.invoice_number || null) === row.invoice_number;
        if (same) { counts.unchanged++; continue; }
        await client.query(
          `UPDATE invoices SET invoice_number = $3, invoice_amount = $4, payment_status = $5, payment_amount = $6, payment_date = $7, due_date = $8,
                  invoice_date = $9, currency = $10, days_overdue = $11, customer_id = COALESCE(customer_id, $12), updated_at = now()
            WHERE id = $1 AND user_id = $2`,
          [prev.id, userId, row.invoice_number, row.invoice_amount, row.payment_status, row.payment_amount, row.payment_date, row.due_date,
            row.invoice_date, row.currency, row.days_overdue, cust.id]
        );
        counts.updated++;
        continue;
      }
      await client.query(
        `INSERT INTO invoices (user_id, customer_id, customer_name, customer_phone, invoice_number, invoice_amount, payment_status, payment_amount,
                               invoice_date, due_date, payment_date, currency, days_overdue, source_type, source_id, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [userId, cust.id, row.customer_name, phoneOf(contact?.phone || rec.customerPhone), row.invoice_number, row.invoice_amount, row.payment_status,
          row.payment_amount, row.invoice_date, row.due_date, row.payment_date, row.currency, row.days_overdue, appId, rec.sourceId, `Synced from ${LABEL[appId] || appId}`]
      );
      counts.inserted++;
    }
    for (const c of cache.values()) { if (c.created) counts.customersCreated++; else counts.customersMatched++; }
    await client.query('COMMIT');
    return { counts, rejected };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Syncs one tenant's app now. Returns { runId, counts, rejected } or throws
 * with a status the route can return.
 */
async function syncApp(pool, userId, appId, { asOf = Date.now(), runtimeOptions = {} } = {}) {
  const p = provider(appId);
  if (!p) throw httpError(404, 'Unknown connector');
  if (!isLive(appId)) throw httpError(409, `${LABEL[appId]} is not switched on on this server yet.`, { code: 'CONNECTOR_NOT_LIVE' });
  if (!p.entities.length) throw httpError(400, `${LABEL[appId]} sends messages to Starlane as they arrive; there is nothing to sync.`);
  const account = await accounts.getAccount(pool, userId, appId);
  if (!account) throw httpError(409, `Connect ${LABEL[appId]} first.`);
  if (account.status === 'AUTH_REQUIRED') throw httpError(409, `${LABEL[appId]} needs to be connected again: ${account.status_reason || 'its access was refused.'}`, { code: 'AUTH_REQUIRED' });

  await closeStaleRuns(pool, userId, { connectorId: appId }).catch(() => 0);
  const running = await pool.query(
    `SELECT id FROM connector_sync_runs WHERE user_id = $1 AND connector_id = $2 AND status = 'running' AND started_at > now() - ($3::int * interval '1 millisecond') LIMIT 1`,
    [userId, appId, SYNC_RUN_TIMEOUT_MS]);
  if (running.rows[0]) throw httpError(409, `${LABEL[appId]} is already syncing.`, { code: 'SYNC_RUNNING' });
  const run = (await pool.query(`INSERT INTO connector_sync_runs (user_id, connector_id, status, client_version) VALUES ($1,$2,'running',$3) RETURNING id`,
    [userId, appId, `${appId}@${p.connector.version}`])).rows[0];

  try {
    const { get, phoneNumberId } = await accounts.clientFor(pool, account);
    const runtime = createRuntime(p.connector, { credentials: { get, phoneNumberId }, maxAttempts: 3, ...runtimeOptions });
    const customers = p.entities.includes('customer') ? (await runtime.read('customer')).records : [];
    const invoices = await runtime.read('invoice');
    const written = await writeInvoices(pool, userId, appId, invoices.records, customers, { asOf });
    const rejected = [...invoices.rejected.map((r) => ({ sourceId: r.sourceId ?? null, reason: r.reason })), ...written.rejected];
    const imported = written.counts.inserted + written.counts.updated + written.counts.unchanged;
    await closeRun(pool, { id: run.id, userId, status: 'succeeded', imported, rejected: rejected.length,
      message: rejected.length ? `${rejected.length} record(s) could not be read: ${rejected.slice(0, 3).map((r) => r.reason).join('; ')}` : null });
    await pool.query('UPDATE app_connector_accounts SET last_sync_at = now(), last_success_at = now(), last_error = NULL, updated_at = now() WHERE id = $1 AND user_id = $2', [account.id, userId]);
    await pool.query('UPDATE connector_sync_runs SET records_received = $3 WHERE id = $1 AND user_id = $2', [run.id, userId, invoices.records.length + invoices.rejected.length]).catch(() => {});
    return { runId: run.id, counts: { ...written.counts, rejected: rejected.length }, rejected: rejected.slice(0, 20) };
  } catch (err) {
    const message = creds.redact(String(err.message || err)).slice(0, 400);
    await closeRun(pool, { id: run.id, userId, status: 'failed', code: err.kind ? String(err.kind).toLowerCase() : 'sync_failed', message }).catch(() => {});
    await pool.query('UPDATE app_connector_accounts SET last_sync_at = now(), last_error = $3, updated_at = now() WHERE id = $1 AND user_id = $2', [account.id, userId, message]).catch(() => {});
    if (err.kind === 'AUTH_EXPIRED') {
      await accounts.markAuthRequired(pool, userId, appId, message);
      throw httpError(409, `${LABEL[appId]} refused Starlane’s access. Connect it again. (${message})`, { code: 'AUTH_REQUIRED' });
    }
    if (err.kind) throw httpError(502, `${LABEL[appId]} sync failed: ${message}`, { code: err.kind });
    throw err;
  }
}

/** Every connected account of every Live app that reads data. For the cron. */
async function syncAllApps(pool, { limit = 500 } = {}) {
  const ids = APP_IDS.filter((id) => isLive(id) && provider(id).entities.length);
  const out = { accounts: 0, succeeded: 0, failed: 0, authRequired: 0 };
  if (!ids.length) return out;
  const r = await pool.query(`SELECT user_id, connector_id FROM app_connector_accounts WHERE status = 'CONNECTED' AND connector_id = ANY($1) ORDER BY last_sync_at NULLS FIRST LIMIT $2`, [ids, limit]);
  for (const a of r.rows) {
    out.accounts++;
    try {
      await syncApp(pool, a.user_id, a.connector_id);
      out.succeeded++;
    } catch (err) {
      if (err.code === 'AUTH_REQUIRED') out.authRequired++;
      else if (err.code !== 'SYNC_RUNNING') out.failed++;
      safeLog('warn', '[app-connectors] sync failed', { userId: a.user_id, connectorId: a.connector_id, error: creds.redact(String(err.message)) });
    }
  }
  return out;
}

module.exports = { syncApp, syncAllApps, writeInvoices, toRow, LABEL };
