'use strict';
// lib/connectors/feeds/feeds.js — data feeds: keep a business's products,
// bills of materials, customer orders and purchase orders flowing in from the
// software it already uses, without uploading files by hand.
//
// A feed is a source (lib/connectors/feeds/sources.js) plus the import
// choices the owner confirmed once (column mapping, date order, source
// system name, currency, who books stock). Each run:
//
//   read the source -> one CSV/XLSX file -> commitOperationalImport()
//
// so every source gets exactly what an upload gets: the same validation,
// stable row identity (a re-run updates rows, never duplicates them), the
// same review rules (an unknown product is held, never created from an order),
// a file_import_batches row, raw observations and an OPERATIONS_IMPORTED
// audit event. Identical data with identical choices is one import: a run
// over unchanged data is recorded as "unchanged" and writes nothing.
//
// A feed never guesses a mapping on its own. If the source's columns change
// so the confirmed mapping no longer fits, or a push brings columns the owner
// has not confirmed, the run writes nothing and the feed moves to
// NEEDS_ATTENTION with the reason, until the owner confirms again.
//
// Nothing here writes to any outside system. Every query filters by user_id.

const crypto = require('crypto');
const creds = require('../../domain/outbound/credentials');
const { safeLog } = require('../../observability/logger');
const { previewOperationalImport, commitOperationalImport, KINDS, KIND_ERROR, FIELDS } = require('../../domain/operations/operationalImport');
const { readSource, fromPush, fromTally, normalizeFileUrl, checkHeader } = require('./sources');
const { checkSftpConfig, checkSftpSecret } = require('./sftp');
const { checkEmailConfig } = require('./emailDrop');
const { TALLY_KINDS } = require('./tallyOps');
const { parseSheetUrl } = require('../sheetLink');
const { CANONICAL, canonicalInput, feedError } = require('./tabular');
const { provider, isLive, APP_IDS } = require('../apps');

const SOURCE_TYPES = ['sheet_link', 'file_url', 'push', 'app', 'tally', 'sftp', 'email'];
// Sources that bring their own data on their own schedule (no interval here).
const ARRIVING = new Set(['push', 'tally']);
const INTERVALS = [15, 30, 60, 180, 360, 720, 1440, 10080];
const STALE_RUN_MS = 15 * 60 * 1000;
const KIND_LABEL = { products: 'Products and stock', components: 'Bill of materials', orders: 'Customer orders', purchase_lines: 'Purchase orders' };
const FIELD_TEXT = {
  sku_or_product_name: 'SKU or product name', finished_sku_or_name: 'finished product SKU or name', component_sku_or_name: 'component SKU or name',
  order_ref: 'order number', po_ref: 'purchase order number', customer_name: 'customer name', supplier_name: 'supplier name',
  quantity: 'quantity', product_name: 'product name', quantity_per_unit: 'quantity per finished unit',
};
const PUSH_KEY_RE = /^slf_[A-Za-z0-9_-]{43}$/;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newPushKey = () => `slf_${crypto.randomBytes(32).toString('base64url')}`;

function feedActor(feedId, userId) {
  return { type: 'system', id: `starlane.data_feed:${feedId}`, onBehalfOf: String(userId) };
}

