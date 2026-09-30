'use strict';
// lib/connectors/sdk.js — the contract every Starlane connector implements, and
// the runtime that calls it.
//
// The intelligence core (decisions, scan, watch, simulate) consumes normalized
// business entities and normalized actions only. A connector adapts one vendor
// system to that vocabulary. Adding a system means writing one adapter with
// defineConnector(); nothing in the core changes (tests/connectorSdk.test.mjs
// adds a sample ERP adapter to prove it).
//
// What the runtime guarantees, whatever the adapter does:
//   - A connector can only do what it declares. An undeclared capability is
//     refused before the adapter is called, and an adapter cannot implement a
//     method it did not declare (so it cannot quietly write).
//   - Retries use exponential backoff with jitter, honour Retry-After, and stop
//     after maxAttempts. Auth failures are never retried; they surface as
//     AUTH_EXPIRED with a reconnect path.
//   - EXECUTE needs an approval record and an idempotency key. The same key
//     never produces a second side effect. A failure whose outcome is unknown
//     is not retried unless the adapter says the vendor dedupes on the key;
//     it is reported as UNKNOWN_OUTCOME for a person to check.
//   - A global stop (kill switch) refuses every EXECUTE.
//   - Records that lack a required normalized field are rejected with a
//     reason, not guessed. Fields the source added or dropped since the last
//     schema discovery are reported (schema drift) and lower health to
//     DEGRADED instead of crashing the sync.

const CAPABILITIES = Object.freeze(['READ', 'SEARCH', 'SUBSCRIBE', 'WRITE', 'EXECUTE']);

const MODES = Object.freeze(['api', 'webhook', 'database', 'file', 'local_bridge', 'polling', 'event_stream', 'manual_import']);

const AUTH_TYPES = Object.freeze(['oauth', 'api_key', 'basic', 'device_credential', 'none', 'file_upload']);

const HEALTH = Object.freeze(['CONNECTED', 'SYNCING', 'DEGRADED', 'STALE', 'AUTH_EXPIRED', 'RATE_LIMITED', 'FAILED', 'DISCONNECTED']);

// Normalized entities and the fields the core relies on. Vendor fields map
// beneath these; everything else is kept as `extra`, never interpreted.
const ENTITIES = Object.freeze({
  customer:  { required: ['sourceId', 'name'] },
  supplier:  { required: ['sourceId', 'name'] },
  product:   { required: ['sourceId', 'name'] },
  order:     { required: ['sourceId', 'date'] },
  invoice:   { required: ['sourceId', 'customerRef', 'amount', 'currency', 'issuedOn'] },
  payment:   { required: ['sourceId', 'amount', 'currency', 'paidOn'] },
  inventory: { required: ['sourceId', 'productRef', 'quantity', 'unit'] },
  purchase:  { required: ['sourceId', 'supplierRef', 'amount', 'currency', 'date'] },
  shipment:  { required: ['sourceId', 'date'] },
  employee:  { required: ['sourceId', 'name'] },
  location:  { required: ['sourceId', 'name'] },
  account:   { required: ['sourceId', 'name'] },
});

// Normalized actions. Which capability each needs.
const ACTIONS = Object.freeze({
  CREATE_INVOICE:   'EXECUTE',
  CREATE_PO:        'EXECUTE',
  SEND_EMAIL:       'EXECUTE',
  UPDATE_CUSTOMER:  'WRITE',
  MOVE_INVENTORY:   'EXECUTE',
  REQUEST_APPROVAL: 'EXECUTE',
});

const METHOD_FOR = Object.freeze({ READ: 'read', SEARCH: 'search', SUBSCRIBE: 'subscribe', WRITE: 'write', EXECUTE: 'execute' });

// Errors an adapter throws so the runtime can react correctly.
class ConnectorError extends Error {
  // kind: AUTH_EXPIRED | RATE_LIMITED | TRANSIENT | PERMANENT
  constructor(kind, message, { retryAfterMs = null, status = null } = {}) {
    super(message);
    this.name = 'ConnectorError';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }

  // Map an HTTP response to the right kind. retryAfter is the raw header.
  static fromHttp(status, retryAfter, message = `HTTP ${status}`) {
    if (status === 401 || status === 403) return new ConnectorError('AUTH_EXPIRED', message, { status });
    if (status === 429) return new ConnectorError('RATE_LIMITED', message, { status, retryAfterMs: parseRetryAfter(retryAfter) });
    if (status >= 500 || status === 408) return new ConnectorError('TRANSIENT', message, { status, retryAfterMs: parseRetryAfter(retryAfter) });
    return new ConnectorError('PERMANENT', message, { status });
  }
}

