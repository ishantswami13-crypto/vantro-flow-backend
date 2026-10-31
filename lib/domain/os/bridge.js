// FILE: lib/domain/os/bridge.js
// BRIDGE: what Starlane is connected to, what it can read and do through
// each connection, how fresh it is, what it understood, and what is missing.
//
// Only connectors with an implementation are listed as available. Each one
// declares the universal contract (READ / SEARCH / SUBSCRIBE / WRITE /
// EXECUTE) with what is really implemented, and its health lowers the
// confidence of anything built on it.

const crypto = require('crypto');
const { CONNECTORS } = require('../automation/connectorCatalog');
const { connectorHealth, receivablesFreshness, humanAge } = require('../decisions/sourceHealth');
const { normalizeName, similarity } = require('../ingestion/entityResolution');
const { SUPERSEDED_NOTE } = require('../decisions/sourceAuthority');

const HEALTH_MAP = { CONNECTED: 'CONNECTED', DEGRADED: 'DEGRADED', STALE: 'STALE', UNAUTHORIZED: 'AUTH_EXPIRED', RATE_LIMITED: 'RATE_LIMITED', FAILED: 'FAILED', NOT_SYNCED: 'DISCONNECTED' };
const CONFIDENCE_EFFECT = { CONNECTED: 'none', DEGRADED: 'lowered', STALE: 'blocked', AUTH_EXPIRED: 'blocked', RATE_LIMITED: 'lowered', FAILED: 'blocked', DISCONNECTED: 'blocked', NOT_CONNECTED: 'n/a' };

function contract({ read = [], search = false, subscribe = false, write = [], execute = [] }) {
  return {
    READ: { supported: read.length > 0, what: read },
    SEARCH: { supported: !!search, what: search || null },
    SUBSCRIBE: { supported: !!subscribe, what: subscribe || null },
    WRITE: { supported: write.length > 0, what: write },
    EXECUTE: { supported: execute.length > 0, what: execute },
  };
}

async function safeCount(pool, sql, params) {
  try { return (await pool.query(sql, params)).rows[0]?.n ?? 0; } catch { return null; }
}

/**
 * similarity() for two already-normalized names, or null when it is below
 * minSimilarity. Same value as similarity(): 1 - distance / longer length.
 */
function nearSimilarity(na, nb, minSimilarity) {
  if (!na || !nb) return null;
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  const budget = Math.floor((1 - minSimilarity) * maxLen + 1e-9);
  if (Math.abs(na.length - nb.length) > budget) return null;
  const dist = boundedLevenshtein(na, nb, budget);
  if (dist == null) return null;
  const s = 1 - dist / maxLen;
  return s >= minSimilarity ? s : null;
}

