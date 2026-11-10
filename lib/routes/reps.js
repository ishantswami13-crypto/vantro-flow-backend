'use strict';
// lib/routes/reps.js — Team dashboard: the people who own customer accounts.
//
//   GET    /api/reps                  auth  every rep with the customers they own
//   POST   /api/reps                  auth  create { name, email?, region?, color? }
//   PATCH  /api/reps/:id              auth  rename or change email / region / colour
//   DELETE /api/reps/:id              auth  remove the rep (their customers become unassigned)
//   PUT    /api/reps/:id/customers    auth  replace their { customers: [] }
//
// The tenant comes from the verified JWT only; every statement is scoped by
// user_id. Assigning a customer moves it away from any other rep, so a
// customer has one rep at a time. Needs migration 072; until it is applied
// GET answers { available: false } and writes answer 503, never a 500.

const express = require('express');
const { safeLog } = require('../observability/logger');

const COLORS = ['#4E6A63', '#5B5670', '#596B54', '#6E5A4A', '#4A5A6E', '#6B4E5E', '#5E6B4A', '#4F5D63'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_CUSTOMERS = 2000;
const MAX_REPS = 200;

const uid = (req) => req.user?.userId || req.user?.id || null;
const missing = (err) => err && (err.code === '42P01' || err.code === '42703');
const squash = (s) => s.trim().replace(/\s+/g, ' ');

function clean(body, { partial }) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = typeof body.name === 'string' ? squash(body.name) : '';
    if (!name || name.length > 80) return { error: 'Give the person a name of up to 80 characters.' };
    out.name = name;
  }
  if (body.email !== undefined) {
    if (body.email === null || body.email === '') out.email = null;
    else if (typeof body.email === 'string' && body.email.trim().length <= 200 && EMAIL.test(body.email.trim())) out.email = body.email.trim().toLowerCase();
    else return { error: 'Email must look like name@company.com.' };
  }
  if (body.region !== undefined) {
    if (body.region === null || body.region === '') out.region = null;
    else if (typeof body.region === 'string' && squash(body.region) && squash(body.region).length <= 60) out.region = squash(body.region);
    else return { error: 'Keep the region or team to 60 characters.' };
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
    const v = squash(n);
    if (!v || v.length > 200) continue;
    if (!seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  }
  return [...seen.values()];
}

async function listReps(pool, userId) {
  const r = await pool.query(
    `SELECT id, name, email, region, color, created_at FROM sales_reps WHERE user_id = $1 ORDER BY created_at, name`, [userId]);
  const m = await pool.query(
    `SELECT rep_id, name FROM sales_rep_customers WHERE user_id = $1 ORDER BY name`, [userId]);
  const by = new Map(r.rows.map((row) => [row.id, { ...row, customers: [] }]));
  for (const row of m.rows) by.get(row.rep_id)?.customers.push(row.name);
  return [...by.values()];
}

function repsRouter({ pool, authMiddleware }) {
  const router = express.Router();
  router.use(authMiddleware);

  const fail = (req, res, err, what) => {
    if (missing(err)) return res.status(503).json({ error: 'The team dashboard needs a database update before people can be saved.', code: 'REPS_UNAVAILABLE' });
    if (err && err.code === '23505') return res.status(409).json({ error: 'Someone on your team already has that name.' });
    safeLog('error', `[reps] ${what} failed`, { error: err.message, requestId: req.requestId });
    return res.status(500).json({ error: 'Could not save your team. Try again in a moment.' });
  };

  router.get('/', async (req, res) => {
    try {
      res.json({ available: true, reps: await listReps(pool, uid(req)) });
    } catch (err) {
      if (missing(err)) return res.json({ available: false, reps: [] });
      return fail(req, res, err, 'list');
    }
  });

  router.post('/', async (req, res) => {
    const c = clean(req.body || {}, { partial: false });
    if (c.error) return res.status(400).json({ error: c.error });
    try {
      const userId = uid(req);
      const count = await pool.query(`SELECT count(*)::int AS n FROM sales_reps WHERE user_id = $1`, [userId]);
      if (count.rows[0].n >= MAX_REPS) return res.status(400).json({ error: `A team can hold up to ${MAX_REPS} people.` });
      const color = c.value.color || COLORS[count.rows[0].n % COLORS.length];
      const r = await pool.query(
        `INSERT INTO sales_reps (user_id, name, email, region, color) VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, email, region, color, created_at`,
        [userId, c.value.name, c.value.email ?? null, c.value.region ?? null, color]);
      res.status(201).json({ rep: { ...r.rows[0], customers: [] } });
    } catch (err) { return fail(req, res, err, 'create'); }
  });

  router.patch('/:id', async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Person not found.' });
    const c = clean(req.body || {}, { partial: true });
    if (c.error) return res.status(400).json({ error: c.error });
    const keys = Object.keys(c.value);
    if (!keys.length) return res.status(400).json({ error: 'Nothing to change.' });
    try {
      // keys come from clean() only: name, email, region, color.
      const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
      const r = await pool.query(
        `UPDATE sales_reps SET ${sets}, updated_at = NOW() WHERE id = $1 AND user_id = $2
         RETURNING id, name, email, region, color, created_at`,
        [req.params.id, uid(req), ...keys.map((k) => c.value[k])]);
      if (!r.rowCount) return res.status(404).json({ error: 'Person not found.' });
      res.json({ rep: r.rows[0] });
    } catch (err) { return fail(req, res, err, 'update'); }
  });

  router.delete('/:id', async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Person not found.' });
    try {
      const r = await pool.query(`DELETE FROM sales_reps WHERE id = $1 AND user_id = $2`, [req.params.id, uid(req)]);
      if (!r.rowCount) return res.status(404).json({ error: 'Person not found.' });
      res.json({ success: true });
    } catch (err) { return fail(req, res, err, 'delete'); }
  });

  router.put('/:id/customers', async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Person not found.' });
    const customers = names(req.body?.customers);
    if (!customers) return res.status(400).json({ error: 'Send customers as a list of names.' });
    if (customers.length > MAX_CUSTOMERS) return res.status(400).json({ error: `Assign up to ${MAX_CUSTOMERS} customers at a time.` });
    const userId = uid(req);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const own = await client.query(`SELECT id FROM sales_reps WHERE id = $1 AND user_id = $2 FOR UPDATE`, [req.params.id, userId]);
      if (!own.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Person not found.' }); }
      await client.query(`DELETE FROM sales_rep_customers WHERE user_id = $1 AND rep_id = $2`, [userId, req.params.id]);
      if (customers.length) {
        // A customer assigned here leaves whichever rep had it before.
        await client.query(
          `DELETE FROM sales_rep_customers WHERE user_id = $1 AND lower(btrim(name)) = ANY($2::text[])`,
          [userId, customers.map((n) => n.toLowerCase())]);
        await client.query(
          `INSERT INTO sales_rep_customers (user_id, rep_id, name) SELECT $1, $2, unnest($3::text[])`,
          [userId, req.params.id, customers]);
      }
      await client.query('COMMIT');
      const all = await listReps(pool, userId);
      res.json({ rep: all.find((r) => r.id === req.params.id) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return fail(req, res, err, 'customers');
    } finally { client.release(); }
  });

  return router;
}

module.exports = { repsRouter, listReps };