function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function defineConnector(def) {
  const errors = [];
  if (!def || typeof def !== 'object') throw new Error('defineConnector: definition required');
  if (!/^[a-z0-9_]+$/.test(def.id || '')) errors.push('id must be lower_snake_case');
  if (!def.provider) errors.push('provider');
  if (!def.version) errors.push('version');
  if (!MODES.includes(def.mode)) errors.push(`mode must be one of ${MODES.join(', ')}`);
  if (!AUTH_TYPES.includes(def.authType)) errors.push(`authType must be one of ${AUTH_TYPES.join(', ')}`);
  const caps = Array.isArray(def.capabilities) ? def.capabilities : [];
  for (const c of caps) if (!CAPABILITIES.includes(c)) errors.push(`unknown capability ${c}`);
  for (const c of CAPABILITIES) {
    const has = typeof def[METHOD_FOR[c]] === 'function';
    if (caps.includes(c) && !has) errors.push(`declares ${c} but has no ${METHOD_FOR[c]}()`);
    if (!caps.includes(c) && has) errors.push(`implements ${METHOD_FOR[c]}() without declaring ${c}`);
  }
  const entities = def.entities || {};
  for (const [type, spec] of Object.entries(entities)) {
    if (!ENTITIES[type]) { errors.push(`unknown entity ${type}`); continue; }
    if (!spec || typeof spec.map !== 'function') errors.push(`entity ${type} needs map(record)`);
  }
  if ((caps.includes('READ') || caps.includes('SEARCH')) && !Object.keys(entities).length) errors.push('READ/SEARCH need at least one entity');
  for (const [action, spec] of Object.entries(def.actions || {})) {
    if (!ACTIONS[action]) { errors.push(`unknown action ${action}`); continue; }
    if (!caps.includes(ACTIONS[action])) errors.push(`action ${action} needs capability ${ACTIONS[action]}`);
    if (spec && spec.vendorDedupesOnKey !== undefined && typeof spec.vendorDedupesOnKey !== 'boolean') errors.push(`action ${action}.vendorDedupesOnKey must be boolean`);
  }
  if (typeof def.test !== 'function') errors.push('test() is required (it proves the credentials work)');
  if (errors.length) throw new Error(`Connector ${def.id || '?'} is invalid: ${errors.join('; ')}`);
  return Object.freeze({
    rateLimit: { requestsPerMinute: null },
    freshness: { staleAfterMs: 24 * 60 * 60 * 1000 },
    actions: {},
    ...def,
    capabilities: Object.freeze([...caps]),
  });
}

// What a person sees next to a connector (truthful capability).
function capabilityLabel(connector, { connected }) {
  if (!connector) return 'UNAVAILABLE';
  const caps = connector.capabilities || [];
  if (!connected) return 'SUPPORTED_NOT_CONNECTED';
  if (caps.includes('EXECUTE')) return 'EXECUTION_REQUIRES_APPROVAL';
  if (caps.includes('WRITE')) return 'WRITE_CAPABLE';
  return 'READ_ONLY';
}

function memoryIdempotencyStore() {
  const m = new Map();
  return {
    async get(key) { return m.get(key) || null; },
    async put(key, value) { m.set(key, value); },
  };
}

