'use strict';

const explicitOrigins = new Set([
  'https://vantro-flow-frontend.vercel.app',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  ...(process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
]);

const previewSlugs = (process.env.VERCEL_PROJECT_SLUGS || 'vantro-flow-frontend')
  .split(',').map(value => value.trim()).filter(Boolean);
const previewScope = (process.env.VERCEL_TEAM_SCOPE || '').trim();

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (explicitOrigins.has(origin)) return true;
  const match = /^https:\/\/([a-z0-9-]+)\.vercel\.app$/.exec(origin);
  if (!match) return false;
  const host = match[1];
  if (previewScope && !host.endsWith(`-${previewScope}`)) return false;
  return previewSlugs.some(slug => host === slug || host.startsWith(`${slug}-`));
}

module.exports = { isAllowedOrigin };
