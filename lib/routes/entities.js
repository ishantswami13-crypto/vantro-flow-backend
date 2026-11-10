'use strict';
// lib/routes/entities.js — Spaces: the companies an owner runs inside one account.
//
//   GET    /api/entities                 auth  every entity with its customers and suppliers
//   POST   /api/entities                 auth  create { name, currency?, country?, color? }
//   PATCH  /api/entities/:id             auth  rename or change currency / country / colour
//   DELETE /api/entities/:id             auth  remove the entity (its members go with it)
//   PUT    /api/entities/:id/members     auth  replace its { customers: [], suppliers: [] }
//
// The tenant comes from the verified JWT only; every statement is scoped by
// user_id. Assigning a name moves it out of any other entity, so a customer
// belongs to one company at a time. Needs migration 071; until it is applied
// GET answers { available: false } and writes answer 503, never a 500.

const express = require('express');
const { safeLog } = require('../observability/logger');

const COLORS = ['#4E6A63', '#5B5670', '#596B54', '#6E5A4A', '#4A5A6E', '#6B4E5E', '#5E6B4A', '#4F5D63'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MEMBERS = 2000;

const uid = (req) => req.user?.userId || req.user?.id || null;
const missing = (err) => err && (err.code === '42P01' || err.code === '42703');

function clean(body, { partial }) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > 80) return { error: 'Give the company a name of up to 80 characters.' };
    out.name = name;
  }
  if (body.currency !== undefined) {
    if (body.currency === null || body.currency === '') out.currency = null;
    else if (typeof body.currency === 'string' && /^[A-Za-z]{3}$/.test(body.currency.trim())) out.currency = body.currency.trim().toUpperCase();
    else return { error: 'Currency must be a three-letter code such as GBP, EUR or INR.' };
  }
  if (body.country !== undefined) {
    if (body.country === null || body.country === '') out.country = null;
    else if (typeof body.country === 'string' && /^[A-Za-z]{2}$/.test(body.country.trim())) out.country = body.country.trim().toUpperCase();
    else return { error: 'Country must be a two-letter code such as GB, DE or IN.' };
  }
  if (body.color !== undefined) {
    if (body.color === null || body.color === '') out.color = null;
    else if (typeof body.color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(body.color)) out.color = body.color;
    else return { error: 'Colour must be a hex value such as #4E6A63.' };
  }
  return { value: out };
}

function names(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) return null;
  const seen = new Map();
  for (const n of list) {
    if (typeof n !== 'string') return null;
    const v = n.trim().replace(/\s+/g, ' ');
    if (!v || v.length > 200) continue;
    if (!seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  }
  return [...seen.values()];
}

async function listEntities(pool, userId) {
  const e = await pool.query(
    `SELECT id, name, currency, country, color, created_at FROM business_entities WHERE user_id = $1 ORDER BY created_at, name`, [userId]);
  const m = await pool.query(
    `SELECT entity_id, kind, name FROM business_entity_members WHERE user_id = $1 ORDER BY name`, [userId]);
  const by = new Map(e.rows.map((r) => [r.id, { ...r, customers: [], suppliers: [] }]));
  for (const r of m.rows) {
    const ent = by.get(r.entity_id);
    if (ent) ent[r.kind === 'customer' ? 'customers' : 'suppliers'].push(r.name);
  }
  return [...by.values()];
}

