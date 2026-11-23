'use strict';
// FILE: lib/domain/operations/masterDataImport.js
// The two master-data kinds of the operational importer:
//
//   kind 'products'    -> products, plus one OPENING-<id> stock movement when
//                         the file sets a product's stock on hand
//   kind 'components'  -> product_components (which components, and how many,
//                         make one finished product)
//
// Called by operationalImport.preview/commitOperationalImport, which read the
// file and route here. Same contract as the order and purchase kinds:
// preview writes nothing; commit writes only what the human confirmed, in one
// transaction under the tenant's import lock, with a file_import_batches row
// and an OPERATIONS_IMPORTED audit event; the same file with the same choices
// is imported once.
//
// Rules:
//   - Stock on hand is physical stock only. Quantities still on order are
//     never stock; they come in as purchase lines and become stock only when
//     a receipt is recorded.
//   - A new product needs a stated stock on hand (0 is a statement; a blank
//     is not). Starlane never assumes a product has no stock.
//   - A product whose stock Starlane already tracks through movements (sales,
//     receipts, adjustments) is never overwritten by a file. The difference
//     is reported as a conflict; the rest of the row still updates.
//   - A product with no movements yet gets the file's stock as its opening
//     balance, recorded as the OPENING-<id> movement the reconcile keeps.
//   - Products are matched on exact SKU, then exact name. A SKU shared by two
//     products, or a name that belongs to a product with another SKU, is a
//     conflict, never a guess.
//   - Components link existing products only; a missing product is a
//     rejected row ("import products first"), never created here.
//   - Nothing is deleted because a newer file leaves it out.

const { normalizeName } = require('../ingestion/entityResolution');
const { appendEvent, humanActor } = require('../decisions/store');
const { planOpeningMovements } = require('../inventory/stockLedger');
const { toMicro, fromMicro } = require('./decimal');

// operationalImport requires this module lazily, so this require resolves to
// its finished exports.
const op = require('./operationalImport');

const LABEL = { products: 'product', components: 'component link' };

function normalizeMaster(kind, headers, rows, v) {
  const idx = Object.fromEntries(Object.keys(op.FIELDS[kind]).map((f) => [f, v.fields[f] ? headers.indexOf(v.fields[f]) : -1]));
  const get = (row, f) => (idx[f] === -1 ? '' : String(row[idx[f]] == null ? '' : row[idx[f]]).trim());
  const records = [];
  const rejected = [];
  const warnings = {};
  const warn = (k, row) => { warnings[k] = warnings[k] || { count: 0, rows: [] }; warnings[k].count++; if (warnings[k].rows.length < 5) warnings[k].rows.push(row); };
  const seen = new Map();

  rows.forEach((row, i) => {
    const rowNo = i + 2; // 1-based, after the header row
    const reject = (reason) => rejected.push({ row: rowNo, reason });
    if (kind === 'products') {
      const name = op.cleanText(get(row, 'product_name'));
      const sku = op.cleanText(get(row, 'sku'), 80);
      if (!name) return reject('no product name');
      const q = op.parseQuantity(get(row, 'on_hand'));
      if (q.error) return reject(`stock on hand ${q.error}`);
      const pr = op.parsePrice(get(row, 'unit_price'));
      if (pr.error) return reject(`selling price ${pr.error}`);
      const rec = {
        _row: rowNo, sku, name,
        onHand: q.micro != null ? fromMicro(q.micro) : null,
        unit: op.cleanText(get(row, 'unit'), 30),
        price: pr.micro != null ? fromMicro(pr.micro) : null,
        category: op.cleanText(get(row, 'category'), 60),
        key: sku ? `sku:${op.keyOf(sku)}` : `name:${normalizeName(name)}`,
      };
      if (rec.onHand == null) warn('stockNotStated', rowNo);
      const fp = JSON.stringify([rec.sku, rec.name, rec.onHand, rec.unit, rec.price, rec.category]);
      const prior = seen.get(rec.key);
      if (prior) {
        if (prior.fp === fp) { warn('duplicateRow', rowNo); return undefined; }
        return reject(`${sku ? `SKU ${sku}` : `"${name}"`} appears again with different values (first at row ${prior.row})`);
      }
      seen.set(rec.key, { fp, row: rowNo });
      records.push(rec);
      return undefined;
    }
    // components
    const fin = { sku: op.cleanText(get(row, 'finished_sku'), 80), name: op.cleanText(get(row, 'finished_name')) };
    const com = { sku: op.cleanText(get(row, 'component_sku'), 80), name: op.cleanText(get(row, 'component_name')) };
    if (!fin.sku && !fin.name) return reject('no finished product');
    if (!com.sku && !com.name) return reject('no component');
    const q = op.parseQuantity(get(row, 'quantity_per_unit'));
    if (q.empty) return reject('no quantity per finished unit');
    if (q.error) return reject(`quantity per finished unit ${q.error}`);
    if (q.micro === 0n) return reject('quantity per finished unit is 0');
    const rec = { _row: rowNo, fin, com, qty: fromMicro(q.micro) };
    const k = JSON.stringify([op.keyOf(fin.sku || fin.name), op.keyOf(com.sku || com.name)]);
    const prior = seen.get(k);
    if (prior) {
      if (prior.qty === rec.qty) { warn('duplicateRow', rowNo); return undefined; }
      return reject(`the same component appears again for the same product with a different quantity (first at row ${prior.row})`);
    }
    seen.set(k, { qty: rec.qty, row: rowNo });
    records.push(rec);
    return undefined;
  });
  return { records, rejected, warnings };
}

