const http = require('https');

const API_BASE = 'https://vantro-flow-backend-production.up.railway.app';
const FRONTEND_BASE = 'https://vantro-flow-frontend.vercel.app';

async function fetchUrl(url, method = 'GET', body = null) {
    return new Promise((resolve) => {
        const req = http.request(url, { method, headers: { 'Content-Type': 'application/json' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, data }));
        });
        req.on('error', (e) => resolve({ status: 'error', message: e.message }));
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function run() {
    console.log("--- Post-Merge Production Smoke Tests ---");
    console.log("Backend Health:", (await fetchUrl(`${API_BASE}/api/health`)).status);
    console.log("Auth Me (no token):", (await fetchUrl(`${API_BASE}/api/auth/me`)).status);
    console.log("Performance Summary (no token):", (await fetchUrl(`${API_BASE}/api/performance/summary`)).status);
    console.log("Metrics (no token):", (await fetchUrl(`${API_BASE}/metrics`)).status);
    
    console.log("\nTesting /api/client-errors POST...");
    const clientErrRes = await fetchUrl(`${API_BASE}/api/client-errors`, 'POST', {
      type: "CLIENT_UI_ERROR",
      message: "Post-merge rollout test error",
      page: "/rollout-test",
      severity: "info"
    });
    console.log("Client Errors POST Status:", clientErrRes.status);
    
    console.log("\nFrontend Checks...");
    console.log("Frontend Root:", (await fetchUrl(`${FRONTEND_BASE}/`)).status);
    console.log("Frontend Login:", (await fetchUrl(`${FRONTEND_BASE}/login`)).status);
    console.log("Frontend Dashboard:", (await fetchUrl(`${FRONTEND_BASE}/dashboard`)).status);
    console.log("Frontend Admin Errors:", (await fetchUrl(`${FRONTEND_BASE}/admin/errors`)).status);
}
run();
