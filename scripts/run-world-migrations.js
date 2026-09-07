require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
async function run(file) {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const sql = fs.readFileSync(file, 'utf-8');
    const res = await client.query(sql);
    const last = Array.isArray(res) ? res[res.length - 1] : res;
    console.log(file, 'OK', last && last.rows);
  } catch (e) {
    console.error(file, 'FAIL', e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
(async () => {
  for (const f of process.argv.slice(2)) await run(f);
})();