function view(row) {
  if (!row) return null;
  const src = row.source_config || {};
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    kindLabel: KIND_LABEL[row.kind],
    sourceType: row.source_type,
    source: {
      url: row.source_type === 'sheet_link' || row.source_type === 'file_url' ? src.url || null : null,
      connectorId: row.source_type === 'app' ? src.connectorId || null : null,
      headerName: row.source_type === 'file_url' && row.secret_enc ? src.headerName || null : null,
      hasHeader: row.source_type === 'file_url' ? !!row.secret_enc : null,
      ...(row.source_type === 'sftp' ? {
        host: src.host, port: src.port, username: src.username, folder: src.folder, pattern: src.pattern,
        authKind: src.authKind || null, hostKey: (row.source_state || {}).hostKey || null, lastFile: (row.source_state || {}).lastFile || null,
      } : {}),
      ...(row.source_type === 'email' ? { from: src.from, subject: src.subject || null, filename: src.filename || null, lastReceivedAt: (row.source_state || {}).lastReceivedAt || null } : {}),
      ...(row.source_type === 'tally' ? { company: src.company || null } : {}),
    },
    mapping: row.mapping,
    autoMapping: !!(row.mapping && row.mapping.auto),
    intervalMinutes: row.interval_minutes,
    status: row.status,
    statusReason: row.status_reason,
    nextRunAt: row.status === 'ACTIVE' ? row.next_run_at : null,
    lastRunAt: row.last_run_at,
    lastSuccessAt: row.last_success_at,
    lastBatchId: row.last_batch_id,
    pushPath: row.source_type === 'push' ? '/api/feeds/in' : null,
    createdAt: row.created_at,
  };
}

function runView(r) {
  return {
    id: r.id, trigger: r.trigger, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at,
    rowsReceived: r.rows_received, rowsAccepted: r.rows_accepted, rowsRejected: r.rows_rejected, rowsReview: r.rows_review,
    batchId: r.batch_id, error: r.error, details: r.details || {},
  };
}

// ── Input checks (pure) ─────────────────────────────────────────────────

function checkKind(kind) {
  if (!KINDS.includes(kind)) throw feedError(KIND_ERROR);
  return kind;
}

function checkInterval(v, sourceType) {
  if (v === null || v === undefined || v === '' || ARRIVING.has(sourceType)) return null;
  const n = Number(v);
  if (!INTERVALS.includes(n)) throw feedError(`Run every ${INTERVALS.join(', ')} minutes, or leave it empty to run only when you press Run now.`);
  return n;
}

/** Pure: the source config to store (non-secret) and the secret to encrypt. */
function checkSource(sourceType, source = {}, kind) {
  if (!SOURCE_TYPES.includes(sourceType)) throw feedError(`source type must be one of ${SOURCE_TYPES.join(', ')}`);
  if (sourceType === 'sheet_link') {
    parseSheetUrl(source.url);
    return { config: { url: String(source.url).trim() }, secret: null };
  }
  if (sourceType === 'file_url') {
    const url = normalizeFileUrl(source.url);
    const header = checkHeader(source.header);
    return { config: { url, ...(header ? { headerName: header.name } : {}) }, secret: header };
  }
  if (sourceType === 'app') {
    const id = String(source.connectorId || '');
    const p = APP_IDS.includes(id) ? provider(id) : null;
    if (!p || !p.feedKinds) throw feedError('Choose a connected app that can feed records.');
    if (!p.feedKinds.includes(kind)) throw feedError(`That app can feed ${p.feedKinds.map((k) => KIND_LABEL[k].toLowerCase()).join(' and ')}, not ${KIND_LABEL[kind].toLowerCase()}.`);
    return { config: { connectorId: id }, secret: null };
  }
  if (sourceType === 'sftp') {
    const secret = checkSftpSecret(source);
    return { config: { ...checkSftpConfig(source), authKind: secret.privateKey ? 'key' : 'password' }, secret };
  }
  if (sourceType === 'email') return { config: checkEmailConfig(source), secret: null };
  if (sourceType === 'tally') {
    if (!TALLY_KINDS.includes(kind)) throw feedError('Tally can feed customer orders, purchase orders and stock items, not bills of materials.');
    const company = String(source.company || '').trim().replace(/\s+/g, ' ');
    if (company.length > 100) throw feedError('The Tally company name is too long.');
    return { config: company ? { company } : {}, secret: null };
  }
  return { config: {}, secret: null };
}