async function loadProducts(db, userId, { lock = false } = {}) {
  const r = await db.query(
    `SELECT p.id, p.name, p.sku, p.unit, p.unit_price::text AS unit_price, p.category, p.current_stock::text AS current_stock,
            EXISTS (SELECT 1 FROM stock_movements m WHERE m.user_id = p.user_id AND m.product_id = p.id) AS has_movements
       FROM products p WHERE p.user_id = $1 ORDER BY p.created_at, p.id${lock ? ' FOR UPDATE OF p' : ''}`,
    [userId]
  );
  return r.rows;
}

function indexProducts(products) {
  const bySku = new Map();
  const byName = new Map();
  for (const p of products) {
    if (p.sku) { const k = op.keyOf(p.sku); bySku.set(k, [...(bySku.get(k) || []), p]); }
    const n = normalizeName(p.name);
    byName.set(n, [...(byName.get(n) || []), p]);
  }
  return { bySku, byName };
}

const same = (a, b) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const ma = toMicro(String(a));
  const mb = toMicro(String(b));
  return ma != null && mb != null ? ma === mb : String(a) === String(b);
};

function planProducts(records, products) {
  const { bySku, byName } = indexProducts(products);
  const plan = [];
  const extraRejected = [];
  for (const rec of records) {
    const entry = { rec, action: null, product: null, changes: [], conflicts: [], setStock: false };
    let match = null;
    if (rec.sku) {
      const hits = bySku.get(op.keyOf(rec.sku)) || [];
      if (hits.length > 1) { entry.action = 'CONFLICT'; entry.conflicts.push(`${hits.length} products already share SKU ${rec.sku} in Starlane; fix that in Products before importing this row`); plan.push(entry); continue; }
      match = hits[0] || null;
      if (!match) {
        const named = (byName.get(normalizeName(rec.name)) || []);
        const otherSku = named.find((p) => p.sku && op.keyOf(p.sku) !== op.keyOf(rec.sku));
        if (otherSku) { entry.action = 'CONFLICT'; entry.conflicts.push(`"${rec.name}" already exists with SKU ${otherSku.sku}, not ${rec.sku}; nothing was changed`); plan.push(entry); continue; }
        if (named.length === 1) match = named[0];
        else if (named.length > 1) { entry.action = 'CONFLICT'; entry.conflicts.push(`${named.length} products are named "${rec.name}"; fix that in Products before importing this row`); plan.push(entry); continue; }
      }
    } else {
      const named = byName.get(normalizeName(rec.name)) || [];
      if (named.length > 1) { entry.action = 'CONFLICT'; entry.conflicts.push(`${named.length} products are named "${rec.name}"; add the SKU to the file to say which one`); plan.push(entry); continue; }
      match = named[0] || null;
    }

    if (!match) {
      if (rec.onHand == null) { extraRejected.push({ row: rec._row, reason: `"${rec.name}" is a new product with no stock on hand stated (write 0 if none is on hand)` }); continue; }
      entry.action = 'INSERT';
      plan.push(entry);
      continue;
    }
    entry.product = match;
    const diff = (field, from, to) => entry.changes.push({ field, from, to });
    if (rec.sku && !match.sku) diff('SKU', null, rec.sku);
    if (rec.name !== match.name) diff('name', match.name, rec.name);
    if (rec.unit && rec.unit !== match.unit) diff('unit', match.unit, rec.unit);
    if (rec.price != null && !same(rec.price, match.unit_price)) diff('selling price', match.unit_price == null ? null : fromMicro(toMicro(match.unit_price)), rec.price);
    if (rec.category && rec.category !== match.category) diff('category', match.category, rec.category);
    if (rec.onHand != null && !same(rec.onHand, match.current_stock)) {
      const now = fromMicro(toMicro(match.current_stock) ?? 0n);
      if (match.has_movements) entry.conflicts.push(`Starlane already tracks stock of ${match.name} through its movements (${now} now); the file's ${rec.onHand} was not applied. Record a stock adjustment if the count is right`);
      else { diff('stock on hand', now, rec.onHand); entry.setStock = true; }
    }
    entry.action = entry.changes.length ? 'UPDATE' : 'UNCHANGED';
    plan.push(entry);
  }
  return { plan, extraRejected };
}

