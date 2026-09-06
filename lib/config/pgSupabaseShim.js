// FILE: lib/config/pgSupabaseShim.js
// Minimal supabase-js-compatible query builder backed directly by Postgres (pg),
// for local dev when no real Supabase project is configured. Supports the subset
// of the query-builder API this codebase actually uses.
const { Pool } = require('pg');

function makeShim(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });

  function quoteIdent(id) {
    return '"' + String(id).replace(/"/g, '""') + '"';
  }

  class QueryBuilder {
    constructor(table) {
      this.table = table;
      this._selectCols = '*';
      this._filters = [];
      this._orders = [];
      this._limit = null;
      this._range = null;
      this._mode = 'select'; // select | insert | update | delete | upsert
      this._payload = null;
      this._countOpt = null; // 'exact' etc
      this._head = false;
      this._single = false;
      this._maybeSingle = false;
      this._onConflict = null;
    }

    select(cols, opts) {
      if (cols) this._selectCols = cols;
      if (opts && opts.count) this._countOpt = opts.count;
      if (opts && opts.head) this._head = true;
      if (this._mode === 'select0') this._mode = 'select';
      return this;
    }

    insert(rows) {
      this._mode = 'insert';
      this._payload = Array.isArray(rows) ? rows : [rows];
      return this;
    }

    upsert(rows, opts) {
      this._mode = 'upsert';
      this._payload = Array.isArray(rows) ? rows : [rows];
      this._onConflict = (opts && opts.onConflict) || 'id';
      return this;
    }

    update(vals) {
      this._mode = 'update';
      this._payload = vals;
      return this;
    }

    delete() {
      this._mode = 'delete';
      return this;
    }

    _push(col, op, val) { this._filters.push({ col, op, val }); return this; }
    eq(col, val) { return this._push(col, '=', val); }
    neq(col, val) { return this._push(col, '!=', val); }
    gt(col, val) { return this._push(col, '>', val); }
    gte(col, val) { return this._push(col, '>=', val); }
    lt(col, val) { return this._push(col, '<', val); }
    lte(col, val) { return this._push(col, '<=', val); }
    like(col, val) { return this._push(col, 'LIKE', val); }
    ilike(col, val) { return this._push(col, 'ILIKE', val); }
    is(col, val) { return this._push(col, 'IS', val); }
    in(col, vals) { return this._push(col, 'IN', vals); }
    contains(col, val) { return this._push(col, '@>', val); }
    order(col, opts) { this._orders.push({ col, asc: !(opts && opts.ascending === false) }); return this; }
    limit(n) { this._limit = n; return this; }
    range(from, to) { this._range = { from, to }; return this; }
    single() { this._single = true; return this; }
    maybeSingle() { this._maybeSingle = true; return this; }

    _whereClause(startIdx) {
      const clauses = [];
      const params = [];
      let i = startIdx;
      for (const f of this._filters) {
        if (f.op === 'IN') {
          clauses.push(`${quoteIdent(f.col)} = ANY($${i++})`);
          params.push(f.val);
        } else if (f.op === 'IS') {
          clauses.push(`${quoteIdent(f.col)} IS ${f.val === null ? 'NULL' : f.val}`);
        } else {
          clauses.push(`${quoteIdent(f.col)} ${f.op} $${i++}`);
          params.push(f.val);
        }
      }
      return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params, nextIdx: i };
    }

    async _exec() {
      try {
        if (this._mode === 'select') return await this._execSelect();
        if (this._mode === 'insert') return await this._execInsert();
        if (this._mode === 'upsert') return await this._execUpsert();
        if (this._mode === 'update') return await this._execUpdate();
        if (this._mode === 'delete') return await this._execDelete();
        return { data: null, error: new Error('Unsupported mode'), count: null };
      } catch (err) {
        return { data: null, error: err, count: null };
      }
    }

    async _execSelect() {
      const { where, params } = this._whereClause(1);
      let cols = this._selectCols === '*' ? '*' : this._selectCols.split(',').map(c => quoteIdent(c.trim())).join(', ');
      if (this._head && this._countOpt) {
        const sql = `SELECT COUNT(*) FROM ${quoteIdent(this.table)} ${where}`;
        const r = await pool.query(sql, params);
        return { data: null, error: null, count: parseInt(r.rows[0].count, 10) };
      }
      let sql = `SELECT ${cols} FROM ${quoteIdent(this.table)} ${where}`;
      if (this._orders.length) {
        sql += ' ORDER BY ' + this._orders.map(o => `${quoteIdent(o.col)} ${o.asc ? 'ASC' : 'DESC'}`).join(', ');
      }
      if (this._range) {
        sql += ` LIMIT ${this._range.to - this._range.from + 1} OFFSET ${this._range.from}`;
      } else if (this._limit != null) {
        sql += ` LIMIT ${this._limit}`;
      }
      const r = await pool.query(sql, params);
      if (this._single) {
        if (r.rows.length !== 1) return { data: null, error: new Error('Row not found'), count: null };
        return { data: r.rows[0], error: null, count: null };
      }
      if (this._maybeSingle) {
        return { data: r.rows[0] || null, error: null, count: null };
      }
      return { data: r.rows, error: null, count: this._countOpt ? r.rowCount : null };
    }

    async _execInsert() {
      const rows = this._payload;
      if (!rows.length) return { data: [], error: null };
      const cols = Object.keys(rows[0]);
      const values = [];
      const params = [];
      let idx = 1;
      for (const row of rows) {
        const placeholders = cols.map(c => `$${idx++}`);
        values.push(`(${placeholders.join(', ')})`);
        for (const c of cols) params.push(row[c]);
      }
      const colList = cols.map(quoteIdent).join(', ');
      const returning = this._selectCols === '*' ? '*' : this._selectCols.split(',').map(c => quoteIdent(c.trim())).join(', ');
      const sql = `INSERT INTO ${quoteIdent(this.table)} (${colList}) VALUES ${values.join(', ')} RETURNING ${returning}`;
      const r = await pool.query(sql, params);
      if (this._single) return { data: r.rows[0], error: null };
      return { data: r.rows, error: null };
    }

    async _execUpsert() {
      const rows = this._payload;
      if (!rows.length) return { data: [], error: null };
      const cols = Object.keys(rows[0]);
      const values = [];
      const params = [];
      let idx = 1;
      for (const row of rows) {
        const placeholders = cols.map(c => `$${idx++}`);
        values.push(`(${placeholders.join(', ')})`);
        for (const c of cols) params.push(row[c]);
      }
      const colList = cols.map(quoteIdent).join(', ');
      const conflictCols = String(this._onConflict).split(',').map(c => c.trim());
      const updateSet = cols.filter(c => !conflictCols.includes(c)).map(c => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`).join(', ');
      const sql = `INSERT INTO ${quoteIdent(this.table)} (${colList}) VALUES ${values.join(', ')}
        ON CONFLICT (${conflictCols.map(quoteIdent).join(', ')}) DO UPDATE SET ${updateSet} RETURNING *`;
      const r = await pool.query(sql, params);
      return { data: r.rows, error: null };
    }

    async _execUpdate() {
      const cols = Object.keys(this._payload);
      let idx = 1;
      const setClauses = cols.map(c => `${quoteIdent(c)} = $${idx++}`);
      const params = cols.map(c => this._payload[c]);
      const { where, params: whereParams } = this._whereClause(idx);
      const returning = this._selectCols === '*' ? '*' : this._selectCols.split(',').map(c => quoteIdent(c.trim())).join(', ');
      const sql = `UPDATE ${quoteIdent(this.table)} SET ${setClauses.join(', ')} ${where} RETURNING ${returning}`;
      const r = await pool.query(sql, [...params, ...whereParams]);
      if (this._single) return { data: r.rows[0], error: null };
      return { data: r.rows, error: null };
    }

    async _execDelete() {
      const { where, params } = this._whereClause(1);
      const sql = `DELETE FROM ${quoteIdent(this.table)} ${where} RETURNING *`;
      const r = await pool.query(sql, params);
      return { data: r.rows, error: null };
    }

    then(resolve, reject) {
      return this._exec().then(resolve, reject);
    }
    catch(fn) {
      return this._exec().catch(fn);
    }
  }

  return {
    from(table) { return new QueryBuilder(table); },
    __isPgShim: true,
  };
}

module.exports = { makeShim };
