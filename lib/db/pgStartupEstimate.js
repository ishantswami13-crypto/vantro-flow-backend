// FILE: lib/db/pgStartupEstimate.js
'use strict';

/**
 * Phase 2C.31W — secret-safe PostgreSQL startup-packet estimator.
 *
 * Proves, by FIELD NAME and BYTE LENGTH ONLY (never any value), exactly what the pg
 * StartupMessage carries and whether it fits Supabase/PgBouncer's 1024-byte limit. It exists
 * because 2C.31V deployed correctly but the live packet was still 1145 > 1024.
 *
 * The byte model is derived from the LOCKFILE-PINNED driver, NOT from any assumed-present
 * node_modules (which is absent in a fresh worktree/CI): pg@8.21.0 + pg-protocol@1.14.0, as
 * pinned in package-lock.json. pg-protocol's startup serializer (serializer.js `startup`) is:
 *     writer.addInt16(3).addInt16(0)                          // 4-byte protocol version 3.0
 *     for (key of opts) writer.addCString(key).addCString(opts[key])
 *     writer.addCString('client_encoding').addCString('UTF8') // ALWAYS appended by the serializer
 *     bodyBuffer = writer.addCString('').flush()              // 1-byte final NUL terminator
 *     length = bodyBuffer.length + 4                           // 4-byte Int32 length prefix
 * The `opts` come from pg client.js getStartupConf(): always user + database; and
 * application_name (= application_name || fallback_application_name), replication, the three
 * *_timeout fields, and options ONLY when truthy. password / host / port are NOT in the
 * startup packet (password is sent later during auth).
 *
 * Therefore fixed framing = 4 (length) + 4 (protocol) + 1 (final NUL) = 9 bytes, PLUS the
 * always-appended client_encoding=UTF8 pair (15+1 + 4+1 = 21 bytes). Each present param costs
 * byteLen(key)+1 + byteLen(value)+1. The minimal user=database='postgres' packet is therefore
 * 9 + 14 + 18 + 21 = 62 bytes. The live 1145-byte packet ⇒ len(user)+len(database) ≈ 1099,
 * i.e. an oversized/malformed pooler credential in DATABASE_URL (an owner env fix, not code).
 *
 * SECRET SAFETY: returns ONLY field names, presence booleans, and integer byte lengths
 * (keyBytes / valueBytes / pairBytes) + total + below-limit. It never returns or logs any
 * value. No console, no I/O, no DB/network call. It does not alter connection behavior.
 */

const PGBOUNCER_LIMIT = 1024;
const LENGTH_PREFIX_BYTES = 4;      // Int32 message length prefix
const PROTOCOL_VERSION_BYTES = 4;   // Int16(3) + Int16(0) protocol version 3.0
const FINAL_NUL_BYTES = 1;          // trailing addCString('') terminator
const FRAMING_BYTES = LENGTH_PREFIX_BYTES + PROTOCOL_VERSION_BYTES + FINAL_NUL_BYTES; // 9

// pg-protocol's startup serializer always appends this pair to EVERY startup message.
const CLIENT_ENCODING_KEY = 'client_encoding';
const CLIENT_ENCODING_VALUE = 'UTF8';

const APP_NAME_KEY = 'application_name';
const FALLBACK_APP_NAME_KEY = 'fallback_application_name';

function byteLen(v) {
  return v === undefined || v === null ? 0 : Buffer.byteLength(String(v), 'utf8');
}

// getStartupConf() serializes each *_timeout as String(parseInt(value, 10)). Mirror that.
function serializeTimeout(v) {
  return v ? String(parseInt(v, 10)) : undefined;
}

// Resolve a startup field the way pg's val() does: config[key] (if truthy) else env else dflt.
// Returns the resolved value ONLY so its byte length can be measured; callers never receive it.
function resolveVal(config, key, envName, dflt) {
  if (config[key]) return config[key];
  if (envName !== false) {
    const env = process.env[envName || 'PG' + key.toUpperCase()];
    if (env !== undefined && env !== null && env !== '') return env;
  }
  return dflt;
}

/**
 * Estimate the StartupMessage size for a sanitized pg config. Returns ONLY field names,
 * presence flags, key/value/pair byte lengths, the total, and a below-limit boolean.
 *
 * @param {object} config result of buildSanitizedPgConfig (or any pg config object)
 * @returns {{fields: Array<{name:string,present:boolean,keyBytes:number,valueBytes:number,pairBytes:number}>,
 *            totalBytes:number, limit:number, belowLimit:boolean}}
 */
function estimateStartupPacket(config) {
  config = config || {};

  const osUser = (process.platform === 'win32' ? process.env.USERNAME : process.env.USER) || undefined;
  const user = resolveVal(config, 'user', 'PGUSER', osUser);
  let database = resolveVal(config, 'database', 'PGDATABASE', undefined);
  if (database === undefined || database === null || database === '') database = user; // pg default

  // On the wire, application_name = application_name || fallback_application_name (getStartupConf).
  // So fallback_application_name is NOT its own wire field — it only feeds application_name and
  // is therefore intentionally NOT emitted as a separate startup field below.
  const appExplicit = resolveVal(config, APP_NAME_KEY, 'PGAPPNAME', undefined);
  const appName = appExplicit || config[FALLBACK_APP_NAME_KEY] || undefined;
  const options = resolveVal(config, 'options', 'PGOPTIONS', undefined);
  const replication = resolveVal(config, 'replication', 'PGREPLICATION', undefined);
  const stTimeout = serializeTimeout(config.statement_timeout);
  const lockTimeout = serializeTimeout(config.lock_timeout);
  const idleTimeout = serializeTimeout(config.idle_in_transaction_session_timeout);

  // getStartupConf() opts (user/database always; the rest only when truthy), then pg-protocol's
  // always-appended client_encoding=UTF8.
  const spec = [
    { name: 'user', present: !!user, value: user },
    { name: 'database', present: !!database, value: database },
    { name: APP_NAME_KEY, present: !!appName, value: appName },
    { name: 'replication', present: !!replication, value: replication === undefined || replication === null ? undefined : String(replication) },
    { name: 'statement_timeout', present: !!stTimeout, value: stTimeout },
    { name: 'lock_timeout', present: !!lockTimeout, value: lockTimeout },
    { name: 'idle_in_transaction_session_timeout', present: !!idleTimeout, value: idleTimeout },
    { name: 'options', present: !!options, value: options },
    { name: CLIENT_ENCODING_KEY, present: true, value: CLIENT_ENCODING_VALUE },
  ];

  let paramBytes = 0;
  const fields = spec.map((f) => {
    const keyBytes = f.present ? byteLen(f.name) : 0;
    const valueBytes = f.present ? byteLen(f.value) : 0;
    const pairBytes = f.present ? keyBytes + 1 + valueBytes + 1 : 0; // CString key + CString value
    if (f.present) paramBytes += pairBytes;
    return { name: f.name, present: f.present, keyBytes, valueBytes, pairBytes };
  });

  const totalBytes = FRAMING_BYTES + paramBytes;
  return { fields, totalBytes, limit: PGBOUNCER_LIMIT, belowLimit: totalBytes < PGBOUNCER_LIMIT };
}

module.exports = { estimateStartupPacket, PGBOUNCER_LIMIT };