function planComponents(records, products, existingLinks) {
  const { bySku, byName } = indexProducts(products);
  const resolve = (ref) => {
    if (ref.sku) {
      const hits = bySku.get(op.keyOf(ref.sku)) || [];
      if (hits.length === 1) return { product: hits[0] };
      if (hits.length > 1) return { error: `${hits.length} products share SKU ${ref.sku}` };
      if (!ref.name) return { error: `no product with SKU ${ref.sku}; import products first` };
    }
    const hits = byName.get(normalizeName(ref.name)) || [];
    if (hits.length === 1) return { product: hits[0] };
    if (hits.length > 1) return { error: `${hits.length} products are named "${ref.name}"; add the SKU` };
    return { error: `no product ${ref.sku ? `with SKU ${ref.sku} or ` : ''}named "${ref.name}"; import products first` };
  };
  const links = new Map(existingLinks.map((l) => [`${l.finished_product_id}|${l.component_product_id}`, l]));
  const pairsInFile = new Set();
  const plan = [];
  const extraRejected = [];
  for (const rec of records) {
    const f = resolve(rec.fin);
    if (f.error) { extraRejected.push({ row: rec._row, reason: `finished product: ${f.error}` }); continue; }
    const c = resolve(rec.com);
    if (c.error) { extraRejected.push({ row: rec._row, reason: `component: ${c.error}` }); continue; }
    if (f.product.id === c.product.id) { extraRejected.push({ row: rec._row, reason: `${f.product.name} cannot be a component of itself` }); continue; }
    const pair = `${f.product.id}|${c.product.id}`;
    const reverse = `${c.product.id}|${f.product.id}`;
    if (links.has(reverse) || pairsInFile.has(reverse)) { extraRejected.push({ row: rec._row, reason: `${c.product.name} is already made from ${f.product.name}; a product cannot be both` }); continue; }
    pairsInFile.add(pair);
    const entry = { rec, finished: f.product, component: c.product, changes: [], conflicts: [], action: 'INSERT', existing: links.get(pair) || null };
    if (entry.existing) {
      if (same(entry.existing.quantity_per_unit, rec.qty)) entry.action = 'UNCHANGED';
      else { entry.action = 'UPDATE'; entry.changes.push({ field: 'quantity per unit', from: fromMicro(toMicro(String(entry.existing.quantity_per_unit))), to: rec.qty }); }
    }
    plan.push(entry);
  }
  return { plan, extraRejected };
}

