'use strict';
// lib/routes/watches.js — Watch feature CRUD + on-demand evaluate.
// Factory pattern: mounted from server.js with its existing pgPool and
// authMiddleware so there is no circular require and no duplicated auth
// logic. All queries are strictly scoped by the authenticated user's id
// (from authMiddleware's req.user), matching the pattern used by every
// other route in server.js.
const express = require('express');
const { evaluateWatch, SUPPORTED_METRICS } = require('../services/watchEvaluator');

function authenticatedUserId(req) {
  return req.user?.userId || req.user?.id || null;
}

function watchesRouter({ pool, authMiddleware }) {
  const router = express.Router();
  router.use(authMiddleware);

  const VALID_STATUS = new Set(['active', 'paused', 'archived']);
  const VALID_SEVERITY = new Set(['low', 'medium', 'high', 'critical']);
  const VALID_OPERATORS = new Set(['gt', 'gte', 'lt', 'lte', 'eq']);

  function validateConditionConfig(conditionConfig) {
    if (!conditionConfig || typeof conditionConfig !== 'object' || Array.isArray(conditionConfig)) {
      return 'condition_config must be an object';
    }
    if (!VALID_OPERATORS.has(conditionConfig.operator)) {
      return `condition_config.operator must be one of ${[...VALID_OPERATORS].join(', ')}`;
    }
    if (conditionConfig.threshold === undefined || conditionConfig.threshold === null || Number.isNaN(Number(conditionConfig.threshold))) {
      return 'condition_config.threshold must be a number';
    }
    return null;
  }

  // POST /api/watches — create
  router.post('/', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const { name, description, metric_key, condition_config, severity } = req.body || {};
      if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
      if (!SUPPORTED_METRICS.has(metric_key)) {
        return res.status(400).json({ error: `metric_key must be one of ${[...SUPPORTED_METRICS].join(', ')}` });
      }
      const configErr = validateConditionConfig(condition_config);
      if (configErr) return res.status(400).json({ error: configErr });
      const sev = VALID_SEVERITY.has(severity) ? severity : 'medium';

      const { rows } = await pool.query(
        `INSERT INTO watches (user_id, created_by, name, description, metric_key, condition_config, severity)
         VALUES ($1,$1,$2,$3,$4,$5,$6) RETURNING *`,
        [userId, name, description || null, metric_key, JSON.stringify(condition_config), sev]
      );
      res.status(201).json({ watch: rows[0] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/watches — list, scoped to req.user
  router.get('/', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const statusFilter = req.query.status;
      let q = `SELECT * FROM watches WHERE user_id = $1`;
      const params = [userId];
      if (statusFilter && VALID_STATUS.has(statusFilter)) {
        q += ` AND status = $2`;
        params.push(statusFilter);
      } else {
        q += ` AND status <> 'archived'`;
      }
      q += ` ORDER BY created_at DESC`;
      const { rows } = await pool.query(q, params);
      res.json({ watches: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/watches/:id — 404 if not owned
  router.get('/:id', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const { rows } = await pool.query(`SELECT * FROM watches WHERE id = $1 AND user_id = $2`, [req.params.id, userId]);
      if (!rows[0]) return res.status(404).json({ error: 'Watch not found' });
      res.json({ watch: rows[0] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // PATCH /api/watches/:id — update / pause / resume (status field, etc.)
  router.patch('/:id', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const existing = await pool.query(`SELECT * FROM watches WHERE id = $1 AND user_id = $2`, [req.params.id, userId]);
      if (!existing.rows[0]) return res.status(404).json({ error: 'Watch not found' });

      const { name, description, metric_key, condition_config, severity, status } = req.body || {};
      const updates = [];
      const params = [];
      let i = 1;

      if (name !== undefined) { updates.push(`name = $${i++}`); params.push(name); }
      if (description !== undefined) { updates.push(`description = $${i++}`); params.push(description); }
      if (metric_key !== undefined) {
        if (!SUPPORTED_METRICS.has(metric_key)) return res.status(400).json({ error: `metric_key must be one of ${[...SUPPORTED_METRICS].join(', ')}` });
        updates.push(`metric_key = $${i++}`); params.push(metric_key);
      }
      if (condition_config !== undefined) {
        const configErr = validateConditionConfig(condition_config);
        if (configErr) return res.status(400).json({ error: configErr });
        updates.push(`condition_config = $${i++}`); params.push(JSON.stringify(condition_config));
      }
      if (severity !== undefined) {
        if (!VALID_SEVERITY.has(severity)) return res.status(400).json({ error: `severity must be one of ${[...VALID_SEVERITY].join(', ')}` });
        updates.push(`severity = $${i++}`); params.push(severity);
      }
      if (status !== undefined) {
        if (!VALID_STATUS.has(status)) return res.status(400).json({ error: `status must be one of ${[...VALID_STATUS].join(', ')}` });
        updates.push(`status = $${i++}`); params.push(status);
      }
      if (updates.length === 0) return res.status(400).json({ error: 'No updatable fields provided' });
      updates.push(`updated_at = NOW()`);

      params.push(req.params.id, userId);
      const { rows } = await pool.query(
        `UPDATE watches SET ${updates.join(', ')} WHERE id = $${i++} AND user_id = $${i++} RETURNING *`,
        params
      );
      res.json({ watch: rows[0] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/watches/:id — soft delete (status='archived')
  router.delete('/:id', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const { rows } = await pool.query(
        `UPDATE watches SET status = 'archived', updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING *`,
        [req.params.id, userId]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Watch not found' });
      res.json({ watch: rows[0] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/watches/:id/evaluate — evaluate-now, on-demand
  router.post('/:id/evaluate', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const { rows } = await pool.query(`SELECT * FROM watches WHERE id = $1 AND user_id = $2`, [req.params.id, userId]);
      const watch = rows[0];
      if (!watch) return res.status(404).json({ error: 'Watch not found' });

      const result = await evaluateAndPersist(pool, watch);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  return router;
}

// Shared by the on-demand route and the cron scheduler — evaluates one
// watch, writes the audit row, and updates last_evaluated_at /
// last_triggered_at (only bumping last_triggered_at on a false->true
// transition, per migration comments).
async function evaluateAndPersist(pool, watch) {
  let evalResult;
  let errorText = null;
  try {
    evalResult = await evaluateWatch(pool, watch);
  } catch (e) {
    errorText = e.message;
    evalResult = { value: null, triggered: false, detail: null };
  }

  // Look at the previous evaluation (if any) to detect a false->true
  // transition, per migration comments — last_triggered_at only bumps
  // when the watch newly becomes triggered, not on every triggered run.
  const prev = await pool.query(
    `SELECT triggered FROM watch_evaluations WHERE watch_id = $1 ORDER BY evaluated_at DESC LIMIT 1`,
    [watch.id]
  );
  const wasTriggered = prev.rows[0] ? prev.rows[0].triggered === true : false;
  const newlyTriggered = evalResult.triggered && !wasTriggered;

  await pool.query(
    `INSERT INTO watch_evaluations (watch_id, user_id, result_value, triggered, error_text)
     VALUES ($1,$2,$3,$4,$5)`,
    [watch.id, watch.user_id, JSON.stringify({ value: evalResult.value, detail: evalResult.detail }), evalResult.triggered, errorText]
  );

  const { rows } = await pool.query(
    `UPDATE watches
     SET last_evaluated_at = NOW(),
         last_triggered_at = CASE WHEN $2 THEN NOW() ELSE last_triggered_at END
     WHERE id = $1 RETURNING *`,
    [watch.id, newlyTriggered]
  );

  return {
    watch: rows[0],
    evaluation: { value: evalResult.value, triggered: evalResult.triggered, detail: evalResult.detail, error: errorText },
  };
}

module.exports = { watchesRouter, evaluateAndPersist };
