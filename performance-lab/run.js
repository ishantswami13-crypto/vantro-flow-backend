const http = require('http');
const https = require('https');
const fs = require('fs');

const API_BASE = process.env.TEST_API_URL || "http://localhost:3001";
const TEST_TOKEN = process.env.CORTEX_TEST_TOKEN || process.env.VANTRO_TEST_TOKEN;

async function fetchUrl(path, method = 'GET', token = null) {
  const url = new URL(path, API_BASE);
  const startTime = performance.now();
  
  return new Promise((resolve) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const client = url.protocol === 'https:' ? https : http;

    const req = client.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const duration = Math.round(performance.now() - startTime);
        
        let source = 'db';
        try {
          const parsed = JSON.parse(data);
          if (parsed.source) source = parsed.source;
        } catch(e){}

        resolve({ 
          status: res.statusCode, 
          durationMs: duration,
          payloadBytes: Buffer.byteLength(data, 'utf8'),
          source
        });
      });
    });
    
    req.on('error', (e) => {
      const duration = Math.round(performance.now() - startTime);
      resolve({ status: 'error', durationMs: duration, error: e.message, payloadBytes: 0, source: 'network' });
    });
    
    req.end();
  });
}

const TESTS = [
  // Unauthorized tests
  { name: 'Unauthorized Dashboard Bootstrap', path: '/api/v1/dashboard/bootstrap', method: 'GET', auth: false, expectedStatus: 401, budgetMs: 300 },
  { name: 'Unauthorized Collections Bootstrap', path: '/api/v1/collections/bootstrap', method: 'GET', auth: false, expectedStatus: 401, budgetMs: 300 },
  { name: 'Unauthorized Cortex Refresh', path: '/api/v1/cortex/refresh', method: 'POST', auth: false, expectedStatus: 401, budgetMs: 300 },
  
  // Authenticated tests
  { name: 'Authenticated Dashboard Bootstrap', path: '/api/v1/dashboard/bootstrap', method: 'GET', auth: true, expectedStatus: 200, budgetMs: 1500 },
  { name: 'Authenticated Collections Bootstrap', path: '/api/v1/collections/bootstrap', method: 'GET', auth: true, expectedStatus: 200, budgetMs: 1500 },
  { name: 'Authenticated Cortex Refresh', path: '/api/v1/cortex/refresh', method: 'POST', auth: true, expectedStatus: 202, budgetMs: 500 },
];

async function run() {
  console.log("==========================================");
  console.log("    VANTRO PERFORMANCE LAB HARNESS        ");
  console.log("==========================================\\n");
  
  const results = [];

  for (const test of TESTS) {
    if (test.auth && !TEST_TOKEN) {
      results.push({
        test: test.name,
        status: 'N/A',
        duration: '-',
        payloadSize: '-',
        source: '-',
        pass: "⚠️ SKIPPED",
        recommendation: "Missing CORTEX_TEST_TOKEN or VANTRO_TEST_TOKEN env var"
      });
      continue;
    }

    const res = await fetchUrl(test.path, test.method, test.auth ? TEST_TOKEN : null);
    
    let pass = true;
    let recommendation = "OK";

    if (res.status !== test.expectedStatus) {
      pass = false;
      recommendation = `FAIL: Expected ${test.expectedStatus}, got ${res.status}`;
    } else if (res.durationMs > test.budgetMs) {
      pass = false;
      recommendation = `FAIL: Exceeds budget of ${test.budgetMs}ms.`;
    } else if (res.payloadBytes > 500 * 1024) {
      pass = false;
      recommendation = "FAIL: Payload exceeds 500KB.";
    }

    if (res.status === 'error') {
      pass = false;
      recommendation = `FAIL: Network error - ${res.error}`;
    }

    results.push({
      test: test.name,
      status: res.status,
      duration: `${res.durationMs}ms`,
      payloadSize: `${(res.payloadBytes / 1024).toFixed(1)} KB`,
      source: res.source,
      pass: pass ? "✅ PASS" : "❌ FAIL",
      recommendation
    });
  }

  console.table(results);
  
  const reportPath = 'performance-lab/report.md';
  if (!fs.existsSync('performance-lab')) fs.mkdirSync('performance-lab');
  
  const reportContent = `# Performance Report\nGenerated: ${new Date().toISOString()}\n\n` +
    results.map(r => `- **${r.test}**: ${r.pass} (${r.duration}, ${r.payloadSize}) - ${r.recommendation}`).join('\n');
  
  fs.writeFileSync(reportPath, reportContent);
  console.log(`\nReport saved to ${reportPath}`);
}

run();
