// scripts/check-production-env.js: fails closed, never prints values.
import { spawnSync } from 'node:child_process';
import { makeChecker } from './helpers/httpHarness.mjs';
const { check, done } = makeChecker();

const secret = 'S3CR3T-' + 'x'.repeat(40);
const good = {
  STARLANE_ENV: 'production', JWT_SECRET: secret, DATABASE_URL: `postgres://u:${secret}@db.abc.supabase.co:5432/postgres`,
  SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_SERVICE_ROLE_KEY: `${secret}-srk`, PUBLIC_APP_URL: 'https://vantro-flow-frontend.vercel.app',
  PUBLIC_API_URL: 'https://api.starlane.test', ADMIN_EMAILS: 'ops@starlane.test', RESEND_API_KEY: `re_${secret}`,
  ACCESS_EMAIL_FROM: 'Starlane <access@starlane.test>', ACCESS_IP_SALT: `${secret}-salt`, ACTION_APPROVAL_SECRET: `${secret}-a`, PUBLIC_LINK_SECRET: `${secret}-b`,
};
const run = (extra) => spawnSync(process.execPath, ['scripts/check-production-env.js'], { env: { PATH: process.env.PATH, ...extra }, encoding: 'utf8' });

const empty = run({ STARLANE_ENV: 'production' });
check('empty production env fails (exit 1)', empty.status === 1);
const ok = run(good);
check('complete production env passes (exit 0)', ok.status === 0, ok.stdout.split('\n').filter((l) => l.includes('FAIL')));
check('no secret value appears in output', !ok.stdout.includes('S3CR3T') && !empty.stdout.includes('S3CR3T'));
check('OTP bypass flag fails production', run({ ...good, OTP_VERIFICATION_DISABLED: 'true' }).status === 1);
check('demo reset flag fails production', run({ ...good, DEMO_RESET_ENABLED: 'true' }).status === 1);
check('short JWT secret fails', run({ ...good, JWT_SECRET: 'short' }).status === 1);
check('http public URL fails production', run({ ...good, PUBLIC_API_URL: 'http://api.starlane.test' }).status === 1);
check('frontend origin not allowed by CORS fails', run({ ...good, PUBLIC_APP_URL: 'https://evil.example.org' }).status === 1);
check('secret-looking NEXT_PUBLIC var fails with --frontend',
  spawnSync(process.execPath, ['scripts/check-production-env.js', '--frontend'], { env: { PATH: process.env.PATH, ...good, NEXT_PUBLIC_API_URL: 'https://api.starlane.test', NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: 'x' }, encoding: 'utf8' }).status === 1);
const { deploymentEnv } = await import('../lib/config/deployEnv.js').then((m) => m.default || m);
check('deployEnv: Railway staging is not production', deploymentEnv({ RAILWAY_ENVIRONMENT_NAME: 'staging', NODE_ENV: 'production' }) === 'staging');
check('deployEnv: explicit STARLANE_ENV wins', deploymentEnv({ STARLANE_ENV: 'staging', RAILWAY_ENVIRONMENT_NAME: 'production' }) === 'staging');
done();
