// FILE: lib/domain/decisions/detectors/supplierDelay.js
// Supplier delay -> customer commitments at risk -> a Decision.
//
// Input is the tenant's own operating data: open purchase lines (with the
// expected date the business relied on and the date the supplier now gives),
// stock on hand, the bill of materials, and open customer order lines with
// their promised dates. For each delayed purchase line it plans fulfilment
// twice (commitments.js) and turns the orders that the delay pushed past
// their promised date into one decision with:
//   - evidence for every claim, labelled observed / calculated / assumption
//   - "do nothing" and "tell the affected customers" options
//   - per-customer message drafts frozen into the option's intent, so the
//     owner approves exactly what would be prepared. Preparing them creates
//     pending ai_actions; nothing is sent by this module or on approval of
//     the decision (external sending has its own approval and flag).
//
// Deterministic code, no language model: every number is a function of
// rows read here, and every message is a fixed template.

const { ENGINE_VERSION, DEFINITIONS_VERSION } = require('../definitions');
const { toIsoDate, startOfUtcDay, pgDateDay } = require('../dates');
const { fmtMoney } = require('./receivables');
const { assessSupplierDelay, daysBetween } = require('../commitments');

const DELAY_MODEL_VERSION = 'commitment-plan@1';
// Dispatched orders have left the building: their goods no longer draw on
// stock or inbound supply.
const OPEN_ORDER_EXCLUDED = ['delivered', 'cancelled', 'canceled', 'completed', 'closed', 'dispatched'];
// Purchase lines that will deliver nothing more.
const CLOSED_LINE = ['closed', 'cancelled'];

