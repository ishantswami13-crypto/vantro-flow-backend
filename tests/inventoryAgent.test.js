// Verifies the fix for inventoryAgent.js querying the nonexistent `inventory`
// table — it must now query `products` (current_stock/low_stock_alert),
// matching the real inventory-sync code (server.js syncInventoryFromSale/
// syncInventoryFromPurchase) and rules.service.js's ruleLowStock.
// Requires DATABASE_URL (real dev Postgres) — no mocking, per project convention.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const assert = require('assert');
const { randomUUID } = require('crypto');
const { Client } = require('pg');
const { run } = require('../lib/services/agents/inventoryAgent');

// low_stock_alerts flag defaults OFF — force it on for this test process only.
process.env.FEATURE_LOW_STOCK_ALERTS = 'true';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('[SKIP] inventoryAgent test — no DATABASE_URL configured');
    return;
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const userId = randomUUID();
  const lowProductId = randomUUID();
  const healthyProductId = randomUUID();

  try {
    await client.query(
      `INSERT INTO users (id, email, business_name, plan, created_at) VALUES ($1, $2, 'Test Biz', 'free', NOW())`,
      [userId, `inv-agent-test-${userId}@example.invalid`]
    );

    await client.query(
      `INSERT INTO products (id, user_id, name, current_stock, low_stock_alert, created_at)
       VALUES ($1, $2, 'Low Stock Widget', 2, 10, NOW())`,
      [lowProductId, userId]
    );
    await client.query(
      `INSERT INTO products (id, user_id, name, current_stock, low_stock_alert, created_at)
       VALUES ($1, $2, 'Healthy Widget', 50, 10, NOW())`,
      [healthyProductId, userId]
    );

    const specs = await run(userId);

    assert.strictEqual(specs.length, 1, 'expected exactly one LOW_STOCK_ALERT — the healthy product must not trigger');
    const spec = specs[0];
    assert.strictEqual(spec.action_type, 'LOW_STOCK_ALERT');
    assert.strictEqual(spec.related_entity_type, 'product', 'related_entity_type must reference the real products table');
    assert.strictEqual(spec.related_entity_id, lowProductId);
    assert(spec.title.includes('Low Stock Widget'), 'title must use products.name');
    assert(spec.description.includes('2 units left'), 'description must reflect current_stock');

    console.log('[PASS] inventoryAgent queries products and flags only the low-stock item');
  } finally {
    await client.query('DELETE FROM ai_actions WHERE user_id = $1', [userId]).catch(() => {});
    await client.query('DELETE FROM products WHERE user_id = $1', [userId]).catch(() => {});
    await client.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
    await client.end();
  }
}

main().catch(err => { console.error('[FAIL] inventoryAgent test:', err.message); process.exit(1); });
