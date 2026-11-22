#!/usr/bin/env node
/* global localStorage, document */ // used inside page.evaluate / addInitScript (browser context)
// FILE: scripts/demo/supplier-delay-journey.js
// `npm run demo:supplier-delay:journey`: drives the supplier-delay demo
// through the real frontend in a headless browser and checks the database
// after every step. It is the click-through behind the demo script, kept so
// anyone can re-run it rather than take a screenshot on trust.
//
// Needs, all local:
//   1. a migrated local Postgres (DATABASE_URL, guarded by testDatabaseGuard)
//   2. `npm run demo:supplier-delay` run against it just before
//   3. this backend running on API_URL (default http://localhost:3001) with
//      the same DATABASE_URL and JWT_SECRET
//   4. the frontend running on APP_URL (default http://localhost:3000) with
//      NEXT_PUBLIC_API_URL pointing at the backend
//
// Journey (one tenant, the synthetic Kaveri Cycle Works):
//   Decisions -> Inbound shipments -> report the wheel delay (negative
//   control: no order affected) -> report the frame delay -> decision ->
//   choose "prepare customer updates" -> approve -> run in SHADOW (nothing
//   written) -> owner switches the account to LIVE -> run -> 2 pending drafts
//   -> approve one draft in Approvals -> still nothing sent.
// Exits non-zero on the first check that fails. Writes screenshots to
// JOURNEY_OUT (default ./demo-journey).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { assertTestDatabase } = require('../../lib/db/testDatabaseGuard');

