'use strict';

const { isProductionDeployment } = require('../config/deployEnv');

// Local development origins are never trusted by the production deployment: a
// page on a visitor's own localhost must not get a credentialed CORS answer.
const LOCAL_ORIGINS = ['http://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:3000', 'http://127.0.0.1:3001'];
const explicitOrigins = new Set([
  'https://vantro-flow-frontend.vercel.app',
  ...(isProductionDeployment() ? [] : LOCAL_ORIGINS),
  ...(process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
]);

const previewSlugs = (process.env.VERCEL_PROJECT_SLUGS || 'vantro-flow-frontend')
  .split(',').map(value => value.trim()).filter(Boolean);
const previewScope = (process.env.VERCEL_TEAM_SCOPE || '').trim();

// The Starlane desktop app (Tauri) calls the API from its native HTTP client,
// which labels requests with the web view's origin: tauri://localhost (macOS,
// Linux) or http(s)://tauri.localhost (Windows). The app authenticates with
// bearer tokens only, so these origins are served without credentials
// (server.js corsDelegate) — a browser page on some *.localhost host cannot
// use them to ride a cookie session.
const nativeAppOrigins = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']);
function isNativeAppOrigin(origin) {
  return nativeAppOrigins.has(origin);
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (explicitOrigins.has(origin)) return true;
  const match = /^https:\/\/([a-z0-9-]+)\.vercel\.app$/.exec(origin);
  if (!match) return false;
  const host = match[1];
  if (previewSlugs.includes(host)) return true;
  // Previews ("<slug>-<hash>-<scope>.vercel.app"): anyone can create a Vercel
  // project whose name starts with the slug, so in production a preview is
  // trusted only when VERCEL_TEAM_SCOPE pins it to our team.
  if (previewScope) {
    if (!host.endsWith(`-${previewScope}`)) return false;
  } else if (isProductionDeployment()) {
    return false;
  }
  return previewSlugs.some(slug => host.startsWith(`${slug}-`));
}

module.exports = { isAllowedOrigin, isNativeAppOrigin };
