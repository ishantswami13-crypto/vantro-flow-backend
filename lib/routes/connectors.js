'use strict';
// lib/routes/connectors.js — the connector platform API.
//
//   GET  /api/connectors/catalog   public   manifests only (no tenant state):
//                                           what Starlane can connect to today,
//                                           and what it honestly cannot yet.
//   GET  /api/connectors           auth     manifests + this tenant's live state
//   POST /api/connectors/:id/pairing auth   short-lived pairing code for a
//                                           local-bridge connector
//
// The pre-existing /api/connectors/tally/{enrollment,claim,devices,...}
// routes in server.js stay as they are (the bridge CLI calls claim).
const express = require('express');
const { listManifests, getManifest } = require('../connectors/registry');
const { getConnectorStates } = require('../connectors/state');
const { createEnrollment } = require('../domain/ingestion/deviceEnrollment');

function publicManifest(m) {
  const { id, name, provider, category, authType, availability, syncMode, summary, unavailableReason, objects, access } = m;
  return { id, name, provider, category, authType, availability, syncMode, summary, unavailableReason: unavailableReason || null, objects, access };
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
          command: `node tally-sync.mjs --enroll ${enrollmentCode}`,
        },
      });
    } catch (err) {
      console.error('[connectors pairing]', err.message);
      res.status(503).json({ success: false, error: 'Could not create a pairing code' });
    }
  });

  return router;
}

module.exports = { connectorsRouter, publicManifest };
