const BASE_URL = process.env.BACKEND_URL || 'https://vantro-flow-backend-production.up.railway.app';

const checks = [
  { name: 'health', method: 'GET', path: '/api/health', expect: [200] },
  { name: 'auth invalid token', method: 'GET', path: '/api/auth/me', token: 'invalid', expect: [401], noStore: true },
  { name: 'inventory invalid token', method: 'GET', path: '/api/inventory', token: 'invalid', expect: [401], noStore: true },
  { name: 'unsigned payment webhook', method: 'POST', path: '/api/payments/webhook', body: '{}', expect: [400], noStore: true },
  { name: 'unsigned voice webhook', method: 'POST', path: '/api/voice/status', body: '{}', expect: [403], noStore: true },
];

async function run(check) {
  const headers = {};
  if (check.token) headers.Authorization = `Bearer ${check.token}`;
  if (check.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE_URL}${check.path}`, {
    method: check.method,
    headers,
    body: check.body,
  });
  const cacheControl = res.headers.get('cache-control') || '';
  const statusOk = check.expect.includes(res.status);
  const cacheOk = !check.noStore || cacheControl.includes('no-store');
  return { ...check, status: res.status, cacheControl, passed: statusOk && cacheOk };
}

(async () => {
  const results = [];
  for (const check of checks) results.push(await run(check));
  for (const result of results) {
    const marker = result.passed ? 'PASS' : 'FAIL';
    console.log(`${marker} ${result.status} ${result.name} cache="${result.cacheControl}"`);
  }
  if (results.some(result => !result.passed)) process.exit(1);
})();
