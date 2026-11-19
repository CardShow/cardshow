// Trade logging (Trades + Show Home, Phase 4: js/trade-log.js). Run like the others:
//   node trade-log.e2e.mjs "iPhone 13"
// The database side (record_trade / delete_dealer_trade) is checked by trade-logging.test.sh.
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
const view = () => page.textContent('#smView');
const outbox = () => page.evaluate(async () => (await smStore.all('outbox')).map(o => o.type));
const card = id => page.evaluate(id => { const c = inventory.find(x => x._dbId === id); return c ? { status: c.Status, pm: c.PaymentMethod, price: c.SoldPrice, code: c.StockCode, needs: c.IdentificationStatus, cost: c.CostBasis, shows: c._shows instanceof Set ? [...c._shows] : [] } : null; }, id);

await ctx.route('**/.netlify/functions/**', r => r.fulfill({ contentType: 'application/json', body: '{"success":false}' }));
await ctx.route('**/supabase-js@2*', r => r.fulfill({ contentType: 'application/javascript', body: mock }));
await ctx.route('https://fonts.**', r => r.fulfill({ body: '' }));

await page.goto(BASE + '/app.html');
await wait(400);
await page.fill('#authEmail', 't@x.com'); await page.fill('#authPassword', 'password1');
await page.evaluate(() => submitAuth());
await wait(2500);
await page.reload(); await wait(2200);   // an online restore caches the handle for an offline one
check('Show Mode opened for today\'s show', await page.isVisible('#showModeRoot'));
check('home has "Log a trade or buy"', (await view()).includes('Log a trade or buy'));

// ── Math ──
const m = await page.evaluate(() => {
  const D = (o) => Object.assign({ type: 'trade', outs: [], ins: [], cashDir: 'none', cash: '' }, o);
  return {
    even: tlTotals(D({ outs: [{ value: '120' }], ins: [{ value: '100' }], cashDir: 'in', cash: '20' })),
    est: tlTotals(D({ outs: [{ value: '120' }, { value: '30' }], ins: [{ value: '' }], cashDir: 'out', cash: '10' })),
    two: tlTotals(D({ outs: [{ value: '120' }], ins: [{ value: '' }, { value: '' }] })),
    giving: tlTotals(D({ outs: [{ value: '120' }], ins: [{ value: '90' }] })),
    buyBlankCash: tlTotals(D({ type: 'buy', cashDir: 'out', ins: [{ value: '25' }, { value: '15' }] })),
    buyBlankVal: tlTotals(D({ type: 'buy', cashDir: 'out', cash: '30', ins: [{ value: '' }] })),
    p2: _tlProblem(D({ outs: [{ value: '120' }], ins: [{ value: '' }, { value: '' }] })),
    p0: _tlProblem(D({ outs: [{ value: '120' }], ins: [] })),
    pOk: _tlProblem(D({ outs: [{ value: '120' }], ins: [{ value: '90' }] })),
  };
});
check('$120 out for $100 in + $20 cash received: even', m.even.delta === 0);
check('one blank card in: worth the balance ($150 out + $10 paid = $160, estimate)', m.est.estimate === 160 && m.est.delta === 0, JSON.stringify(m.est));
check('two blank cards in: no split guessed', m.two.estimate === null && m.two.blanks === 2);
check('$120 out for $90: giving $30 more', m.giving.delta === 30);
check('buy with blank cash: cash = what the cards are worth ($40)', m.buyBlankCash.cashOut === 40);
check('buy of one card for $30 with blank value: worth $30', m.buyBlankVal.estimate === 30 && m.buyBlankVal.inV === 30);
check('save blocked on two blank values or no card back; an unbalanced trade is fine', /each card coming in/.test(m.p2) && /Sell a card/.test(m.p0) && m.pOk === null);

// ── Log a trade with no signal ──
await setOffline(true);
await page.click('text=Log a trade or buy');
await page.waitForSelector('#tlSearch');
check('trade screen opened, Save disabled until there\'s something to save', await page.isDisabled('#tlSaveBtn'));
await page.fill('#tlSearch', 'crews');
await page.click('#tlResults .sm-row--button');
check('card going out added at its asking price', await page.inputValue('[data-tl="out:0"]') === '120');
await page.click('text=Add a card coming in');
await page.fill('[data-tl="title:0"]', 'Wemby Prizm RC PSA 10');
check('blank value shows an estimate from the trade', (await page.getAttribute('[data-tl="value:0"]', 'placeholder')) === '120.00'
  && await page.isVisible('[data-tl="estnote:0"]'));
