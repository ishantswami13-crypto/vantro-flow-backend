const fs = require('fs');
const path = require('path');
const http = require('https');

const API_BASE = 'https://vantro-flow-backend-production.up.railway.app';
const FRONTEND_BASE = 'https://vantro-flow-frontend.vercel.app';

async function fetchUrl(url, method = 'GET', body = null) {
    return new Promise((resolve) => {
        const req = http.request(url, { method, headers: { 'Content-Type': 'application/json' } }, (res) => {
            resolve({ status: res.statusCode });
        });
        req.on('error', (e) => resolve({ status: 'error', message: e.message }));
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function run() {
    console.log("--- Smoke Tests ---");
    console.log("Health:", (await fetchUrl(`${API_BASE}/api/health`)).status);
    console.log("Auth Me:", (await fetchUrl(`${API_BASE}/api/auth/me`)).status);
    console.log("Inventory:", (await fetchUrl(`${API_BASE}/api/inventory`)).status);
    console.log("Metrics:", (await fetchUrl(`${API_BASE}/metrics`)).status);
    console.log("Admin Errors:", (await fetchUrl(`${API_BASE}/api/admin/error-events`)).status);
    
    const clientErrRes = await fetchUrl(`${API_BASE}/api/client-errors`, 'POST', {
      error_message: "Smoke test error",
      fingerprint: "smoke-test"
    });
    console.log("Client Errors:", clientErrRes.status);
    
    console.log("Frontend Home:", (await fetchUrl(FRONTEND_BASE)).status);
    console.log("Frontend Login:", (await fetchUrl(`${FRONTEND_BASE}/login`)).status);
    console.log("Frontend Admin Errors:", (await fetchUrl(`${FRONTEND_BASE}/admin/errors`)).status);

    console.log("\n--- File Checks ---");
    const backendPath = 'C:\\Users\\Dell\\vantro-flow-backend';
    const files = [
        'supabase-error-events-rollout.sql',
        'supabase-error-events-rollback.sql',
        'SUPABASE_ERROR_EVENTS_APPLY_GUIDE.md',
        'RAILWAY_ERROR_STORAGE_ACTIVATION.md'
    ];
    for (const f of files) {
        console.log(`${f}:`, fs.existsSync(path.join(backendPath, f)));
    }
}
run();
