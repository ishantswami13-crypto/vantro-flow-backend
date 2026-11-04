// Access flow end to end over real HTTP + real DB:
//   visitor applies -> persisted with deterministic eligibility -> status via token
//   -> admin reviews -> approves -> entitlement -> download list -> bridge download
//   recorded -> signup gate honours approval.
// Plus the abuse cases: honeypot, validation, duplicate email, bad tokens,
// non-admin access, illegal transitions, rate limiting.
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { makeChecker, openPool, seedUser, deleteUsers, startServer } from './helpers/httpHarness.mjs';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');
const { check, done } = makeChecker();
const PORT = 3923;

async function main() {
  const pool = openPool();
  const tag = randomUUID().slice(0, 8);
  const adminEmail = `admin-${tag}@test.starlane.invalid`;
  const applicantEmail = `applicant-${tag}@test.starlane.invalid`;
  const users = [];
  let server;
  try {
    const nonAdmin = await seedUser(pool, 'access-nonadmin'); users.push(nonAdmin.id);
    const adminId = randomUUID();
    await pool.query(`INSERT INTO users (id, email, password_hash, business_name, email_verified) VALUES ($1, $2, 'x', 'Admin', true)`, [adminId, adminEmail]);
    users.push(adminId);
    const adminToken = jwt.sign({ userId: adminId, email: adminEmail }, process.env.JWT_SECRET, { expiresIn: '10m' });

    server = await startServer(PORT, {
      ADMIN_EMAILS: adminEmail, ACCESS_AUTO_APPROVE: 'false', ACCESS_APPLY_LIMIT_PER_HOUR: '6',
      FEATURE_ACCESS_GATE_ENABLED: 'true', RESEND_API_KEY: '', PUBLIC_APP_URL: 'https://app.test',
    });
    const { base } = server;
    const json = (headers = {}) => ({ 'Content-Type': 'application/json', ...headers });
    const apply = (body) => fetch(`${base}/api/access/applications`, { method: 'POST', headers: json(), body: JSON.stringify(body) });
    const application = {
      name: 'Asha Rao', email: applicantEmail, company: 'Rao Distributors', website: 'raodist.in', role: 'Owner',
      companySize: '11-50', industry: 'Distribution', country: 'IN', systems: ['tally', 'xero'],
      problem: 'We never know which customers will actually pay this month.',
      desiredOutcome: 'Collect faster without damaging relationships.', willConnectSystems: true,
    };

    console.log('— apply');
    const invalid = await apply({ ...application, email: 'not-an-email', problem: 'x' });
    const invalidBody = await invalid.json();
    check('invalid application -> 400 with per-field errors', invalid.status === 400 && invalidBody.fields?.email && invalidBody.fields?.problem, invalidBody);

    const bot = await apply({ ...application, email: `bot-${tag}@test.starlane.invalid`, companyFax: 'filled' });
    const { rows: botRows } = await pool.query('SELECT 1 FROM access_applications WHERE email = $1', [`bot-${tag}@test.starlane.invalid`]);
    check('honeypot -> looks accepted (202) but nothing stored', bot.status === 202 && botRows.length === 0);

    const res = await apply(application);
    const body = await res.json();
    check('application accepted (201)', res.status === 201, body);
    check('eligibility is deterministic and explained: ready, names Xero as not yet connectable',
      body.eligibility?.tier === 'ready' && body.eligibility.reasons.some((r) => r.includes('Xero')) && !!body.eligibility.rules_version, body.eligibility);
    check('not auto-approved (admin review by default)', body.status === 'submitted' && body.downloadToken === null);
    check('honest about email delivery (not configured -> emailed:false)', body.emailed === false);
    const { rows: stored } = await pool.query('SELECT status, status_token_hash, systems FROM access_applications WHERE email = $1', [applicantEmail]);
    check('persisted with only a hash of the status token', stored.length === 1 && stored[0].status_token_hash === createHash('sha256').update(body.statusToken).digest('hex'));

    const dup = await apply({ ...application, email: applicantEmail.toUpperCase() });
    const dupBody = await dup.json();
    check('duplicate email (case-insensitive) -> 202, no token, nothing new stored',
      dup.status === 202 && !dupBody.statusToken && (await pool.query('SELECT COUNT(*)::int c FROM access_applications WHERE lower(email) = $1', [applicantEmail])).rows[0].c === 1);

    console.log('— CORS (browser preflight from the frontend origin)');
    const pre = await fetch(`${base}/api/access/status`, { method: 'OPTIONS', headers: {
      Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-access-token' } });
    check('preflight allows the X-Access-Token header', /x-access-token/i.test(pre.headers.get('access-control-allow-headers') || ''), pre.headers.get('access-control-allow-headers'));

    console.log('— status');
    const st = await fetch(`${base}/api/access/status`, { headers: { 'X-Access-Token': body.statusToken } });
    const stBody = await st.json();
    check('status via token: submitted, email masked', st.status === 200 && stBody.application.status === 'submitted' && !stBody.application.email.startsWith(applicantEmail.slice(0, 5)), stBody);
    check('status with a wrong token -> 404', (await fetch(`${base}/api/access/status`, { headers: { 'X-Access-Token': 'nope' } })).status === 404);

    console.log('— signup gate (before approval)');
    const signup = () => fetch(`${base}/api/auth/signup`, { method: 'POST', headers: json(), body: JSON.stringify({ email: applicantEmail, phone: '919800000000', business_name: 'Rao Distributors', password: 'correct-horse-9' }) });
    const early = await signup();
    check('signup refused while not approved (403 ACCESS_NOT_APPROVED)', early.status === 403 && (await early.json()).code === 'ACCESS_NOT_APPROVED');

    console.log('— admin');
    const { rows: [{ id: appId }] } = await pool.query('SELECT id FROM access_applications WHERE email = $1', [applicantEmail]);
    check('non-admin cannot list applications (403)', (await fetch(`${base}/api/admin/access/applications`, { headers: { Authorization: `Bearer ${nonAdmin.token}` } })).status === 403);
    const list = await (await fetch(`${base}/api/admin/access/applications?status=submitted`, { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    check('admin lists submitted applications with counts', list.applications?.some((a) => a.id === appId) && list.counts?.submitted >= 1);
    const patch = (status, extra = {}) => fetch(`${base}/api/admin/access/applications/${appId}`, {
      method: 'PATCH', headers: json({ Authorization: `Bearer ${adminToken}` }), body: JSON.stringify({ status, ...extra }),
    });
    check('illegal transition submitted -> expired is 409', (await patch('expired')).status === 409);
    check('submitted -> reviewing', (await patch('reviewing')).status === 200);
    const approve = await patch('approved', { reviewNote: 'Welcome aboard — onboarding call Tuesday.' });
    const approveBody = await approve.json();
    check('reviewing -> approved returns the download link once', approve.status === 200 && /^https:\/\/app\.test\/download#token=/.test(approveBody.downloadUrl || ''), approveBody);
    const dlToken = approveBody.downloadUrl.split('#token=')[1];
    const detail = await (await fetch(`${base}/api/admin/access/applications/${appId}`, { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    check('audit trail: submitted, reviewing, approved with actor', detail.application?.events?.map((e) => e.to_status).join() === 'submitted,reviewing,approved' && detail.application.events[2].actor === adminEmail);
    check('admin detail never exposes token hashes', !('status_token_hash' in detail.application) && !JSON.stringify(detail).includes('token_hash'));

    const st2 = await (await fetch(`${base}/api/access/status`, { headers: { 'X-Access-Token': body.statusToken } })).json();
    check('applicant sees approved + review note + download ready', st2.application.status === 'approved' && st2.application.downloadReady && st2.application.reviewNote.startsWith('Welcome'));

    console.log('— download');
    check('download list refused without a valid token (403)', (await fetch(`${base}/api/access/download`, { headers: { 'X-Access-Token': body.statusToken } })).status === 403);
    const dl = await (await fetch(`${base}/api/access/download`, { headers: { 'X-Access-Token': dlToken } })).json();
    const bridge = dl.artifacts?.find((a) => a.id === 'tally-bridge');
    check('download list: bridge available with checksum', bridge?.available && /^[0-9a-f]{64}$/.test(bridge.sha256));
    check('download list: unpublished desktop builds are marked unavailable, not faked', dl.artifacts.filter((a) => a.kind === 'desktop').every((a) => a.available === false && a.note));
    const file = await fetch(`${base}/api/access/download/tally-bridge`, { method: 'POST', headers: { 'X-Access-Token': dlToken } });
    const fileText = await file.text();
    check('bridge file served as attachment and matches its checksum',
      file.status === 200 && /attachment/.test(file.headers.get('content-disposition') || '') && createHash('sha256').update(fileText).digest('hex') === bridge.sha256);
    const { rows: evs } = await pool.query(`SELECT artifact FROM access_download_events d JOIN access_entitlements e ON e.id = d.entitlement_id WHERE e.application_id = $1`, [appId]);
    check('download recorded', evs.length === 1 && evs[0].artifact === 'tally-bridge');
    const plat = await (await fetch(`${base}/api/access/platforms`)).json();
    check('public platform list: booleans only, nothing claimed without a build', Object.values(plat.platforms).every((v) => v === false) && !JSON.stringify(plat).includes('http'), plat);
    check('unpublished mobile build cannot be downloaded (404)', (await fetch(`${base}/api/access/download/mobile-android`, { method: 'POST', headers: { 'X-Access-Token': dlToken } })).status === 404);
    check('unpublished desktop build cannot be downloaded (404)', (await fetch(`${base}/api/access/download/desktop-windows`, { method: 'POST', headers: { 'X-Access-Token': dlToken } })).status === 404);

    const reissue = await (await fetch(`${base}/api/admin/access/applications/${appId}/entitlement`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } })).json();
    check('re-issuing a link revokes the previous one', (await fetch(`${base}/api/access/download`, { headers: { 'X-Access-Token': dlToken } })).status === 403
      && (await fetch(`${base}/api/access/download`, { headers: { 'X-Access-Token': reissue.downloadUrl.split('#token=')[1] } })).status === 200);

    console.log('— signup gate (after approval)');
    const late = await signup();
    check('signup allowed once approved', late.status === 200, await late.text());
    const { rows: newUser } = await pool.query('SELECT id FROM users WHERE email = $1', [applicantEmail]);
    if (newUser[0]) users.push(newUser[0].id);

    console.log('— rate limit');
    let limited = false;
    for (let i = 0; i < 8 && !limited; i++) {
      const r = await apply({ ...application, email: `rl-${i}-${tag}@test.starlane.invalid` });
      limited = r.status === 429;
    }
    check('applications are rate limited per network (429)', limited);
  } finally {
    if (server) server.stop();
    await pool.query(`DELETE FROM access_applications WHERE email LIKE $1`, [`%-${tag}@test.starlane.invalid`]).catch(() => {});
    await deleteUsers(pool, users);
    await pool.end();
  }
}

main().then(done).catch((e) => { console.error('Test run crashed:', e); process.exitCode = 1; });
