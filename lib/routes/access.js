'use strict';
// lib/routes/access.js — selective-rollout access flow.
//
// Public (no account yet):
//   POST /api/access/applications        submit; returns eligibility + a status token (once)
//   GET  /api/access/status              X-Access-Token: status token
//   GET  /api/access/download            X-Access-Token: entitlement token -> artifact list
//   POST /api/access/download/:artifact  X-Access-Token: entitlement token -> file / URL, recorded
// Admin (ADMIN_EMAILS):
//   GET   /api/admin/access/applications[?status=&limit=&before=]
//   GET   /api/admin/access/applications/:id
//   PATCH /api/admin/access/applications/:id           { status, reviewNote }
//   POST  /api/admin/access/applications/:id/entitlement  re-issue download link
//
// Tokens travel in a header (never a query string) so they do not end up in
// access logs, browser history or Referer headers. The frontend keeps them in
// the URL fragment, which browsers never send to any server.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { validateApplication } = require('../access/validation');
const svc = require('../access/service');
const { listArtifacts, artifactPayload } = require('../access/artifacts');
const { sendAccessEmail } = require('../access/notify');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function appUrl() {
  return (process.env.PUBLIC_APP_URL || 'https://vantro-flow-frontend.vercel.app').replace(/\/+$/, '');
}
const statusUrl = (token) => `${appUrl()}/access/status#token=${token}`;
const downloadUrl = (token) => `${appUrl()}/download#token=${token}`;
const accessToken = (req) => String(req.get('x-access-token') || '').trim();

