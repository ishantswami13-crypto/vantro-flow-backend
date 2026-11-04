'use strict';
// lib/routes/region.js — the business's country, currency, language format,
// timezone and tax label.
//
//   GET /api/settings/region          auth   the tenant's region + picker options
//   PUT /api/settings/region          auth   change any of them (versioned)
//   GET /api/settings/region/options  public countries and currencies
//
// The values are stored as versioned decision definitions (base_currency,
// timezone, locale, tax_label, country), so every decision records which
// currency and timezone it was computed in. The tenant comes from the
// verified JWT only.

const express = require('express');
const { getSettings, setDefinitions } = require('../domain/decisions/controls');
const { regionFromDefinitions, regionForCountry, regionOptions, countryCode, COUNTRY_DEFAULTS } = require('../locale/region');
const { safeLog } = require('../observability/logger');

function uid(req) {
  return req.user?.userId || req.user?.id || null;
}

async function readRegion(pool, userId) {
  const settings = await getSettings(pool, userId);
  const o = settings.definitionsOverrides || {};
  return {
    ...regionFromDefinitions(settings.definitions),
    // Which values the owner (or onboarding) actually set, so the UI can
    // tell a chosen currency from the built-in default.
    explicit: { currency: !!o.base_currency, timezone: !!o.timezone, locale: !!o.locale, taxLabel: !!o.tax_label, country: !!o.country },
    definitionsVersion: settings.definitionsVersion,
  };
}

/**
 * Called when an owner picks a country (onboarding). Fills currency,
 * locale, timezone and tax label from the country, but only the ones the
 * owner has not set already, so it never overwrites a deliberate choice.
 */
async function applyCountryDefaults(pool, userId, country) {
  const code = countryCode(country);
  if (!code) return null;
  const settings = await getSettings(pool, userId);
  const o = settings.definitionsOverrides || {};
  const d = regionForCountry(code);
  const patch = {};
  if (!o.country) patch.country = code;
  if (!o.base_currency) patch.base_currency = d.currency;
  if (!o.locale) patch.locale = d.locale;
  if (!o.timezone) patch.timezone = d.timezone;
  if (!o.tax_label) patch.tax_label = d.taxLabel;
  if (!Object.keys(patch).length) return readRegion(pool, userId);
  await setDefinitions(pool, userId, patch, userId);
  return readRegion(pool, userId);
}

function regionRouter({ pool, authMiddleware }) {
  const router = express.Router();

  router.get('/options', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(regionOptions());
  });

  router.get('/', authMiddleware, async (req, res) => {
    try {
      res.json({ region: await readRegion(pool, uid(req)), options: regionOptions() });
    } catch (err) {
      safeLog('error', '[region] read failed', { error: err.message, requestId: req.requestId });
      res.status(500).json({ error: 'Could not load your region settings.' });
    }
  });

  router.put('/', authMiddleware, async (req, res) => {
    const body = req.body || {};
    const patch = {};
    if (body.country !== undefined) {
      if (body.country === null || body.country === '') patch.country = null;
      else {
        const code = countryCode(body.country);
        if (!code) return res.status(400).json({ error: 'Unknown country. Use an ISO code such as US, GB or DE.' });
        patch.country = code;
        // Picking a country alone fills the rest from it; anything sent
        // alongside wins.
        const d = regionForCountry(code);
        if (body.currency === undefined) patch.base_currency = d.currency;
        if (body.locale === undefined) patch.locale = d.locale;
        if (body.timezone === undefined) patch.timezone = d.timezone;
        if (body.taxLabel === undefined) patch.tax_label = d.taxLabel;
      }
    }
    if (body.currency !== undefined) patch.base_currency = String(body.currency || '').toUpperCase();
    if (body.locale !== undefined) patch.locale = body.locale || null;
    if (body.timezone !== undefined) patch.timezone = body.timezone;
    if (body.taxLabel !== undefined) patch.tax_label = body.taxLabel || null;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Send country, currency, locale, timezone or taxLabel.' });
    try {
      const userId = uid(req);
      await setDefinitions(pool, userId, patch, userId);
      if (patch.country !== undefined) {
        // users.country holds the display name the onboarding form uses.
        const name = patch.country ? COUNTRY_DEFAULTS[patch.country]?.name || patch.country : null;
        await pool.query('UPDATE users SET country = $2 WHERE id = $1', [userId, name]).catch(() => {});
      }
      res.json({ region: await readRegion(pool, userId) });
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ error: err.message });
      safeLog('error', '[region] update failed', { error: err.message, requestId: req.requestId });
      res.status(500).json({ error: 'Could not save your region settings. Nothing was changed.' });
    }
  });

  return router;
}

module.exports = { regionRouter, readRegion, applyCountryDefaults };