// Levenshtein distance, or null once it must exceed max. Two rows, and
// only the diagonal band |i - j| <= max is filled.
function boundedLevenshtein(a, b, max) {
  const m = a.length, n = b.length;
  const INF = max + 1;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j <= max ? j : INF;
  for (let i = 1; i <= m; i++) {
    const lo = Math.max(1, i - max);
    const hi = Math.min(n, i + max);
    cur.fill(INF);
    cur[0] = i <= max ? i : INF;
    let rowMin = cur[0];
    for (let j = lo; j <= hi; j++) {
      const v = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
      cur[j] = v > INF ? INF : v;
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return null;
    [prev, cur] = [cur, prev];
  }
  return prev[n] <= max ? prev[n] : null;
}

const DUPLICATE_MEMO = new Map();
const DUPLICATE_MEMO_MAX = 500;

// Index of the first entry in an ascending list that is greater than i.
function firstAfter(list, i) {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] <= i) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Candidate duplicate customers across imports ("ABC Pvt Ltd" / "ABC
 * PRIVATE LIMITED"). Never merged automatically: listed with evidence for a
 * person to confirm.
 */
function duplicateCandidates(names) {
  // The customer list rarely changes between Home loads, and the scan is the
  // costliest part of the page, so the result is remembered per exact list.
  const memoKey = crypto.createHash('sha1').update(JSON.stringify(names)).digest('hex');
  const remembered = DUPLICATE_MEMO.get(memoKey);
  if (remembered) {
    DUPLICATE_MEMO.delete(memoKey);
    DUPLICATE_MEMO.set(memoKey, remembered);
    return structuredClone(remembered);
  }
  const result = scanDuplicateCandidates(names);
  DUPLICATE_MEMO.set(memoKey, result);
  if (DUPLICATE_MEMO.size > DUPLICATE_MEMO_MAX) DUPLICATE_MEMO.delete(DUPLICATE_MEMO.keys().next().value);
  return structuredClone(result);
}

function scanDuplicateCandidates(names) {
  const groups = new Map();
  for (const n of names) {
    const k = normalizeName(n);
    if (!k) continue;
    const g = groups.get(k) || new Set();
    g.add(n);
    groups.set(k, g);
  }
  const out = [];
  for (const [key, set] of groups) {
    if (set.size < 2) continue;
    out.push({ names: [...set], normalized: key, confidence: 'HIGH', evidence: 'Same name once legal suffixes and punctuation are removed' });
  }
  // Near-duplicates: s >= 0.9 means an edit distance of at most 10% of the
  // longer name. Comparing every pair with a full Levenshtein made this
  // O(n^2 * len^2) on every Home load. Bucketing names by length lets each
  // name meet only names within 3 characters of its length (the same skip
  // as before), and the banded distance gives up once the 10% budget is
  // spent. Pairs are visited in the original order, so the output and the
  // 50-candidate cut-off are unchanged.
  const keys = [...groups.keys()];
  const norm = keys.map((k) => normalizeName(k));
  const byLength = new Map(); // length -> ascending indices
  keys.forEach((k, i) => {
    if (!byLength.has(k.length)) byLength.set(k.length, []);
    byLength.get(k.length).push(i);
  });
  for (let i = 0; i < keys.length && out.length < 50; i++) {
    const near = [];
    for (let len = keys[i].length - 3; len <= keys[i].length + 3; len++) {
      const list = byLength.get(len);
      if (!list) continue;
      for (let x = firstAfter(list, i); x < list.length; x++) near.push(list[x]);
    }
    near.sort((p, q) => p - q);
    for (const j of near) {
      const s = nearSimilarity(norm[i], norm[j], 0.9);
      if (s != null && s < 1) out.push({ names: [...groups.get(keys[i]), ...groups.get(keys[j])], normalized: `${keys[i]} ~ ${keys[j]}`, confidence: 'MEDIUM', evidence: `Names are ${Math.round(s * 100)}% similar` });
    }
  }
  return out.slice(0, 50);
}

async function bridgeOverview(pool, userId, defs, { externalSendEnabled = false, whatsappConfigured = false } = {}) {
  const [live, freshness, lastFile] = await Promise.all([
    connectorHealth(pool, userId, defs),
    receivablesFreshness(pool, userId, defs),
    pool.query(`SELECT MAX(completed_at) AS at, COUNT(*)::int AS n FROM file_import_batches WHERE user_id = $1 AND status = 'COMPLETED'`, [userId]).then((r) => r.rows[0]).catch(() => ({ at: null, n: 0 })),
  ]);

  const connectors = [];
  const tally = live.find((c) => c.source === 'TALLY');
  const tallyHealth = tally ? HEALTH_MAP[tally.health] || 'FAILED' : 'NOT_CONNECTED';
  connectors.push({
    key: 'TALLY',
    name: 'Tally',
    state: CONNECTORS.TALLY.state,
    health: tallyHealth,
    confidenceEffect: CONFIDENCE_EFFECT[tallyHealth],
    lastSyncAt: tally?.lastSyncAt || null,
    lastError: tally?.lastError || null,
    contract: contract({ read: CONNECTORS.TALLY.reads, write: [], execute: [] }),
    auth: 'Local Windows agent paired with a one-time code',
    syncMode: 'Scheduled pull from the Tally machine',
    sensor: CONNECTORS.TALLY.reads,
    actuator: [],
    limitations: CONNECTORS.TALLY.limitations,
  });

  const fileAgeHours = lastFile?.at ? (Date.now() - new Date(lastFile.at).getTime()) / 3600000 : null;
  const fileHealth = !lastFile?.n ? 'NOT_CONNECTED' : fileAgeHours > defs.receivables_stale_hours ? 'STALE' : fileAgeHours > defs.receivables_fresh_hours ? 'DEGRADED' : 'CONNECTED';
  connectors.push({
    key: 'FILE_IMPORT',
    name: 'CSV / Excel receivables file',
    state: 'READ_READY',
    health: fileHealth,
    confidenceEffect: CONFIDENCE_EFFECT[fileHealth],
    lastSyncAt: lastFile?.at || null,
    imports: lastFile?.n || 0,
    freshness: lastFile?.at ? `Last file ${humanAge(fileAgeHours)} ago` : 'No file imported yet',
    contract: contract({ read: ['invoices', 'customers', 'payments'] }),
    auth: 'Uploaded by a signed-in person',
    syncMode: 'Manual upload; re-uploading the same file is a no-op',
    sensor: ['invoices', 'customers', 'payment status and dates'],
    actuator: [],
    limitations: ['Updates only when a new file is uploaded'],
  });

  const waHealth = whatsappConfigured ? 'CONNECTED' : 'NOT_CONNECTED';
  connectors.push({
    key: 'WHATSAPP',
    name: 'WhatsApp (Twilio)',
    state: whatsappConfigured && externalSendEnabled ? 'SEND_READY' : 'PREPARE_ONLY',
    health: waHealth,
    confidenceEffect: 'n/a',
    contract: contract({ execute: externalSendEnabled && whatsappConfigured ? ['send approved messages from the reminders page'] : [] }),
    auth: 'Twilio account configured by the operator',
    syncMode: 'Outbound only',
    sensor: [],
    actuator: externalSendEnabled && whatsappConfigured ? ['send approved message'] : [],
    limitations: [
      externalSendEnabled ? 'External sending is on for approved reminders' : 'External sending is off: messages are drafts only',
      'Workflows never send on their own; approved workflow reminders are sent by a person',
    ],
  });

  const notAvailable = Object.entries(CONNECTORS).filter(([, c]) => c.state === 'PLANNED').map(([k]) => k);

  // What Starlane inferred from the connected data.
  const [customers, invoices, paid, suppliers, products, names] = await Promise.all([
    safeCount(pool, 'SELECT COUNT(*)::int AS n FROM customers WHERE user_id = $1', [userId]),
    safeCount(pool, 'SELECT COUNT(*)::int AS n FROM invoices WHERE user_id = $1', [userId]),
    safeCount(pool, `SELECT COUNT(*)::int AS n FROM invoices WHERE user_id = $1 AND payment_status = 'Paid'`, [userId]),
    safeCount(pool, 'SELECT COUNT(*)::int AS n FROM suppliers WHERE user_id = $1', [userId]),
    safeCount(pool, 'SELECT COUNT(*)::int AS n FROM products WHERE user_id = $1', [userId]),
    pool.query('SELECT DISTINCT customer_name AS n FROM invoices WHERE user_id = $1 AND customer_name IS NOT NULL LIMIT 5000', [userId]).then((r) => r.rows.map((x) => x.n)).catch(() => []),
  ]);
  const discovered = [
    { entity: 'customers', count: customers, source: 'ledger' },
    { entity: 'invoices', count: invoices, source: 'ledger' },
    { entity: 'payments', count: paid, source: 'ledger (invoices marked paid)' },
    { entity: 'suppliers', count: suppliers, source: 'purchases' },
    { entity: 'products', count: products, source: 'stock' },
  ];
  // Bills that arrived from both a file and Tally: kept once (Tally), and
  // any disagreement between the two copies is shown, not hidden.
  const crossSource = await pool.query(
    `SELECT invoice_number, customer_name, payment_notes FROM invoices
      WHERE user_id = $1 AND payment_status = 'Cancelled' AND payment_notes LIKE $2
      ORDER BY updated_at DESC NULLS LAST LIMIT 200`,
    [userId, `${SUPERSEDED_NOTE}%`],
  ).then((r) => r.rows).catch(() => []);
  const disagreements = crossSource.filter((r) => /Disagreement:/.test(r.payment_notes || ''));
  const missing = [];
  if (!invoices) missing.push('No invoices yet: upload a receivables file or connect Tally.');
  if (!suppliers) missing.push('No suppliers: supplier risk and purchasing cannot be analysed.');
  if (!products) missing.push('No stock data: inventory objectives are not available.');
  missing.push('No bank feed: cash balance cannot be measured.');

  return {
    connectors,
    notAvailable,
    freshness,
    discovered,
    entityResolution: { candidates: duplicateCandidates(names), rule: 'Never merged automatically; confirm each pair.' },
    semantics: {
      definitions: {
        overdue: `An invoice is overdue the day after its due date (+${defs.overdue_after_days} days)`,
        material: `A receivables decision is material from ${Number(defs.material_amount_min).toLocaleString('en-IN')} ${defs.base_currency}`,
        baseCurrency: defs.base_currency,
      },
      authority: [{ fact: 'Invoices, amounts and payment status', source: tally && tallyHealth === 'CONNECTED' ? 'Tally' : 'Uploaded receivables file' }],
      authorityRule: 'When the same bill comes from Tally and from a file, Tally is kept and the file copy is withdrawn.',
    },
    crossSource: {
      keptFromTally: crossSource.length,
      disagreements: disagreements.slice(0, 20).map((r) => ({ bill: r.invoice_number, customer: r.customer_name, detail: (r.payment_notes.split('Disagreement: ')[1] || '').replace(/\.$/, '') })),
    },
    missing,
    answers: {
      connectedTo: connectors.filter((c) => !['NOT_CONNECTED'].includes(c.health)).map((c) => c.name),
      canRead: [...new Set(connectors.filter((c) => c.health !== 'NOT_CONNECTED').flatMap((c) => c.contract.READ.what))],
      canDo: connectors.flatMap((c) => c.contract.EXECUTE.what),
    },
  };
}

module.exports = { bridgeOverview, duplicateCandidates, HEALTH_MAP };
