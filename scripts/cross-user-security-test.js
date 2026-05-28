const BASE_URL = process.env.BACKEND_URL || 'https://vantro-flow-backend-production.up.railway.app';
const USER_A_TOKEN = process.env.USER_A_TOKEN;
const USER_B_ID = process.env.USER_B_ID;
const USER_B_INVENTORY_ID = process.env.USER_B_INVENTORY_ID || USER_B_ID;

const required = { USER_A_TOKEN, USER_B_ID };
const missing = Object.entries(required).filter(([, value]) => !value).map(([key]) => key);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  console.error('Usage: USER_A_TOKEN=... USER_B_ID=... npm run security:cross-user');
  process.exit(2);
}

const checks = [
  { name: 'User A cannot read User B inventory', method: 'GET', path: `/api/inventory/${USER_B_INVENTORY_ID}`, expect: [403] },
  { name: 'User A cannot read User B invoices', method: 'GET', path: `/api/invoices/${USER_B_ID}`, expect: [403] },
  { name: 'User A cannot read User B analytics', method: 'GET', path: `/api/analytics/${USER_B_ID}`, expect: [403] },
  { name: 'User A cannot read User B forecast', method: 'GET', path: `/api/cash-forecast/${USER_B_ID}`, expect: [403] },
  { name: 'User A cannot read User B transactions', method: 'GET', path: `/api/transactions/${USER_B_ID}`, expect: [403] },
  { name: 'User A cannot read User B collections summary', method: 'GET', path: `/api/collections/summary/${USER_B_ID}`, expect: [403] },
  { name: 'Invalid token is rejected', method: 'GET', path: '/api/auth/me', token: 'invalid', expect: [401] },
];

async function runCheck(check) {
  const token = check.token || USER_A_TOKEN;
  const res = await fetch(`${BASE_URL}${check.path}`, {
    method: check.method,
    headers: { Authorization: `Bearer ${token}` },
  });
  const passed = check.expect.includes(res.status);
  return { ...check, status: res.status, passed };
}

(async () => {
  const results = [];
  for (const check of checks) {
    results.push(await runCheck(check));
  }

  for (const result of results) {
    const marker = result.passed ? 'PASS' : 'FAIL';
    console.log(`${marker} ${result.status} ${result.name}`);
  }

  const failed = results.filter(result => !result.passed);
  if (failed.length) process.exit(1);
})();
