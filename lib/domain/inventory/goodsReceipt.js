'use strict';
// FILE: lib/domain/inventory/goodsReceipt.js
// Recording that goods arrived against an inbound purchase line.
//
// Inventory integrity rules this module enforces, all inside ONE database
// transaction that holds a row lock on the purchase line (and the product):
//
//   1. A receipt never takes a line past what is still outstanding. Receiving
//      more than was ordered, or undoing a mistaken receipt, is a CORRECTION:
//      a separate kind that needs a written reason and is shown as such in the
//      history. Corrections never take the received total below zero.
//   2. The same receipt is never recorded twice. Every request carries a
//      client-generated idempotency key (unique per tenant in the database).
//      A retry with the same key and the same content returns the original
//      receipt; the same key with different content is refused.
//   3. Stock moves exactly once, in the same transaction, and only when
//      Starlane is the stock book for the line (stock_follows = 'STARLANE').
//      For lines whose stock an accounting system books (EXTERNAL, e.g. Tally
//      purchase vouchers), a receipt reduces what is outstanding and posts no
//      movement, so goods are not counted twice.
//   4. The stock movement carries the line's PLI-<lineId> reference, the same
//      one the reconcile uses (stockLedger.planPurchaseReceipts), so the
//      reconcile sees the units as already booked and never adds them again.
//   5. Stock that predates the ledger is recorded as an OPENING movement
//      before the receipt, so the reconcile recount keeps it.
//   6. Purchase amounts, bills, payments and vouchers are never touched.
//
// The tenant always comes from the caller (the verified JWT); a line that
// belongs to another tenant is "not found".

const crypto = require('crypto');
const { lineReceiptReference, planOpeningMovements } = require('./stockLedger');
const { toMicro, fromMicro } = require('../operations/decimal');
const { appendEvent, humanActor } = require('../decisions/store');
const { pgDateDay } = require('../decisions/dates');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[A-Za-z0-9_.:-]{8,200}$/;
const DAY_MS = 86400000;

function fail(status, error, extra = {}) {
  return { ok: false, status, body: { error, ...extra } };
}

/** Validates the request body. Returns { ok, value } or a failure. Pure. */
function validateReceiptInput(input, { now = Date.now() } = {}) {
  const b = input || {};
  const kind = b.kind == null ? 'RECEIPT' : String(b.kind).toUpperCase();
  if (kind !== 'RECEIPT' && kind !== 'CORRECTION') return fail(400, 'kind must be RECEIPT or CORRECTION');
  const key = String(b.idempotencyKey || '');
  if (!KEY_RE.test(key)) return fail(400, 'idempotencyKey must be 8-200 characters (letters, digits, _ . : -). Generate one per receipt and reuse it on retries.');
  const qtyMicro = typeof b.quantity === 'string' || typeof b.quantity === 'number' ? toMicro(String(b.quantity).trim()) : null;
  if (qtyMicro == null) return fail(400, 'quantity must be a number with at most 6 decimal places');
  if (kind === 'RECEIPT' && qtyMicro <= 0n) return fail(400, 'A receipt quantity must be more than 0. To undo a receipt, record a correction.');
  if (kind === 'CORRECTION' && qtyMicro === 0n) return fail(400, 'A correction quantity cannot be 0');
  const day = String(b.receivedOn || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
    return fail(400, 'receivedOn must be a date (YYYY-MM-DD)');
  }
  const t = Date.parse(`${day}T00:00:00Z`);
  // One day of slack: the owner's local "today" can be UTC tomorrow.
  if (t > now + DAY_MS) return fail(400, 'receivedOn cannot be in the future');
  if (t < Date.parse('2000-01-01T00:00:00Z')) return fail(400, 'receivedOn is too far in the past');
  const reference = b.reference == null || b.reference === '' ? null : String(b.reference).trim().slice(0, 120) || null;
  const notes = b.notes == null || b.notes === '' ? null : String(b.notes).trim().slice(0, 1000) || null;
  if (kind === 'CORRECTION' && (!notes || notes.length < 3)) return fail(400, 'A correction needs a reason in notes (what was wrong and why it is being corrected)');
  return { ok: true, value: { kind, idempotencyKey: key, qtyMicro, quantity: fromMicro(qtyMicro), receivedOn: day, reference, notes } };
}

function requestHash(lineId, v) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([String(lineId).toLowerCase(), v.kind, v.quantity, v.receivedOn, v.reference, v.notes]))
    .digest('hex');
}

