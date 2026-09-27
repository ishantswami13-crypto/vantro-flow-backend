// Pure unit tests for the connector registry and health derivation (no DB).
// Run: node lib/connectors/connectors.test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { listManifests, getManifest, validateManifest } = require('./registry');
const { deriveHealth, deriveBridgeHealth, STALE_AFTER_MS, DELAYED_AFTER_MS } = require('./state');

let pass = 0; let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name, detail ?? ''); }
};

const all = listManifests();
check('every manifest is valid', all.every((m) => validateManifest(m).length === 0),
  all.map((m) => [m.id, validateManifest(m)]).filter(([, e]) => e.length));
check('ids are unique', new Set(all.map((m) => m.id)).size === all.length);
check('no OAuth connector claims to be available (none is built)', all.filter((m) => m.authType === 'oauth').every((m) => m.availability === 'not_available'));
check('every unavailable connector says why', all.filter((m) => m.availability === 'not_available').every((m) => m.unavailableReason));
check('every available tenant connector states what access Starlane gets', all.filter((m) => m.availability === 'available' && m.authType !== 'public_feed').every((m) => m.access.length > 0));
check('getManifest returns a copy (registry cannot be mutated by callers)', (() => { const t = getManifest('tally'); t.availability = 'x'; return getManifest('tally').availability === 'available'; })());

const tally = getManifest('tally');
const file = getManifest('file_import');
const qb = getManifest('quickbooks');
const now = Date.parse('2026-09-27T12:00:00Z');
const iso = (msAgo) => new Date(now - msAgo).toISOString();

check('unavailable connector -> unavailable even if a row exists', deriveHealth({ manifest: qb, connection: { status: 'CONNECTED', last_sync_at: iso(0) }, now }) === 'unavailable');
check('no connection, no device -> not_connected', deriveHealth({ manifest: tally, connection: null, now }) === 'not_connected');
check('paired device but never synced -> stale', deriveHealth({ manifest: tally, connection: null, devices: [{ status: 'ACTIVE' }], now }) === 'stale');
check('connected, synced 10 min ago -> healthy', deriveHealth({ manifest: tally, connection: { status: 'CONNECTED', last_sync_at: iso(600000) }, now }) === 'healthy');
check('connected, silent past threshold -> stale', deriveHealth({ manifest: tally, connection: { status: 'CONNECTED', last_sync_at: iso(STALE_AFTER_MS + 1) }, now }) === 'stale');
check('connected with no sync time -> stale, not healthy', deriveHealth({ manifest: tally, connection: { status: 'CONNECTED', last_sync_at: null }, now }) === 'stale');
check('error -> error', deriveHealth({ manifest: tally, connection: { status: 'ERROR' }, now }) === 'error');
check('disconnected -> disconnected', deriveHealth({ manifest: tally, connection: { status: 'DISCONNECTED' }, now }) === 'disconnected');
check('file import: no batches -> not_connected', deriveHealth({ manifest: file, lastImport: null, now }) === 'not_connected');
check('file import: last batch failed -> error', deriveHealth({ manifest: file, lastImport: { status: 'FAILED' }, now }) === 'error');
check('file import: last batch completed -> healthy', deriveHealth({ manifest: file, lastImport: { status: 'COMPLETED' }, now }) === 'healthy');

const act = [{ status: 'ACTIVE' }];
const B = (o) => deriveBridgeHealth({ now, ...o });
check('bridge: nothing -> not_connected', B({}) === 'not_connected');
check('bridge: open code, no device -> pairing', B({ openPairing: true }) === 'pairing');
check('bridge: only revoked devices -> revoked', B({ devices: [{ status: 'REVOKED' }] }) === 'revoked');
check('bridge: paired, never synced -> connected (not healthy)', B({ devices: act }) === 'connected');
check('bridge: running attempt 1 min old -> syncing', B({ devices: act, latestRun: { status: 'running', started_at: iso(60000) } }) === 'syncing');
check('bridge: running attempt 20 min old, recent success -> not syncing', B({ devices: act, latestRun: { status: 'running', started_at: iso(20 * 60000) }, lastSuccessAt: iso(60000) }) === 'healthy');
check('bridge: latest attempt failed -> error even with an older success', B({ devices: act, latestRun: { status: 'failed' }, lastSuccessAt: iso(60000) }) === 'error');
check('bridge: success 10 min ago -> healthy', B({ devices: act, latestRun: { status: 'succeeded' }, lastSuccessAt: iso(600000) }) === 'healthy');
check('bridge: success older than threshold -> delayed', B({ devices: act, latestRun: { status: 'succeeded' }, lastSuccessAt: iso(DELAYED_AFTER_MS + 1) }) === 'delayed');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