function accessRouter({ pool, requireAdmin }) {
  const router = express.Router();

  const applyLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: Number(process.env.ACCESS_APPLY_LIMIT_PER_HOUR || 5), standardHeaders: true, legacyHeaders: false, message: { success: false, error: 'Too many applications from this network. Please try again later.' } });
  const readLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

  router.post('/access/applications', applyLimiter, async (req, res) => {
    const body = req.body || {};
    // Honeypot: a field real users never see. Bots that fill it get a normal-
    // looking response and nothing is stored.
    if (typeof body.companyFax === 'string' && body.companyFax.trim()) {
      return res.status(202).json({ success: true, received: true });
    }
    const { ok, errors, value } = validateApplication(body);
    if (!ok) return res.status(400).json({ success: false, error: 'Please correct the highlighted fields', fields: errors });

    try {
      const result = await svc.submitApplication(pool, value, { ip: req.ip, autoApprove: process.env.ACCESS_AUTO_APPROVE === 'true' });
      if (result.duplicate) {
        // Same shape as a first submission, without a token: never confirm
        // or deny to an arbitrary caller whether an email has applied.
        return res.status(202).json({ success: true, received: true, duplicate: true, eligibility: result.eligibility });
      }
      const emailed = await sendAccessEmail({
        to: value.email,
        subject: 'Your Starlane application',
        text: `Hi ${value.name},\n\nWe received ${value.company}'s application.\n\nAssessment: ${result.eligibility.label}\n${result.eligibility.reasons.map((r) => `- ${r}`).join('\n')}\n\nFollow its status here (keep this link private):\n${statusUrl(result.statusToken)}\n${result.entitlement ? `\nYou're approved. Download and setup: ${downloadUrl(result.entitlement.token)}\n` : ''}\n— Starlane`,
      });
      res.status(201).json({
        success: true,
        received: true,
        status: result.status,
        eligibility: result.eligibility,
        statusToken: result.statusToken,
        downloadToken: result.entitlement?.token || null,
        emailed,
      });
    } catch (err) {
      console.error('[access apply]', err.message);
      res.status(500).json({ success: false, error: 'Could not submit your application. Please try again.' });
    }
  });

  router.get('/access/status', readLimiter, async (req, res) => {
    try {
      const status = await svc.getStatusByToken(pool, accessToken(req));
      if (!status) return res.status(404).json({ success: false, error: 'This status link is not valid.' });
      res.json({ success: true, application: status });
    } catch (err) {
      console.error('[access status]', err.message);
      res.status(500).json({ success: false, error: 'Could not load status' });
    }
  });

  router.get('/access/download', readLimiter, async (req, res) => {
    try {
      const ent = await svc.resolveEntitlement(pool, accessToken(req));
      if (!ent) return res.status(403).json({ success: false, error: 'This download link is invalid, expired, or has been replaced.' });
      res.json({ success: true, company: ent.company, name: ent.name, expiresAt: ent.expires_at, artifacts: listArtifacts() });
    } catch (err) {
      console.error('[access download list]', err.message);
      res.status(500).json({ success: false, error: 'Could not load downloads' });
    }
  });

  router.post('/access/download/:artifact', readLimiter, async (req, res) => {
    try {
      const ent = await svc.resolveEntitlement(pool, accessToken(req));
      if (!ent) return res.status(403).json({ success: false, error: 'This download link is invalid, expired, or has been replaced.' });
      const payload = artifactPayload(req.params.artifact);
      if (!payload) return res.status(404).json({ success: false, error: 'This download is not available' });
      await svc.recordDownload(pool, ent.id, req.params.artifact, req.ip);
      if (payload.type === 'redirect') return res.json({ success: true, url: payload.url });
      res.setHeader('Content-Type', payload.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${payload.filename}"`);
      res.setHeader('X-Content-SHA256', payload.sha256);
      res.send(payload.content);
    } catch (err) {
      console.error('[access download]', err.message);
      res.status(500).json({ success: false, error: 'Download failed' });
    }
  });

  // ── Admin review ───────────────────────────────────────────────────────
  router.get('/admin/access/applications', requireAdmin, async (req, res) => {
    try {
      const { status, limit, before } = req.query;
      if (status && !Object.keys(svc.TRANSITIONS).includes(status)) return res.status(400).json({ success: false, error: 'Unknown status' });
      res.json({ success: true, ...(await svc.listApplications(pool, { status, limit, before })) });
    } catch (err) {
      console.error('[admin access list]', err.message);
      res.status(500).json({ success: false, error: 'Could not load applications' });
    }
  });

  router.get('/admin/access/applications/:id', requireAdmin, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ success: false, error: 'Application not found' });
    try {
      const app = await svc.getApplication(pool, req.params.id);
      if (!app) return res.status(404).json({ success: false, error: 'Application not found' });
      res.json({ success: true, application: app });
    } catch (err) {
      console.error('[admin access get]', err.message);
      res.status(500).json({ success: false, error: 'Could not load application' });
    }
  });

  async function deliverDecision(application, entitlement) {
    if (application.status === 'approved' && entitlement) {
      return sendAccessEmail({
        to: application.email,
        subject: 'You’re approved for Starlane',
        text: `Hi ${application.name},\n\n${application.company} is approved for Starlane.\n\nYour private download and setup page (valid until ${new Date(entitlement.expiresAt).toDateString()}):\n${downloadUrl(entitlement.token)}\n\n— Starlane`,
      });
    }
    return false;
  }

  router.patch('/admin/access/applications/:id', requireAdmin, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ success: false, error: 'Application not found' });
    const { status, reviewNote } = req.body || {};
    try {
      const { application, entitlement } = await svc.decide(pool, req.params.id, { status, reviewNote }, req.user.email);
      const emailed = await deliverDecision(application, entitlement);
      res.json({
        success: true,
        application,
        // Shown once so the admin can send it by hand when email is not configured.
        downloadUrl: entitlement ? downloadUrl(entitlement.token) : null,
        emailed,
      });
    } catch (err) {
      if (err instanceof svc.AccessError) return res.status(err.status).json({ success: false, error: err.message });
      console.error('[admin access decide]', err.message);
      res.status(500).json({ success: false, error: 'Could not update application' });
    }
  });

  router.post('/admin/access/applications/:id/entitlement', requireAdmin, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ success: false, error: 'Application not found' });
    try {
      const entitlement = await svc.reissueEntitlement(pool, req.params.id, req.user.email);
      const app = await svc.getApplication(pool, req.params.id);
      const emailed = await deliverDecision(app, entitlement);
      res.json({ success: true, downloadUrl: downloadUrl(entitlement.token), expiresAt: entitlement.expiresAt, emailed });
    } catch (err) {
      if (err instanceof svc.AccessError) return res.status(err.status).json({ success: false, error: err.message });
      console.error('[admin access reissue]', err.message);
      res.status(500).json({ success: false, error: 'Could not issue a new link' });
    }
  });

  return router;
}

module.exports = { accessRouter };
