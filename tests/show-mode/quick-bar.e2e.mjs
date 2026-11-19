// Quick bar (js/quick-bar.js) on the Show Mode home screen. Run like the others:
//   node quick-bar.e2e.mjs "iPhone 13"
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
const outbox = () => page.evaluate(async () => (await smStore.all('outbox')).map(o => o.type));
const card = id => page.evaluate(id => { const c = inventory.find(x => x._dbId === id); return c ? { status: c.Status, price: c.SoldPrice, pm: c.PaymentMethod } : null; }, id);
const preview = () => page.textContent('#qbPreview');
const type = async v => { await page.fill('#qbInput', v); await page.waitForFunction(v => _qbText === v, v); };

await ctx.route('**/.netlify/functions/**', r => r.fulfill({ contentType: 'application/json', body: '{"success":false}' }));
await ctx.route('**/supabase-js@2*', r => r.fulfill({ contentType: 'application/javascript', body: mock }));
await ctx.route('https://fonts.**', r => r.fulfill({ body: '' }));

await page.goto(BASE + '/app.html');
await wait(400);
await page.evaluate(() => {
  const S = window.__srv;
  const codes = { c1: 'S-1', c2: 'R-1', c3: 'S-2' };
  S.inventory.forEach(r => { if (codes[r.id]) r.stock_code = codes[r.id]; });
  S.inventory.push({ id: 'c4', seller_id: 'u1', card_title: 'Test single four', player: 'Test Four', price: 25, status: 'Available', stock_code: 'R-4' });
  S.inventory.push({ id: 'c5', seller_id: 'u1', card_title: 'Test single five', player: 'Test Five', price: 0, status: 'Available', stock_code: 'R-5' });
  S.show_inventory.push({ show_id: 'show_a', card_id: 'c4' });
  localStorage.setItem('__srv', JSON.stringify(S));
});
await page.reload(); await wait(400);
await page.fill('#authEmail', 't@x.com'); await page.fill('#authPassword', 'password1');
await page.evaluate(() => submitAuth());
await wait(2500);
await page.reload(); await wait(2200);
check('Show Mode home has the quick bar', await page.isVisible('#qbInput'));

