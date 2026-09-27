'use strict';
// lib/routes/connectors.js — the connector platform API.
//
//   GET  /api/connectors/catalog   public   manifests only (no tenant state):
//                                           what Starlane can connect to today,
//                                           and what it honestly cannot yet.
//   GET  /api/connectors           auth     manifests + this tenant's live state
//   POST /api/connectors/:id/pairing auth   short-lived pairing code for a
//                                           local-bridge connector
//   GET  /api/connectors/:id/bridge  auth   the bridge program itself (with SHA-256)
//
// The pre-existing /api/connectors/tally/{enrollment,claim,devices,...}
// routes in server.js stay as they are (the bridge CLI calls claim).
const express = require('express');
const { listManifests, getManifest } = require('../connectors/registry');
const { getConnectorStates } = require('../connectors/state');
const { createEnrollment } = require('../domain/ingestion/deviceEnrollment');
const { artifactPayload } = require('../access/artifacts');

function publicManifest(m) {
  const { id, name, provider, category, authType, availability, syncMode, summary, unavailableReason, objects, access } = m;
  return { id, name, provider, category, authType, availability, syncMode, summary, unavailableReason: unavailableReason || null, objects, access };
}

// The API origin the bridge should talk to. PUBLIC_API_URL wins (set it in
// production); otherwise the request's own origin (trust proxy is on).
function publicApiBase(req) {
  return (process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

function connectorsRouter({ pool, authMiddleware }) {
  const router = express.Router();

  router.get('/catalog', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ success: true, connectors: listManifests().map(publicManifest) });
  });

  router.get('/', authMiddleware, async (req, res) => {
    try {
      const connectors = await getConnectorStates(pool, req.user.userId);
      res.json({ success: true, connectors });
    } catch (err) {
      console.error('[connectors list]', err.message);
      res.status(500).json({ success: false, error: 'Could not load connector state' });
    }
  });

  router.post('/:id/pairing', authMiddleware, async (req, res) => {
    const manifest = getManifest(req.params.id);
    if (!manifest) return res.status(404).json({ success: false, error: 'Unknown connector' });
    if (manifest.authType !== 'local_bridge' || manifest.availability !== 'available') {
      return res.status(400).json({ success: false, error: `${manifest.name} is not paired through the local bridge` });
    }
    try {
      const { enrollmentCode, expiresAt } = await createEnrollment(req.user.userId, manifest.sourceType);
      res.status(201).json({
        success: true,
        pairing: {
          connectorId: manifest.id,
          code: enrollmentCode,
          expiresAt,
          // The exact command the owner runs on the machine with Tally.
          command: `node tally-sync.mjs --api ${publicApiBase(req)} --enroll ${enrollmentCode}`,
        },
      });
    } catch (err) {
      console.error('[connectors pairing]', err.message);
      res.status(503).json({ success: false, error: 'Could not create a pairing code' });
    }
  });

  router.get('/:id/bridge', authMiddleware, (req, res) => {
    const manifest = getManifest(req.params.id);
    if (!manifest || manifest.authType !== 'local_bridge' || manifest.availability !== 'available') {
      return res.status(404).json({ success: false, error: 'No bridge for this connector' });
    }
    const file = artifactPayload('tally-bridge');
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('X-Content-SHA256', file.sha256);
    res.send(file.content);
  });

  return router;
}

module.exports = { connectorsRouter, publicManifest, publicApiBase };