function entitiesRouter({ pool, authMiddleware }) {
  const router = express.Router();
  router.use(authMiddleware);

  const fail = (req, res, err, what) => {
    if (missing(err)) return res.status(503).json({ error: 'Spaces need a database update before companies can be saved.', code: 'ENTITIES_UNAVAILABLE' });
    if (err && err.code === '23505') return res.status(409).json({ error: 'You already have a company with that name.' });
    safeLog('error', `[entities] ${what} failed`, { error: err.message, requestId: req.requestId });
    return res.status(500).json({ error: 'Could not save your companies. Try again in a moment.' });
  };

  router.get('/', async (req, res) => {
    try {
      res.json({ available: true, entities: await listEntities(pool, uid(req)) });
    } catch (err) {
      if (missing(err)) return res.json({ available: false, entities: [] });
      return fail(req, res, err, 'list');
    }
  });

  router.post('/', async (req, res) => {
    const c = clean(req.body || {}, { partial: false });
    if (c.error) return res.status(400).json({ error: c.error });
    try {
      const userId = uid(req);
      const count = await pool.query(`SELECT count(*)::int AS n FROM business_entities WHERE user_id = $1`, [userId]);
      if (count.rows[0].n >= 50) return res.status(400).json({ error: 'An account can hold up to 50 companies.' });
      const color = c.value.color || COLORS[count.rows[0].n % COLORS.length];
      const r = await pool.query(
        `INSERT INTO business_entities (user_id, name, currency, country, color) VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, currency, country, color, created_at`,
        [userId, c.value.name, c.value.currency ?? null, c.value.country ?? null, color]);
      res.status(201).json({ entity: { ...r.rows[0], customers: [], suppliers: [] } });
    } catch (err) { return fail(req, res, err, 'create'); }
  });

  router.patch('/:id', async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Company not found.' });
    const c = clean(req.body || {}, { partial: true });
    if (c.error) return res.status(400).json({ error: c.error });
    const keys = Object.keys(c.value);
    if (!keys.length) return res.status(400).json({ error: 'Nothing to change.' });
    try {
      const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
      const r = await pool.query(
        `UPDATE business_entities SET ${sets}, updated_at = NOW() WHERE id = $1 AND user_id = $2
         RETURNING id, name, currency, country, color, created_at`,
        [req.params.id, uid(req), ...keys.map((k) => c.value[k])]);
      if (!r.rowCount) return res.status(404).json({ error: 'Company not found.' });
      res.json({ entity: r.rows[0] });
    } catch (err) { return fail(req, res, err, 'update'); }
  });

  router.delete('/:id', async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Company not found.' });
    try {
      const r = await pool.query(`DELETE FROM business_entities WHERE id = $1 AND user_id = $2`, [req.params.id, uid(req)]);
      if (!r.rowCount) return res.status(404).json({ error: 'Company not found.' });
      res.json({ success: true });
    } catch (err) { return fail(req, res, err, 'delete'); }
  });

  router.put('/:id/members', async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Company not found.' });
    const customers = names(req.body?.customers);
    const suppliers = names(req.body?.suppliers);
    if (!customers || !suppliers) return res.status(400).json({ error: 'Send customers and suppliers as lists of names.' });
    if (customers.length + suppliers.length > MAX_MEMBERS) return res.status(400).json({ error: `Assign up to ${MAX_MEMBERS} names at a time.` });
    const userId = uid(req);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const own = await client.query(`SELECT id FROM business_entities WHERE id = $1 AND user_id = $2 FOR UPDATE`, [req.params.id, userId]);
      if (!own.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Company not found.' }); }
      await client.query(`DELETE FROM business_entity_members WHERE user_id = $1 AND entity_id = $2`, [userId, req.params.id]);
      for (const [kind, list] of [['customer', customers], ['supplier', suppliers]]) {
        if (!list.length) continue;
        // A name assigned here leaves whichever company had it before.
        await client.query(
          `DELETE FROM business_entity_members WHERE user_id = $1 AND kind = $2 AND lower(btrim(name)) = ANY($3::text[])`,
          [userId, kind, list.map((n) => n.toLowerCase())]);
        await client.query(
          `INSERT INTO business_entity_members (user_id, entity_id, kind, name)
           SELECT $1, $2, $3, unnest($4::text[])`,
          [userId, req.params.id, kind, list]);
      }
      await client.query('COMMIT');
      const all = await listEntities(pool, userId);
      res.json({ entity: all.find((e) => e.id === req.params.id) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return fail(req, res, err, 'members');
    } finally { client.release(); }
  });

  return router;
}

module.exports = { entitiesRouter, listEntities };
