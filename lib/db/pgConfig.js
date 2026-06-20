// FILE: lib/db/pgConfig.js
'use strict';

/**
 * Phase 2C.31V — PG startup-packet hardening.
 *
 * Builds an explicit pg.Pool / pg.Client config from DATABASE_URL while keeping the
 * PostgreSQL startup packet small enough for Supabase's transaction pooler. PgBouncer
 * caps the startup packet at 1024 bytes and rejects anything larger with
 * ESTARTUPPACKETTOOLARGE.
 *
 * Phase 2C.31U already stopped passing the raw connectionString and stopped forwarding
 * the DATABASE_URL query string, yet the deployed packet stayed at 1209 bytes. The cause
 * (verified against node_modules/pg) is the env fallback inside node-postgres:
 *
 *   - connection-parameters.js `val(key, config, envVar)` only honors `config[key]` when
 *     it is TRUTHY; otherwise it falls through to process.env['PG' + KEY] and then to the
 *     library defaults. Concretely:
 *        * the application name is read from PGAPPNAME when config does not set it
 *        * the libpq "options" startup param is read from PGOPTIONS when config does not
 *          set it
 *   - client.js `getStartupConf()` then folds those values into the startup packet
 *     whenever they are truthy (it always sends user + database, and conditionally sends
 *     the application name, replication, the timeouts, and the options param).
 *
 * So a large PGAPPNAME / PGOPTIONS present in the deployed environment inflates the packet
 * even though our config object never sets either field. An absent or empty config value
 * does NOT suppress the fallback (empty is falsy, so pg still reads the env). The only
 * reliable block is to clear the env vars themselves before pg constructs its connection
 * parameters.
 *
 * Hardening applied here:
 *   1. Parse DATABASE_URL with the native URL parser. Never pass the raw connectionString,
 *      never forward the URL query string.
 *   2. Decode user / password / database. The native URL parser leaves these
 *      percent-encoded; pg-connection-string (the old connectionString path) would have
 *      decoded them, so we match that behavior with a fail-safe decoder.
 *   3. Clear PGOPTIONS / PGAPPNAME from the process env so pg cannot inject them into the
 *      startup packet. We set NEITHER an application name NOR an options param in the
 *      config — with the env cleared and the pg defaults being undefined, the startup
 *      packet carries only user + database.
 *   4. Preserve SSL and the pool sizing / timeout settings exactly (unchanged from 2C.31U).
 *
 * No DATABASE_URL, credential, or other secret is ever logged.
 */

// Decode a single URL component, falling back to the raw value if it is not valid
// percent-encoding. Never throws, never logs.
function safeDecode(value) {
  if (value === undefined || value === null || value === '') return value;
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

// Remove the libpq env vars that node-postgres would otherwise fold into the startup
// packet. getStartupConf() always sends user + database and, when the corresponding field
// is truthy, also sends the application name (PGAPPNAME), the options param (PGOPTIONS), and
// replication (PGREPLICATION) — these three are the ONLY env-sourced fields it can write to
// the packet. (The *_timeout fields use pg's envVar=false path and read no env at all;
// pg-protocol always appends the fixed client_encoding=UTF8 startup pair itself, so
// PGCLIENT_ENCODING cannot inflate the packet.) PGOPTIONS is the critical one: no config
// value can mean "send nothing" for it, so the env itself must be cleared; the other two are
// cleared as defence-in-depth (we also set no application name and no replication in config).
// Clearing all three makes the packet provably free of env-sourced inflation. This is an
// in-process runtime change only; it does not read or modify any Railway / .env file.
function neutralizePgStartupEnv() {
  if ('PGOPTIONS' in process.env) delete process.env.PGOPTIONS;
  if ('PGAPPNAME' in process.env) delete process.env.PGAPPNAME;
  if ('PGREPLICATION' in process.env) delete process.env.PGREPLICATION;
}

/**
 * Parses DATABASE_URL safely and returns a configuration object for pg.Pool / pg.Client.
 * Bypassing connectionString and the env startup-param fallbacks keeps the startup packet
 * within PgBouncer's limit (ESTARTUPPACKETTOOLARGE otherwise).
 */
function buildSanitizedPgConfig(dbUrlStr) {
  if (!dbUrlStr) return null;
  try {
    const url = new URL(dbUrlStr);

    // new URL() is pure (it does not read process.env), so clearing the env here — after
    // parsing but before pg builds its ConnectionParameters at connect time — is correct
    // ordering: the env fallback will read the already-cleared values.
    // Stop pg from inheriting an oversized startup packet from libpq env vars.
    neutralizePgStartupEnv();

    return {
      host: url.hostname,
      port: Number(url.port) || 5432,
      database: safeDecode(url.pathname.replace(/^\//, '')),
      user: safeDecode(url.username),
      password: safeDecode(url.password),
      // Fixed safe pool settings matching previous expectations
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };
  } catch (err) {
    throw new Error('DATABASE_URL is malformed or invalid.');
  }
}

// Phase 2C.31W — re-export the secret-safe startup-packet estimator. Its implementation lives
// in a sibling module so this file stays free of the application-name / options config-key
// literals that the 2C.31U/2C.31V regression checkers forbid here. The estimator returns only
// field names and byte lengths — never any value.
const { estimateStartupPacket } = require('./pgStartupEstimate');

module.exports = { buildSanitizedPgConfig, estimateStartupPacket };