const WARNINGS = {
  stockNotStated: (n) => ({ severity: 'reduces', message: `${op.nOf(n, 'row')} ${n === 1 ? 'has' : 'have'} no stock on hand. Existing products keep their stock; a new product without a stated stock is not created.` }),
};

function summarizeMaster(kind, plan, norm, extraRejected, rowsTotal) {
  const count = (a) => plan.filter((p) => p.action === a).length;
  const rejected = [...norm.rejected, ...extraRejected].sort((a, b) => a.row - b.row);
  const limitations = [];
  for (const [k, w] of Object.entries(norm.warnings)) if (WARNINGS[k]) limitations.push({ key: k, ...WARNINGS[k](w.count), rows: w.rows });
  if (kind === 'products') limitations.push({ key: 'stockIsPhysical', severity: 'info', message: 'Stock on hand is counted as physical stock today. Goods still on order are not stock: import them as purchase lines, and they become stock only when you record them as received.' });
  const withConflicts = plan.filter((p) => p.conflicts.length);
  return {
    kind,
    counts: {
      rows: rowsTotal,
      accepted: count('INSERT') + count('UPDATE') + count('UNCHANGED'),
      new: count('INSERT'),
      updated: count('UPDATE'),
      unchanged: count('UNCHANGED'),
      closedSkipped: 0,
      reviewRequired: 0,
      skippedByChoice: 0,
      conflicts: withConflicts.length,
      rejected: rejected.length,
      duplicateRows: norm.warnings.duplicateRow?.count || 0,
      unlinked: 0,
    },
    review: [],
    rejectedByReason: op.groupRejected(rejected),
    conflicts: withConflicts.slice(0, 50).map((p) => ({ row: p.rec._row, ref: kind === 'products' ? (p.rec.sku || p.rec.name) : `${p.finished?.name} ← ${p.component?.name}`, details: p.conflicts })),
    changes: plan.filter((p) => p.action === 'UPDATE').slice(0, 50).map((p) => ({ row: p.rec._row, ref: kind === 'products' ? (p.rec.sku || p.rec.name) : `${p.finished.name} ← ${p.component.name}`, changes: p.changes })),
    limitations,
    sample: plan.filter((p) => p.action === 'INSERT' || p.action === 'UPDATE').slice(0, 8).map((p) => (kind === 'products'
      ? { row: p.rec._row, action: p.action, party: p.rec.category || '', ref: p.rec.sku, product: p.rec.name, productBasis: null, sku: p.rec.sku, productNameInFile: p.rec.name, quantity: p.rec.onHand ?? (p.product ? fromMicro(toMicro(p.product.current_stock) ?? 0n) : null), outstanding: null, received: null, price: p.rec.price, currency: null, dueDate: null, status: p.rec.unit }
      : { row: p.rec._row, action: p.action, party: p.finished.name, ref: p.finished.sku, product: p.component.name, productBasis: null, sku: p.component.sku, productNameInFile: p.rec.com.name, quantity: p.rec.qty, outstanding: null, received: null, price: null, currency: null, dueDate: null, status: null })),
    notInThisFile: 0,
  };
}

async function buildPlan(db, userId, kind, norm, { lock = false } = {}) {
  const products = await loadProducts(db, userId, { lock });
  if (kind === 'products') return planProducts(norm.records, products);
  const links = (await db.query('SELECT id, finished_product_id, component_product_id, quantity_per_unit::text AS quantity_per_unit FROM product_components WHERE user_id = $1', [userId])).rows;
  return planComponents(norm.records, products, links);
}

