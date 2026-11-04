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
//   GET    /api/custom-workflows/approvals      emails workflows drafted
//   POST   /api/custom-workflows/approvals/:id/approve|reject
//   GET    /api/custom-workflows/tasks          tasks workflows created
//   POST   /api/custom-workflows/tasks/:id/done|reopen
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

function customWorkflowsRouter({ pool, authMiddleware, isEnabled = () => false, runAgent = null, notifyFn = null, sendFn = null, guardFn = null, callConnection = null }) {
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
      if (err && err.code === '42P01') {
        return res.status(503).json({ error: 'This part of workflows is not set up on this server yet (migration 069).' });
      }
      safeLog('error', '[custom-workflows] request failed', { path: req.path, requestId: req.requestId, error: err && err.message });
      res.status(500).json({ error: 'Something went wrong on our side. Nothing was changed unless the run history shows it.', requestId: req.requestId || null });
    }
  };

  const tz = async (userId) => (await getSettings(pool, userId)).definitions.timezone || 'UTC';

  router.get('/catalog', authMiddleware, (req, res) => {
    res.json(cw.catalog({ schedulerEnabled: schedulerEnabled(), flags: {
      external_message_sending_enabled: isEnabled('external_message_sending_enabled'),
      workflow_http_actions_enabled: isEnabled('workflow_http_actions_enabled'),
    } }));
  });

  router.post('/validate', authMiddleware, (req, res) => {
    const v = cw.validateDefinition(req.body?.definition);
    res.status(v.ok ? 200 : 400).json(v);
  });

  // ── Approvals and tasks (before /:id so the words are not read as ids)
  router.get('/approvals', authMiddleware, wrap(async (req, res) => {
    const status = ['PENDING', 'BLOCKED', 'SENT', 'REJECTED', 'FAILED', 'SENDING'].includes(req.query.status) ? req.query.status : null;
    res.json({ approvals: await cw.listApprovals(pool, uid(req), { status }), externalSendEnabled: isEnabled('external_message_sending_enabled') });
  }));
  for (const decision of ['approve', 'reject']) {
    router.post(`/approvals/:id/${decision}`, authMiddleware, wrap(async (req, res) => {
      const edits = decision === 'approve' && req.body && typeof req.body === 'object' ? { subject: req.body.subject, body: req.body.body } : null;
      res.json({ approval: await cw.decideApproval(pool, uid(req), req.params.id, decision, { actorId: uid(req), edits, ...(sendFn ? { sendFn } : {}), ...(guardFn ? { guardFn } : {}) }) });
    }));
  }
  router.get('/tasks', authMiddleware, wrap(async (req, res) => {
    const status = req.query.status === 'all' ? null : req.query.status === 'DONE' ? 'DONE' : 'OPEN';
    res.json({ tasks: await cw.listTasks(pool, uid(req), { status }) });
  }));
  for (const [verb, status] of [['done', 'DONE'], ['reopen', 'OPEN']]) {
    router.post(`/tasks/:id/${verb}`, authMiddleware, wrap(async (req, res) => {
      await cw.setTaskStatus(pool, uid(req), req.params.id, status);
      res.json({ ok: true });
    }));
  }

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
    // A workflow that starts from an email or a webhook is tested on the
    // latest one that arrived, or on a sample the builder sends (not stored).
    let event = null;
    const tType = w.definition?.trigger?.type;
    if (tType === 'email_received' || tType === 'webhook_received') {
      const sample = req.body && typeof req.body.sample === 'object' && req.body.sample ? req.body.sample : null;
      if (sample) {
        event = tType === 'email_received'
          ? { payload: { from: String(sample.from || ''), fromAddress: String(sample.fromAddress || (/<([^<>\s]+@[^<>\s]+)>/.exec(String(sample.from || '')) || [])[1] || sample.from || '').trim().toLowerCase(), subject: String(sample.subject || ''), body: String(sample.body || '').slice(0, 4000) } }
          : { payload: sample, connection_id: w.definition.trigger.connectionId };
      } else {
        const r = await pool.query(
          tType === 'email_received'
            ? `SELECT * FROM starlane_connection_events WHERE user_id = $1 AND source = 'gmail' ORDER BY received_at DESC LIMIT 1`
            : `SELECT * FROM starlane_connection_events WHERE user_id = $1 AND source = 'webhook' AND connection_id = $2 ORDER BY received_at DESC LIMIT 1`,
          tType === 'email_received' ? [userId] : [userId, w.definition.trigger.connectionId]
        );
        event = r.rows[0] || null;
        if (!event) return res.status(400).json({ error: tType === 'email_received' ? 'No email has arrived yet. Test with a sample email, or wait for one.' : 'Nothing has been sent to this webhook yet. Test with sample data, or send a test request.' });
      }
    }
    const slot = `manual:${new Date().toISOString().slice(0, 16)}`;
    const r = await cw.executeWorkflow(pool, userId, w, { trigger: 'manual', slot, event, actorId: userId, runAgent, notifyFn, ...(callConnection ? { callConnection } : {}) });
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