/** Pure: the stored import choices. `auto` = use the import's own proposal when it needs no confirmation. */
function checkMapping(kind, input = {}) {
  const sourceSystem = String(input.sourceSystem == null ? '' : input.sourceSystem).trim().replace(/\s+/g, ' ');
  if (!sourceSystem || sourceSystem.length > 60 || !/^[\p{L}\p{N} ._&()/-]+$/u.test(sourceSystem)) throw feedError('Name the system these records come from (for example "Shopify" or "Orders sheet"), up to 60 characters.');
  const out = { sourceSystem, currency: input.currency ? String(input.currency).toUpperCase() : null, reviewChoices: {} };
  if (kind === 'purchase_lines') {
    if (input.stockFollows !== 'STARLANE' && input.stockFollows !== 'EXTERNAL') throw feedError('Say who records stock when these goods arrive: Starlane, or your accounting system.');
    out.stockFollows = input.stockFollows;
  }
  if (input.auto) return { ...out, auto: true };
  if (!input.mapping || typeof input.mapping !== 'object' || !Object.keys(input.mapping).length) throw feedError('Confirm the column mapping first.');
  out.mapping = {};
  for (const [f, h] of Object.entries(input.mapping)) {
    if (!FIELDS[kind][f]) throw feedError(`unknown field "${f}"`);
    if (h != null && h !== '') out.mapping[f] = String(h).slice(0, 200);
  }
  out.dateOrders = {};
  for (const [h, o] of Object.entries(input.dateOrders || {})) {
    if (o !== 'DMY' && o !== 'MDY') throw feedError('Date order must be DMY or MDY.');
    out.dateOrders[String(h).slice(0, 200)] = o;
  }
  return out;
}

// ── Reading a source and planning the import ────────────────────────────

/**
 * The input to hand the import for this file. Fixed mapping: as confirmed.
 * Auto: the import's own proposal, only when it needs no human answer.
 */
async function resolveInput(pool, userId, kind, file, mapping) {
  if (!mapping.auto) {
    const { auto, ...fixed } = mapping;
    return { input: fixed };
  }
  const preview = await previewOperationalImport(pool, userId, kind, file.buffer, file.filename, null);
  if (!preview.ok) return { problem: preview.error };
  const p = preview.proposal;
  const questions = [...(p.needsConfirmation || []).map((q) => q.message), ...(p.missingRequired || []).map((f) => `No column for the ${FIELD_TEXT[f] || f.replace(/_/g, ' ')}.`)];
  if (questions.length) return { problem: `These columns need your confirmation before they are imported: ${questions.slice(0, 5).join(' ')}`, columns: preview.file.columns };
  const s = preview.suggestedInput;
  return { input: { mapping: s.mapping, dateOrders: s.dateOrders, sourceSystem: mapping.sourceSystem, currency: mapping.currency, ...(kind === 'purchase_lines' ? { stockFollows: mapping.stockFollows } : {}), reviewChoices: {} } };
}

async function readFeedSource(pool, row) {
  const secret = row.secret_enc ? creds.decrypt(row.secret_enc) : null;
  if (row.secret_enc && !secret) throw feedError(`The saved ${row.source_type === 'sftp' ? 'SFTP password or key' : 'request header'} cannot be read on this server (OUTBOUND_CREDENTIALS_KEY changed or missing). Delete the feed and add it again.`, 503);
  return readSource(pool, row.user_id, { sourceType: row.source_type, source: row.source_config || {}, kind: row.kind, secret, state: row.source_state || {} });
}

/**
 * Preview for a feed being set up: reads the source once and returns the
 * import's preview (proposal, suggested input, summary). Writes nothing.
 */