await page.fill('[data-tl="value:0"]', '100');
await page.waitForFunction(() => /giving/.test(document.getElementById('tlBalance').textContent), null, { timeout: 3000 })
  .catch(async () => console.log('DBG', await page.inputValue('[data-tl="value:0"]'), await page.evaluate(() => JSON.stringify(_tlDraft))));
const bal = await page.textContent('#tlBalance');
check('balance: "You\'re giving $20 more" with a one-tap fix', /giving \$20 more/.test(bal) && /I got \$20 cash/.test(bal), bal);
await page.click('#tlBalance button');
check('fix sets "I got cash" $20 and the trade is even', await page.inputValue('#tlCash') === '20' && /Even trade/.test(await page.textContent('#tlBalance')));
await page.fill('[data-tl="price:0"]', '175');
const t0 = Date.now();
await page.click('#tlSaveBtn');
await wait(300);
check('saved offline in under a second, back home with an Undo toast', Date.now() - t0 < 1500 && await page.isVisible('#tlToast') && (await page.textContent('#tlToast')).includes('Trade saved'));
const newId = await page.evaluate(() => inventory.find(c => c._tradeIn)._dbId);
const c1 = await card('c1'), nw = await card(newId);
check('card out: Sold as Trade at $120, off the show on this phone', c1.status === 'Sold' && c1.pm === 'Trade' && Number(c1.price) === 120 && !c1.shows.includes('show_a'), JSON.stringify(c1));
check('card in: in the case, Needs details, cost $100, asking $175', nw.status === 'Available' && nw.needs === 'unidentified' && nw.cost === 100
  && await page.evaluate(id => inventory.find(c => c._dbId === id).Price, newId) === 175, JSON.stringify(nw));
const home = await view();
check('home: Recent shows the trade, syncing', /Trade/.test(home) && home.includes('Wemby Prizm RC PSA 10') && home.includes('Syncing'));
check('home: "Sold today" counts sales only (still 1)', await page.evaluate(() => document.querySelector('.sm-stat-num').textContent) === '1');
check('outbox holds the trade', JSON.stringify(await outbox()) === '["trade_save"]');
check('classic Report revenue leaves the trade out', await page.evaluate(() => getSellerInventory().filter(isSoldForCash).reduce((s, r) => s + (Number(r.SoldPrice) || 0), 0)) === 280);

// Reload with no signal: still traded.
await page.reload(); await wait(2500);
check('offline reload: trade still applied', (await card('c1')).status === 'Sold' && !!(await card(newId)));

// Back online: syncs.
await setOffline(false);
await wait(2000);
let S = await srv();
const dtx = (S.dealer_transactions || []);
check('synced: one trade row with $20 received', dtx.length === 1 && dtx[0].cash_in === 20 && dtx[0].txn_type === 'trade' && dtx[0].show_id === 'show_a', JSON.stringify(dtx));
check('server: card out Sold as Trade and off the show; card in kept the phone\'s id', S.inventory.find(r => r.id === 'c1').payment_method === 'Trade'
  && !S.show_inventory.some(r => r.card_id === 'c1') && S.inventory.some(r => r.id === newId && r.identification_status === 'unidentified'));
check('nothing on the ledger', (S.show_floor_transactions || []).length === 0);
const synced = await card(newId);
check('card in got its stock code from the server', /^S-\d+$/.test(synced.code || ''), synced.code);
check('outbox empty', (await outbox()).length === 0);
check('record_trade called once', await page.evaluate(() => window.__mockLog.filter(l => l.op === 'record_trade').length) === 1);

// Undo after sync.
await page.click('#smView .sm-row-btn:has-text("Undo")');
await wait(1500);
S = await srv();
check('undo after sync: card back Available and on the show, card in removed (server and phone)',
  S.inventory.find(r => r.id === 'c1').status === 'Available' && S.show_inventory.some(r => r.card_id === 'c1') && !S.inventory.some(r => r.id === newId)
  && (await card('c1')).status === 'Available' && (await card('c1')).shows.includes('show_a') && !(await card(newId)) && (S.dealer_transactions || []).length === 0);

// ── Undo before it syncs ──
await setOffline(true);
await page.click('text=Log a trade or buy');
await page.fill('#tlSearch', 'R-');
await page.fill('#tlSearch', 'elly');
await page.click('#tlResults .sm-row--button');
await page.click('text=Add a card coming in');
await page.fill('[data-tl="title:0"]', 'Some card');
await page.click('#tlSaveBtn');
await wait(300);
await page.click('#tlToast button');
await wait(300);
check('undo before sync: nothing queued, card back', (await outbox()).length === 0 && (await card('c2')).status === 'Available' && !(await page.evaluate(() => inventory.some(c => c._tradeIn))));
await setOffline(false); await wait(800);

