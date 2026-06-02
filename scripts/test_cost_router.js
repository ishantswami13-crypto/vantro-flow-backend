const fs = require('fs');

async function testEndpoint(url, token, body, name) {
  const start = performance.now();
  let status, resBody, reqPayloadSize, resPayloadSize, text;
  try {
    const payload = JSON.stringify(body);
    reqPayloadSize = Buffer.byteLength(payload);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      },
      body: payload
    });
    status = res.status;
    text = await res.text();
    resPayloadSize = Buffer.byteLength(text);
    try {
      resBody = text ? JSON.parse(text) : null;
    } catch(e) {
      resBody = { error: 'JSON Parse Error: ' + text };
    }
  } catch (e) {
    status = 'Fetch Error';
    resBody = { error: e.message };
  }
  const end = performance.now();
  return {
    name,
    status,
    latency_ms: end - start,
    reqPayloadSize,
    resPayloadSize,
    route: resBody?.route,
    approvalRequired: resBody?.approval_required ?? resBody?.approvalRequired,
    safeToExecute: resBody?.safe_to_execute ?? resBody?.safeToExecute,
    fullResponse: resBody
  };
}

async function main() {
  const token = fs.readFileSync('.staging-token', 'utf-8').trim();
  const badToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.invalid';

  const rustUrl = 'https://vantro-automation-staging-production.up.railway.app/api/v2/agents/core.cost_router/evaluate';
  const nodeUrl = 'https://vantro-node-staging-production.up.railway.app/api/agents/core.cost_router/evaluate';

  const cases = [
    {
      name: 'A. Deterministic scoring task',
      body: {
        task_type: "customer_risk_scoring",
        risk_level: "low",
        deterministic_possible: true,
        requires_reasoning: false,
        requires_message_drafting: false,
        requires_external_action: false,
        cache_available: false,
        batchable: false
      }
    },
    {
      name: 'B. Cache available',
      body: {
        task_type: "owner_briefing_summary",
        risk_level: "low",
        cache_available: true,
        deterministic_possible: false,
        requires_reasoning: true,
        requires_message_drafting: false,
        requires_external_action: false
      }
    },
    {
      name: 'C. Simple explanation',
      body: {
        task_type: "explain_overdue_invoice",
        risk_level: "low",
        requires_reasoning: true,
        requires_message_drafting: false,
        requires_external_action: false,
        cache_available: false,
        deterministic_possible: false,
        estimated_tokens: 800
      }
    },
    {
      name: 'D. External WhatsApp draft',
      body: {
        task_type: "draft_collection_message",
        risk_level: "high",
        requires_reasoning: true,
        requires_message_drafting: true,
        requires_external_action: true,
        cache_available: false,
        deterministic_possible: false
      }
    },
    {
      name: 'E. Financial mutation',
      body: {
        task_type: "mark_invoice_paid",
        risk_level: "critical",
        requires_reasoning: false,
        requires_message_drafting: false,
        requires_external_action: false,
        deterministic_possible: false,
        policy_decision: "block"
      }
    },
    {
      name: 'F. High token budget',
      body: {
        task_type: "large_report_generation",
        risk_level: "medium",
        requires_reasoning: true,
        requires_message_drafting: false,
        requires_external_action: false,
        estimated_tokens: 50000,
        cache_available: false,
        batchable: true
      }
    }
  ];

  console.log('--- RUST ENDPOINT TESTS ---');
  for (const c of cases) {
    const res = await testEndpoint(rustUrl, token, c.body, c.name);
    console.log(`[Rust] ${c.name} -> status: ${res.status}, route: ${res.route}, latency: ${res.latency_ms.toFixed(2)}ms`);
    if(res.fullResponse?.error) console.log(`       Error: ${res.fullResponse.error}`);
    if(c.name === 'E. Financial mutation') console.log(`       safeToExecute: ${res.safeToExecute}`);
  }
  const rustNoToken = await testEndpoint(rustUrl, null, cases[0].body, 'Missing Token');
  console.log(`[Rust] Missing Token -> status: ${rustNoToken.status}, body: ${JSON.stringify(rustNoToken.fullResponse)}`);
  const rustBadToken = await testEndpoint(rustUrl, badToken, cases[0].body, 'Invalid Token');
  console.log(`[Rust] Invalid Token -> status: ${rustBadToken.status}, body: ${JSON.stringify(rustBadToken.fullResponse)}`);

  console.log('\n--- NODE ENDPOINT TESTS ---');
  for (const c of cases) {
    const res = await testEndpoint(nodeUrl, token, c.body, c.name);
    console.log(`[Node] ${c.name} -> status: ${res.status}, route: ${res.route}, latency: ${res.latency_ms.toFixed(2)}ms`);
    if(res.fullResponse?.error) console.log(`       Error: ${res.fullResponse.error}`);
  }
  const nodeNoToken = await testEndpoint(nodeUrl, null, cases[0].body, 'Missing Token');
  console.log(`[Node] Missing Token -> status: ${nodeNoToken.status}, body: ${JSON.stringify(nodeNoToken.fullResponse)}`);
  const nodeBadToken = await testEndpoint(nodeUrl, badToken, cases[0].body, 'Invalid Token');
  console.log(`[Node] Invalid Token -> status: ${nodeBadToken.status}, body: ${JSON.stringify(nodeBadToken.fullResponse)}`);
}
main();