async function previewMasterData(pool, userId, kind, file, buffer, filename, mappingInput) {
  const proposal = op.proposeMapping(kind, file.headers, file.rows);
  const suggestedInput = {
    mapping: Object.fromEntries(Object.entries(proposal.fields).map(([f, m]) => [f, m.header])),
    dateOrders: {}, sourceSystem: '', currency: null, reviewChoices: {},
  };
  const input = mappingInput || suggestedInput;
  const v = op.validateMapping(kind, file.headers, input, file.rows);
  const fileHash = op.hashBytes(buffer);
  const prior = (await pool.query(
    `SELECT id, filename, completed_at FROM file_import_batches WHERE user_id = $1 AND source_system = $2 AND status = 'COMPLETED' AND file_content_hash LIKE $3 ORDER BY completed_at DESC LIMIT 1`,
    [userId, `ops_import:${kind}`, `${fileHash}%`]
  )).rows[0] || null;
  let summary = null;
  if (v.ok) {
    const norm = normalizeMaster(kind, file.headers, file.rows, v);
    const { plan, extraRejected } = await buildPlan(pool, userId, kind, norm);
    summary = summarizeMaster(kind, plan, norm, extraRejected, file.rows.length);
  }
  return {
    ok: true,
    kind,
    file: { name: filename, type: file.fileType, sheet: file.sheet, rows: file.rows.length, columns: file.headers, sampleRows: file.rows.slice(0, 5), hash: fileHash },
    alreadyImported: prior ? { batchId: prior.id, filename: prior.filename, at: prior.completed_at } : null,
    proposal,
    suggestedInput,
    tenant: { hasTallyStock: false, hasTallyPurchases: false },
    mappingErrors: v.ok ? [] : v.errors,
    summary,
  };
}

