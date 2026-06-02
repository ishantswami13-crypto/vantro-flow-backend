const path = require('path');

// Mock process.env before requiring
process.env.RUST_AUTOMATION_BASE_URL = 'https://invalid-url.local.test';
process.env.FEATURE_COST_ROUTER_AGENT_ENABLED = 'true';

const { evaluateCostRouterRust } = require('../lib/services/rustAutomation/costRouterAgentClient.js');

async function main() {
  console.log('--- CONSERVATIVE FALLBACK PROOF ---');
  console.log('Testing with RUST_AUTOMATION_BASE_URL =', process.env.RUST_AUTOMATION_BASE_URL);
  
  const body = {
    task_type: "external_mutation_task",
    risk_level: "high",
    requires_external_action: true
  };
  
  const start = performance.now();
  const result = await evaluateCostRouterRust(body, 'dummy_token');
  const end = performance.now();
  
  console.log('Result:', JSON.stringify(result, null, 2));
  console.log('Latency:', (end - start).toFixed(2), 'ms');
  
  if (result.route === 'require_approval' && result.approvalRequired === true && result.safeToExecute === false) {
    console.log('✅ Fallback proof passed: Returns require_approval with safe_to_execute=false');
  } else {
    console.log('❌ Fallback proof failed!');
  }
}

main().catch(console.error);