function fmtDay(day) {
  if (!day) return 'a date not yet known';
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// Fixed template. Does not name the supplier to the customer, does not
// promise a date Starlane cannot see, and says what the business will do.
function customerUpdateMessage({ customerName, orderRef, productName, neededBy, revisedDate }) {
  const when = revisedDate
    ? `We now expect it to be ready on ${fmtDay(revisedDate)}, instead of ${fmtDay(neededBy)}.`
    : `It will not be ready by ${fmtDay(neededBy)}, and we do not yet have a confirmed new date.`;
  return `Dear ${customerName || 'Customer'}, a delay at one of our suppliers affects your order ${orderRef}${productName ? ` (${productName})` : ''}. ${when} We will confirm as soon as the goods are in. We are sorry for the inconvenience.`;
}

async function loadOperatingData(pool, userId, { baseCurrency = null } = {}) {
  const [delayed, inboundAll, stock, bom, orders] = await Promise.all([
    pool.query(
      `SELECT pli.id, pli.product_id, pli.quantity, pli.received_quantity, pli.expected_at, pli.original_expected_at,
              pli.delay_reason, pli.delay_reported_at, pli.purchase_id,
              pu.supplier_name, pu.bill_number, p.name AS product_name, p.sku
       FROM purchase_line_items pli
       JOIN purchases pu ON pu.id = pli.purchase_id AND pu.user_id = pli.user_id
       LEFT JOIN products p ON p.id = pli.product_id AND p.user_id = pli.user_id
       WHERE pli.user_id = $1 AND pli.original_expected_at IS NOT NULL AND pli.expected_at > pli.original_expected_at
         AND pli.product_id IS NOT NULL AND COALESCE(pli.received_quantity, 0) < pli.quantity
         AND COALESCE(pli.line_status, 'open') <> ALL($2)
       ORDER BY pli.delay_reported_at DESC NULLS LAST
       LIMIT 50`,
      [userId, CLOSED_LINE]
    ),
    pool.query(
      `SELECT id, product_id, quantity, received_quantity, expected_at FROM purchase_line_items
       WHERE user_id = $1 AND product_id IS NOT NULL AND COALESCE(received_quantity, 0) < quantity
         AND COALESCE(line_status, 'open') <> ALL($2)`,
      [userId, CLOSED_LINE]
    ),
    pool.query('SELECT id, name, sku, current_stock FROM products WHERE user_id = $1', [userId]),
    pool.query('SELECT finished_product_id, component_product_id, quantity_per_unit FROM product_components WHERE user_id = $1', [userId]),
    pool.query(
      `SELECT oli.id AS order_line_id, oli.order_id, oli.product_id, oli.quantity, oli.outstanding_quantity, oli.unit_price, oli.needed_by,
              oli.currency, oli.source_system, oli.external_ref AS line_ref, o.external_ref AS order_ref,
              o.customer_name, o.status, c.id AS customer_id
       FROM order_line_items oli
       JOIN orders o ON o.id = oli.order_id AND o.user_id = oli.user_id
       LEFT JOIN LATERAL (
         SELECT id FROM customers WHERE user_id = oli.user_id AND lower(trim(name)) = lower(trim(o.customer_name)) ORDER BY created_at LIMIT 1
       ) c ON TRUE
       WHERE oli.user_id = $1 AND lower(COALESCE(o.status, '')) <> ALL($2)
         AND lower(COALESCE(oli.line_status, '')) <> ALL($2)
         AND COALESCE(oli.outstanding_quantity, oli.quantity) > 0`,
      [userId, OPEN_ORDER_EXCLUDED]
    ),
  ]);
  const products = new Map(stock.rows.map((p) => [String(p.id), p]));
  // An inbound line with no expected date is not counted as supply: Starlane
  // cannot say when it arrives. The decision says how many were left out.
  const inbound = { rows: inboundAll.rows.filter((r) => r.expected_at != null) };
  const inboundUndated = inboundAll.rows.length - inbound.rows.length;
  // Money is only summed in one currency. A line priced in another currency,
  // or an imported line whose currency the file did not give, keeps its
  // quantity in the plan but is left out of value totals.
  const valueOf = (r) => {
    if (r.unit_price == null) return null;
    const cur = r.currency ? String(r.currency).toUpperCase() : null;
    if (cur && baseCurrency && cur !== baseCurrency) return null;
    if (!cur && r.source_system) return null;
    return Number(r.unit_price);
  };
  const orderRefs = new Map(orders.rows.map((r) => [String(r.order_id), r.order_ref || null]));
  return {
    delayed: delayed.rows,
    inboundUndated,
    assumedFullQuantity: orders.rows.filter((r) => r.outstanding_quantity == null && r.source_system).length,
    orderRefs,
    inbound: inbound.rows.map((r) => ({ purchaseLineId: String(r.id), productId: String(r.product_id), quantity: Number(r.quantity), receivedQuantity: Number(r.received_quantity || 0), expectedAt: r.expected_at })),
    stock: stock.rows.filter((p) => p.current_stock != null).map((p) => ({ productId: String(p.id), onHand: Number(p.current_stock) })),
    bom: bom.rows.map((r) => ({ finished_product_id: String(r.finished_product_id), component_product_id: String(r.component_product_id), quantity_per_unit: Number(r.quantity_per_unit) })),
    orderLines: orders.rows.map((r) => ({
      orderId: String(r.order_id), orderLineId: String(r.order_line_id), productId: r.product_id ? String(r.product_id) : null,
      productName: r.product_id ? products.get(String(r.product_id))?.name || null : null,
      // What is still to deliver: the source's outstanding quantity when it
      // gave one, else the ordered quantity (counted in assumedFullQuantity).
      quantity: Number(r.outstanding_quantity ?? r.quantity), unitPrice: valueOf(r), neededBy: pgDateDay(r.needed_by),
      customerName: r.customer_name, customerId: r.customer_id || null,
    })),
    products,
    stockMissing: stock.rows.filter((p) => p.current_stock == null).map((p) => p.name),
  };
}

// The customer's own order number when the order was imported, else a
// short form of Starlane's id.
function orderRef(orderId, data) {
  const ext = data && data.orderRefs ? data.orderRefs.get(String(orderId)) : null;
  return ext ? `#${ext}` : `#${String(orderId).slice(0, 8)}`;
}

function assessLine(data, row, asOfDay) {
  return assessSupplierDelay({
    asOfDay,
    delayedLine: { purchaseLineId: String(row.id), productId: String(row.product_id), quantity: Number(row.quantity), receivedQuantity: Number(row.received_quantity || 0), originalExpectedAt: row.original_expected_at, expectedAt: row.expected_at },
    orderLines: data.orderLines,
    stock: data.stock,
    inbound: data.inbound,
    bom: data.bom,
  });
}

function buildDraft(row, a, data, defs, asOfDay) {
  const cur = defs.base_currency;
  const supplier = row.supplier_name || 'the supplier';
  const item = row.product_name || 'an item';
  const remaining = Number(row.quantity) - Number(row.received_quantity || 0);
  const n = a.atRisk.length;
  const plural = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const customers = [...new Map(a.atRisk.map((l) => [l.customerName, l])).values()];

  const drafts = a.atRisk.map((l) => ({
    orderId: l.orderId,
    orderLineId: l.orderLineId,
    customerName: l.customerName,
    customerId: l.customerId,
    productName: l.productName,
    neededBy: l.neededBy,
    revisedDate: l.readyAt,
    message: customerUpdateMessage({ customerName: l.customerName, orderRef: orderRef(l.orderId, data), productName: l.productName, neededBy: l.neededBy, revisedDate: l.readyAt }),
  }));

  const src = (table, id, extra = {}) => ({ table, id: id == null ? null : String(id), ...extra });
  const evidence = [
    { kind: 'OBSERVED_FACT', label: 'Delayed shipment', detail: `${remaining} × ${item} from ${supplier}${row.bill_number ? ` (bill ${row.bill_number})` : ''}: expected ${fmtDay(a.originalExpectedAt)}, now ${fmtDay(a.expectedAt)} (${plural(a.delayDays, 'day')} later)${row.delay_reason ? `. Reason given: ${row.delay_reason}` : ''}`, source: src('purchase_line_items', row.id), confidence: 'HIGH' },
    { kind: 'OBSERVED_FACT', label: 'Stock on hand', detail: `${item}: ${data.products.get(String(row.product_id))?.current_stock ?? 'not recorded'} on hand`, source: src('products', row.product_id), confidence: 'HIGH' },
    ...a.atRisk.map((l) => ({
      kind: 'CALCULATED_FACT',
      label: `Order ${orderRef(l.orderId, data)} — ${l.customerName}`,
      detail: `${l.quantity} × ${l.productName || 'item'} promised for ${fmtDay(l.neededBy)}. With the shipment on its original date it would be ready ${fmtDay(l.plannedReadyAt)}; now ${l.readyAt ? `${fmtDay(l.readyAt)}, ${plural(l.slipDays, 'day')} late` : 'no stock or inbound supply on record covers it'}. Needs ${l.dependsOnDelayedShipment} unit(s) from this shipment.`,
      source: src('order_line_items', l.orderLineId, { orderId: l.orderId, model: DELAY_MODEL_VERSION }),
      confidence: 'HIGH',
    })),
    ...(a.alreadyAtRisk.length ? [{ kind: 'CALCULATED_FACT', label: 'Already at risk before this delay', detail: `${plural(a.alreadyAtRisk.length, 'order')} (${a.alreadyAtRisk.map((l) => `${orderRef(l.orderId, data)} ${l.customerName}`).join(', ')}) could not be met on time even with the shipment on its original date; not caused by this delay.`, source: src('order_line_items', null, { model: DELAY_MODEL_VERSION }), confidence: 'HIGH' }] : []),
    { kind: 'CALCULATED_FACT', label: 'Orders unaffected', detail: `${plural(a.unaffected.length, 'open order line')} stay on time.`, source: src('order_line_items', null, { model: DELAY_MODEL_VERSION }), confidence: 'HIGH' },
    ...(data.assumedFullQuantity ? [{ kind: 'ASSUMPTION', label: 'Outstanding quantity not reported', detail: `${plural(data.assumedFullQuantity, 'imported open order line')} did not say how much is still to deliver, so the full ordered quantity is assumed outstanding. If part has already been delivered, fewer orders may be late.`, source: src('order_line_items', null), confidence: 'MEDIUM' }] : []),
    ...(data.inboundUndated ? [{ kind: 'UNKNOWN', label: 'Inbound goods with no expected date', detail: `${plural(data.inboundUndated, 'open purchase line')} have no expected date and are not counted as supply. If any of them arrive in time, fewer orders may be late.`, source: src('purchase_line_items', null), confidence: 'UNKNOWN' }] : []),
    ...(a.valueExcluded ? [{ kind: 'UNKNOWN', label: 'Order value not counted', detail: `${plural(a.valueExcluded, 'at-risk order line')} have no price in ${cur}, so the value at risk leaves them out.`, source: src('order_line_items', null), confidence: 'UNKNOWN' }] : []),
    ...(a.unknown.length ? [{ kind: 'UNKNOWN', label: 'Orders Starlane cannot check', detail: `${plural(a.unknown.length, 'open order line')} have no promised date or product link, so they are not assessed.`, source: src('order_line_items', null), confidence: 'UNKNOWN' }] : []),
    { kind: 'ASSUMPTION', label: 'Allocation rule', detail: 'Stock and inbound goods go to the order with the earliest promised date first; an order that cannot be fully supplied reserves nothing.', source: src('model', null, { model: DELAY_MODEL_VERSION }), confidence: 'MEDIUM' },
    { kind: 'ASSUMPTION', label: 'Ready = goods in', detail: 'An order is counted ready the day its last needed item arrives. No production or delivery time is on record.', source: src('model', null, { model: DELAY_MODEL_VERSION }), confidence: 'MEDIUM' },
  ];

  const options = [
    {
      key: 'do_nothing',
      label: 'Keep current promises and wait',
      summary: `Say nothing for now. ${plural(n, 'order')} miss their promised date unless ${supplier} recovers.`,
      intent: { type: 'NONE' },
      isDoNothing: true,
      reversibility: 'HIGHLY_REVERSIBLE',
      blastRadius: { customers: 0, moneyTouched: 0, externalParties: 0, systemsTouched: [], summary: 'Nothing changes.' },
      approval: { required: false, approvers: 0 },
      valid: true,
      executableAs: 'no action',
      assumptions: [],
      futures: { ordersLate: n, valueAtRisk: a.valueAtRisk, customersToldInAdvance: 0 },
    },
    {
      key: 'notify_customers',
      label: `Prepare updates for ${plural(customers.length, 'affected customer')}`,
      summary: `Draft one message per affected order with the revised date. Drafts wait in Approvals; nothing is sent until you approve each one and external sending is switched on.`,
      intent: { type: 'PREPARE_CUSTOMER_UPDATE', purchaseLineItemId: String(row.id), drafts },
      isDoNothing: false,
      reversibility: 'REVERSIBLE_UNTIL_SENT',
      blastRadius: { customers: customers.length, moneyTouched: 0, externalParties: 0, systemsTouched: ['ai_actions'], summary: `${plural(drafts.length, 'draft message')} in Approvals. No message leaves Starlane at this step.` },
      approval: { required: true, approvers: 1, role: 'owner', reason: 'Owner approval required: prepares messages to customers.' },
      valid: true,
      executableAs: 'pending ai_actions (COMMITMENT_DELAY_NOTICE), each needing its own approval to send',
      assumptions: [{ key: 'template', label: 'Messages use a fixed template, not a language model', basis: 'FACT' }],
      futures: { ordersLate: n, valueAtRisk: a.valueAtRisk, customersToldInAdvance: customers.length },
    },
  ];

  const daysToFirst = a.earliestAtRiskNeededBy ? daysBetween(asOfDay, a.earliestAtRiskNeededBy) : 0;
  return {
    kind: 'SUPPLIER_DELAY',
    dedupKey: `delay:${row.id}`,
    title: `${supplier} is ${plural(a.delayDays, 'day')} late: tell ${plural(customers.length, 'customer')} about ${plural(n, 'order')} worth ${fmtMoney(a.valueAtRisk, cur)}?`,
    description: `${remaining} × ${item} from ${supplier} moved from ${fmtDay(a.originalExpectedAt)} to ${fmtDay(a.expectedAt)}. ${plural(n, 'open order')} that were on track now miss their promised date.`,
    currency: cur,
    affectedEntities: [
      { type: 'supplier', id: null, name: supplier },
      { type: 'purchase_line_item', id: String(row.id), name: `${remaining} × ${item}` },
      { type: 'product', id: String(row.product_id), name: item },
      ...a.atRisk.map((l) => ({ type: 'order', id: l.orderId, name: `${orderRef(l.orderId, data)} ${l.customerName}`, neededBy: l.neededBy, readyAt: l.readyAt, value: l.value })),
      ...customers.map((l) => ({ type: 'customer', id: l.customerId, name: l.customerName })),
    ],
    affectedProcesses: ['procure_to_pay', 'order_to_cash'],
    triggerSignals: [{ code: 'SUPPLIER_DELAY_REPORTED', label: `Expected date moved ${plural(a.delayDays, 'day')} later`, purchaseLineItemId: String(row.id), reportedAt: row.delay_reported_at }],
    whyNow: [
      `${supplier} now expects ${item} on ${fmtDay(a.expectedAt)} instead of ${fmtDay(a.originalExpectedAt)}`,
      `${plural(n, 'order')} worth ${fmtMoney(a.valueAtRisk, cur)} now miss their promised date`,
      a.earliestAtRiskNeededBy ? `The first is promised for ${fmtDay(a.earliestAtRiskNeededBy)} (${plural(Math.max(0, daysToFirst), 'day')} from now)` : 'Promised dates are not all on record',
    ],
    whatIfIgnored: `${plural(n, 'customer order')} arrive late without warning: ${a.atRisk.map((l) => `${l.customerName} ${l.readyAt ? `by ${plural(l.slipDays, 'day')}` : '(no date known)'}`).join(', ')}.`,
    window: {
      discoveredAt: new Date().toISOString(),
      usefulFrom: asOfDay,
      latestSafeAt: a.earliestAtRiskNeededBy,
      costOfDelayPerWeek: null,
      basis: a.earliestAtRiskNeededBy ? `Customers should hear before ${fmtDay(a.earliestAtRiskNeededBy)}, the first promised date that will be missed.` : 'No promised date on record.',
      timezone: defs.timezone,
    },
    objectives: [{ key: 'customer_trust', label: 'Keep customers informed before a promise is missed', weight: 1 }],
    constraints: [{ key: 'no_external_send', type: 'POLICY', hard: true, label: 'Messages are drafted only; sending needs a separate approval and external sending switched on', status: 'LIMITS_EXECUTION' }],
    options,
    doNothingKey: 'do_nothing',
    evidence,
    unknowns: [
      { key: 'partial_shipment', label: `Whether ${supplier} can send ${a.unitsNeededFromShipment} of the ${remaining} units by ${fmtDay(a.earliestAtRiskNeededBy)}`, status: 'UNKNOWN', valueOfInformation: null, acquisition: { type: 'REQUEST_INFORMATION', how: `Ask ${supplier} whether ${a.unitsNeededFromShipment} units can ship by ${fmtDay(a.earliestAtRiskNeededBy)}; that would keep these orders on time` } },
      { key: 'alternate_source', label: `Whether another supplier can provide ${item} sooner`, status: 'UNKNOWN', valueOfInformation: null, acquisition: { type: 'REQUEST_INFORMATION', how: 'No alternate source is on record for this item' } },
      { key: 'fulfilment_time', label: 'Production or delivery time after goods arrive', status: 'UNKNOWN', valueOfInformation: null, acquisition: { type: 'REQUEST_INFORMATION', how: 'Record lead time from goods-in to dispatch' } },
    ],
    assumptions: [
      { key: 'allocation', label: 'Earliest promised order is supplied first; unfillable orders reserve nothing', basis: 'ASSUMPTION' },
      { key: 'ready_on_arrival', label: 'Ready the day the last needed item arrives (no production or delivery time on record)', basis: 'ASSUMPTION' },
      { key: 'supplier_date', label: `${supplier}'s new date holds`, basis: 'ASSUMPTION' },
    ],
    contradictions: [],
    expectedValue: null,
    downsideRisk: a.valueAtRisk,
    upsidePotential: null,
    reversibility: 'REVERSIBLE_UNTIL_SENT',
    blastRadius: options[1].blastRadius,
    urgency: daysToFirst <= 0 ? 1 : Math.max(0.1, Math.round((1 - daysToFirst / 30) * 1000) / 1000),
    materiality: { revenueExposure: a.valueAtRisk, ordersAtRisk: n, customersAffected: customers.length, delayDays: a.delayDays, valueExcludedLines: a.valueExcluded },
    confidence: { score: 0.75, band: 'LIKELY', components: [{ name: 'supplier_date', value: 0.7, detail: 'The new date is what the supplier reported; it may move again' }, { name: 'records', value: 0.8, detail: 'Stock, bill of materials and promised dates are as recorded in Starlane' }], meaning: 'How sure Starlane is that these orders are late if nothing changes.' },
    recommendation: {
      key: 'notify_customers',
      label: options[1].label,
      why: `${plural(n, 'order')} will miss their date by up to ${plural(Math.max(0, ...a.atRisk.map((l) => l.slipDays || 0)), 'day')}. Telling customers before ${fmtDay(a.earliestAtRiskNeededBy)} costs nothing and nothing is sent without your approval.`,
      whyNot: [{ key: 'do_nothing', reason: `Customers find out when the order is late (${fmtMoney(a.valueAtRisk, cur)} of orders).` }],
      wouldChangeIf: [{ assumption: 'supplier_date', label: `${supplier} confirms ${a.unitsNeededFromShipment} units can ship by ${fmtDay(a.earliestAtRiskNeededBy)}`, detail: 'Those units keep every affected order on time; the orders would no longer be at risk.' }],
      informationFirst: null,
    },
    analysis: {
      supplierDelay: {
        purchaseLineItemId: String(row.id),
        delayDays: a.delayDays,
        originalExpectedAt: a.originalExpectedAt,
        expectedAt: a.expectedAt,
        atRisk: a.atRisk,
        alreadyAtRisk: a.alreadyAtRisk.map((l) => ({ orderId: l.orderId, customerName: l.customerName, neededBy: l.neededBy, plannedReadyAt: l.plannedReadyAt })),
        unaffectedCount: a.unaffected.length,
        unknownCount: a.unknown.length,
        unitsNeededFromShipment: a.unitsNeededFromShipment,
        stockMissing: data.stockMissing,
      },
      model: DELAY_MODEL_VERSION,
      deterministic: true,
    },
    modelVersions: { engine: ENGINE_VERSION, supplierDelay: DELAY_MODEL_VERSION, definitions: DEFINITIONS_VERSION },
  };
}

/**
 * @returns {{ drafts: object[], watched: object[] }}
 */
async function discoverSupplierDelayDecisions(pool, userId, defs, { asOfIso = new Date().toISOString() } = {}) {
  const asOfDay = toIsoDate(startOfUtcDay(Date.parse(asOfIso)));
  const data = await loadOperatingData(pool, userId, { baseCurrency: defs && defs.base_currency ? String(defs.base_currency).toUpperCase() : null });
  const drafts = [];
  const watched = [];
  for (const row of data.delayed) {
    const a = assessLine(data, row, asOfDay);
    const label = `${row.product_name || 'item'} from ${row.supplier_name || 'supplier'}`;
    if (!a.sufficientData) { watched.push({ purchaseLineItemId: String(row.id), item: label, reason: a.reason }); continue; }
    if (!a.atRisk.length) {
      watched.push({ purchaseLineItemId: String(row.id), item: label, reason: `Delay of ${a.delayDays} day(s) puts no promised order at risk (${a.unaffected.length} on time, ${a.alreadyAtRisk.length} already at risk before the delay)` });
      continue;
    }
    drafts.push(buildDraft(row, a, data, defs, asOfDay));
  }
  return { drafts, watched };
}

/**
 * Re-checks one delay decision against live data before execution.
 * Returns the same shape lifecycle.worldStillCurrent uses.
 */
async function recheckSupplierDelay(pool, userId, decision) {
  const lineId = decision.analysis?.supplierDelay?.purchaseLineItemId;
  const before = new Set((decision.analysis?.supplierDelay?.atRisk || []).map((l) => l.orderLineId || l.orderId));
  const data = await loadOperatingData(pool, userId, { baseCurrency: decision.currency ? String(decision.currency).toUpperCase() : null });
  const row = data.delayed.find((r) => String(r.id) === String(lineId));
  if (!row) return { ok: false, checks: [{ check: 'shipment_still_late', ok: false, detail: 'The shipment is no longer late, or has been received' }] };
  const a = assessLine(data, row, toIsoDate(startOfUtcDay(Date.now())));
  const now = new Set((a.atRisk || []).map((l) => l.orderLineId || l.orderId));
  const same = now.size === before.size && [...now].every((k) => before.has(k));
  const checks = [
    { check: 'shipment_still_late', ok: true },
    { check: 'orders_still_at_risk', ok: now.size > 0, detail: now.size ? null : 'No order is at risk any more' },
    { check: 'same_orders_at_risk', ok: same, detail: same ? null : `At-risk orders changed from ${before.size} to ${now.size}` },
  ];
  return { ok: checks.every((c) => c.ok), checks, currentExposure: a.valueAtRisk ?? null };
}

module.exports = { discoverSupplierDelayDecisions, recheckSupplierDelay, customerUpdateMessage, loadOperatingData, DELAY_MODEL_VERSION };
