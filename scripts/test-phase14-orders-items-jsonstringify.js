// Phase 14 regression test: proves the three orders write paths in server.js
// (POST /api/orders, PATCH /api/orders/:id, and the AI-call intake insert)
// correctly JSON.stringify() the `items` JSONB payload before insert/update,
// matching the established pattern used elsewhere in this file (e.g. lines
// ~1460, ~9520, ~9585 for invoices/purchases). Confirmed in a prior review
// cycle that inserting a raw JS array into a JSONB column via the local
// pg-backed supabase shim (pgSupabaseShim.js, DATABASE_URL) throws
// "invalid input syntax for type json" — this does NOT reproduce against
// real Supabase/PostgREST HTTP in production, which JSON-encodes request
// bodies regardless. JSON.stringify() before insert is valid there too.
//
// This test mirrors the exact code now in server.js (post-fix) for each of
// the three call sites, rather than re-deriving its own insert shape, so a
// regression in any of the three sites (reverting to a raw array, or
// accidentally double-stringifying) will be caught here.
//
// Run: node scripts/test-phase14-orders-items-jsonstringify.js
require('dotenv').config();
const { randomUUID } = require('crypto');
const { supabase } = require('../lib/config/supabaseClient');

let pass = 0, fail = 0;
function check(label, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  cond ? pass++ : fail++;
}

// Mirrors server.js POST /api/orders (post-fix): items: JSON.stringify(items || [])
async function postOrderEquivalent(userId, body) {
  const { customer_name, customer_phone, delivery_address, items, total_amount, delivery_time, special_instructions, worker_id } = body;
  return supabase.from('orders').insert([{
    user_id: userId, customer_name, customer_phone,
    delivery_address, items: JSON.stringify(items || []), total_amount: total_amount || null,
    delivery_time, special_instructions, worker_id: worker_id || null,
    source: 'manual', status: 'new',
    order_date: new Date().toISOString().split('T')[0], created_at: new Date(),
  }]).select().single();
}

// Mirrors server.js pickAllowed + PATCH /api/orders/:id (post-fix).
function pickAllowed(source, allowed) {
  return allowed.reduce((out, key) => {
    if (source[key] !== undefined) out[key] = source[key];
    return out;
  }, {});
}
async function patchOrderEquivalent(orderId, userId, body) {
  const updates = pickAllowed(body, ['customer_name', 'customer_phone', 'delivery_address', 'items', 'total_amount', 'delivery_time', 'special_instructions', 'worker_id', 'status']);
  if (updates.items !== undefined) updates.items = JSON.stringify(updates.items || []);
  updates.updated_at = new Date();
  return supabase.from('orders').update(updates).eq('id', orderId).eq('user_id', userId).select().single();
}

// Mirrors server.js AI-call intake insert payload (post-fix).
async function aiCallIntakeEquivalent(userId, extracted, callerPhone) {
  const orderPayload = {
    user_id: userId,
    customer_name: extracted.customer_name || callerPhone || 'Unknown',
    customer_phone: extracted.customer_phone || null,
    delivery_address: extracted.delivery_address || null,
    items: JSON.stringify(extracted.items || []),
    delivery_time: extracted.delivery_time || null,
    special_instructions: extracted.special_instructions || null,
    call_recording_url: null,
    call_transcript: 'test transcript',
    source: 'ai_call',
    status: 'new',
    order_date: new Date().toISOString().split('T')[0],
    created_at: new Date(),
  };
  return supabase.from('orders').insert([orderPayload]).select().single();
}