function publicReceipt(r) {
  if (!r) return null;
  return {
    id: r.id,
    purchaseLineId: r.purchase_line_id,
    kind: r.kind,
    quantity: fromMicro(toMicro(r.quantity)),
    receivedOn: pgDateDay(r.received_on),
    reference: r.reference,
    notes: r.notes,
    stockPosted: r.stock_posted,
    stockMovementId: r.stock_movement_id,
    receivedBefore: fromMicro(toMicro(r.received_before)),
    receivedAfter: fromMicro(toMicro(r.received_after)),
    orderedQuantity: fromMicro(toMicro(r.ordered_quantity)),
    recordedAt: r.created_at,
  };
}

function lineSummary(line) {
  const ordered = toMicro(line.quantity) ?? 0n;
  const received = toMicro(line.received_quantity) ?? 0n;
  const outstanding = ordered - received;
  return {
    id: line.id,
    orderedQuantity: fromMicro(ordered),
    receivedQuantity: fromMicro(received),
    outstandingQuantity: fromMicro(outstanding > 0n ? outstanding : 0n),
    overReceived: received > ordered ? fromMicro(received - ordered) : null,
    stockFollows: line.stock_follows || 'STARLANE',
    productId: line.product_id || null,
    lineStatus: line.line_status || null,
  };
}

/**
 * Records one receipt or correction. Returns { ok, status, body }.
 * body on success: { receipt, line, duplicate, stock: { posted, reason } }.
 */