const EMAIL = 'owner@supplier-delay-demo.invalid';
const APP = process.env.APP_URL || 'http://localhost:3000';
const API = process.env.API_URL || 'http://localhost:3001';
const OUT = process.env.JOURNEY_OUT || path.join(process.cwd(), 'demo-journey');

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required (a local database).');
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required (the one the local backend uses).');
  assertTestDatabase(process.env.DATABASE_URL);
  const { chromium } = require('playwright');
  const { getPool } = require('../../lib/db/pg');
  const pool = getPool();
  fs.mkdirSync(OUT, { recursive: true });

  const tenant = async () => {
    const user = (await pool.query('SELECT id FROM users WHERE email = $1', [EMAIL])).rows[0];
    if (!user) throw new Error('Demo tenant not found. Run `npm run demo:supplier-delay` first.');
    return { userId: user.id, token: jwt.sign({ userId: user.id, email: EMAIL }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' }) };
  };
  // Re-seeds the demo tenant with the same script the demo uses.
  const freshTenant = async () => {
    const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'seed-supplier-delay.js')], { env: process.env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`re-seed failed: ${r.stderr || r.stdout}`);
    return tenant();
  };
  let { userId, token } = await tenant();
  const lines = (await pool.query(
    `SELECT pli.id, pu.supplier_name, pli.expected_at::date::text AS expected, pli.original_expected_at
       FROM purchase_line_items pli JOIN purchases pu ON pu.id = pli.purchase_id WHERE pli.user_id = $1`, [userId])).rows;
  if (lines.some((l) => l.original_expected_at)) throw new Error('The demo tenant already has a reported delay. Re-run `npm run demo:supplier-delay` for a fresh one.');
  const frame = lines.find((l) => l.supplier_name === 'Shenzhen Frame Co');
  const newDate = new Date(Date.parse(`${frame.expected}T00:00:00Z`) + 15 * 86400000).toISOString().slice(0, 10);

  const state = async () => (await pool.query(
    `SELECT (SELECT COUNT(*) FROM decisions WHERE user_id = $1 AND kind = 'SUPPLIER_DELAY')::int AS decisions,
            (SELECT COUNT(*) FROM ai_actions WHERE user_id = $1)::int AS drafts,
            (SELECT COUNT(*) FROM ai_actions WHERE user_id = $1 AND status = 'approved')::int AS approved_drafts,
            (SELECT COUNT(*) FROM execution_records WHERE user_id = $1)::int AS sends,
            (SELECT COUNT(*) FROM outbound_send_jobs WHERE user_id = $1)::int AS send_jobs,
            (SELECT string_agg(name || '=' || current_stock::float, ', ' ORDER BY name) FROM products WHERE user_id = $1) AS stock`,
    [userId])).rows[0];
  const startStock = (await state()).stock;
  const nothingSent = (s) => s.sends === 0 && s.send_jobs === 0 && s.stock === startStock;

  const browser = await chromium.launch();
  const host = new URL(APP).hostname;
  const errors = [];
  const openPage = async (t) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies([{ name: 'vantro_token', value: t, domain: host, path: '/' }]);
    await ctx.addInitScript((v) => { try { localStorage.setItem('vantro_token', v); } catch { /* ignore */ } }, t);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    return p;
  };
  let page = await openPage(token);
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  const row = (supplier) => page.locator('li', { hasText: supplier });

  try {
    await page.goto(`${APP}/decisions`, { waitUntil: 'load', timeout: 240000 });
    await page.getByRole('link', { name: 'Inbound shipments' }).click();
    await page.getByText('Shenzhen Frame Co').waitFor({ timeout: 120000 });
    await shot('1-inbound-shipments');
    check(await row('Shenzhen Frame Co').count() === 1 && await row('Pune Wheel Works').count() === 1, 'both open shipments are listed');

    await row('Pune Wheel Works').getByRole('button', { name: 'Report a delay' }).click();
    await row('Pune Wheel Works').locator('input[type=date]').fill(newDate);
    await row('Pune Wheel Works').getByRole('button', { name: 'Check affected orders' }).click();
    await page.getByText('No promised order is affected').waitFor({ timeout: 60000 });
    await shot('2-wheel-delay-no-impact');
    check((await state()).decisions === 0, 'wheel delay (200 wheels on hand) opens no decision');

    await row('Shenzhen Frame Co').getByRole('button', { name: 'Report a delay' }).click();
    await row('Shenzhen Frame Co').locator('input[type=date]').fill(newDate);
    await row('Shenzhen Frame Co').getByPlaceholder('e.g. Factory power cuts').fill('Factory power cuts');
    await row('Shenzhen Frame Co').getByRole('button', { name: 'Check affected orders' }).click();
    await page.getByText('Some customer orders are now at risk').waitFor({ timeout: 60000 });
    await shot('3-frame-delay-at-risk');
    let s = await state();
    check(s.decisions === 1 && s.drafts === 0 && nothingSent(s), 'frame delay opens one decision and writes nothing else', JSON.stringify(s));

    await page.getByRole('link', { name: /See which orders/ }).click();
    await page.getByRole('button', { name: 'Choose' }).first().waitFor({ timeout: 120000 });
    await shot('4-decision');
    const text = await page.evaluate(() => document.body.innerText);
    check(/Brightwater Stores by 10 days, Harbour Traders by 7 days/.test(text), 'names exactly the two orders the delay makes late');
    check(!/Echo Fleet Services by|Acme Retail by|Delta Sports by|Cobalt Rentals by/.test(text), 'does not blame the delay for the other orders');
    check(/Calculation/.test(text) && /Assumption/.test(text), 'evidence is labelled (calculation, assumption)');

    await page.getByRole('button', { name: 'Choose' }).nth(1).click();
    await page.getByRole('button', { name: 'Approve', exact: true }).waitFor({ timeout: 30000 });
    s = await state();
    check(s.drafts === 0 && nothingSent(s), 'choosing an option writes no drafts');
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Run in shadow mode' }).waitFor({ timeout: 30000 });
    s = await state();
    check(s.drafts === 0 && nothingSent(s), 'approving writes no drafts until it is run');
    await page.getByRole('button', { name: 'Run in shadow mode' }).click();
    await page.waitForTimeout(4000);
    await shot('5-shadow-run');
    s = await state();
    check(s.drafts === 0 && nothingSent(s), 'shadow run changes nothing outside Starlane', JSON.stringify(s));
    const shadowEvents = (await pool.query(`SELECT event_type FROM decision_events WHERE user_id = $1`, [userId])).rows.map((e) => e.event_type);
    check(shadowEvents.includes('SHADOW_RECORDED'), 'audit trail records what the shadow run would have done (SHADOW_RECORDED)');

    // A shadowed decision is finished; it is not run again for real. Phase 2
    // starts from a freshly seeded tenant with the account in live mode, the
    // switch the owner makes on the Control page.
    ({ userId, token } = await freshTenant());
    page = await openPage(token); // a new browser context: nothing cached from the first tenant
    const ctl = await fetch(`${API}/api/decisions/controls`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ pilotMode: 'LIVE', reason: 'synthetic demo journey' }) });
    check(ctl.ok, 'phase 2: fresh tenant, account switched to live mode');
    await page.goto(`${APP}/decisions/shipments`, { waitUntil: 'load', timeout: 240000 });
    await page.getByText('Shenzhen Frame Co').waitFor({ timeout: 120000 });
    await row('Shenzhen Frame Co').getByRole('button', { name: 'Report a delay' }).click();
    await row('Shenzhen Frame Co').locator('input[type=date]').fill(newDate);
    await row('Shenzhen Frame Co').getByRole('button', { name: 'Check affected orders' }).click();
    await page.getByRole('link', { name: /See which orders/ }).click();
    await page.getByRole('button', { name: 'Choose' }).first().waitFor({ timeout: 120000 });
    await page.getByRole('button', { name: 'Choose' }).nth(1).click();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Run', exact: true }).waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await page.waitForTimeout(5000);
    await shot('6-live-run');
    s = await state();
    check(s.drafts === 2 && s.approved_drafts === 0 && nothingSent(s), 'live run writes 2 pending drafts and sends nothing', JSON.stringify(s));

    await page.goto(`${APP}/approvals`, { waitUntil: 'load', timeout: 240000 });
    await page.getByText(/Delay update: Brightwater Stores/).first().waitFor({ timeout: 120000 });
    await page.getByText(/Delay update: Brightwater Stores/).first().click();
    await page.waitForTimeout(1500);
    await shot('7-draft-in-approvals');
    await page.getByRole('button', { name: /^Approve/ }).first().click();
    await page.waitForTimeout(3000);
    s = await state();
    check(s.approved_drafts === 1 && nothingSent(s), 'approving a draft marks it approved and sends nothing', JSON.stringify(s));

    const audit = (await pool.query(`SELECT event_type, actor_type, COALESCE(model, '') AS model FROM decision_events WHERE user_id = $1 ORDER BY created_at`, [userId])).rows;
    const types = audit.map((e) => e.event_type);
    for (const t of ['SUPPLIER_DELAY_REPORTED', 'DISCOVERED', 'OPTION_SELECTED', 'APPROVED', 'EXECUTION_STARTED']) {
      check(types.includes(t), `audit trail has ${t}`);
    }
    check(audit.filter((e) => e.actor_type === 'agent').every((e) => /no LLM/.test(e.model)), 'every engine event is recorded as deterministic (no LLM)');
    check(errors.length === 0, 'no page errors', errors.join(' | '));
  } finally {
    await browser.close();
    await pool.end();
  }
  console.log(`\n${failures ? `${failures} check(s) FAILED` : 'All checks passed'}. Screenshots: ${OUT}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error('JOURNEY FAILED:', err.message); process.exit(1); });