function createRuntime(connector, {
  credentials = {},
  idempotencyStore = memoryIdempotencyStore(),
  isStopped = () => false,
  maxAttempts = 4,
  baseDelayMs = 500,
  maxDelayMs = 60_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  random = Math.random,
  onEvent = () => {},
} = {}) {
  const state = {
    health: 'DISCONNECTED',
    lastSyncAt: null,
    lastError: null,
    rateLimitedUntil: null,
    recordsRead: 0,
    recordsRejected: 0,
    recordsWritten: 0,
    calls: 0,
    errors: 0,
    lastLatencyMs: null,
    knownSchema: null,
    drift: null,
  };
  const emit = (type, data) => { try { onEvent({ type, connectorId: connector.id, at: new Date(now()).toISOString(), ...data }); } catch { /* observers never break a sync */ } };
  const ctx = () => ({ credentials, now });

  function delayFor(attempt, err) {
    const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    const jittered = Math.round(backoff / 2 + random() * (backoff / 2));
    return err && err.retryAfterMs !== null && err.retryAfterMs !== undefined ? Math.min(maxDelayMs, Math.max(jittered, err.retryAfterMs)) : jittered;
  }

  async function call(op, fn, { retry = true } = {}) {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const t0 = now();
      state.calls += 1;
      try {
        const out = await fn();
        state.lastLatencyMs = now() - t0;
        if (state.health === 'RATE_LIMITED' || state.health === 'FAILED') state.health = state.drift?.breaking ? 'DEGRADED' : 'CONNECTED';
        state.rateLimitedUntil = null;
        return out;
      } catch (raw) {
        state.lastLatencyMs = now() - t0;
        state.errors += 1;
        const err = raw instanceof ConnectorError ? raw : new ConnectorError('TRANSIENT', raw?.message || String(raw));
        state.lastError = `${err.kind}: ${err.message}`;
        emit('error', { op, kind: err.kind, attempt, message: err.message });
        if (err.kind === 'AUTH_EXPIRED') { state.health = 'AUTH_EXPIRED'; throw err; }
        if (err.kind === 'PERMANENT') { state.health = 'FAILED'; throw err; }
        if (err.kind === 'RATE_LIMITED') {
          state.health = 'RATE_LIMITED';
          state.rateLimitedUntil = err.retryAfterMs !== null ? new Date(now() + err.retryAfterMs).toISOString() : null;
        }
        if (!retry || attempt >= maxAttempts) {
          if (err.kind !== 'RATE_LIMITED') state.health = 'FAILED';
          throw err;
        }
        const wait = delayFor(attempt, err);
        emit('retry', { op, attempt, waitMs: wait, kind: err.kind });
        await sleep(wait);
      }
    }
  }

  function need(cap) {
    if (!connector.capabilities.includes(cap)) {
      throw new ConnectorError('PERMANENT', `${connector.id} does not support ${cap}`);
    }
  }

  function normalize(type, rows, fetchedAt) {
    const spec = connector.entities[type];
    const required = ENTITIES[type].required;
    const records = [];
    const rejected = [];
    for (const raw of rows || []) {
      let mapped;
      try { mapped = spec.map(raw); } catch (e) { rejected.push({ reason: `mapping failed: ${e.message}`, raw }); continue; }
      const missing = required.filter((f) => mapped?.[f] === undefined || mapped?.[f] === null || mapped?.[f] === '');
      if (missing.length) { rejected.push({ reason: `missing ${missing.join(', ')}`, sourceId: mapped?.sourceId ?? null }); continue; }
      if ('amount' in mapped && !Number.isFinite(Number(mapped.amount))) { rejected.push({ reason: 'amount is not a number', sourceId: mapped.sourceId }); continue; }
      if ('currency' in mapped && !/^[A-Z]{3}$/.test(String(mapped.currency))) { rejected.push({ reason: `currency "${mapped.currency}" is not an ISO code`, sourceId: mapped.sourceId }); continue; }
      records.push({
        type,
        ...mapped,
        provenance: { connectorId: connector.id, connectorVersion: connector.version, provider: connector.provider, fetchedAt },
      });
    }
    return { records, rejected };
  }

  const runtime = {
    connector,
    status() {
      const stale = state.lastSyncAt && now() - Date.parse(state.lastSyncAt) > connector.freshness.staleAfterMs;
      const health = state.health === 'CONNECTED' && stale ? 'STALE' : state.health;
      return {
        connectorId: connector.id, provider: connector.provider, version: connector.version, mode: connector.mode,
        capabilities: connector.capabilities, health,
        lastSyncAt: state.lastSyncAt, lastError: state.lastError, rateLimitedUntil: state.rateLimitedUntil,
        recordsRead: state.recordsRead, recordsRejected: state.recordsRejected, recordsWritten: state.recordsWritten,
        calls: state.calls, errors: state.errors, lastLatencyMs: state.lastLatencyMs, drift: state.drift,
        // Downstream confidence: anything but a fresh, healthy source lowers it.
        confidenceFactor: health === 'CONNECTED' ? 1 : health === 'SYNCING' ? 1 : health === 'DEGRADED' || health === 'STALE' ? 0.5 : 0,
      };
    },

    async connect() {
      await call('test', () => connector.test(ctx()), { retry: false });
      state.health = 'CONNECTED';
      emit('connected', {});
      return runtime.status();
    },

    disconnect() {
      state.health = 'DISCONNECTED';
      emit('disconnected', {});
      return runtime.status();
    },

    async discoverSchema() {
      if (typeof connector.discoverSchema !== 'function') return null;
      const schema = await call('discoverSchema', () => connector.discoverSchema(ctx()));
      if (state.knownSchema) {
        const drift = { added: {}, removed: {}, breaking: false };
        for (const [entity, fields] of Object.entries(schema)) {
          const before = new Set(state.knownSchema[entity] || []);
          const after = new Set(fields);
          const added = [...after].filter((f) => !before.has(f));
          const removed = [...before].filter((f) => !after.has(f));
          if (added.length) drift.added[entity] = added;
          if (removed.length) drift.removed[entity] = removed;
          const needs = connector.entities[entity]?.sourceFields || [];
          if (removed.some((f) => needs.includes(f))) drift.breaking = true;
        }
        state.drift = Object.keys(drift.added).length || Object.keys(drift.removed).length ? drift : null;
        if (state.drift) emit('schema_drift', state.drift);
        if (drift.breaking && state.health === 'CONNECTED') state.health = 'DEGRADED';
      }
      state.knownSchema = schema;
      return schema;
    },

    async read(type, opts = {}) {
      need('READ');
      if (!connector.entities[type]) throw new ConnectorError('PERMANENT', `${connector.id} does not provide ${type}`);
      if (state.health === 'AUTH_EXPIRED') throw new ConnectorError('AUTH_EXPIRED', 'Reconnect this source: its authentication expired');
      const prev = state.health;
      state.health = 'SYNCING';
      let rows;
      try {
        rows = await call('read', () => connector.read(type, opts, ctx()));
      } catch (err) {
        if (state.health === 'SYNCING') state.health = prev === 'DISCONNECTED' ? 'FAILED' : prev;
        throw err;
      }
      const fetchedAt = new Date(now()).toISOString();
      const out = normalize(type, rows, fetchedAt);
      state.recordsRead += out.records.length;
      state.recordsRejected += out.rejected.length;
      state.lastSyncAt = fetchedAt;
      state.health = state.drift?.breaking || out.rejected.length > out.records.length ? 'DEGRADED' : 'CONNECTED';
      emit('read', { entity: type, records: out.records.length, rejected: out.rejected.length });
      return out;
    },

    async search(type, query, opts = {}) {
      need('SEARCH');
      const rows = await call('search', () => connector.search(type, query, opts, ctx()));
      return normalize(type, rows, new Date(now()).toISOString());
    },

    // Normalized actions. approval = { approvedBy, approvedAt, policy } from
    // the deterministic approval system; the runtime never infers it.
    async execute(action, payload, { idempotencyKey, approval } = {}) {
      const cap = ACTIONS[action];
      if (!cap) throw new ConnectorError('PERMANENT', `unknown action ${action}`);
      need(cap);
      if (!connector.actions[action]) throw new ConnectorError('PERMANENT', `${connector.id} does not implement ${action}`);
      if (isStopped()) return { status: 'REFUSED', reason: 'Execution is stopped (kill switch).' };
      if (!approval || !approval.approvedBy) return { status: 'REFUSED', reason: 'This action needs an approval from a person first.' };
      if (!idempotencyKey) return { status: 'REFUSED', reason: 'An idempotency key is required so a retry cannot repeat the action.' };
      const key = `${connector.id}:${action}:${idempotencyKey}`;
      const prior = await idempotencyStore.get(key);
      if (prior) return { ...prior, duplicate: true };
      await idempotencyStore.put(key, { status: 'IN_FLIGHT' });
      const retry = connector.actions[action].vendorDedupesOnKey === true;
      const method = cap === 'WRITE' ? 'write' : 'execute';
      try {
        const result = await call(action, () => connector[method](action, payload, { idempotencyKey: key, approval }, ctx()), { retry });
        const done = { status: 'DONE', result };
        await idempotencyStore.put(key, done);
        state.recordsWritten += 1;
        emit('executed', { action, idempotencyKey: key, approvedBy: approval.approvedBy });
        return done;
      } catch (err) {
        // A failure before the vendor could have acted (auth, rate limit,
        // rejected request) is safe to try again later; anything else may
        // have happened on the vendor's side.
        const safe = ['AUTH_EXPIRED', 'RATE_LIMITED', 'PERMANENT'].includes(err.kind);
        const out = safe
          ? { status: 'FAILED', kind: err.kind, reason: err.message }
          : { status: 'UNKNOWN_OUTCOME', kind: err.kind, reason: `${err.message}. It may or may not have happened in ${connector.provider}; check there before retrying.` };
        await idempotencyStore.put(key, safe ? null : out);
        emit('execute_failed', { action, idempotencyKey: key, status: out.status, kind: err.kind });
        return out;
      }
    },
  };
  return runtime;
}

module.exports = {
  CAPABILITIES, MODES, AUTH_TYPES, HEALTH, ENTITIES, ACTIONS,
  ConnectorError, parseRetryAfter, defineConnector, createRuntime, capabilityLabel, memoryIdempotencyStore,
};
