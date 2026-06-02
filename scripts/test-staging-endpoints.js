const fs = require('fs');

const token = fs.readFileSync('.staging-token', 'utf8').trim();
const rustUrl = 'https://vantro-automation-staging-production.up.railway.app/api/v2/agents/core.owner_briefing/preview';
const nodeUrl = 'https://vantro-node-staging-production.up.railway.app/api/agents/core.owner_briefing/preview';

async function testEndpoint(name, url, method, useToken = true) {
  let headers = { 'Content-Type': 'application/json' };
  if (useToken) headers['Authorization'] = `Bearer ${token}`;

  const bodyObj = {
    include_low_priority: true,
    max_items_per_section: 5,
    include_data_quality: true,
    include_policy_preview: true,
    include_cost_route: true
  };

  const reqInit = {
    method,
    headers,
  };
  if (method === 'POST') reqInit.body = JSON.stringify(bodyObj);

  let retries = 3;
  while (retries > 0) {
    try {
      const res = await fetch(url, reqInit);
      const text = await res.text();
      const prefix = `${name}${useToken ? '' : ' (No Token)'}`;
      console.log(`[${prefix}] Status: ${res.status}`);
      if (useToken) {
        try {
          const parsed = JSON.parse(text);
          console.log(`[${prefix}] Response:`, JSON.stringify(parsed, null, 2).substring(0, 1000));
        } catch (e) {
          console.log(`[${prefix}] Raw Response:`, text);
        }
      }
      return;
    } catch (e) {
      const isNotFound = e.code === 'ENOTFOUND' || (e.cause && e.cause.code === 'ENOTFOUND');
      if (isNotFound && retries > 1) {
        retries--;
        await new Promise(r => setTimeout(r, 2000));
      } else {
        throw e;
      }
    }
  }
}

async function run() {
  await testEndpoint('Rust API', rustUrl, 'POST', false);
  await testEndpoint('Rust API', rustUrl, 'POST', true);
  await testEndpoint('Node API', nodeUrl, 'GET', false);
  await testEndpoint('Node API', nodeUrl, 'GET', true);
}

run();
