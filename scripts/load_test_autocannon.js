// FILE: scripts/load_test_autocannon.js
// VANTRO FLOW — Local Performance Stress Benchmarking
// Run with: node scripts/load_test_autocannon.js

const autocannon = require('autocannon');

async function startLoadTest() {
  const url = process.env.TEST_URL || 'http://localhost:3001';
  const token = process.env.TEST_AUTH_TOKEN || '';
  
  console.log(`⚡ Starting Vantro Flow Load Test targeting ${url}...`);
  if (!token) {
    console.warn('⚠️  No TEST_AUTH_TOKEN provided. Route queries may fail with 401 Unauthorized.');
  }

  const instance = autocannon({
    url,
    connections: 50,  // Number of concurrent client sessions
    duration: 10,     // Test runtime in seconds
    pipelining: 1,
    title: 'Control Room read stress benchmark',
    headers: token ? {
      'Authorization': `Bearer ${token}`
    } : {},
    requests: [
      {
        method: 'GET',
        path: '/api/business/control-room'
      }
    ]
  }, (err, result) => {
    if (err) {
      console.error('❌ Error during load test:', err);
    } else {
      console.log('\n📊 Benchmark Run Complete!');
      console.log('---------------------------------------------');
      console.log(`Duration          : ${result.duration} seconds`);
      console.log(`Total Requests    : ${result.requests.total}`);
      console.log(`Average Requests/s: ${result.requests.average}`);
      console.log(`Total Bytes (MB)  : ${(result.throughput.total / 1024 / 1024).toFixed(2)}`);
      
      console.log('\n⏱️  Response Latency Profile:');
      console.log(`- Min Latency (ms): ${result.latency.min}`);
      console.log(`- p50 Latency (ms): ${result.latency.p50}`);
      console.log(`- p95 Latency (ms): ${result.latency.p95}`);
      console.log(`- p99 Latency (ms): ${result.latency.p99}`);
      console.log(`- Max Latency (ms): ${result.latency.max}`);
      
      console.log('\n❌ Socket / HTTP Errors:');
      console.log(`- Socket Errors   : ${result.errors}`);
      console.log(`- HTTP 4xx Errors : ${result.non2xx || 0}`);
      console.log('---------------------------------------------');
    }
  });

  autocannon.track(instance, { renderProgressBar: true });
}

startLoadTest();