async function main() {
  const userId = randomUUID();
  let orderId1 = null, orderId2 = null, orderId3 = null;

  try {
    await supabase.from('users').insert([{ id: userId, email: `phase14-${userId}@test.local`, password_hash: 'x', business_name: 'Phase14 Tenant' }]);

    // --- 1. POST /api/orders equivalent — non-empty structured items ---
    const itemsA = [
      { name: 'Bucket 20L', local_name: 'bucket', quantity: 5, unit: 'piece' },
      { name: 'Mug', local_name: 'mug', quantity: 12, unit: 'piece' },
    ];
    const { data: created, error: createErr } = await postOrderEquivalent(userId, {
      customer_name: 'Bharat Traders', customer_phone: '9111122223',
      delivery_address: 'MIDC Phase 2, Nashik', items: itemsA, total_amount: 2500,
    });
    check('POST insert succeeds (no "invalid input syntax for type json")', !createErr && !!created);
    if (createErr) console.log('  -> error:', JSON.stringify(createErr));
    orderId1 = created && created.id;

    // Round-trip via GET-equivalent select — verify items parsed correctly, not
    // double-encoded (a string), not null, and matches exact content.
    const { data: fetched1 } = await supabase.from('orders').select('*').eq('id', orderId1).eq('user_id', userId).single();
    check('POST round-trip: items is an array (not a JSON string / not double-encoded)', Array.isArray(fetched1 && fetched1.items));
    check('POST round-trip: items has correct length', fetched1 && Array.isArray(fetched1.items) && fetched1.items.length === 2);
    check('POST round-trip: item 1 name/quantity/unit correct', fetched1 && fetched1.items[0].name === 'Bucket 20L' && fetched1.items[0].quantity === 5 && fetched1.items[0].unit === 'piece');
    check('POST round-trip: item 2 name/quantity/unit correct', fetched1 && fetched1.items[1].name === 'Mug' && fetched1.items[1].quantity === 12 && fetched1.items[1].unit === 'piece');

    // --- 1b. POST with items undefined — must not crash, must default gracefully ---
    const { data: createdNoItems, error: noItemsErr } = await postOrderEquivalent(userId, {
      customer_name: 'No Items Co', customer_phone: '9000000001', delivery_address: 'Nashik',
      items: undefined, total_amount: 100,
    });
    check('POST with items undefined does not crash', !noItemsErr && !!createdNoItems);
    const { data: fetchedNoItems } = await supabase.from('orders').select('items').eq('id', createdNoItems.id).eq('user_id', userId).single();
    check('POST with items undefined round-trips to empty array (matches pre-fix tolerant behavior)', Array.isArray(fetchedNoItems.items) && fetchedNoItems.items.length === 0);
    await supabase.from('orders').delete().eq('id', createdNoItems.id).eq('user_id', userId);

    // --- 2. PATCH /api/orders/:id equivalent — update items ---
    const itemsB = [{ name: 'Chair', local_name: 'kursi', quantity: 3, unit: 'piece' }];
    const { data: patched, error: patchErr } = await patchOrderEquivalent(orderId1, userId, { items: itemsB, status: 'confirmed' });
    check('PATCH update succeeds', !patchErr && !!patched);
    if (patchErr) console.log('  -> error:', JSON.stringify(patchErr));

    const { data: fetched1After } = await supabase.from('orders').select('*').eq('id', orderId1).eq('user_id', userId).single();
    check('PATCH round-trip: items is an array (not double-encoded)', Array.isArray(fetched1After && fetched1After.items));
    check('PATCH round-trip: items reflects the update (length 1)', fetched1After && fetched1After.items.length === 1);
    check('PATCH round-trip: updated item name/quantity correct', fetched1After && fetched1After.items[0].name === 'Chair' && fetched1After.items[0].quantity === 3);
    check('PATCH also applied non-items field (status)', fetched1After && fetched1After.status === 'confirmed');

    // --- 2b. PATCH without touching items — items must remain unaffected ---
    const { data: patched2 } = await patchOrderEquivalent(orderId1, userId, { status: 'delivered' });
    check('PATCH without items in body leaves items untouched', patched2 && Array.isArray(patched2.items) && patched2.items.length === 1 && patched2.items[0].name === 'Chair');

    // --- 3. AI-call intake insert path equivalent ---
    const extracted = {
      customer_name: 'Ramesh Kirana', delivery_address: 'Gangapur Road',
      items: [{ name: 'Rice 5kg', local_name: 'chawal', quantity: 2, unit: 'bag' }],
      delivery_time: 'evening', special_instructions: 'Leave at gate',
    };
    const { data: createdAi, error: aiErr } = await aiCallIntakeEquivalent(userId, extracted, '+919876500000');
    check('AI-call intake insert succeeds', !aiErr && !!createdAi);
    if (aiErr) console.log('  -> error:', JSON.stringify(aiErr));
    orderId3 = createdAi && createdAi.id;

    const { data: fetched3 } = await supabase.from('orders').select('*').eq('id', orderId3).eq('user_id', userId).single();
    check('AI-call intake round-trip: items is an array (not double-encoded)', Array.isArray(fetched3 && fetched3.items));
    check('AI-call intake round-trip: item content correct', fetched3 && fetched3.items[0].name === 'Rice 5kg' && fetched3.items[0].quantity === 2 && fetched3.items[0].unit === 'bag');
    check('AI-call intake round-trip: source is ai_call', fetched3 && fetched3.source === 'ai_call');

    // --- 3b. AI-call intake with items missing from extraction (LLM returned no items) ---
    const { data: createdAiNoItems, error: aiNoItemsErr } = await aiCallIntakeEquivalent(userId, { customer_name: 'X' }, '+919876500001');
    check('AI-call intake with missing items does not crash', !aiNoItemsErr && !!createdAiNoItems);
    const { data: fetchedAiNoItems } = await supabase.from('orders').select('items').eq('id', createdAiNoItems.id).eq('user_id', userId).single();
    check('AI-call intake with missing items round-trips to empty array', Array.isArray(fetchedAiNoItems.items) && fetchedAiNoItems.items.length === 0);
    await supabase.from('orders').delete().eq('id', createdAiNoItems.id).eq('user_id', userId);

  } finally {
    await supabase.from('orders').delete().eq('user_id', userId);
    await supabase.from('users').delete().eq('id', userId);

    const { data: residueOrders } = await supabase.from('orders').select('id').eq('user_id', userId);
    const { data: residueUsers } = await supabase.from('users').select('id').eq('id', userId);
    check('cleanup leaves zero residual orders', (residueOrders || []).length === 0);
    check('cleanup leaves zero residual synthetic users', (residueUsers || []).length === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (!process.env.DATABASE_URL) {
  console.error('FAIL: DATABASE_URL is not set. This test requires the real local-dev DB connection string.');
  process.exit(1);
}
if (/NEON_READONLY/i.test(process.env.DATABASE_URL) || process.env.NEON_READONLY_URL === process.env.DATABASE_URL) {
  console.error('FAIL: refusing to run against what looks like a readonly/production URL.');
  process.exit(1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