// ── Parser ──
const p = await page.evaluate(() => {
  const s = (t) => { const r = qbParse(t); return r && { kind: r.kind, action: r.action, error: r.error || null, summary: r.summary || null,
    items: r.items && r.items.map(i => [i.label, i.price, i.atAsking]), payment: r.payment, amount: r.amount, count: r.count,
    draft: r.draft && { type: r.draft.type, outs: r.draft.outs.map(o => o.value), ins: r.draft.ins.map(i => i.title), cashDir: r.draft.cashDir, cash: r.draft.cash } }; };
  return {
    sale: s('S1 100'), word: s('slab 1 100 venmo'), dash: s('s-1 $100 card'), asking: s('S1'), two: s('S1 100 R1 30'),
    oneTotal: s('S1 R1 130'), none: s('S9 10'), sold: s('S2 10'), noAsk: s('R5'), twice: s('S1 10 S1 20'), junk: s('hello'),
    lot: s('lot 120 3 cards'), lotPay: s('lot $75 venmo'), lotBad: s('lot abc'),
    trade: s('T S1 for wemby psa 10 +20'), tradePaid: s('trade s1 -15 for luka'), tradeArrow: s('T S1 -> luka'),
    tradeTwo: s('T S1 for a, b'), tradeOpen: s('T S1'), tradeBad: s('T wemby for S1'),
    buy: s('B 50 charizard psa 9'), buyEnd: s('B charizard psa 9 $50'), buyLast: s('buy luka rc 40'), buyOpen: s('B charizard'), buyTwo: s('B 90 a, b'),
  };
});
check('S1 100 → sell S-1 for $100, last payment (Cash)', p.sale.kind === 'sale' && JSON.stringify(p.sale.items) === '[["S-1",100,false]]' && p.sale.payment === 'Cash', JSON.stringify(p.sale));
check('"slab 1 100 venmo" and "s-1 $100 card" read the same card, payment from the word', p.word.items[0][0] === 'S-1' && p.word.payment === 'Venmo' && p.dash.items[0][1] === 100 && p.dash.payment === 'Card');
check('S1 alone sells at the asking price', JSON.stringify(p.asking.items) === '[["S-1",120,true]]' && /asking/.test(p.asking.summary));
check('two cards, a price each', JSON.stringify(p.two.items) === '[["S-1",100,false],["R-1",30,false]]' && /= \$130/.test(p.two.summary));
check('one price for two cards is refused (never split), suggests lot', /lot 130/.test(p.oneTotal.error || ''), p.oneTotal.error);
check('unknown code, sold card, no asking price, a code twice, junk: each explained', /No card S-9/.test(p.none.error) && /already sold/.test(p.sold.error)
  && /no asking price/.test(p.noAsk.error) && /twice/.test(p.twice.error) && /Didn't understand "hello"/.test(p.junk.error));
check('lot 120 3 cards → lot sale, 3 cards; lot $75 venmo', p.lot.kind === 'lot' && p.lot.amount === 120 && p.lot.count === 3 && p.lotPay.amount === 75 && p.lotPay.payment === 'Venmo' && !!p.lotBad.error);
check('T S1 for wemby psa 10 +20 → trade saves, got $20, in-card worth the balance ($100)', p.trade.action === 'save' && p.trade.draft.cashDir === 'in' && p.trade.draft.cash === '20'
  && JSON.stringify(p.trade.draft.ins) === '["wemby psa 10"]' && /worth \$100/.test(p.trade.summary), p.trade.summary);
check('"-15" = paid; "->" works like "for"', p.tradePaid.draft.cashDir === 'out' && p.tradePaid.draft.ins[0] === 'luka' && p.tradeArrow.draft.ins[0] === 'luka');
check('two cards in, or nothing back yet: opens the trade screen instead of guessing', p.tradeTwo.action === 'open' && p.tradeOpen.action === 'open' && !!p.tradeBad.error);
check('B 50 charizard psa 9 / B charizard psa 9 $50 / buy luka rc 40 → buy', p.buy.action === 'save' && p.buy.draft.cash === '50' && p.buy.draft.ins[0] === 'charizard psa 9'
  && p.buyEnd.draft.cash === '50' && p.buyEnd.draft.ins[0] === 'charizard psa 9' && p.buyLast.draft.cash === '40' && p.buyLast.draft.ins[0] === 'luka rc');
check('buy with no price, or two cards for one price: opens the screen', p.buyOpen.action === 'open' && p.buyTwo.action === 'open');

// ── Live preview + sale ──
await type('S1 100');
check('preview says what Enter will do', /Sell S-1 .* \$100 · Cash — Enter to save/.test(await preview()), await preview());
await type('S1 R1 130');
check('error shows in the preview and the button is off', /lot 130/.test(await preview()) && await page.isDisabled('#qbGo'));
await type('S1 100');
await page.evaluate(() => smRefresh());
check('typing survives a home re-render (focus and text kept)', await page.inputValue('#qbInput') === 'S1 100' && await page.evaluate(() => document.activeElement.id === 'qbInput'));
const t0 = Date.now();
await page.press('#qbInput', 'Enter');
await wait(400);
check('Enter sells: toast, bar cleared', Date.now() - t0 < 2000 && (await page.textContent('#qbToast')).includes('Sold S-1 · $100 · Cash') && await page.inputValue('#qbInput') === '');
check('card sold on the phone', JSON.stringify(await card('c1')) === '{"status":"Sold","price":100,"pm":"Cash"}');
await wait(1500);
let S = await srv();
check('synced through record_sale', S.inventory.find(r => r.id === 'c1').status === 'Sold' && S.sales.some(s => s.inventory_id === 'c1' && s.price === 100));
check('home: Sales total counts it ($280 earlier + $100)', (await page.textContent('.sm-stats')).includes('$380'), await page.textContent('.sm-stats'));
await page.click('#qbToast button');
await wait(1500);
S = await srv();
check('Undo voids it: back in the case', (await card('c1')).status === 'Available' && S.inventory.find(r => r.id === 'c1').status === 'Available');

// ── Two cards offline ──
await setOffline(true);
await type('S1 90 R4 20 venmo');
await page.press('#qbInput', 'Enter');
await wait(300);
check('offline: two sales queued', JSON.stringify(await outbox()).split('"sale"').length - 1 === 2 && (await card('c4')).pm === 'Venmo');
await setOffline(false);
await wait(2000);
S = await srv();
check('synced: both sold on the server', S.inventory.find(r => r.id === 'c1').status === 'Sold' && S.inventory.find(r => r.id === 'c4').sold_price === 20 && (await outbox()).length === 0);

// ── Lot ──
await type('lot 75 2 cards');
await page.press('#qbInput', 'Enter');
await wait(1500);
S = await srv();
check('lot 75 → a Snap & Sell sale, Needs details', (S.snap_sales || []).some(x => Number(x.amount) === 75 && x.item_count_hint === 2)
  && (await page.textContent('#smView')).includes('Needs details'), JSON.stringify(S.snap_sales));

// ── Trade + buy ──
await type('T R1 for wemby psa 10 +10');
check('trade preview', /Trade R-1 .* for wemby psa 10 \(worth \$30\) \+ you got \$10/.test(await preview()), await preview());
await page.press('#qbInput', 'Enter');
await wait(1500);
S = await srv();
const tr = (S.dealer_transactions || []).find(d => d.txn_type === 'trade');
check('trade saved through record_trade', tr && tr.cash_in === 10 && S.inventory.find(r => r.id === 'c2').payment_method === 'Trade'
  && S.inventory.some(r => r.card_title === 'wemby psa 10' && r.grader === 'PSA'));
await type('B 50 charizard psa 9');
await page.press('#qbInput', 'Enter');
await wait(1500);
S = await srv();
check('buy saved: $50 paid, card in the case', (S.dealer_transactions || []).some(d => d.txn_type === 'buy' && d.cash_out === 50)
  && S.inventory.some(r => r.card_title === 'charizard psa 9' && r.status === 'Available'));

// ── Opens the trade screen pre-filled ──
await page.evaluate(() => smGoHome()); await wait(300);
await type('T S2 for a');
check('a sold card in a trade is refused', /already sold/.test(await preview()));
await type('B 90 card a, card b');
await page.press('#qbInput', 'Enter');
await wait(500);
check('two cards for one price opens the buy screen, both cards and $90 filled in',
  await page.isVisible('.sm-title:has-text("Log a buy")') && await page.inputValue('[data-tl="title:1"]') === 'card b' && await page.inputValue('#tlCash') === '90');

// ── Help + layout ──
await page.evaluate(() => smGoHome()); await wait(300);
await page.click('#qbHelpBtn');
check('help lists the syntax', (await page.textContent('#qbHelp')).includes('T S12 for wemby psa 10 +20'));
await type('T S1 for an extremely long card title that keeps going and going and going without any break at all');
check('no sideways scroll', await page.evaluate(() => document.getElementById('smScroll').scrollWidth <= document.getElementById('smScroll').clientWidth + 1));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
