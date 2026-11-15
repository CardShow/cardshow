// Snap & Sell, Phase 1 (js/snap-sell.js). Run like the others:
//   node snap-sell.e2e.mjs "iPhone 13"
import { chromium, devices } from 'playwright';
import fs from 'fs';
const mock = fs.readFileSync(new URL('./mock-supabase.js', import.meta.url), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const deviceName = process.argv[2] || 'iPhone 13';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ ...devices[deviceName], serviceWorkers: 'block' });
await ctx.addInitScript(() => {
  Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get() { return localStorage.getItem('__offline') !== '1'; } });
  window.confirm = () => true;
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${extra}`); };
const wait = ms => page.waitForTimeout(ms);
const srv = () => page.evaluate(() => JSON.parse(localStorage.getItem('__srv')));
const setOffline = on => page.evaluate(on => { localStorage.setItem('__offline', on ? '1' : '0'); if (!on) window.dispatchEvent(new Event('online')); }, on);
const fnCalls = [];

await ctx.route('**/.netlify/functions/**', r => { fnCalls.push(r.request().url()); r.fulfill({ contentType: 'application/json', body: '{"success":false}' }); });
await ctx.route('**/supabase-js@2*', r => r.fulfill({ contentType: 'application/javascript', body: mock }));
await ctx.route('https://fonts.**', r => r.fulfill({ body: '' }));
await ctx.route('**/__signed/**', r => r.fulfill({ contentType: 'image/jpeg', body: Buffer.alloc(0) }));

await page.goto(BASE + '/app.html');
await wait(400);
const photo = await page.screenshot({ type: 'jpeg', quality: 50 });
await page.fill('#authEmail', 't@x.com'); await page.fill('#authPassword', 'password1');
await page.evaluate(() => submitAuth());
await wait(2500);
await page.reload(); await wait(2200);   // an online restore caches the handle for an offline one
check('Show Mode opened for today\'s show', await page.isVisible('#showModeRoot'));
check('home has a Snap & Sell button', (await page.textContent('#smView')).includes('Snap & Sell'));

// ── Allocation math ──
const alloc = await page.evaluate(() => [
  ssAllocate(100, [{ typed: null, weight: 1 }, { typed: null, weight: 1 }, { typed: null, weight: 1 }]),
  ssAllocate(120, [{ typed: 70 }, { typed: null, weight: 40 }, { typed: null }]),
  ssAllocate(10, [{ typed: null, weight: 300 }, { typed: null, weight: 100 }, { typed: null, weight: 1 }]),
]);
const sum = a => Math.round(a.reduce((s, x) => s + x, 0) * 100) / 100;
check('split: leftover cent goes to the top card, sums to the total', JSON.stringify(alloc[0]) === '[33.34,33.33,33.33]', JSON.stringify(alloc[0]));
check('split keeps typed prices; a card with no price weighs the average', JSON.stringify(alloc[1]) === '[70,25,25]', JSON.stringify(alloc[1]));
check('split by asking price always sums exactly', sum(alloc[2]) === 10, JSON.stringify(alloc[2]));

// ── Capture offline, timed ──
await setOffline(true);
const t0 = Date.now();
await page.click('.sm-sec-btn--snap');
await page.setInputFiles('.ss-tile input >> nth=0', { name: 'items.jpg', mimeType: 'image/jpeg', buffer: photo });
await page.waitForSelector('.ss-tile--done');
await page.setInputFiles('.ss-tile input >> nth=1', { name: 'pay.jpg', mimeType: 'image/jpeg', buffer: photo });
await page.waitForFunction(() => document.querySelectorAll('.ss-tile--done').length === 2);
await page.fill('#ssAmount', '120');
await page.click('[data-sspay="Card"]');
for (let i = 0; i < 3; i++) await page.click('[aria-label="One more card"]');
check('4 cards marks it a lot', (await page.getAttribute('#ssLotChip', 'aria-pressed')) === 'true');
await page.click('#ssSaveBtn');
await page.waitForSelector('#ssToast');
const elapsed = Date.now() - t0;
check('capture to toast under 5s offline (incl. two photos)', elapsed < 5000, `${elapsed}ms`);
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT.replace('.png', '-home.png') });
check('toast says saved, details later', (await page.textContent('#ssToast')).includes('Sale saved · $120 · details later'));
let home = await page.textContent('#smView');
check('home shows the sale with Needs details', home.includes('Needs details') && home.includes('Lot · 4 cards'));
check('header shows 1 sale syncing', home.includes('1 sale syncing'));
check('nothing reached the server while offline', ((await srv()).snap_sales || []).length === 0);
check('sale saved on the phone (IndexedDB) with both photos', await page.evaluate(async () => {
  const all = await smStore.all('snapSales'); return all.length === 1 && all[0].photos.length === 2 && all[0].photos.every(p => p.blob instanceof Blob);
}));

// Nine more offline (no photos).
for (let i = 1; i <= 9; i++) {
  await page.evaluate(() => ssStart('test')); await wait(50);
  await page.fill('#ssAmount', String(i * 10));
  await page.click('#ssSaveBtn'); await wait(80);
}
check('10 sales queued', await page.evaluate(() => ssSyncingCount()) === 10);

// Reload while offline: the queue survives.
await page.reload(); await wait(2500);
check('after an offline reload, all 10 are still on the phone', await page.evaluate(() => ssMine().length) === 10);

// ── Back online: sync ──
await setOffline(false);
await page.waitForFunction(() => ssSyncingCount() === 0, null, { timeout: 15000 }).catch(() => {});
let S = await srv();
const snapTx = S.show_floor_transactions.filter(t => t.source === 'snap');
check('10 snap_sales rows', (S.snap_sales || []).length === 10);
check('10 ledger rows, one per sale', snapTx.length === 10 && new Set(snapTx.map(t => t.client_sale_id)).size === 10);
check('ledger GMV = what was typed ($570)', snapTx.reduce((s, t) => s + t.sold_price, 0) === 570);
check('ledger rows kept out of comps (api_eligible false)', snapTx.every(t => t.api_eligible === false));
const lot = S.snap_sales.find(r => Number(r.amount) === 120);
check('lot row: is_lot, 4 cards, payment Card, needs_review', lot && lot.is_lot && lot.item_count_hint === 4 && lot.payment_method === 'Card' && (lot.capture_status || 'needs_review') === 'needs_review');
check('lot row linked to its ledger row', lot && snapTx.some(t => t.id === lot.transaction_id));
const photos = (S.transaction_photos || []).filter(p => p.sale_key === lot.client_sale_id);
check('both photos uploaded to the seller\'s own folder', photos.length === 2 && photos.every(p => p.storage_path.startsWith('u1/' + lot.client_sale_id + '/')) && S.storage.length === 2);
check('payment photo removed from the phone after upload, items photo kept', await page.evaluate(async id => {
  const r = await smStore.get('snapSales', id); return !r.photos.find(p => p.kind === 'payment').blob && !!r.photos.find(p => p.kind === 'items').blob;
}, lot.client_sale_id));
check('sync pill gone', !(await page.textContent('#smView')).includes('syncing'));

// Replay the same op (as a retry would): no duplicates.
await page.evaluate(async id => { (await smStore.get('snapSales', id)); const r = ssMine().find(x => x.clientSaleId === id); r.synced = false; await smEnqueue({ type: 'snap_sale', clientSaleId: id }); }, lot.client_sale_id);
await wait(1200);
S = await srv();
check('retried op adds no rows', S.snap_sales.length === 10 && S.show_floor_transactions.filter(t => t.source === 'snap').length === 10);

// ── Undo ──
await page.evaluate(() => ssStart('test')); await wait(50);
await page.fill('#ssAmount', '33'); await page.click('#ssSaveBtn');
await wait(1200);
await page.click('#ssToast .sm-toast-btn'); await wait(1200);
S = await srv();
const undone = S.snap_sales.find(r => Number(r.amount) === 33);
check('undo after sync: sale voided, ledger nets to 0', undone && undone.voided_at &&
  S.show_floor_transactions.filter(t => t.client_sale_id === undone.client_sale_id || t.voids_transaction_id === undone.transaction_id).reduce((s, t) => s + t.sold_price, 0) === 0);
await setOffline(true);
await page.evaluate(() => ssStart('test')); await wait(50);
await page.fill('#ssAmount', '44'); await page.click('#ssSaveBtn'); await wait(200);
await page.click('#ssToast .sm-toast-btn'); await wait(200);
await setOffline(false); await wait(1200);
S = await srv();
check('undo before sync: never reaches the server', !S.snap_sales.some(r => Number(r.amount) === 44) && !S.show_floor_transactions.some(t => t.sold_price === 44));
check('undone sales leave the list', await page.evaluate(() => ssMine().length) === 10);

// ── Needs details: resolve the lot ──
await page.evaluate(() => smGo('/needs')); await wait(400);
check('Needs details lists 10 sales', await page.locator('#smView .sm-row--button').count() === 10);
await page.evaluate(id => ssOpenEditor(id), lot.client_sale_id); await wait(500);
check('payment photo hidden until asked', await page.locator('.ss-pay-photo').count() === 0 && (await page.textContent('#smView')).includes('Show payment photo'));
await page.click('#smView >> text=Show payment photo'); await wait(200);
check('payment photo shows on request', await page.locator('.ss-pay-photo').count() === 1);
await page.fill('#ssEditSearch', 'crews'); await wait(100);
await page.click('#ssEditResults .sm-row--button >> nth=0'); await wait(100);
await page.fill('#ssEditSearch', 'elly'); await wait(100);
await page.click('#ssEditResults .sm-row--button >> nth=0'); await wait(100);
await page.click('#smView >> text=Card not in my inventory'); await wait(100);
await page.fill('#ssUnknown', 'Ohtani base'); await page.click('#smView button.sm-chip:has-text("Add")'); await wait(100);
await page.fill('.ss-price input >> nth=0', '70'); await wait(100);
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT.replace('.png', '-editor.png') });
check('blank prices show the estimate split', (await page.getAttribute('.ss-price input >> nth=1', 'placeholder')) === '25.00' && (await page.getAttribute('.ss-price input >> nth=2', 'placeholder')) === '25.00');
check('running total matches', (await page.textContent('.ss-total')).includes('Cards $120 of $120'));
await page.fill('.ss-price input >> nth=1', '80'); await wait(100);
check('mismatch warns but still lets you save', (await page.getAttribute('.ss-total', 'class')).includes('ss-total--warn'));
await page.fill('.ss-price input >> nth=1', ''); await wait(100);
await page.click('#smView >> text=Mark complete'); await wait(1500);
S = await srv();
const items = (S.transaction_items || []).filter(i => i.sale_key === lot.client_sale_id);
check('3 items saved', items.length === 3, JSON.stringify(items.map(i => [i.card_title, i.price, i.price_basis])));
check('typed price observed, the rest allocated', items.filter(i => i.price_basis === 'observed').length === 1 && items.find(i => i.price_basis === 'observed').price === 70);
check('items sum to the total', items.reduce((s, i) => s + i.price, 0) === 120);
check('linked cards confirmed, unknown card manual', items.filter(i => i.identification_status === 'confirmed').length === 2 && items.some(i => i.identification_status === 'manual' && i.card_title === 'Ohtani base'));
check('inventory cards marked sold (once)', S.inventory.find(r => r.id === 'c1').status === 'Sold' && S.inventory.find(r => r.id === 'c2').status === 'Sold' && S.inventory.find(r => r.id === 'c1').sold_price === 70);
check('no extra ledger row for the resolved cards', S.show_floor_transactions.filter(t => t.source !== 'snap' && t.sold_price > 0).length === 0);
check('sale marked complete', S.snap_sales.find(r => r.client_sale_id === lot.client_sale_id).capture_status === 'complete');
check('Needs details now 9', await page.evaluate(() => ssNeedsDetails().length) === 9);

// Keep as lot.
const other = S.snap_sales.find(r => Number(r.amount) === 90);
await page.evaluate(id => ssOpenEditor(id), other.client_sale_id); await wait(300);
await page.click('#smView >> text=Keep as lot'); await wait(1200);
check('Keep as lot → unresolved_lot', (await srv()).snap_sales.find(r => r.client_sale_id === other.client_sale_id).capture_status === 'unresolved_lot');

// ── Report tab totals ──
const report = await page.evaluate(() => { updateReport(); return { rev: document.getElementById('rptRevenue').textContent, log: document.getElementById('rptTxBody').innerHTML }; });
// Cards: c3 $280 (earlier) + c1 $70 + c2 $25. Snap remainders: lot $25 (Ohtani) + 9 others ($450).
check('Report revenue counts every snap dollar once ($850)', report.rev === '$850', report.rev);
check('Report log tags snap sales and has no share button on them', report.log.includes('NEEDS DETAILS') && report.log.includes('SNAP') && (report.log.match(/📤/g) || []).length === 3);

// ── Organizer analytics reads the ledger ──
const org = await page.evaluate(async () => {
  const sales = await _orgFetchSales('show_a');
  return { gmv: sales.reduce((s, r) => s + r.sold_price, 0), tx: sales.length, items: sales.reduce((s, r) => s + r._items, 0), lot: sales.find(r => r.sold_price === 120)._items };
});
check('organizer GMV = typed totals, undo excluded ($570)', org.gmv === 570 && org.tx === 10, JSON.stringify(org));
check('a resolved lot counts as its 3 cards', org.lot === 3);

// ── Privacy ──
const visionCalls = fnCalls.filter(u => /vision-scan|scan-card|cardsight-identify|bulk-scan/.test(u));
check('no identification / vision call made during Snap & Sell (photos never sent)', visionCalls.length === 0, visionCalls.join(','));
check('no page errors', errors.length === 0, errors.join(' | '));

// Narrow screen: no sideways scroll on the capture screen.
await page.evaluate(() => ssStart('test')); await wait(150);
check('capture screen fits the width', await page.evaluate(() => document.getElementById('smScroll').scrollWidth <= document.getElementById('smScroll').clientWidth + 1));
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

await browser.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
