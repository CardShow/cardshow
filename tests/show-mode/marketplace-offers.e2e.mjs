// Marketplace offers, dealer side (js/marketplace-offers.js): strip, Offers panel, accept / counter / decline,
// an accepted offer showing as a hold and "Sold to them" at the agreed price. Run like the others:
//   node marketplace-offers.e2e.mjs "iPhone 13"
import { chromium, devices } from 'playwright';
import fs from 'fs';
const mock = fs.readFileSync(new URL('./mock-supabase.js', import.meta.url), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const deviceName = process.argv[2] || 'iPhone 13';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ ...devices[deviceName], serviceWorkers: 'block' });
const today = new Date().toLocaleDateString('en-CA');
await ctx.addInitScript(([today]) => {
  localStorage.setItem('smExited:tester', 'show_a|' + today);
  window.confirm = () => true;
}, [today]);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${ok ? '' : extra}`); };
const wait = ms => page.waitForTimeout(ms);
const srv = () => page.evaluate(() => JSON.parse(localStorage.getItem('__srv')));
const off = (S, id) => S.offers.find(o => o.id === id);
const notifies = [];
await ctx.route('**/.netlify/functions/**', r => r.fulfill({ contentType: 'application/json', body: '{"success":false}' }));
await ctx.route('**/.netlify/functions/offer-notify-now', r => { notifies.push(JSON.parse(r.request().postData() || '{}').offer_id); r.fulfill({ contentType: 'application/json', body: '{}' }); });
await ctx.route('**/supabase-js@2*', r => r.fulfill({ contentType: 'application/javascript', body: mock }));
await ctx.route('https://fonts.**', r => r.fulfill({ body: '' }));
async function signIn(url) {
  await page.goto(BASE + url); await wait(400);
  await page.fill('#authEmail', 't@x.com'); await page.fill('#authPassword', 'password1');
  await page.evaluate(() => submitAuth());
  await wait(2500);
}
const inH = h => new Date(Date.now() + h * 3600000).toISOString();

await page.goto(BASE + '/app.html'); await wait(400);
await page.evaluate(([inH20, inH5, ago]) => {
  const S = window.__srv;
  S.inventory.find(r => r.id === 'c1').listing_status = 'active';
  S.inventory.find(r => r.id === 'c1').stock_code = 'S-12';
  S.inventory.find(r => r.id === 'c2').listing_status = 'active';
  S.offers = [
    { id: 'o1', dealer_id: 'u1', listing_id: 'c1', buyer_name: 'Alex P', buyer_contact: '(555) 010-0100', buyer_note: 'Cash Saturday', status: 'pending',
      amount_cents: 10000, offer_cents: 10000, last_by: 'buyer', moves: 1, history: [{ by: 'buyer', cents: 10000 }], expires_at: inH20 },
    { id: 'o2', dealer_id: 'u1', listing_id: 'c1', buyer_name: 'Dee', buyer_contact: '@dee_cards', status: 'pending',
      amount_cents: 9000, offer_cents: 9000, last_by: 'buyer', moves: 1, history: [{ by: 'buyer', cents: 9000 }], expires_at: inH5 },
    { id: 'o3', dealer_id: 'u1', listing_id: 'c2', buyer_name: 'Sam', buyer_contact: 'sam@example.test', status: 'pending',
      amount_cents: 3000, offer_cents: 3000, last_by: 'buyer', moves: 1, history: [{ by: 'buyer', cents: 3000 }], expires_at: inH5 },
    { id: 'o4', dealer_id: 'u1', listing_id: 'c2', buyer_name: 'Lo', buyer_contact: 'lo@example.test', status: 'declined', decided_by: 'auto',
      end_reason: 'below_minimum', amount_cents: 1000, offer_cents: 1000, last_by: 'buyer', moves: 1, history: [], expires_at: ago, ended_at: ago },
    { id: 'ox', dealer_id: 'someone_else', listing_id: 'zz', buyer_name: 'Nope', buyer_contact: 'x', status: 'pending', amount_cents: 1, moves: 1, history: [], expires_at: inH5 },
  ];
  localStorage.setItem('__srv', JSON.stringify(S));
  localStorage.removeItem('marketplaceTest');
}, [inH(20), inH(5), inH(-2)]);

await signIn('/app.html');
check('switch off: no offers strip', !(await page.isVisible('#moStrip')));
await page.evaluate(() => signOut()); await wait(500);

await signIn('/app.html?marketplace=1');
await page.waitForSelector('#moStrip:not([style*="none"])', { timeout: 5000 }).catch(() => {});
check('strip: offers to answer', /3 offers to answer/.test(await page.textContent('#moStrip')), await page.textContent('#moStrip'));
await page.waitForFunction(() => /offers waiting|offered/.test(document.getElementById('toast').textContent), null, { timeout: 8000 }).catch(() => {});
check('toast for new offers', /3 offers waiting/.test(await page.textContent('#toast')), await page.textContent('#toast'));
await page.click('#moStrip button'); await wait(300);
const panel = await page.textContent('#moOverlay');
check('panel: offers with amount, % of price, card code and asking, buyer note, auto-declined in ended', /Alex P offers \$100/.test(panel)
  && /83% of your price/.test(panel) && /S-12/.test(panel) && /asking \$120/.test(panel) && /Cash Saturday/.test(panel)
  && /Declined automatically · below your lowest offer/.test(panel) && !/Nope/.test(panel), panel);
check('panel: contact links', (await page.getAttribute('[data-offer="o1"] .mh-contact a[href^="sms:"]', 'href')) === 'sms:5550100100');
check('panel: no sideways scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));

// counter
await page.click('[data-offer="o3"] button:has-text("Counter")');
await page.fill('#moCounter_o3 input', '50'); await page.click('#moCounter_o3 button[type=submit]'); await wait(300);
check('counter: at or above the price refused on the page', /less than \$40/.test(await page.textContent('#moCounter_o3 .mo-err')));
await page.fill('#moCounter_o3 input', '35'); await page.click('#moCounter_o3 button[type=submit]'); await wait(700);
let S = await srv();
check('counter: sent in cents, buyer emailed, shown as waiting on the buyer', off(S, 'o3').status === 'countered' && off(S, 'o3').amount_cents === 3500
  && notifies.includes('o3') && /Waiting on the buyer/.test(await page.textContent('#moOverlay')) && /2 offers to answer · 1 waiting on the buyer/.test(await page.textContent('#moStrip')));

// decline
await page.click('[data-offer="o2"] button:has-text("Decline")'); await wait(700);
S = await srv();
check('decline: offer declined, buyer emailed', off(S, 'o2').status === 'declined' && notifies.includes('o2'));

// accept → hold
await page.click('[data-offer="o1"] button:has-text("Accept")'); await wait(900);
S = await srv();
check('accept: becomes a hold for the buyer at $100, card held, buyer emailed', off(S, 'o1').status === 'accepted'
  && S.holds.some(h => h.agreed_cents === 10000 && h.status === 'active') && S.inventory.find(r => r.id === 'c1').listing_status === 'reserved'
  && notifies.includes('o1') && /on hold for Alex P at \$100/.test(await page.textContent('#toast')));
await page.evaluate(() => closeOffersPanel());
await page.waitForSelector('#mhStrip:not([style*="none"])', { timeout: 4000 }).catch(() => {});
check('the hold strip shows it', /1 card on hold/.test(await page.textContent('#mhStrip')));
await page.evaluate(() => openHoldsPanel()); await wait(300);
check('Holds panel: from an offer, agreed price', /From an offer: agreed \$100/.test(await page.textContent('#mhOverlay')));
await page.click('#mhOverlay .mh-hold:not(.mh-ended) .btn-primary'); await wait(500);
check('Sold to them: Sell Drawer has the agreed price filled in', (await page.inputValue('#sdPrice')) === '100'
  && /agreed \$100/.test(await page.textContent('#sdHoldText')));
await page.click('.pay-opt >> nth=0'); await page.evaluate(() => sdConfirm()); await wait(1200);
S = await srv();
check('sale at the agreed price: hold bought, card sold for $100', S.holds.find(h => h.agreed_cents === 10000).status === 'converted'
  && Number(S.inventory.find(r => r.id === 'c1').sold_price) === 100);
check('strip: no offers to answer, one waiting on the buyer', /^💬 1 waiting on the buyer/.test((await page.textContent('#moStrip')).trim()), await page.textContent('#moStrip'));

// bundle offer: two cards, one price
await page.evaluate(inH20 => { const S = window.__srv;
  S.inventory.find(r => r.id === 'c2').listing_status = 'active'; S.inventory.find(r => r.id === 'c2').reservation_id = null;
  S.inventory.push({ id: 'c5', seller_id: 'u1', card_title: '2023 Prizm Victor Wembanyama', price: 60, status: 'Available', listing_status: 'active', stock_code: 'R-9' });
  S.offers = S.offers.filter(o => o.id !== 'o3');
  S.offers.push({ id: 'ob', dealer_id: 'u1', listing_id: 'c2', listing_ids: ['c2', 'c5'], buyer_name: 'Bo', buyer_contact: 'bo@example.test', status: 'pending',
    amount_cents: 8000, offer_cents: 8000, last_by: 'buyer', moves: 1, history: [{ by: 'buyer', cents: 8000 }], expires_at: inH20 });
  localStorage.setItem('__srv', JSON.stringify(S)); }, inH(20));
await page.evaluate(() => fetchSellerInventoryFromDB(currentSeller).then(() => { renderSellerTable(getSellerInventory()); return moLoad({ quiet: true }); })); await wait(800);
await page.evaluate(() => openOffersPanel()); await wait(400);
const bp = await page.textContent('[data-offer="ob"]');
check('bundle: both cards listed with the total asking and % of it', /Bundle · 2 cards/.test(bp) && /Elly De La Cruz/.test(bp) && /Wembanyama/.test(bp)
  && /Asking together\s*\$100/.test(bp) && /80% of your price/.test(bp), bp);
await page.click('[data-offer="ob"] button:has-text("Counter")');
await page.fill('#moCounter_ob input', '100'); await page.click('#moCounter_ob button[type=submit]'); await wait(300);
check('bundle counter: must be under the total', /less than \$100/.test(await page.textContent('#moCounter_ob .mo-err')));
await page.evaluate(() => { const S = window.__srv; S.offers.find(o => o.id === 'ob').moves = 1; localStorage.setItem('__srv', JSON.stringify(S)); });
await page.click('[data-offer="ob"] button:has-text("Accept")'); await wait(900);
S = await srv();
const bh = S.holds.find(h => h.agreed_cents === 8000);
check('bundle accept: one hold over both cards at $80', bh && bh.listing_ids.length === 2 && ['c2', 'c5'].every(id => S.inventory.find(r => r.id === id).listing_status === 'reserved'),
  JSON.stringify(bh));
await page.evaluate(() => closeOffersPanel());
await page.evaluate(() => mhLoad({ quiet: true })); await wait(400);
await page.evaluate(() => openHoldsPanel()); await wait(300);
await page.click(`[data-hold="${bh.id}"] .btn-primary`); await wait(400);
const prices = await page.$$eval('#mhSaleOverlay input[data-i]', els => els.map(e => e.value));
check('Sold to them on a bundle: sale dialog, $80 split by asking ($40 + $60 → $32 + $48)', await page.isVisible('#mhSaleOverlay.open')
  && JSON.stringify(prices) === '["32.00","48.00"]' && /\$80/.test(await page.textContent('#mhSaleTotal')), JSON.stringify(prices));
await page.click('#mhSaleBtn'); await wait(200);
check('bundle sale: payment required', /how they paid/.test(await page.textContent('#mhSaleErr')));
await page.click('#mhSaleOverlay .mh-pay:has-text("Venmo")'); await page.click('#mhSaleBtn'); await wait(1500);
S = await srv();
check('bundle sale: hold bought, both cards sold at their split, Venmo', S.holds.find(h => h.id === bh.id).status === 'converted'
  && Number(S.inventory.find(r => r.id === 'c2').sold_price) === 32 && Number(S.inventory.find(r => r.id === 'c5').sold_price) === 48
  && S.inventory.find(r => r.id === 'c5').payment_method === 'Venmo' && /Sold 2 cards to Bo/.test(await page.textContent('#toast')),
  JSON.stringify(S.inventory.filter(r => ['c2','c5'].includes(r.id))));

// before the migration
await page.evaluate(() => { window.__moMissing = true; moReset(); moStart(); }); await wait(400);
check('migration not run: no strip, no errors', !(await page.isVisible('#moStrip')) && errors.length === 0);
await page.evaluate(() => { window.__moMissing = false; });

await page.evaluate(() => signOut()); await wait(500);
check('signed out: strip hidden', !(await page.isVisible('#moStrip')));
check('no page errors', errors.length === 0, JSON.stringify(errors));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
