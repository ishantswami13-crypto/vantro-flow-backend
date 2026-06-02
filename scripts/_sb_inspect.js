'use strict';
const https = require('https');
const fs = require('fs');
const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SB_REF;

function sqlApi(query) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ query });
    const opts = { hostname: 'api.supabase.com',
      path: '/v1/projects/' + ref + '/database/query', method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload) } };
    const r = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject); r.write(payload); r.end();
  });
}

async function runSQL(label, sql) {
  const r = await sqlApi(sql);
  if (r.status === 200 || r.status === 201) { console.log('  OK:', label); return JSON.parse(r.body); }
  let msg; try { msg = JSON.parse(r.body)?.message || r.body.slice(0, 300); } catch { msg = r.body.slice(0, 300); }
  throw new Error('FAILED [' + label + ']: ' + msg);
}

async function main() {
  // Inspect current schema state
  const tables = await runSQL('list tables',
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name");
  console.log('Tables:', tables.map(t => t.table_name).join(', '));

  // Check ai_actions columns
  const aicols = await runSQL('ai_actions cols',
    "SELECT column_name FROM information_schema.columns WHERE table_name='ai_actions' AND table_schema='public'");
  if (aicols.length) console.log('ai_actions cols:', aicols.map(c => c.column_name).join(', '));
  else console.log('ai_actions: not created yet');

  // Check call_logs columns
  const clcols = await runSQL('call_logs cols',
    "SELECT column_name FROM information_schema.columns WHERE table_name='call_logs' AND table_schema='public'");
  console.log('call_logs cols:', clcols.map(c => c.column_name).join(', ') || 'not created');
}
main().catch(e => { console.error('[inspect] Fatal:', e.message); process.exit(1); });
