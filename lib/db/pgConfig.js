// FILE: lib/db/pgConfig.js
'use strict';

/**
 * Parses DATABASE_URL safely and returns a configuration object for pg.Pool.
 * Bypassing connectionString prevents uncontrolled startup parameters from inflating
 * the startup packet size beyond PgBouncer's limits (ESTARTUPPACKETTOOLARGE).
 */
function buildSanitizedPgConfig(dbUrlStr) {
  if (!dbUrlStr) return null;
  try {
    const url = new URL(dbUrlStr);
    return {
      host: url.hostname,
      port: Number(url.port) || 5432,
      database: url.pathname.replace(/^\//, ''),
      user: url.username,
      password: url.password,
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

module.exports = { buildSanitizedPgConfig };