async function previewFeed(pool, userId, body = {}) {
  const kind = checkKind(String(body.kind || ''));
  const sourceType = String(body.sourceType || '');
  const { config, secret } = checkSource(sourceType, body.source || {}, kind);
  let file;
  if (sourceType === 'tally') {
    // Nothing to read until the bridge sends; the columns are Starlane's own.
    return { ok: true, kind, sourceType, columns: columnsFor(kind), file: null, preview: null };
  }
  if (sourceType === 'push') {
    if (body.sample === undefined || body.sample === null || body.sample === '') {
      return { ok: true, kind, sourceType, columns: columnsFor(kind), file: null, preview: null };
    }
    file = fromPush(typeof body.sample === 'string' ? body.sample : body.sample);
  } else {
    file = await readSource(pool, userId, { sourceType, source: config, kind, secret });
  }
  const base = { ok: true, kind, sourceType, columns: columnsFor(kind), rowsReceived: file.rowsReceived, truncated: !!file.truncated, ...(file.origin ? { origin: file.origin } : {}), ...(file.state?.hostKey ? { hostKey: file.state.hostKey } : {}) };
  if (!file.buffer.length) return { ...base, empty: true, note: file.note || null, preview: null };
  // App rows use the import's own column names: confirmed up front.
  const mappingInput = sourceType === 'app'
    ? canonicalInput(kind, headerLine(file.buffer), { sourceSystem: file.label || config.connectorId, currency: file.currency, stockFollows: body.mapping?.stockFollows || undefined })
    : body.mapping || null;
  const preview = await previewOperationalImport(pool, userId, kind, file.buffer, file.filename, mappingInput);
  if (!preview.ok) throw feedError(preview.error, preview.status || 400);
  return { ...base, preview, suggestedInput: sourceType === 'app' ? mappingInput : preview.suggestedInput };
}

function headerLine(buffer) {
  const first = buffer.toString('utf8').split(/\r?\n/, 1)[0] || '';
  return first.split(',').map((h) => h.replace(/^"|"$/g, '').replace(/""/g, '"'));
}

/** The column names the import recognises for a kind (for the push API docs). */
function columnsFor(kind) {
  return Object.entries(FIELDS[kind]).map(([field, def]) => ({
    field, column: CANONICAL[kind][field] || field, required: !!def.required, type: def.kind, alsoAccepted: def.aliases.slice(0, 6),
  }));
}

// ── CRUD ────────────────────────────────────────────────────────────────

async function listFeeds(pool, userId) {
  const r = await pool.query('SELECT * FROM data_feeds WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200', [userId]);
  const last = await pool.query(
    `SELECT DISTINCT ON (feed_id) * FROM data_feed_runs WHERE user_id = $1 ORDER BY feed_id, started_at DESC`, [userId]);
  const byFeed = new Map(last.rows.map((x) => [x.feed_id, runView(x)]));
  return r.rows.map((row) => ({ ...view(row), lastRun: byFeed.get(row.id) || null }));
}

async function getFeedRow(pool, userId, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw feedError('Feed not found', 404);
  const r = await pool.query('SELECT * FROM data_feeds WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!r.rows[0]) throw feedError('Feed not found', 404);
  return r.rows[0];
}

/** Creates a feed. A push feed returns its key once; it is stored only as a hash. */
async function createFeed(pool, userId, body = {}) {
  const kind = checkKind(String(body.kind || ''));
  const sourceType = String(body.sourceType || '');
  const { config, secret } = checkSource(sourceType, body.source || {}, kind);
  const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 80) || `${KIND_LABEL[kind]} from ${sourceType.replace('_', ' ')}`;
  let mapping;
  if (sourceType === 'app') {
    // Columns are Starlane's own; the mapping is built at each run from them.
    const p = provider(config.connectorId);
    mapping = checkMapping(kind, { ...(body.mapping || {}), sourceSystem: body.mapping?.sourceSystem || (p && p.id ? labelFor(p.id) : 'App'), auto: true });
    mapping.canonical = true;
  } else if (sourceType === 'tally') {
    // Tally books stock itself through its vouchers (the Tally sync), so a
    // purchase order received there never moves Starlane's stock a second time.
    mapping = checkMapping(kind, { sourceSystem: body.mapping?.sourceSystem || (config.company ? `Tally ${config.company}`.slice(0, 60) : 'Tally'), stockFollows: kind === 'purchase_lines' ? 'EXTERNAL' : undefined, auto: true });
    mapping.canonical = true;
  } else {
    mapping = checkMapping(kind, body.mapping || {});
  }
  const interval = checkInterval(body.intervalMinutes, sourceType);
  if (secret && !creds.available()) throw feedError(`OUTBOUND_CREDENTIALS_KEY is not set, so the ${sourceType === 'sftp' ? 'SFTP password or key' : 'header'} cannot be stored safely.`, 503);
  const key = sourceType === 'push' ? newPushKey() : null;
  const r = await pool.query(
    `INSERT INTO data_feeds (user_id, name, kind, source_type, source_config, secret_enc, push_token_hash, mapping, interval_minutes, next_run_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $9::int IS NULL THEN NULL ELSE now() + ($9::int * interval '1 minute') END) RETURNING *`,
    [userId, name, kind, sourceType, JSON.stringify(config), secret ? creds.encrypt(secret) : null, key ? sha256(key) : null, JSON.stringify(mapping), interval]
  );
  return { feed: view(r.rows[0]), pushKey: key };
}

