// FILE: lib/config/deployEnv.js
// Which deployment this process is: 'production' | 'staging' | 'development'.
//
// server.js's IS_PRODUCTION is true for ANY Railway service (staging too), so
// it cannot tell production from staging. This can:
//   1. STARLANE_ENV, when set explicitly (set it on every deployment);
//   2. else Railway's RAILWAY_ENVIRONMENT_NAME ('production' / anything else);
//   3. else NODE_ENV=production -> production, otherwise development.
function deploymentEnv(env = process.env) {
  const explicit = String(env.STARLANE_ENV || '').toLowerCase();
  if (['production', 'staging', 'development'].includes(explicit)) return explicit;
  const railway = String(env.RAILWAY_ENVIRONMENT_NAME || '').toLowerCase();
  if (railway) return railway === 'production' ? 'production' : 'staging';
  return env.NODE_ENV === 'production' ? 'production' : 'development';
}

const isProductionDeployment = (env = process.env) => deploymentEnv(env) === 'production';

module.exports = { deploymentEnv, isProductionDeployment };