// ── Buy ──
await page.click('text=Log a trade or buy');
await page.click('.sm-chip:has-text("Buy")');
await page.waitForSelector('.sm-title:has-text("Log a buy")');
check('buy screen: no cards-out section', !(await page.isVisible('#tlSearch')));
await page.click('text=Add a card coming in');
await page.fill('[data-tl="title:0"]', 'S-88: Base card PSA 9');
await page.fill('#tlCash', '30');
check('one card, blank value: worth what you paid', (await page.getAttribute('[data-tl="value:0"]', 'placeholder')) === '30.00');
await page.click('#tlSaveBtn');
await wait(1500);
S = await srv();
const buy = (S.dealer_transactions || [])[0] || {};
const bought = S.inventory.find(r => r.card_title === 'Base card PSA 9');
check('buy synced: $30 paid, card S-88 with grade read from the title, cost $30',
  buy.txn_type === 'buy' && buy.cash_out === 30 && bought && bought.stock_code === 'S-88' && bought.grader === 'PSA' && bought.grade === 9
  && S.inventory_costs.find(c => c.inventory_id === bought.id).cost_basis === 30, JSON.stringify({ buy, bought }));

// ── Two cards coming in, no values: blocked ──
await page.click('text=Log a trade or buy');
await page.fill('#tlSearch', 'elly');
await page.click('#tlResults .sm-row--button');
await page.click('text=Add a card coming in');
await page.click('text=Another card coming in');
check('two cards in with no values: Save disabled', await page.isDisabled('#tlSaveBtn'));
await page.fill('[data-tl="value:0"]', '25');
check('one value typed: the other is the estimate and Save works', (await page.getAttribute('[data-tl="value:1"]', 'placeholder')) === '15.00' && !(await page.isDisabled('#tlSaveBtn')));

// ── Card sold elsewhere before the trade synced ──
await setOffline(true);
await page.click('#tlSaveBtn');
await wait(300);
await page.evaluate(() => { const S = JSON.parse(localStorage.getItem('__srv')); Object.assign(S.inventory.find(r => r.id === 'c2'), { status: 'Sold', sold_price: 40, payment_method: 'Cash' }); localStorage.setItem('__srv', JSON.stringify(S)); window.__srv.inventory.find(r => r.id === 'c2').status = 'Sold'; Object.assign(window.__srv.inventory.find(r => r.id === 'c2'), { sold_price: 40, payment_method: 'Cash' }); });
await setOffline(false);
await wait(2000);
S = await srv();
check('already sold: trade refused, cards in removed, card shows the real sale', (S.dealer_transactions || []).filter(d => d.txn_type === 'trade').length === 0
  && !(await page.evaluate(() => inventory.some(c => c._tradeIn && c.Status === 'Available' && c['Card Title'] === 'Card from a trade')))
  && (await card('c2')).pm === 'Cash', JSON.stringify(await card('c2')));

// ── Show Home: undo a trade from its detail ──
await page.click('text=Log a trade or buy');
await page.fill('#tlSearch', 'crews');
await page.click('#tlResults .sm-row--button');
await page.click('text=Add a card coming in');
await page.fill('[data-tl="title:0"]', 'Edit me');
await page.fill('[data-tl="value:0"]', '110');
await page.click('#tlSaveBtn');
await wait(1500);
const txId = (await srv()).dealer_transactions.find(d => d.txn_type === 'trade').id;
await page.evaluate(() => closeShowMode({ remember: true }));
await page.evaluate(id => shOpenTxn(id), txId);
await wait(500);
check('Show Home trade detail has Edit values and Undo trade', await page.isVisible('.sh-modal button:has-text("Edit values")') && await page.isVisible('.sh-modal button:has-text("Undo trade")'));
await page.click('.sh-modal button:has-text("Edit values")');
await page.fill('#shEditCashIn', '10');
await page.click('#shEditSave');
await wait(1200);
check('edit saved through update_dealer_trade', (await srv()).dealer_transactions.find(d => d.id === txId).cash_in === 10);
await page.evaluate(id => shOpenTxn(id), txId);
await wait(500);
await page.click('.sh-modal button:has-text("Undo trade")');
await wait(1500);
S = await srv();
check('undo from Show Home: trade gone, card back', !S.dealer_transactions.some(d => d.id === txId) && S.inventory.find(r => r.id === 'c1').status === 'Available'
  && (await card('c1')).status === 'Available');

// No sideways scroll on the trade screen.
await page.evaluate(() => openShowMode('show_a', '/trade'));
await wait(400);
await page.click('text=Add a card coming in');
check('no sideways scroll', await page.evaluate(() => document.getElementById('smScroll').scrollWidth <= document.getElementById('smScroll').clientWidth + 1));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