function labelFor(connectorId) {
  return { shopify: 'Shopify', woocommerce: 'WooCommerce', zoho_inventory: 'Zoho Inventory', quickbooks: 'QuickBooks Online', xero: 'Xero' }[connectorId] || connectorId;
}

async function updateFeed(pool, userId, id, body = {}) {
  const row = await getFeedRow(pool, userId, id);
  const sets = [];
  const vals = [id, userId];
  const set = (sql, v) => { vals.push(v); sets.push(sql.replace('?', `$${vals.length}`)); };
  if (body.name !== undefined) set('name = ?', String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 80) || row.name);
  if (body.intervalMinutes !== undefined) {
    const n = checkInterval(body.intervalMinutes, row.source_type);
    set('interval_minutes = ?', n);
    sets.push(`next_run_at = CASE WHEN interval_minutes IS NULL THEN NULL ELSE now() + (interval_minutes * interval '1 minute') END`);
  }
  if (body.mapping !== undefined && row.source_type !== 'app' && row.source_type !== 'tally') {
    set('mapping = ?', JSON.stringify(checkMapping(row.kind, body.mapping)));
    // Confirming the mapping again is what clears NEEDS_ATTENTION.
    if (row.status === 'NEEDS_ATTENTION') sets.push(`status = 'ACTIVE', status_reason = NULL`);
  }
  if (body.status !== undefined) {
    if (!['ACTIVE', 'PAUSED'].includes(body.status)) throw feedError('status must be ACTIVE or PAUSED');
    set('status = ?', body.status);
    sets.push('status_reason = NULL');
  }
  if (!sets.length) return view(row);
  // The interval may have changed above; next_run_at follows it.
  const r = await pool.query(`UPDATE data_feeds SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING *`, vals);
  const out = r.rows[0];
  if (out.interval_minutes && out.status === 'ACTIVE' && !out.next_run_at) {
    await pool.query(`UPDATE data_feeds SET next_run_at = now() WHERE id = $1 AND user_id = $2`, [id, userId]);
  }
  return view((await pool.query('SELECT * FROM data_feeds WHERE id = $1 AND user_id = $2', [id, userId])).rows[0]);
}

async function rotatePushKey(pool, userId, id) {
  const row = await getFeedRow(pool, userId, id);
  if (row.source_type !== 'push') throw feedError('Only a push feed has a key.');
  const key = newPushKey();
  await pool.query('UPDATE data_feeds SET push_token_hash = $3, updated_at = now() WHERE id = $1 AND user_id = $2', [id, userId, sha256(key)]);
  return { pushKey: key };
}