async function commitMasterData(pool, userId, kind, file, buffer, filename, mappingInput, { correlationId = null } = {}) {
  const v = op.validateMapping(kind, file.headers, mappingInput || {}, file.rows);
  if (!v.ok) return { ok: false, status: 400, error: 'The column choices need attention before importing.', errors: v.errors };
  const fileHash = op.hashBytes(buffer);
  const batchHash = `${fileHash}:${op.sha(JSON.stringify([kind, v.fields, op.keyOf(v.sourceSystem)])).slice(0, 16)}`;
  const norm = normalizeMaster(kind, file.headers, file.rows, v);
  const sourceTag = `ops_import:${kind}`;
  const profile = `${kind}:${v.sourceSystem}`.slice(0, 120);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ops_import:${userId}`]);
    const prior = (await client.query('SELECT id, status, completed_at FROM file_import_batches WHERE user_id = $1 AND file_content_hash = $2 FOR UPDATE', [userId, batchHash])).rows[0];
    if (prior && prior.status === 'COMPLETED') {
      await client.query('ROLLBACK');
      return { ok: true, alreadyImported: true, batchId: prior.id, importedAt: prior.completed_at, summary: null };
    }
    const batch = prior || (await client.query(
      `INSERT INTO file_import_batches (user_id, source_system, filename, file_type, file_content_hash, mapping_profile, status, rows_total)
       VALUES ($1,$2,$3,$4,$5,$6,'STARTED',$7) RETURNING id`,
      [userId, sourceTag, String(filename).slice(0, 200), file.fileType, batchHash, profile, file.rows.length]
    )).rows[0];

    // Planned under row locks on the tenant's products, so a receipt or a
    // reconcile cannot add a movement between "no movements" and the write.
    const { plan, extraRejected } = await buildPlan(client, userId, kind, norm, { lock: true });
    const entities = { productsCreated: 0, productsUpdated: 0, openingStockRecorded: 0, componentLinks: 0 };
    const note = `Opening stock from import of ${String(filename).slice(0, 120)}`;

    for (const p of plan) {
      if (kind === 'products') {
        if (p.action === 'INSERT') {
          const row = (await client.query(
            `INSERT INTO products (user_id, name, sku, unit, unit_price, category, current_stock) VALUES ($1,$2,$3,COALESCE($4,'unit'),$5,$6,$7) RETURNING id, current_stock`,
            [userId, p.rec.name, p.rec.sku, p.rec.unit, p.rec.price, p.rec.category, p.rec.onHand]
          )).rows[0];
          entities.productsCreated++;
          for (const o of planOpeningMovements(userId, [row], [])) {
            await client.query('INSERT INTO stock_movements (user_id, product_id, movement_type, quantity, reference, notes) VALUES ($1,$2,$3,$4,$5,$6)', [userId, row.id, o.movement_type, fromMicro(toMicro(String(o.quantity))), o.reference, note]);
            entities.openingStockRecorded++;
          }
        } else if (p.action === 'UPDATE') {
          await client.query(
            `UPDATE products SET name = $3, sku = COALESCE(sku, $4), unit = COALESCE($5, unit), unit_price = COALESCE($6, unit_price), category = COALESCE($7, category),
                    current_stock = CASE WHEN $8::boolean THEN $9::numeric ELSE current_stock END, updated_at = NOW()
              WHERE id = $1 AND user_id = $2`,
            [p.product.id, userId, p.rec.name, p.rec.sku, p.rec.unit, p.rec.price, p.rec.category, p.setStock, p.rec.onHand]
          );
          entities.productsUpdated++;
          if (p.setStock) {
            for (const o of planOpeningMovements(userId, [{ id: p.product.id, current_stock: p.rec.onHand }], [])) {
              await client.query('INSERT INTO stock_movements (user_id, product_id, movement_type, quantity, reference, notes) VALUES ($1,$2,$3,$4,$5,$6)', [userId, p.product.id, o.movement_type, fromMicro(toMicro(String(o.quantity))), o.reference, note]);
              entities.openingStockRecorded++;
            }
          }
        }
      } else if (p.action === 'INSERT') {
        await client.query(
          `INSERT INTO product_components (user_id, finished_product_id, component_product_id, quantity_per_unit) VALUES ($1,$2,$3,$4)
           ON CONFLICT (user_id, finished_product_id, component_product_id) DO UPDATE SET quantity_per_unit = EXCLUDED.quantity_per_unit`,
          [userId, p.finished.id, p.component.id, p.rec.qty]
        );
        entities.componentLinks++;
      } else if (p.action === 'UPDATE') {
        await client.query('UPDATE product_components SET quantity_per_unit = $3 WHERE id = $1 AND user_id = $2', [p.existing.id, userId, p.rec.qty]);
        entities.componentLinks++;
      }
    }

    const summary = summarizeMaster(kind, plan, norm, extraRejected, file.rows.length);
    summary.entities = entities;
    await client.query(
      `UPDATE file_import_batches SET status = 'COMPLETED', completed_at = NOW(), rows_total = $2, rows_accepted = $3, rows_rejected = $4,
              rows_review_required = 0, rows_duplicate = $5, entities_created = $6, entities_matched = $7, error_message = NULL
        WHERE id = $1`,
      [batch.id, file.rows.length, summary.counts.accepted, summary.counts.rejected, summary.counts.duplicateRows, summary.counts.new, summary.counts.accepted - summary.counts.new]
    );
    await appendEvent(client, {
      userId, decisionId: null, type: 'OPERATIONS_IMPORTED', actor: humanActor(userId), correlationId,
      payload: { batchId: batch.id, kind, sourceSystem: v.sourceSystem, filename: String(filename).slice(0, 200), fileHash, counts: summary.counts, entities },
    });
    await client.query('COMMIT');
    return { ok: true, alreadyImported: false, batchId: batch.id, summary };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await pool.query(
      `INSERT INTO file_import_batches (user_id, source_system, filename, file_type, file_content_hash, mapping_profile, status, rows_total, error_message, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,'FAILED',$7,$8,NOW())
       ON CONFLICT (user_id, file_content_hash) DO UPDATE SET status = 'FAILED', error_message = EXCLUDED.error_message, completed_at = NOW()`,
      [userId, sourceTag, String(filename).slice(0, 200), file.fileType, batchHash, profile, file.rows.length, String(err.message || err).slice(0, 500)]
    ).catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { previewMasterData, commitMasterData, normalizeMaster, planProducts, planComponents, LABEL };
