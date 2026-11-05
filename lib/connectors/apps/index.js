'use strict';
// lib/connectors/apps/index.js — the live app connectors and when each is Live.
//
// A connector is Live (registry availability 'available') only when both:
//   - its feature flag is 'true' (default OFF), and
//   - every environment variable it needs is set (developer app credentials,
//     PUBLIC_API_URL for OAuth callbacks, OUTBOUND_CREDENTIALS_KEY to encrypt
//     tokens).
// Otherwise the catalog keeps showing it as Coming soon with no connect
// action, exactly as before the connector existed. Turn the flag on only
// after connecting a real account and seeing a sync succeed.

const PROVIDERS = {
  zoho_books: require('./zohoBooks'),
  quickbooks: require('./quickbooks'),
  razorpay: require('./razorpay'),
  whatsapp_business: require('./whatsappBusiness'),
};

const APP_IDS = Object.freeze(Object.keys(PROVIDERS));

function provider(id) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? PROVIDERS[id] : null;
}

function missingEnv(id, env = process.env) {
  const p = provider(id);
  return p ? p.requiresEnv.filter((k) => !env[k]) : [];
}

function flagOn(id, env = process.env) {
  const p = provider(id);
  return !!p && env[p.flag] === 'true';
}

function isLive(id, env = process.env) {
  return flagOn(id, env) && missingEnv(id, env).length === 0;
}

/** Why a built connector is not Live yet, for operators (never shown as Live). */
function liveness(id, env = process.env) {
  const p = provider(id);
  if (!p) return null;
  return { connectorId: id, flag: p.flag, flagOn: flagOn(id, env), missingEnv: missingEnv(id, env), live: isLive(id, env) };
}

module.exports = { PROVIDERS, APP_IDS, provider, isLive, flagOn, missingEnv, liveness };
