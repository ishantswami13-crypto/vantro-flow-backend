'use strict';
// lib/data/events/dispatcher.js — deliver event_log rows to consumers.
//
// Two kinds of consumer:
//
//   durable    One cursor in event_consumers, shared by every server. A run
//              locks the consumer row (FOR UPDATE SKIP LOCKED), so exactly one
//              server processes it at a time. The handler runs inside that same
//              transaction, each event under its own SAVEPOINT, and the cursor
//              moves in the same commit: a projection written by the handler
//              and the cursor move together, so a crash never applies an event
//              twice or skips one. Use for read models and analytics loaders.
//
//   broadcast  An in-memory cursor per process, starting at "now". Every server
//              sees every new event. Use for per-process work such as clearing
//              an in-memory cache.
//
// Events are read in commit order (see migration 091): only rows whose
// transaction is older than every open transaction are taken, so a slow
// transaction's event is never skipped.
//
// Delivery is woken by LISTEN/NOTIFY when a session connection is configured
// (EVENT_LISTEN_DATABASE_URL; Supabase's transaction pooler on port 6543 does
// not support LISTEN) and by polling otherwise. Polling alone is correct, just
// slower.
//
// A handler that throws stops its consumer at that event. The error is recorded
// and the same event is retried on the next run, so handlers must tolerate a
// retry of an event whose side effects lived outside the database.

const { toEvent } = require('./log');

const NAME = /^[a-z][a-z0-9_.-]{1,80}$/;

const FETCH = (withTypes) => `
  SELECT * FROM event_log
   WHERE (txid, id) > ($1::xid8, $2::bigint)
     AND txid < pg_snapshot_xmin(pg_current_snapshot())
     ${withTypes ? 'AND event_type = ANY($4)' : ''}
   ORDER BY txid, id
   LIMIT $3`;

