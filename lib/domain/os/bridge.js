// FILE: lib/domain/os/bridge.js
// BRIDGE: what Starlane is connected to, what it can read and do through
// each connection, how fresh it is, what it understood, and what is missing.
//
// Only connectors with an implementation are listed as available. Each one
// declares the universal contract (READ / SEARCH / SUBSCRIBE / WRITE /
// EXECUTE) with what is really implemented, and its health lowers the
// confidence of anything built on it.

const { CONNECTORS } = require('../automation/connectorCatalog');
const { connectorHealth, receivablesFreshness, humanAge } = require('../decisions/sourceHealth');
const { normalizeName, similarity } = require('../ingestion/entityResolution');

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
 * Candidate duplicate customers across imports ("ABC Pvt Ltd" / "ABC
 * PRIVATE LIMITED"). Never merged automatically: listed with evidence for a
 * person to confirm.
 */
function duplicateCandidates(names) {
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
  const keys = [...groups.keys()];
  for (let i = 0; i < keys.length && out.length < 50; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (Math.abs(keys[i].length - keys[j].length) > 3) continue;
      const s = similarity(keys[i], keys[j]);
      if (s >= 0.9 && s < 1) out.push({ names: [...groups.get(keys[i]), ...groups.get(keys[j])], normalized: `${keys[i]} ~ ${keys[j]}`, confidence: 'MEDIUM', evidence: `Names are ${Math.round(s * 100)}% similar` });
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
