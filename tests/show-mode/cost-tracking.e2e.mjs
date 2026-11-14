// Cost Tracking & Stock Codes, Phase 1 (js/cost-tracking.js). Run like the others:
//   node cost-tracking.e2e.mjs "iPhone 13"
import { chromium, devices } from 'playwright';
import fs from 'fs';
const mock = fs.readFileSync(new URL('./mock-supabase.js', import.meta.url), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const deviceName = process.argv[2] || 'iPhone 13';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ ...devices[deviceName], serviceWorkers: 'block' });
const today = new Date().toLocaleDateString('en-CA');
await ctx.addInitScript(([today]) => {
  Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get() { return localStorage.getItem('__offline') !== '1'; } });
  localStorage.setItem('smExited:tester', 'show_a|' + today);   // start in the classic view
  window.confirm = () => true;
}, [today]);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${extra}`); };
const wait = ms => page.waitForTimeout(ms);
const srv = () => page.evaluate(() => JSON.parse(localStorage.getItem('__srv')));
const toast = () => page.textContent('#toast');
const setOffline = on => page.evaluate(on => { localStorage.setItem('__offline', on ? '1' : '0'); if (!on) window.dispatchEvent(new Event('online')); }, on);
const idxOf = id => page.evaluate(id => inventory.findIndex(c => c._dbId === id), id);

await ctx.route('**/.netlify/functions/**', r => r.fulfill({ contentType: 'application/json', body: '{"success":false}' }));
await ctx.route('**/supabase-js@2*', r => r.fulfill({ contentType: 'application/javascript', body: mock }));
await ctx.route('https://fonts.**', r => r.fulfill({ body: '' }));

await page.goto(BASE + '/app.html');
await wait(400);
await page.evaluate(() => {
  const S = window.__srv;
  S.inventory.push(
    { id: 'c4', seller_id: 'u1', card_title: '2022 Topps Julio Rodriguez', player: 'Julio Rodriguez', year: 2022, card_set: 'Topps', price: 50, status: 'Available' },
    { id: 'c5', seller_id: 'u1', card_title: '2021 Bowman Bobby Witt', player: 'Bobby Witt', year: 2021, card_set: 'Bowman', grader: 'PSA', grade: 9, price: 90, status: 'Available' },
    { id: 'c6', seller_id: 'u1', card_title: 'Prizm Blaster', price: 30, status: 'Available', item_type: 'sealed' },
    { id: 'zz', seller_id: 'someone_else', card_title: 'Not mine', price: 1, status: 'Available' },
  );
  S.show_inventory.push({ show_id: 'show_a', card_id: 'c4' }, { show_id: 'show_a', card_id: 'c5' });
  S.inventory_costs = [{ inventory_id: 'c1', owner_id: 'u1', cost_basis: 50, acquired_from: 'eBay' }];
  S.transaction_costs = [];
  localStorage.setItem('__srv', JSON.stringify(S));
});
await page.reload(); await wait(400);
await page.fill('#authEmail', 't@x.com'); await page.fill('#authPassword', 'password1');
await page.evaluate(() => submitAuth());
await wait(2500);

// ── Load ──
check('cost loaded from inventory_costs onto the card', await page.evaluate(() => inventory.find(c => c._dbId === 'c1').CostBasis === 50));
check('Assign codes button shown to sellers', await page.isVisible('#assignCodesBtn'));

// ── Assign codes (bulk, table order) ──
await page.evaluate(() => assignStockCodesBulk()); await wait(500);
let S = await srv();
const code = id => S.inventory.find(r => r.id === id).stock_code;
check('graded → S, raw → R, sealed → B', code('c1') === 'S-1' && code('c2') === 'R-1' && code('c5') === 'S-2' && code('c6') === 'B-1', JSON.stringify(S.inventory.map(r => [r.id, r.stock_code])));
check('sold card and another seller\'s card not coded', !code('c3') && !code('zz'));
check('code chip shows in the inventory table', (await page.textContent('#inventoryBody')).includes('S-1'));

// ── Search by code ──
const searchCount = async q => { await page.fill('#sellerSearchInput', q); return page.locator('#inventoryBody tr').count(); };
check('search "slab 1" finds S-1', await searchCount('slab 1') === 1);
check('search "s-2" finds S-2', await searchCount('s-2') === 1);
check('search "box 1" finds B-1', await searchCount('box 1') === 1);
await page.fill('#sellerSearchInput', ''); await page.evaluate(() => applyInventoryFilters());

// ── Add Card: cost + auto code ──
await page.evaluate(() => openAddCard()); await wait(200);
check('Add Card code placeholder previews the next code', (await page.getAttribute('#ac_code', 'placeholder')) === 'Auto: R-3');
await page.fill('#ac_title', '2024 Topps Paul Skenes');
await page.fill('#ac_price', '60');
await page.click('#ac_cost_details summary');
await page.fill('#ac_cost', '25');
await page.fill('#ac_cost_from', 'Card show buy');
check('unrealized profit hint', (await page.textContent('#ac_cost_hint')).includes('+$35'));
await page.evaluate(() => saveAddCard()); await wait(900);
S = await srv();
const skenes = S.inventory.find(r => r.card_title === '2024 Topps Paul Skenes');
check('new card got the next raw code R-3', skenes && skenes.stock_code === 'R-3', skenes && skenes.stock_code);
const skCost = S.inventory_costs.find(r => r.inventory_id === skenes?.id);
check('its cost saved to inventory_costs', skCost && skCost.cost_basis === 25 && skCost.acquired_from === 'Card show buy');
check('cost never written to the inventory row', !Object.keys(skenes || {}).some(k => /cost/.test(k)));

// ── Add Card: custom + duplicate code ──
await page.evaluate(() => openAddCard()); await wait(150);
await page.fill('#ac_title', 'Dup code card');
await page.fill('#ac_code', 's 1');
await page.evaluate(() => saveAddCard()); await wait(300);
check('duplicate code blocks the save with an inline error', (await page.textContent('#ac_code_err')).includes('already used') && await page.evaluate(() => !inventory.some(c => c['Card Title'] === 'Dup code card')));
await page.fill('#ac_code', 'TOPLOADER7');
await page.evaluate(() => saveAddCard()); await wait(800);
S = await srv();
check('custom code saved', S.inventory.some(r => r.card_title === 'Dup code card' && r.stock_code === 'TOPLOADER7'));

// ── Sell Drawer: profit + copy of cost ──
await page.evaluate(i => { openSellDrawer(i); }, await idxOf('c1')); await wait(200);
await page.fill('#sdPrice', '85');
await page.evaluate(() => { sdSelectedPayment = 'Cash'; sdConfirm(); });
await wait(150);
check('sale toast shows profit', (await toast()).includes('Profit +$35'), await toast());
await wait(900);
S = await srv();
const tc1 = S.transaction_costs.find(r => r.inventory_id === 'c1');
const tx1 = S.show_floor_transactions.find(r => r.inventory_id === 'c1');
check('transaction_costs row with cost at sale', tc1 && tc1.cost_at_sale === 50 && tc1.sale_price === 85 && tc1.show_id === 'show_a');
check('ledger row and cost row share client_sale_id', tx1 && tc1 && tx1.client_sale_id === tc1.client_sale_id);
check('ledger row has no cost fields', tx1 && !Object.keys(tx1).some(k => /cost|profit/.test(k)));

// Edit cost later → past sale unchanged
await page.evaluate(i => openCEM(i), await idxOf('c1')); await wait(150);
check('Edit Card shows the saved cost', (await page.inputValue('#cem_cost')) === '50');
await page.fill('#cem_cost', '70');
await page.evaluate(() => saveCEM()); await wait(700);
S = await srv();
check('editing cost updates inventory_costs', S.inventory_costs.find(r => r.inventory_id === 'c1').cost_basis === 70);
check('…and not the cost copied at sale', S.transaction_costs.find(r => r.inventory_id === 'c1').cost_at_sale === 50);

// Edit code to a duplicate → inline error; to a new value → saved
await page.evaluate(i => openCEM(i), await idxOf('c2')); await wait(150);
await page.fill('#cem_code', 'S-2');
await page.evaluate(() => saveCEM()); await wait(200);
check('Edit Card rejects a duplicate code', (await page.textContent('#cem_code_err')).includes('already used') && await page.isVisible('#cardEditOverlay.open'));
await page.fill('#cem_code', 'R-40');
await page.evaluate(() => saveCEM()); await wait(600);
S = await srv();
check('Edit Card code change saved', code('c2') === 'R-40');

// ── Sale with no cost → "Add cost" ──
await page.evaluate(i => openSellDrawer(i), await idxOf('c4')); await wait(200);
await page.fill('#sdPrice', '45');
await page.evaluate(() => { sdSelectedPayment = 'Venmo'; sdConfirm(); });
await wait(300);
check('no profit in toast without a cost', !(await toast()).includes('Profit'));
check('"Add cost" offered (seller tracks cost)', await page.isVisible('#costAddBar.show'));
await page.click('#costAddBar .cost-bar-btn'); await wait(150);
await page.fill('#costQuickInput', '20');
await page.evaluate(() => costSaveQuick()); await wait(700);
check('Add cost toast shows profit', (await toast()).includes('Profit +$25'), await toast());
S = await srv();
const tc4 = S.transaction_costs.find(r => r.inventory_id === 'c4');
check('Add cost writes the sale copy and the card cost', tc4 && tc4.cost_at_sale === 20 && S.inventory_costs.find(r => r.inventory_id === 'c4')?.cost_basis === 20);
check('…matched to the ledger row', tc4 && S.show_floor_transactions.some(r => r.client_sale_id === tc4.client_sale_id));

// ── Manual sale with cost ──
await page.evaluate(() => openManualSaleModal()); await wait(200);
await page.fill('#mslPlayer', 'Ken Griffey Jr');
await page.fill('#mslPrice', '100');
await page.fill('#mslCost', '120');
await page.evaluate(() => { _mslPayment = 'Cash'; document.getElementById('mslShow').value = 'show_a'; return confirmManualSale(); });
await wait(150);
check('manual sale toast shows a loss', (await toast()).includes('Loss −$20'), await toast());
await wait(900);
S = await srv();
const grif = S.inventory.find(r => r.player === 'Ken Griffey Jr');
const tcg = S.transaction_costs.find(r => r.inventory_id === grif?.id);
check('manual sale: cost copy + ledger share the sale id', tcg && tcg.cost_at_sale === 120 && S.show_floor_transactions.some(r => r.client_sale_id === tcg.client_sale_id && r.source === 'manual'));
check('manual sale card (sold) gets no stock code', grif && !grif.stock_code);

// ── Offline: cost edit + sale replay exactly once ──
await setOffline(true);
await page.evaluate(i => openCEM(i), await idxOf('c5')); await wait(150);
await page.click('#cem_cost_details summary');
await page.fill('#cem_cost', '40');
await page.evaluate(() => saveCEM()); await wait(300);
await page.evaluate(i => openSellDrawer(i), await idxOf('c5')); await wait(200);
await page.fill('#sdPrice', '88');
await page.evaluate(() => { sdSelectedPayment = 'Cash'; sdConfirm(); });
await wait(600);
S = await srv();
check('offline: nothing written yet', !S.transaction_costs.some(r => r.inventory_id === 'c5') && !S.inventory_costs.some(r => r.inventory_id === 'c5'));
check('offline: writes queued in the outbox', (await page.evaluate(() => smStore.all('outbox'))).filter(o => /cost/.test(o.type)).length === 2);
await setOffline(false); await wait(2500);
S = await srv();
check('online: queued cost writes synced', S.inventory_costs.find(r => r.inventory_id === 'c5')?.cost_basis === 40 && S.transaction_costs.filter(r => r.inventory_id === 'c5').length === 1 && S.transaction_costs.find(r => r.inventory_id === 'c5').cost_at_sale === 40);
await page.evaluate(() => smDrain()); await wait(800);
S = await srv();
check('replaying again creates no duplicate', S.transaction_costs.filter(r => r.inventory_id === 'c5').length === 1);

// ── Show Mode sale: profit on the sold screen; undo removes the cost copy ──
await page.evaluate(() => { const c = inventory.find(x => x._dbId === 'c6'); costSave(c, { cost_basis: 18 }); });
await page.evaluate(() => { localStorage.removeItem('smExited:tester'); openShowMode('show_a'); }); await wait(800);
await page.evaluate(() => {
  _smDraft = { showId: 'show_a', mode: 'sell', itemKey: 'c6', newItem: null, captureId: null, chip: 'asking', otherPrice: '', payment: 'Cash', buyerHandle: '' };
  return smMarkSold();
});
await wait(1200);
check('Show Mode sold screen shows profit', (await page.textContent('#smView')).includes('Profit +$12'), (await page.textContent('#smView')).slice(0, 200));
S = await srv();
const tc6 = S.transaction_costs.find(r => r.inventory_id === 'c6');
check('Show Mode sale: cost copy saved with the sale id', tc6 && tc6.cost_at_sale === 18 && S.sales.some(s => s.client_sale_id === tc6.client_sale_id));
await page.evaluate(id => smUndoSale(id), tc6?.client_sale_id); await wait(1500);
S = await srv();
check('undo deletes the cost copy', !S.transaction_costs.some(r => r.inventory_id === 'c6'));

// ── Never in buyer / share surfaces ──
const shareText = await page.evaluate(() => {
  const c = inventory.find(x => x._dbId === 'c1');
  return generateCaptionBody(c, 'Cal Expo') + ' ' + generateCaptionFooter(c);
});
check('share caption has no cost or profit', !/\b(70|50)\b|cost|profit/i.test(shareText), shareText);

check('no page errors', errors.length === 0, JSON.stringify(errors));
await browser.close();
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