function createDispatcher({ pool, consumers = [], pollMs = 2000, batchSize = 100, listen = null, log = () => {} } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('createDispatcher: pool is required');
  const list = consumers.map((c) => {
    if (!c || !NAME.test(c.name || '')) throw new TypeError(`createDispatcher: invalid consumer name "${c && c.name}"`);
    if (typeof c.handle !== 'function') throw new TypeError(`createDispatcher: consumer ${c.name} needs handle()`);
    const mode = c.mode || 'durable';
    if (mode !== 'durable' && mode !== 'broadcast') throw new TypeError(`createDispatcher: consumer ${c.name} has unknown mode`);
    return { ...c, mode, types: Array.isArray(c.types) && c.types.length ? c.types : null, cursor: null };
  });
  if (new Set(list.map((c) => c.name)).size !== list.length) throw new TypeError('createDispatcher: consumer names must be unique');

  const stats = Object.fromEntries(list.map((c) => [c.name, { processed: 0, errors: 0, lastError: null }]));

  function fetchParams(cursor, types) {
    const p = [cursor.txid, cursor.id, batchSize];
    if (types) p.push(types);
    return p;
  }

  async function runDurable(c) {
    const client = await pool.connect();
    let done = 0;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('statement_timeout', '30000', true)");
      await client.query('INSERT INTO event_consumers (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [c.name]);
      const lock = await client.query(
        'SELECT last_txid::text AS txid, last_id::text AS id FROM event_consumers WHERE name = $1 FOR UPDATE SKIP LOCKED',
        [c.name]
      );
      if (!lock.rows.length) { await client.query('COMMIT'); return 0; } // another server has it
      const cursor = { txid: lock.rows[0].txid, id: lock.rows[0].id };
      const rows = (await client.query(FETCH(!!c.types), fetchParams(cursor, c.types))).rows;
      let failure = null;
      for (const row of rows) {
        await client.query('SAVEPOINT starlane_event');
        try {
          await c.handle(toEvent(row), { db: client });
          await client.query('RELEASE SAVEPOINT starlane_event');
          cursor.txid = row.txid; cursor.id = String(row.id); done += 1;
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT starlane_event');
          failure = err;
          break;
        }
      }
      await client.query(
        `UPDATE event_consumers
            SET last_txid = $2::xid8, last_id = $3::bigint, processed = processed + $4, updated_at = now(),
                last_error = $5, last_error_at = CASE WHEN $5::text IS NULL THEN last_error_at ELSE now() END
          WHERE name = $1`,
        [c.name, cursor.txid, cursor.id, done, failure ? String(failure.message || failure).slice(0, 1000) : null]
      );
      await client.query('COMMIT');
      if (failure) recordError(c, failure, rows[done]);
      stats[c.name].processed += done;
      return failure ? -1 : rows.length;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      recordError(c, err);
      return -1;
    } finally {
      client.release();
    }
  }

  async function headCursor() {
    const r = await pool.query('SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS txid');
    return { txid: r.rows[0].txid, id: '0' };
  }

  async function runBroadcast(c) {
    if (!c.cursor) c.cursor = await headCursor();
    const rows = (await pool.query(FETCH(!!c.types), fetchParams(c.cursor, c.types))).rows;
    for (const row of rows) {
      try {
        await c.handle(toEvent(row), { db: pool });
      } catch (err) {
        recordError(c, err, row);
        return -1;
      }
      c.cursor = { txid: row.txid, id: String(row.id) };
      stats[c.name].processed += 1;
    }
    return rows.length;
  }

  function recordError(c, err, row) {
    stats[c.name].errors += 1;
    stats[c.name].lastError = String((err && err.message) || err);
    log('warn', '[events] consumer failed; will retry', { consumer: c.name, eventId: row && String(row.id), error: stats[c.name].lastError });
  }

  // Drain every consumer: keep running one while it returns full batches.
  let running = null;
  let again = false;
  async function drainOnce() {
    for (const c of list) {
      for (let i = 0; i < 50; i += 1) {
        let n;
        try { n = c.mode === 'durable' ? await runDurable(c) : await runBroadcast(c); } catch (err) { recordError(c, err); n = -1; }
        if (n < batchSize) break;
      }
    }
  }
  function runAll() {
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        do { again = false; await drainOnce(); } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  let timer = null;
  let listener = null;
  let stopped = true;
  let wakeTimer = null;
  function wake() {
    if (wakeTimer) return;
    wakeTimer = setTimeout(() => { wakeTimer = null; runAll(); }, 25);
  }

  async function connectListener() {
    if (!listen || stopped) return;
    try {
      const { Client } = require('pg');
      const client = new Client(listen);
      client.on('notification', wake);
      client.on('error', (err) => {
        log('warn', '[events] LISTEN connection lost; polling until it reconnects', { error: err.message });
        listener = null;
        client.end().catch(() => {});
        if (!stopped) setTimeout(connectListener, 5000).unref();
      });
      await client.connect();
      await client.query('LISTEN starlane_events');
      listener = client;
    } catch (err) {
      log('warn', '[events] LISTEN unavailable; polling only', { error: err.message });
      if (!stopped) setTimeout(connectListener, 30000).unref();
    }
  }

  return {
    consumers: list.map((c) => ({ name: c.name, mode: c.mode, types: c.types })),
    runAll,
    async start() {
      if (!stopped) return;
      stopped = false;
      // Broadcast consumers start at "now", not at the beginning of history.
      for (const c of list) if (c.mode === 'broadcast' && !c.cursor) c.cursor = await headCursor();
      timer = setInterval(runAll, pollMs);
      timer.unref();
      await connectListener();
      runAll();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      if (wakeTimer) clearTimeout(wakeTimer);
      timer = null; wakeTimer = null;
      if (listener) { const l = listener; listener = null; await l.end().catch(() => {}); }
      if (running) await running.catch(() => {});
    },
    isListening: () => !!listener,
    stats: () => JSON.parse(JSON.stringify(stats)),
  };
}

// Clears a tenant's cached values whenever one of its events commits. Broadcast,
// so every server's in-memory cache is cleared, not just one.
function cacheInvalidationConsumer(cache, { name = 'cache.invalidate', types } = {}) {
  return { name, mode: 'broadcast', types, handle: (event) => cache.clearTenant(event.userId) };
}

module.exports = { createDispatcher, cacheInvalidationConsumer };
