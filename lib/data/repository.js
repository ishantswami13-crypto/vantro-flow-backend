'use strict';
// lib/data/repository.js — tenant-scoped table access.
//
// defineRepository({ table, columns }) returns findById / findMany / count /
// insert / update / remove. Every method takes the tenant handle from
// withTenant() as its first argument and adds `<tenantColumn> = db.userId` to
// every statement it builds. There is no way to call a method without a tenant,
// and no way to read or change another tenant's rows through it.
//
// Identifiers (table, columns, order) come only from the definition, never from
// the caller's input, so they are safe to interpolate. Values are always bound
// parameters.

const IDENT = /^[a-z_][a-z0-9_]*$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function q(ident) {
  if (!IDENT.test(ident)) throw new Error(`repository: invalid identifier "${ident}"`);
  return `"${ident}"`;
}

function requireTenant(db) {
  if (!db || typeof db.query !== 'function' || !db.userId) {
    throw new TypeError('repository: pass the tenant handle from withTenant() as the first argument');
  }
  return db.userId;
}

function defineRepository(def) {
  const table = def && def.table;
  const tenantColumn = (def && def.tenantColumn) || 'user_id';
  const primaryKey = (def && def.primaryKey) || 'id';
  const columns = new Set((def && def.columns) || []);
  if (!table || !columns.size) throw new Error('repository: table and columns are required');
  for (const c of [...columns, tenantColumn, primaryKey]) q(c);
  columns.add(tenantColumn);
  columns.add(primaryKey);
  const tableSql = table.split('.').map(q).join('.');

  function col(name) {
    if (!columns.has(name)) throw new Error(`repository(${table}): unknown column "${name}"`);
    return q(name);
  }

  // WHERE tenant = $n AND <filters>; appends to params.
  function where(db, filters = {}, params = []) {
    params.push(requireTenant(db));
    const parts = [`${q(tenantColumn)} = $${params.length}`];
    for (const [name, value] of Object.entries(filters)) {
      if (value === undefined) continue;
      if (name === tenantColumn) throw new Error(`repository(${table}): the tenant filter is implicit`);
      if (value === null) { parts.push(`${col(name)} IS NULL`); continue; }
      params.push(value);
      parts.push(Array.isArray(value) ? `${col(name)} = ANY($${params.length})` : `${col(name)} = $${params.length}`);
    }
    return { sql: parts.join(' AND '), params };
  }

  function orderSql(orderBy) {
    if (!orderBy) return '';
    const list = Array.isArray(orderBy) ? orderBy : [orderBy];
    const parts = list.map((o) => {
      const [name, dirRaw] = typeof o === 'string' ? o.trim().split(/\s+/) : [o.column, o.direction];
      const dir = String(dirRaw || 'asc').toLowerCase();
      if (dir !== 'asc' && dir !== 'desc') throw new Error(`repository(${table}): bad sort direction "${dirRaw}"`);
      return `${col(name)} ${dir.toUpperCase()}`;
    });
    return parts.length ? ` ORDER BY ${parts.join(', ')}` : '';
  }

  function clampLimit(limit) {
    if (limit === undefined || limit === null) return DEFAULT_LIMIT;
    const n = Math.floor(Number(limit));
    if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
    return Math.min(n, MAX_LIMIT);
  }

  function writable(row, { forUpdate }) {
    const out = {};
    for (const [name, value] of Object.entries(row || {})) {
      if (value === undefined) continue;
      if (name === tenantColumn) throw new Error(`repository(${table}): ${tenantColumn} is set from the tenant handle`);
      if (forUpdate && name === primaryKey) throw new Error(`repository(${table}): cannot change ${primaryKey}`);
      col(name);
      out[name] = value;
    }
    return out;
  }

  const repo = {
    table,
    async findById(db, id) {
      const w = where(db, { [primaryKey]: id });
      const r = await db.query(`SELECT * FROM ${tableSql} WHERE ${w.sql} LIMIT 1`, w.params);
      return r.rows[0] || null;
    },
    async findMany(db, filters = {}, opts = {}) {
      const w = where(db, filters);
      w.params.push(clampLimit(opts.limit));
      let sql = `SELECT * FROM ${tableSql} WHERE ${w.sql}${orderSql(opts.orderBy)} LIMIT $${w.params.length}`;
      if (opts.offset) {
        w.params.push(Math.max(0, Math.floor(Number(opts.offset)) || 0));
        sql += ` OFFSET $${w.params.length}`;
      }
      const r = await db.query(sql, w.params);
      return r.rows;
    },
    async count(db, filters = {}) {
      const w = where(db, filters);
      const r = await db.query(`SELECT count(*)::int AS n FROM ${tableSql} WHERE ${w.sql}`, w.params);
      return r.rows[0].n;
    },
    async insert(db, row) {
      const tenant = requireTenant(db);
      const data = writable(row, { forUpdate: false });
      const names = [tenantColumn, ...Object.keys(data)];
      const params = [tenant, ...Object.values(data)];
      const placeholders = params.map((_, i) => `$${i + 1}`);
      const r = await db.query(
        `INSERT INTO ${tableSql} (${names.map(q).join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
        params
      );
      return r.rows[0];
    },
    async update(db, id, patch) {
      const data = writable(patch, { forUpdate: true });
      const names = Object.keys(data);
      if (!names.length) return repo.findById(db, id);
      const params = Object.values(data);
      const sets = names.map((n, i) => `${q(n)} = $${i + 1}`);
      const w = where(db, { [primaryKey]: id }, params);
      const r = await db.query(`UPDATE ${tableSql} SET ${sets.join(', ')} WHERE ${w.sql} RETURNING *`, w.params);
      return r.rows[0] || null;
    },
    async remove(db, id) {
      const w = where(db, { [primaryKey]: id });
      const r = await db.query(`DELETE FROM ${tableSql} WHERE ${w.sql}`, w.params);
      return r.rowCount > 0;
    },
  };
  return Object.freeze(repo);
}

module.exports = { defineRepository, DEFAULT_LIMIT, MAX_LIMIT };
