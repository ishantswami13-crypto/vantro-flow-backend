'use strict';
// lib/data/events/log.js — append to and read the L2 event log (migration 091).
//
// appendEvent takes the tenant handle from withTenant(), so the event is
// written in the same transaction as the change it describes (transactional
// outbox) and always carries the tenant from the verified JWT.

const TYPE = /^[a-z][a-z0-9_.]{1,80}$/;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_READ = 1000;

function requireTenant(db) {
  if (!db || typeof db.query !== 'function' || !db.userId) {
    throw new TypeError('events: pass the tenant handle from withTenant() as the first argument');
  }
  return db.userId;
}

function toEvent(row) {
  return Object.freeze({
    id: String(row.id),
    eventId: row.event_id,
    userId: row.user_id,
    stream: row.stream,
    type: row.event_type,
    payload: row.payload,
    metadata: row.metadata,
    idempotencyKey: row.idempotency_key || null,
    occurredAt: row.occurred_at,
  });
}

function validate({ stream, type, payload = {}, metadata = {}, idempotencyKey }) {
  if (typeof type !== 'string' || !TYPE.test(type)) throw new TypeError(`events: invalid type "${type}" (lower-case, dots and underscores)`);
  if (typeof stream !== 'string' || !stream.length || stream.length > 200) throw new TypeError('events: stream must be 1-200 characters');
  if (payload === null || typeof payload !== 'object') throw new TypeError('events: payload must be an object');
  if (metadata === null || typeof metadata !== 'object') throw new TypeError('events: metadata must be an object');
  const payloadJson = JSON.stringify(payload);
  if (Buffer.byteLength(payloadJson) > MAX_PAYLOAD_BYTES) throw new RangeError('events: payload is larger than 64 KB; store a reference instead');
  if (idempotencyKey !== undefined && idempotencyKey !== null && (typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 200)) {
    throw new TypeError('events: idempotencyKey must be a 1-200 character string');
  }
  return { payloadJson, metadataJson: JSON.stringify(metadata) };
}

// Returns { event, duplicate }. With an idempotencyKey, a second append with
// the same key for the same tenant returns the first event and writes nothing.
async function appendEvent(db, input) {
  const tenant = requireTenant(db);
  const { payloadJson, metadataJson } = validate(input);
  const key = input.idempotencyKey || null;
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())) throw new TypeError('events: occurredAt is not a valid date');
  const ins = await db.query(
    `INSERT INTO event_log (user_id, stream, event_type, payload, metadata, idempotency_key, occurred_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
     ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [tenant, input.stream, input.type, payloadJson, metadataJson, key, occurredAt]
  );
  if (ins.rows.length) return { event: toEvent(ins.rows[0]), duplicate: false };
  const prior = await db.query('SELECT * FROM event_log WHERE user_id = $1 AND idempotency_key = $2', [tenant, key]);
  return { event: toEvent(prior.rows[0]), duplicate: true };
}

// One stream's events for this tenant, oldest first.
async function readStream(db, stream, { afterId = 0, limit = 100 } = {}) {
  const tenant = requireTenant(db);
  const n = Math.min(Math.max(1, Math.floor(Number(limit)) || 100), MAX_READ);
  const r = await db.query(
    'SELECT * FROM event_log WHERE user_id = $1 AND stream = $2 AND id > $3 ORDER BY id LIMIT $4',
    [tenant, stream, String(afterId), n]
  );
  return r.rows.map(toEvent);
}

// This tenant's most recent events, newest first (activity feeds, audit views).
async function recentEvents(db, { types, limit = 50 } = {}) {
  const tenant = requireTenant(db);
  const n = Math.min(Math.max(1, Math.floor(Number(limit)) || 50), MAX_READ);
  const params = [tenant, n];
  let filter = '';
  if (Array.isArray(types) && types.length) { params.push(types); filter = ' AND event_type = ANY($3)'; }
  const r = await db.query(`SELECT * FROM event_log WHERE user_id = $1${filter} ORDER BY id DESC LIMIT $2`, params);
  return r.rows.map(toEvent);
}

module.exports = { appendEvent, readStream, recentEvents, toEvent, MAX_PAYLOAD_BYTES };
