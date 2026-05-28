// FILE: scripts/backfill-customers.js
// One-time script: derives the customers master table from denormalized
// customer_name + customer_phone columns across invoices and sales tables.
//
// Run AFTER applying migration 001_cortex_foundation.sql.
// Safe to re-run — uses upsert on (user_id, lower(name), coalesce(phone, '')).
//
// Usage: node scripts/backfill-customers.js
// Optional: node scripts/backfill-customers.js --dry-run  (prints counts, no writes)
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
);

const DRY_RUN = process.argv.includes('--dry-run');

function normalize(str) {
  return (str || '').trim().replace(/\s+/g, ' ');
}

// Collect unique (user_id, name, phone) combos from a given table
async function collectFromTable(tableName, nameCol, phoneCol) {
  const PAGE = 1000;
  let offset = 0;
  const map = new Map(); // key: `${userId}||${normalizedName}||${phone}` → { user_id, name, phone }

  while (true) {
    const { data, error } = await supabase
      .from(tableName)
      .select(`user_id, ${nameCol}, ${phoneCol}`)
      .range(offset, offset + PAGE - 1);

    if (error) {
      console.error(`[backfill] Error reading ${tableName}:`, error.message);
      break;
    }
    if (!data || data.length === 0) break;

    for (const row of data) {
      const userId = row.user_id;
      const name   = normalize(row[nameCol]);
      const phone  = normalize(row[phoneCol] || '');
      if (!userId || !name) continue;

      const key = `${userId}||${name.toLowerCase()}||${phone.toLowerCase()}`;
      if (!map.has(key)) {
        map.set(key, { user_id: userId, name, phone: phone || null });
      }
    }

    if (data.length < PAGE) break;
    offset += PAGE;
  }

  return map;
}

async function main() {
  console.log(`[backfill] Starting customers backfill (${DRY_RUN ? 'DRY RUN' : 'LIVE'})...`);

  // Collect from invoices and sales
  const [invoiceMap, salesMap] = await Promise.all([
    collectFromTable('invoices', 'customer_name', 'customer_phone'),
    collectFromTable('sales',    'customer_name', 'customer_phone'),
  ]);

  // Merge: prefer sales entry (more likely to have phone) over invoices
  const merged = new Map([...invoiceMap, ...salesMap]);
  // Re-merge: if key exists in both, keep the one with a phone number
  for (const [key, val] of invoiceMap) {
    if (!merged.has(key) || (!merged.get(key).phone && val.phone)) {
      merged.set(key, val);
    }
  }

  const rows = [...merged.values()];
  console.log(`[backfill] Found ${rows.length} unique customers to upsert.`);

  if (DRY_RUN) {
    console.log('[backfill] DRY RUN — no writes. First 10 customers:');
    console.table(rows.slice(0, 10));
    return;
  }

  // Upsert in batches of 200
  const BATCH = 200;
  let upserted = 0;
  let errors   = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supabase
      .from('customers')
      .upsert(batch, { onConflict: 'user_id,name,phone', ignoreDuplicates: true });

    if (error) {
      console.error(`[backfill] Upsert error on batch ${i}–${i + BATCH}:`, error.message);
      errors++;
    } else {
      upserted += batch.length;
    }
  }

  console.log(`[backfill] Done. Upserted: ${upserted} | Batch errors: ${errors}`);
}

main().catch(err => {
  console.error('[backfill] Fatal:', err.message);
  process.exit(1);
});
