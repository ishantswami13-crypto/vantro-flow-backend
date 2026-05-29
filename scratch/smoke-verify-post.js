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
    console.log("--- Post-Rollout Smoke Tests ---");
    console.log("Health:", (await fetchUrl(`${API_BASE}/api/health`)).status);
    console.log("Auth Me (no token):", (await fetchUrl(`${API_BASE}/api/auth/me`)).status);
    console.log("Admin Error Events (no token):", (await fetchUrl(`${API_BASE}/api/admin/error-events`)).status);
    
    console.log("\nTesting /api/client-errors POST...");
    const clientErrRes = await fetchUrl(`${API_BASE}/api/client-errors`, 'POST', {
      type: "CLIENT_UI_ERROR",
      message: "Post-rollout test error",
      page: "/rollout-test",
      severity: "info"
    });
    console.log("Client Errors POST Status:", clientErrRes.status);
    if(clientErrRes.data) {
        try {
           const json = JSON.parse(clientErrRes.data);
           console.log("Response JSON:", json);
        } catch(e) {
           console.log("Response text:", clientErrRes.data);
        }
    }
    
    console.log("\nTesting Frontend /admin/errors (no auth)...");
    console.log("Frontend Admin Errors:", (await fetchUrl(`${FRONTEND_BASE}/admin/errors`)).status);
}
run();