async function recordReceipt(pool, userId, lineId, input, { correlationId = null, now = Date.now() } = {}) {
  if (!userId) throw new Error('recordReceipt: userId is required');
  if (!UUID_RE.test(String(lineId || ''))) return fail(404, 'Purchase line not found');
  const parsed = validateReceiptInput(input, { now });
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  const hash = requestHash(lineId, v);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lineRes = await client.query(
      `SELECT pli.*, pu.bill_number, pu.supplier_name, pu.external_ref AS purchase_ref
         FROM purchase_line_items pli
         JOIN purchases pu ON pu.id = pli.purchase_id AND pu.user_id = pli.user_id
        WHERE pli.id = $1 AND pli.user_id = $2
        FOR UPDATE OF pli`,
      [lineId, userId]
    );
    const line = lineRes.rows[0];
    if (!line) { await client.query('ROLLBACK'); return fail(404, 'Purchase line not found'); }

    const prior = await client.query(
      'SELECT * FROM purchase_line_receipts WHERE user_id = $1 AND idempotency_key = $2',
      [userId, v.idempotencyKey]
    );
    if (prior.rows[0]) {
      await client.query('ROLLBACK');
      const p = prior.rows[0];
      if (p.request_hash === hash && String(p.purchase_line_id) === String(line.id)) {
        const fresh = await pool.query('SELECT * FROM purchase_line_items WHERE id = $1 AND user_id = $2', [line.id, userId]);
        return { ok: true, status: 200, body: { duplicate: true, receipt: publicReceipt(p), line: lineSummary(fresh.rows[0]), stock: { posted: p.stock_posted, reason: null } } };
      }
      return fail(409, 'This idempotency key was already used for a different receipt. Generate a new key for a new receipt.');
    }

    if (line.line_status === 'cancelled') { await client.query('ROLLBACK'); return fail(409, 'This purchase line is cancelled; goods cannot be received against it.'); }

    const ordered = toMicro(line.quantity);
    if (ordered == null || ordered <= 0n) { await client.query('ROLLBACK'); return fail(409, 'This purchase line has no ordered quantity on record, so a receipt cannot be checked against it.'); }
    const received = toMicro(line.received_quantity) ?? 0n;
    const outstanding = ordered - received;
    const after = received + v.qtyMicro;

    if (v.kind === 'RECEIPT' && v.qtyMicro > outstanding) {
      await client.query('ROLLBACK');
      return fail(409, outstanding > 0n
        ? `Only ${fromMicro(outstanding)} ${outstanding === ONE_UNIT ? 'unit is' : 'units are'} outstanding on this line. To record more than was ordered, record a correction with a reason.`
        : 'Nothing is outstanding on this line. To record more than was ordered, record a correction with a reason.',
      { outstandingQuantity: fromMicro(outstanding > 0n ? outstanding : 0n) });
    }
    if (after < 0n) {
      await client.query('ROLLBACK');
      return fail(409, `A correction of ${v.quantity} would take the received total below zero (${fromMicro(received)} received so far).`, { receivedQuantity: fromMicro(received) });
    }

    // Stock: only when Starlane books it and the line is linked to a product.
    let stockPosted = false;
    let stockReason = null;
    let movementId = null;
    const follows = String(line.stock_follows || 'STARLANE').toUpperCase();
    if (!line.product_id) stockReason = 'The line is not linked to a product, so stock was not changed.';
    else if (follows === 'EXTERNAL') stockReason = 'Stock for this line is booked by your accounting system (for example when the Tally purchase voucher syncs), so Starlane did not change stock.';
    else {
      const prod = (await client.query(
        'SELECT id, name, current_stock FROM products WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [line.product_id, userId]
      )).rows[0];
      if (!prod) {
        stockReason = 'The linked product no longer exists, so stock was not changed.';
      } else {
        const stockNow = toMicro(prod.current_stock ?? 0) ?? 0n;
        if (stockNow + v.qtyMicro < 0n) {
          await client.query('ROLLBACK');
          return fail(409, `Stock of ${prod.name} is ${fromMicro(stockNow)}; removing ${fromMicro(-v.qtyMicro)} would make it negative. Correct the stock first.`);
        }
        const anyMove = await client.query('SELECT 1 FROM stock_movements WHERE user_id = $1 AND product_id = $2 LIMIT 1', [userId, prod.id]);
        if (!anyMove.rows.length) {
          for (const o of planOpeningMovements(userId, [prod], [])) {
            await client.query(
              `INSERT INTO stock_movements (user_id, product_id, movement_type, quantity, reference, notes) VALUES ($1,$2,$3,$4,$5,$6)`,
              [o.user_id, o.product_id, o.movement_type, fromMicro(toMicro(o.quantity)), o.reference, o.notes]
            );
          }
        }
        const abs = v.qtyMicro < 0n ? -v.qtyMicro : v.qtyMicro;
        const mv = await client.query(
          `INSERT INTO stock_movements (user_id, product_id, movement_type, quantity, unit_cost, reference, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [userId, prod.id, v.qtyMicro > 0n ? 'in' : 'out', fromMicro(abs), line.unit_price ?? null, lineReceiptReference(line.id),
            `${v.kind === 'CORRECTION' ? 'Receipt correction' : 'Goods received'} on ${line.purchase_ref || line.bill_number || `purchase ${line.purchase_id}`}${v.reference ? ` (${v.reference})` : ''}`.slice(0, 300)]
        );
        movementId = mv.rows[0].id;
        await client.query(
          'UPDATE products SET current_stock = COALESCE(current_stock, 0) + $3::numeric, updated_at = NOW() WHERE id = $1 AND user_id = $2',
          [prod.id, userId, v.quantity]
        );
        stockPosted = true;
      }
    }

    const ins = await client.query(
      `INSERT INTO purchase_line_receipts
         (user_id, purchase_line_id, kind, quantity, received_on, reference, notes, idempotency_key, request_hash,
          stock_posted, stock_movement_id, received_before, received_after, ordered_quantity, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$1)
       RETURNING *`,
      [userId, line.id, v.kind, v.quantity, v.receivedOn, v.reference, v.notes, v.idempotencyKey, hash,
        stockPosted, movementId, fromMicro(received), fromMicro(after), fromMicro(ordered)]
    );
    const updated = await client.query(
      `UPDATE purchase_line_items
          SET received_quantity = $3::numeric,
              received_at = CASE WHEN $4::numeric > 0 THEN GREATEST(COALESCE(received_at, $5::date), $5::date) ELSE received_at END
        WHERE id = $1 AND user_id = $2
        RETURNING *`,
      [line.id, userId, fromMicro(after), v.quantity, v.receivedOn]
    );
    await appendEvent(client, {
      userId, decisionId: null, type: v.kind === 'CORRECTION' ? 'GOODS_RECEIPT_CORRECTED' : 'GOODS_RECEIPT_RECORDED', actor: humanActor(userId), correlationId,
      payload: {
        purchaseLineItemId: line.id, receiptId: ins.rows[0].id, quantity: v.quantity, receivedOn: v.receivedOn, reference: v.reference,
        receivedBefore: fromMicro(received), receivedAfter: fromMicro(after), orderedQuantity: fromMicro(ordered),
        stockPosted, stockMovementId: movementId, stockFollows: follows,
      },
    });
    await client.query('COMMIT');
    return {
      ok: true,
      status: 201,
      body: { duplicate: false, receipt: publicReceipt(ins.rows[0]), line: lineSummary(updated.rows[0]), stock: { posted: stockPosted, reason: stockReason } },
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Two requests with the same key racing on different lines: the unique
    // index stops the second. Report it the same way as a sequential retry.
    if (err && err.code === '23505' && /idem/.test(String(err.constraint || err.message))) {
      const p = (await pool.query('SELECT * FROM purchase_line_receipts WHERE user_id = $1 AND idempotency_key = $2', [userId, v.idempotencyKey])).rows[0];
      if (p && p.request_hash === hash) {
        const fresh = await pool.query('SELECT * FROM purchase_line_items WHERE id = $1 AND user_id = $2', [p.purchase_line_id, userId]);
        return { ok: true, status: 200, body: { duplicate: true, receipt: publicReceipt(p), line: lineSummary(fresh.rows[0]), stock: { posted: p.stock_posted, reason: null } } };
      }
      return fail(409, 'This idempotency key was already used for a different receipt. Generate a new key for a new receipt.');
    }
    throw err;
  } finally {
    client.release();
  }
}

const ONE_UNIT = 1000000n;

/** A line with its receipt history, newest last. Tenant-scoped. */
async function listReceipts(pool, userId, lineId) {
  if (!UUID_RE.test(String(lineId || ''))) return null;
  const line = (await pool.query(
    `SELECT pli.*, pu.supplier_name, pu.bill_number, pu.external_ref AS purchase_ref, p.name AS product_name, p.sku
       FROM purchase_line_items pli
       JOIN purchases pu ON pu.id = pli.purchase_id AND pu.user_id = pli.user_id
       LEFT JOIN products p ON p.id = pli.product_id AND p.user_id = pli.user_id
      WHERE pli.id = $1 AND pli.user_id = $2`,
    [lineId, userId]
  )).rows[0];
  if (!line) return null;
  const receipts = (await pool.query(
    'SELECT * FROM purchase_line_receipts WHERE user_id = $1 AND purchase_line_id = $2 ORDER BY created_at, id',
    [userId, lineId]
  )).rows;
  return {
    line: {
      ...lineSummary(line),
      productName: line.product_name || line.product_name_as_imported || null,
      sku: line.sku || line.sku_as_imported || null,
      supplierName: line.supplier_name,
      purchaseRef: line.purchase_ref || line.bill_number || null,
      receivedBeforeTracking: fromMicro(toMicro(line.received_before_tracking ?? 0) ?? 0n),
    },
    receipts: receipts.map(publicReceipt),
  };
}

/**
 * Books, exactly once, received units on tracked lines that have no stock
 * movement yet (e.g. received_quantity written by an older code path). Each
 * line is re-read under its row lock, the same lock recordReceipt takes, so a
 * receipt committing at the same moment can never be booked twice. Used by
 * the reconcile instead of inserting the planned movements blindly.
 * Returns the number of movements written.
 */
async function bookUnpostedLineReceipts(pool, userId, lineIds) {
  let written = 0;
  for (const lineId of [...new Set((lineIds || []).map(String))]) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const l = (await client.query(
        `SELECT pli.id, pli.product_id, pli.unit_price, pli.stock_follows, pu.bill_number, pu.id AS purchase_id,
                COALESCE(pli.received_quantity, 0) - COALESCE(pli.received_before_tracking, 0) AS should_be_booked
           FROM purchase_line_items pli JOIN purchases pu ON pu.id = pli.purchase_id AND pu.user_id = pli.user_id
          WHERE pli.id = $1 AND pli.user_id = $2 FOR UPDATE OF pli`,
        [lineId, userId]
      )).rows[0];
      if (!l || !l.product_id || String(l.stock_follows || 'STARLANE').toUpperCase() === 'EXTERNAL') { await client.query('ROLLBACK'); continue; }
      const ref = lineReceiptReference(l.id);
      const booked = (await client.query(
        `SELECT COALESCE(SUM(CASE WHEN movement_type = 'in' THEN quantity ELSE -quantity END), 0) AS q
           FROM stock_movements WHERE user_id = $1 AND reference = $2`,
        [userId, ref]
      )).rows[0].q;
      const delta = (toMicro(l.should_be_booked) ?? 0n) - (toMicro(booked) ?? 0n);
      if (delta > 0n) {
        await client.query(
          `INSERT INTO stock_movements (user_id, product_id, movement_type, quantity, unit_cost, reference, notes) VALUES ($1,$2,'in',$3,$4,$5,$6)`,
          [userId, l.product_id, fromMicro(delta), l.unit_price ?? null, ref, `Received on purchase ${l.bill_number || l.purchase_id}`]
        );
        written++;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return written;
}

module.exports = { recordReceipt, listReceipts, bookUnpostedLineReceipts, validateReceiptInput, lineSummary };
