// Marketplace holds, dealer side (js/marketplace-holds.js): strip, Holds panel, Release, "Sold to them" in the
// Sell Drawer, a held card sold to someone else. Run like the others:   node marketplace-holds.e2e.mjs "iPhone 13"
import { chromium, devices } from 'playwright';
import fs from 'fs';
const mock = fs.readFileSync(new URL('./mock-supabase.js', import.meta.url), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const deviceName = process.argv[2] || 'iPhone 13';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ ...devices[deviceName], serviceWorkers: 'block' });
const today = new Date().toLocaleDateString('en-CA');
await ctx.addInitScript(([today]) => {
  localStorage.setItem('smExited:tester', 'show_a|' + today);   // start in the classic view
  window.confirm = () => true;
}, [today]);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${ok ? '' : extra}`); };
const wait = ms => page.waitForTimeout(ms);
const srv = () => page.evaluate(() => JSON.parse(localStorage.getItem('__srv')));
const hold = (S, id) => S.holds.find(h => h.id === id);
const notifies = [];
await ctx.route('**/.netlify/functions/**', r => r.fulfill({ contentType: 'application/json', body: '{"success":false}' }));
// Registered after the catch-all so it wins (Playwright runs the newest matching route first).
await ctx.route('**/.netlify/functions/hold-notify-now', r => { notifies.push(JSON.parse(r.request().postData() || '{}').reservation_id); r.fulfill({ contentType: 'application/json', body: '{}' }); });
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
  S.inventory.find(r => r.id === 'c1').listing_status = 'reserved'; S.inventory.find(r => r.id === 'c1').reservation_id = 'h1';
  S.inventory.find(r => r.id === 'c2').listing_status = 'reserved'; S.inventory.find(r => r.id === 'c2').reservation_id = 'h2';
  S.inventory.find(r => r.id === 'c1').stock_code = 'S-12';
  S.inventory.push({ id: 'c4', seller_id: 'u1', card_title: '2020 Prizm Justin Herbert', price: 80, status: 'Available', listing_status: 'active' });
  S.holds = [
    { id: 'h1', dealer_id: 'u1', buyer_name: 'Alex P', buyer_contact: '(555) 010-0100', buyer_note: 'Saturday works', status: 'active', expires_at: inH20, listing_ids: ['c1'] },
    { id: 'h2', dealer_id: 'u1', buyer_name: 'Dee', buyer_contact: '@dee_cards', status: 'active', expires_at: inH5, listing_ids: ['c2'] },
    { id: 'h3', dealer_id: 'u1', buyer_name: 'Sam', buyer_contact: 'sam@example.test', status: 'released', end_reason: 'buyer_cancelled', ended_at: ago, expires_at: ago, listing_ids: ['c4'] },
    { id: 'hx', dealer_id: 'someone_else', buyer_name: 'Nope', buyer_contact: 'x', status: 'active', expires_at: inH5, listing_ids: ['zz'] },
  ];
  localStorage.setItem('__srv', JSON.stringify(S));
  localStorage.removeItem('marketplaceTest');
}, [inH(20), inH(5), inH(-2)]);

// ── switch off ──
await signIn('/app.html');
check('switch off: no holds strip', !(await page.isVisible('#mhStrip')));
await page.evaluate(() => signOut()); await wait(500);

// ── switch on ──
await signIn('/app.html?marketplace=1');
await page.waitForSelector('#mhStrip:not([style*="none"])', { timeout: 5000 }).catch(() => {});
const strip = await page.textContent('#mhStrip');
check('strip: cards on hold, for how many buyers, next end', /2 cards on hold/.test(strip) && /2 buyers/.test(strip) && /next one ends/.test(strip), strip);
await page.waitForFunction(() => /new holds|is holding/.test(document.getElementById('toast').textContent), null, { timeout: 6000 }).catch(() => {});
check('toast for new holds', /2 new holds/.test(await page.textContent('#toast')), await page.textContent('#toast'));
check('ON HOLD chips on both cards', (await page.locator('.mk-chip--hold').count()) >= 2);
await page.click('#mhStrip button'); await wait(300);
const panel = await page.textContent('#mhOverlay');
check('panel: buyers, notes, card with code and price, ended section', /Alex P/.test(panel) && /Saturday works/.test(panel) && /S-12/.test(panel)
  && /\$120/.test(panel) && /Ended recently/.test(panel) && /Buyer cancelled/.test(panel) && !/Nope/.test(panel), panel);
check('panel: phone → text/call links, @handle → Instagram',
  (await page.getAttribute('[data-hold="h1"] .mh-contact a[href^="sms:"]', 'href')) === 'sms:5550100100'
  && (await page.getAttribute('[data-hold="h2"] .mh-contact a', 'href')) === 'https://instagram.com/dee_cards');
check('panel: no sideways scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
await page.evaluate(() => closeHoldsPanel());
await page.evaluate(() => openCEM(inventory.findIndex(c => c._dbId === 'c1'))); await wait(200);
check('Edit Card names the buyer holding it', /Alex P is holding this card/.test(await page.textContent('#cem_mk_status')));
await page.evaluate(() => closeCEM());

// ── release ──
await page.evaluate(() => openHoldsPanel()); await wait(300);
await page.click('[data-hold="h2"] .btn-ghost'); await wait(600);
let S = await srv();
check('release: hold ended, card back on sale, buyer emailed now', hold(S, 'h2').status === 'released' && hold(S, 'h2').end_reason === 'dealer_released'
  && S.inventory.find(r => r.id === 'c2').listing_status === 'active' && notifies.includes('h2'));
check('release: strip down to one card', /1 card on hold/.test(await page.textContent('#mhStrip')));

// ── sold to them ──
await page.click('[data-hold="h1"] .btn-primary'); await wait(500);
check('Sold to them: Sell Drawer opens with the holder ticked', await page.isVisible('#sellDrawerOverlay.open')
  && await page.isChecked('#sdHoldTo') && /Sold to Alex P/.test(await page.textContent('#sdHoldText')));
await page.fill('#sdPrice', '115'); await page.click('.pay-opt >> nth=0'); await page.evaluate(() => sdConfirm()); await wait(1200);
S = await srv();
check('sale to the holder: hold ends as bought (not "sold to someone else"), card sold at the price',
  hold(S, 'h1').status === 'converted' && hold(S, 'h1').end_reason === 'sold_to_holder'
  && S.inventory.find(r => r.id === 'c1').status === 'Sold' && Number(S.inventory.find(r => r.id === 'c1').sold_price) === 115 && notifies.includes('h1'),
  JSON.stringify(hold(S, 'h1')));
check('strip gone once nothing is held', !(await page.isVisible('#mhStrip')));

// ── a held card sold to someone else ──
await page.evaluate(inH5 => { const S = window.__srv;
  S.holds.push({ id: 'h4', dealer_id: 'u1', buyer_name: 'Jo', buyer_contact: 'jo@example.test', status: 'active', expires_at: inH5, listing_ids: ['c4'] });
  const r = S.inventory.find(x => x.id === 'c4'); r.listing_status = 'reserved'; r.reservation_id = 'h4';
  localStorage.setItem('__srv', JSON.stringify(S)); }, inH(5));
await page.evaluate(() => mhLoad({ quiet: true })); await wait(400);
await page.evaluate(() => openSellDrawer(inventory.findIndex(c => c._dbId === 'c4'))); await wait(300);
check('ordinary sale of a held card: holder shown, not ticked, warns the hold ends',
  (await page.isVisible('#sdHoldWrap')) && !(await page.isChecked('#sdHoldTo')) && /hold ends and they get an email/.test(await page.textContent('#sdHoldNote')));
await page.fill('#sdPrice', '80'); await page.click('.pay-opt >> nth=0'); await page.evaluate(() => sdConfirm()); await wait(800);
S = await srv();
check('sold to someone else: hold broken (buyer gets the "sold at the table" email)', hold(S, 'h4').status === 'broken');
await page.evaluate(() => openSellDrawer(inventory.findIndex(c => c._dbId === 'c3' || c.Status !== 'Sold'))); await wait(200);
check('a card with no hold: no hold box in the Sell Drawer', !(await page.isVisible('#sdHoldWrap')));
await page.evaluate(() => closeSellDrawer());

// ── before the migration ──
await page.evaluate(() => { window.__mhMissing = true; mhReset(); mhStart(); }); await wait(400);
check('migration not run: no strip, no errors', !(await page.isVisible('#mhStrip')) && errors.length === 0);
await page.evaluate(() => { window.__mhMissing = false; });

// ── sign out ──
await page.evaluate(() => signOut()); await wait(500);
check('signed out: strip hidden', !(await page.isVisible('#mhStrip')));
check('no page errors', errors.length === 0, JSON.stringify(errors));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
