'use strict';
// lib/routes/customWorkflows.js — the custom workflow builder over HTTP.
//
//   GET    /api/custom-workflows/catalog        triggers, agents, actions, templates
//   POST   /api/custom-workflows/validate       check a definition without saving
//   GET    /api/custom-workflows                this tenant's workflows
//   POST   /api/custom-workflows                create (DRAFT)
//   GET    /api/custom-workflows/:id            one workflow + recent runs
//   PUT    /api/custom-workflows/:id            edit (bumps version)
//   DELETE /api/custom-workflows/:id
//   POST   /api/custom-workflows/:id/activate|pause
//   POST   /api/custom-workflows/:id/run        run now (at most once a minute)
//   GET    /api/custom-workflows/:id/runs
//
// Every handler takes the tenant from the verified JWT, never the request.

const express = require('express');
const cw = require('../domain/workflows/customWorkflows');
const { getSettings } = require('../domain/decisions/controls');
const { safeLog } = require('../observability/logger');

function uid(req) {
  return req.user?.userId || req.user?.id || null;
}

function runView(r) {
  return {
    id: r.id, workflowVersion: r.workflow_version, trigger: r.trigger, status: r.status,
    steps: r.steps || [], summary: r.summary, error: r.error, startedAt: r.started_at, finishedAt: r.finished_at,
  };
}

function workflowView(w, { timezone = 'UTC', schedulerEnabled = false } = {}) {
  const trigger = w.definition?.trigger || null;
  return {
    id: w.id, name: w.name, description: w.description, status: w.status, version: w.version,
    definition: w.definition, createdAt: w.created_at, updatedAt: w.updated_at,
    lastRun: w.last_run_at ? { status: w.last_run_status, startedAt: w.last_run_at, summary: w.last_run_summary } : null,
    runCount: w.run_count ?? null,
    // When a schedule fires next, only if it would actually run.
    nextRunAt: trigger?.type === 'schedule' && w.status === 'ACTIVE' && schedulerEnabled ? cw.nextRunAt(trigger, timezone) : null,
    timezone,
  };
}

function customWorkflowsRouter({ pool, authMiddleware, isEnabled = () => false, runAgent = null, notifyFn = null }) {
  const router = express.Router();
  const schedulerEnabled = () => isEnabled('custom_workflow_scheduler_enabled');

  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
      if (err && err.status && err.status < 500) {
        const body = { error: err.message };
        if (err.errors) body.errors = err.errors;
        return res.status(err.status).json(body);
      }
      if (err && /starlane_custom_workflow/.test(String(err.message)) && /does not exist/.test(String(err.message))) {
        return res.status(503).json({ error: 'Custom workflows are not set up on this server yet (migration 068).' });
      }
      safeLog('error', '[custom-workflows] request failed', { path: req.path, requestId: req.requestId, error: err && err.message });
      res.status(500).json({ error: 'Something went wrong on our side. Nothing was changed unless the run history shows it.', requestId: req.requestId || null });
    }
  };

  const tz = async (userId) => (await getSettings(pool, userId)).definitions.timezone || 'UTC';

  router.get('/catalog', authMiddleware, (req, res) => {
    res.json(cw.catalog({ schedulerEnabled: schedulerEnabled() }));
  });

  router.post('/validate', authMiddleware, (req, res) => {
    const v = cw.validateDefinition(req.body?.definition);
    res.status(v.ok ? 200 : 400).json(v);
  });

  router.get('/', authMiddleware, wrap(async (req, res) => {
    const userId = uid(req);
    const [rows, timezone] = await Promise.all([cw.listWorkflows(pool, userId), tz(userId)]);
    res.json({ workflows: rows.map((w) => workflowView(w, { timezone, schedulerEnabled: schedulerEnabled() })), schedulerEnabled: schedulerEnabled(), timezone });
  }));

  router.post('/', authMiddleware, wrap(async (req, res) => {
    const userId = uid(req);
    const w = await cw.createWorkflow(pool, userId, req.body || {});
    res.status(201).json({ workflow: workflowView(w, { timezone: await tz(userId), schedulerEnabled: schedulerEnabled() }) });
  }));

  router.get('/:id', authMiddleware, wrap(async (req, res) => {
    const userId = uid(req);
    const w = await cw.getWorkflow(pool, userId, req.params.id);
    if (!w) return res.status(404).json({ error: 'workflow not found' });
    const [runs, timezone] = await Promise.all([cw.listRuns(pool, userId, w.id, { limit: 20 }), tz(userId)]);
    res.json({ workflow: workflowView(w, { timezone, schedulerEnabled: schedulerEnabled() }), runs: runs.map(runView) });
  }));

  router.put('/:id', authMiddleware, wrap(async (req, res) => {
    const userId = uid(req);
    const w = await cw.updateWorkflow(pool, userId, req.params.id, req.body || {});
    res.json({ workflow: workflowView(w, { timezone: await tz(userId), schedulerEnabled: schedulerEnabled() }) });
  }));

  router.delete('/:id', authMiddleware, wrap(async (req, res) => {
    await cw.deleteWorkflow(pool, uid(req), req.params.id);
    res.json({ deleted: true });
  }));

  for (const [verb, status] of [['activate', 'ACTIVE'], ['pause', 'PAUSED']]) {
    router.post(`/:id/${verb}`, authMiddleware, wrap(async (req, res) => {
      const userId = uid(req);
      const w = await cw.setStatus(pool, userId, req.params.id, status);
      res.json({ workflow: workflowView(w, { timezone: await tz(userId), schedulerEnabled: schedulerEnabled() }) });
    }));
  }

  router.post('/:id/run', authMiddleware, wrap(async (req, res) => {
    const userId = uid(req);
    const w = await cw.getWorkflow(pool, userId, req.params.id);
    if (!w) return res.status(404).json({ error: 'workflow not found' });
    const v = cw.validateDefinition(w.definition);
    if (!v.ok) return res.status(400).json({ error: v.errors[0], errors: v.errors });
    const slot = `manual:${new Date().toISOString().slice(0, 16)}`;
    const r = await cw.executeWorkflow(pool, userId, w, { trigger: 'manual', slot, actorId: userId, runAgent, notifyFn });
    if (r.status === 'DUPLICATE') return res.status(429).json({ error: 'This workflow already ran in the last minute. Try again shortly.' });
    res.json({ run: { id: r.runId, status: r.status, steps: r.steps, summary: r.summary, error: r.error } });
  }));

  router.get('/:id/runs', authMiddleware, wrap(async (req, res) => {
    const rows = await cw.listRuns(pool, uid(req), req.params.id, { limit: req.query.limit });
    res.json({ runs: rows.map(runView) });
  }));

  return router;
}

module.exports = { customWorkflowsRouter, runScheduledCustomWorkflows: cw.runScheduledCustomWorkflows };
