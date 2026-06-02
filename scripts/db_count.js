const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function main() {
  const tables = ['customers', 'invoices', 'promises', 'products', 'purchases', 'ai_actions', 'agent_registry'];
  const counts = {};
  
  for (const table of tables) {
    try {
      const res = await fetch(`${url}/rest/v1/${table}?select=*`, {
        method: 'HEAD',
        headers: {
          'apikey': key,
          'Authorization': `Bearer ${key}`,
          'Prefer': 'count=exact'
        }
      });
      const count = res.headers.get('content-range');
      counts[table] = count ? count.split('/')[1] : '0';
    } catch (e) {
      counts[table] = 'Error: ' + e.message;
    }
  }
  console.log(JSON.stringify(counts, null, 2));
}

main().catch(console.error);