async function deleteFeed(pool, userId, id) {
  const r = await pool.query('DELETE FROM data_feeds WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!r.rowCount) throw feedError('Feed not found', 404);
}

async function listRuns(pool, userId, id, { limit = 20 } = {}) {
  await getFeedRow(pool, userId, id);
  const r = await pool.query('SELECT * FROM data_feed_runs WHERE feed_id = $1 AND user_id = $2 ORDER BY started_at DESC LIMIT $3', [id, userId, Math.min(100, Math.max(1, Number(limit) || 20))]);
  return r.rows.map(runView);
}

/** The push feed a key belongs to, or null. */
async function feedForPushKey(pool, key) {
  if (!PUSH_KEY_RE.test(String(key || ''))) return null;
  const r = await pool.query(`SELECT * FROM data_feeds WHERE push_token_hash = $1 AND source_type = 'push'`, [sha256(key)]);
  return r.rows[0] || null;
}

// ── Running ─────────────────────────────────────────────────────────────

async function saveState(pool, row, state) {
  if (JSON.stringify(state) === JSON.stringify(row.source_state || {})) return;
  await pool.query('UPDATE data_feeds SET source_state = $3 WHERE id = $1 AND user_id = $2', [row.id, row.user_id, JSON.stringify(state)]);
  row.source_state = state;
}

async function finishRun(pool, row, runId, { status, file = null, out = null, error = null, details = {}, feedStatus = null, feedReason = null }) {
  const c = out?.summary?.counts || {};
  await pool.query(
    `UPDATE data_feed_runs SET status = $3, finished_at = now(), rows_received = $4, rows_accepted = $5, rows_rejected = $6, rows_review = $7,
            batch_id = $8, error = $9, details = $10 WHERE id = $1 AND user_id = $2`,
    [runId, row.user_id, status, file?.rowsReceived ?? c.rows ?? 0, c.accepted || 0, c.rejected || 0, c.reviewRequired || 0,
      out?.batchId || null, error ? creds.redact(String(error)).slice(0, 500) : null, JSON.stringify(details)]
  );
  const ok = status === 'imported' || status === 'unchanged';
  await pool.query(
    `UPDATE data_feeds SET last_run_at = now(),
            last_success_at = CASE WHEN $3::boolean THEN now() ELSE last_success_at END,
            last_batch_id = COALESCE($4::uuid, last_batch_id),
            status = COALESCE($5, status), status_reason = CASE WHEN $5::text IS NULL THEN status_reason ELSE $6 END,
            updated_at = now()
      WHERE id = $1 AND user_id = $2`,
    [row.id, row.user_id, ok, out?.batchId || null, feedStatus, feedReason ? creds.redact(String(feedReason)).slice(0, 500) : null]
  );
}

/**
 * Runs one feed now. `pushed` is the body of a push delivery. Returns
 * { run, summary, discovery } — never throws for a source or mapping
 * problem; those are recorded on the run and the feed.
 */
async function runFeed(pool, row, { trigger = 'manual', pushed = null, tally = null, contentType = '', discover = null, correlationId = null } = {}) {
  if (row.source_type === 'tally' && !tally) {
    throw feedError('Tally records arrive from the Starlane bridge on the computer running Tally, on its own schedule. Run the bridge there (or wait for its next sync) to bring them in now.', 409);
  }
  await pool.query(`UPDATE data_feed_runs SET status = 'failed', finished_at = now(), error = 'Stopped without finishing (timed out).'
                     WHERE feed_id = $1 AND user_id = $2 AND status = 'running' AND started_at < now() - ($3::int * interval '1 millisecond')`, [row.id, row.user_id, STALE_RUN_MS]);
  const running = await pool.query(`SELECT 1 FROM data_feed_runs WHERE feed_id = $1 AND user_id = $2 AND status = 'running' LIMIT 1`, [row.id, row.user_id]);
  if (running.rows[0]) throw feedError('This feed is already running.', 409);
  const runId = (await pool.query(`INSERT INTO data_feed_runs (feed_id, user_id, trigger) VALUES ($1,$2,$3) RETURNING id`, [row.id, row.user_id, trigger])).rows[0].id;
  let file = null;
  try {
    file = tally ? fromTally(tally, row.kind) : pushed !== null ? fromPush(pushed, contentType) : await readFeedSource(pool, row);
    if (file.state) await saveState(pool, row, file.state);
    if (!file.buffer.length) {
      const note = file.note || 'The source had no records, so nothing changed.';
      await finishRun(pool, row, runId, { status: 'unchanged', file, details: { note } });
      return { runId, status: 'unchanged', note };
    }
    const mapping = row.mapping || {};
    let input;
    if (mapping.canonical) {
      input = canonicalInput(row.kind, headerLine(file.buffer), { sourceSystem: mapping.sourceSystem, currency: mapping.currency || file.currency || null, stockFollows: mapping.stockFollows });
    } else {
      const resolved = await resolveInput(pool, row.user_id, row.kind, file, mapping);
      if (resolved.problem) {
        await finishRun(pool, row, runId, { status: 'needs_attention', file, error: resolved.problem, details: { columns: resolved.columns || null }, feedStatus: 'NEEDS_ATTENTION', feedReason: resolved.problem });
        return { runId, status: 'needs_attention', error: resolved.problem, columns: resolved.columns || null };
      }
      input = resolved.input;
    }
    const out = await commitOperationalImport(pool, row.user_id, row.kind, file.buffer, file.filename, input, { correlationId, actor: feedActor(row.id, row.user_id) });
    if (!out.ok) {
      const reason = `${out.error}${out.errors?.length ? ` ${out.errors.slice(0, 5).join('; ')}.` : ''}`;
      await finishRun(pool, row, runId, { status: 'needs_attention', file, error: reason, details: { errors: out.errors || [] }, feedStatus: 'NEEDS_ATTENTION', feedReason: reason });
      return { runId, status: 'needs_attention', error: reason, errors: out.errors || [] };
    }
    const details = {
      ...(file.origin ? { origin: file.origin } : {}),
      ...(file.truncated ? { truncated: 'The app had more records than one run reads; the rest come in on the next runs once these close, or narrow the source.' } : {}),
      ...(out.summary ? { counts: out.summary.counts, entities: out.summary.entities || null, notInThisFile: out.summary.notInThisFile ?? null } : {}),
    };
    const status = out.alreadyImported ? 'unchanged' : 'imported';
    // A good run clears a past problem.
    await finishRun(pool, row, runId, { status, file, out, details, feedStatus: row.status === 'NEEDS_ATTENTION' ? 'ACTIVE' : null, feedReason: null });
    let discovery = null;
    if (status === 'imported' && discover && row.kind !== 'components') {
      try { discovery = await discover(row.user_id); } catch (err) { safeLog('warn', '[data-feeds] discovery after import failed', { feedId: row.id, error: err.message }); }
    }
    return { runId, status, batchId: out.batchId, summary: out.summary || null, details, discovery };
  } catch (err) {
    const message = String(err.message || err);
    const auth = err.kind === 'AUTH_EXPIRED';
    // A refused sign-in or a bad address needs the owner; a passing failure is retried next time.
    const needsOwner = auth || !!err.needsOwner || (err.status && err.status < 500 && err.status !== 409 && err.status !== 413);
    await finishRun(pool, row, runId, { status: 'failed', file, error: message, feedStatus: needsOwner ? 'NEEDS_ATTENTION' : null, feedReason: needsOwner ? message : null }).catch(() => {});
    safeLog('warn', '[data-feeds] run failed', { feedId: row.id, userId: row.user_id, error: creds.redact(message).slice(0, 300) });
    return { runId, status: 'failed', error: creds.redact(message).slice(0, 500) };
  }
}

/** Every ACTIVE scheduled feed that is due. Claims each by moving next_run_at first, so replicas never run one twice. */
async function runDueFeeds(pool, { limit = 50, discover = null } = {}) {
  const claimed = (await pool.query(
    `UPDATE data_feeds f SET next_run_at = now() + (f.interval_minutes * interval '1 minute')
      WHERE f.id IN (SELECT id FROM data_feeds WHERE status = 'ACTIVE' AND interval_minutes IS NOT NULL AND next_run_at <= now()
                     ORDER BY next_run_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING f.*`, [limit])).rows;
  const out = { feeds: claimed.length, imported: 0, unchanged: 0, needsAttention: 0, failed: 0 };
  for (const row of claimed) {
    try {
      const r = await runFeed(pool, row, { trigger: 'schedule', discover });
      if (r.status === 'imported') out.imported++;
      else if (r.status === 'unchanged') out.unchanged++;
      else if (r.status === 'needs_attention') out.needsAttention++;
      else out.failed++;
    } catch (err) {
      out.failed++;
      safeLog('warn', '[data-feeds] scheduled run skipped', { feedId: row.id, error: err.message });
    }
  }
  return out;
}

// ── Tally (records arrive from the bridge) ───────────────────────────────

/** What the bridge should export for this tenant: the kinds of its Tally feeds that are not paused. */
async function tallyFeedKinds(pool, userId) {
  const r = await pool.query(`SELECT DISTINCT kind FROM data_feeds WHERE user_id = $1 AND source_type = 'tally' AND status <> 'PAUSED'`, [userId]);
  return TALLY_KINDS.filter((k) => r.rows.some((x) => x.kind === k));
}

/**
 * One Tally export the bridge sent, run through every not-paused Tally feed
 * of that kind (normally one). A feed tied to a company only takes that
 * company's export.
 */
async function runTallyDelivery(pool, userId, { kind, xml, company = '' }, { discover = null, correlationId = null } = {}) {
  if (!TALLY_KINDS.includes(kind)) throw feedError('Tally can feed customer orders, purchase orders and stock items.');
  if (typeof xml !== 'string') throw feedError('xml must be the text of the Tally export.');
  const rows = (await pool.query(`SELECT * FROM data_feeds WHERE user_id = $1 AND source_type = 'tally' AND kind = $2 AND status <> 'PAUSED' ORDER BY created_at`, [userId, kind])).rows;
  const co = String(company || '').trim().toLowerCase();
  const results = [];
  for (const row of rows) {
    const only = String(row.source_config?.company || '').trim().toLowerCase();
    if (only && co && only !== co) continue;
    try {
      results.push({ feedId: row.id, ...(await runFeed(pool, row, { trigger: 'push', tally: { xml, company }, discover, correlationId })) });
    } catch (err) {
      results.push({ feedId: row.id, status: 'failed', error: err.message });
    }
  }
  return { feeds: results.length, results };
}

/** The apps this tenant can add feeds from, and the kinds each can feed. */
async function appSources(pool, userId) {
  const r = await pool.query(`SELECT connector_id, status, account_label FROM app_connector_accounts WHERE user_id = $1`, [userId]);
  return APP_IDS.filter((id) => provider(id).feedKinds).map((id) => {
    const a = r.rows.find((x) => x.connector_id === id);
    return { connectorId: id, name: labelFor(id), kinds: provider(id).feedKinds, live: isLive(id), connected: !!a, status: a?.status || null, label: a?.account_label || null };
  });
}

module.exports = {
  SOURCE_TYPES, INTERVALS, KIND_LABEL,
  view, checkSource, checkMapping, checkInterval, columnsFor,
  previewFeed, listFeeds, getFeedRow, createFeed, updateFeed, rotatePushKey, deleteFeed, listRuns, feedForPushKey,
  runFeed, runDueFeeds, appSources, sha256, tallyFeedKinds, runTallyDelivery,
};
