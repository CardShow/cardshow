// Marketplace dealer listing controls (js/marketplace-dealer.js). Run like the others:
//   node marketplace-dealer.e2e.mjs "iPhone 13"
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
page.on('console', m => { if (process.env.DEBUG && /marketplace|show-mode/.test(m.text())) console.log('  console:', m.text()); });
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${extra}`); };
const wait = ms => page.waitForTimeout(ms);
const srv = () => page.evaluate(() => JSON.parse(localStorage.getItem('__srv')));
const row = (S, id) => S.inventory.find(r => r.id === id);
const idxOf = id => page.evaluate(id => inventory.findIndex(c => c._dbId === id), id);

await ctx.route('**/.netlify/functions/**', r => r.fulfill({ contentType: 'application/json', body: '{"success":false}' }));
await ctx.route('**/supabase-js@2*', r => r.fulfill({ contentType: 'application/javascript', body: mock }));
await ctx.route('https://fonts.**', r => r.fulfill({ body: '' }));

async function signIn(url) {
  await page.goto(BASE + url); await wait(400);
  await page.fill('#authEmail', 't@x.com'); await page.fill('#authPassword', 'password1');
  await page.evaluate(() => submitAuth());
  await wait(2500);
}

await page.goto(BASE + '/app.html'); await wait(400);
await page.evaluate(() => {
  const S = window.__srv;
  S.inventory.push(
    { id: 'c7', seller_id: 'u1', card_title: 'No Price Card', player: 'X', price: 0, status: 'Available' },
    { id: 'c8', seller_id: 'u1', card_title: 'Flagged Slab', player: 'Y', grader: 'PSA', grade: 10, cert_number: '999', price: 500, status: 'Available', trust_flag: 'flagged' },
    { id: 'c9', seller_id: 'u1', card_title: 'Traded In Card', player: 'Z', price: 25, status: 'Available', identification_status: 'unidentified' },
    { id: 'zz', seller_id: 'someone_else', card_title: 'Not mine', price: 10, status: 'Available' },
    { id: 'c10', seller_id: 'u1', card_title: 'Photo Needed Card', player: 'P', price: 60, status: 'Available' },
    { id: 'c11', seller_id: 'u1', card_title: 'Sealed Hobby Box', price: 150, status: 'Available', item_type: 'sealed' },
  );
  // c1 and c2 already have uploaded seller photos.
  S.card_captures.push(
    { id: 'p1', seller_id: 'u1', entry_point: 'case_scan', crop_key: 'u1/p1/crop.jpg', uploaded_at: new Date().toISOString(), status: 'attached', inventory_id: 'c1' },
    { id: 'p2', seller_id: 'u1', entry_point: 'case_scan', crop_key: 'u1/p2/crop.jpg', uploaded_at: new Date().toISOString(), status: 'attached', inventory_id: 'c2' });
  S.inventory.find(r => r.id === 'c1').primary_capture_id = 'p1';
  S.inventory.find(r => r.id === 'c2').primary_capture_id = 'p2';
  localStorage.setItem('__srv', JSON.stringify(S));
  localStorage.removeItem('marketplaceTest');
});

// ── Switch off ──
await signIn('/app.html');
check('switch off: no Marketplace button', !(await page.isVisible('#mkBtn')));
await page.evaluate(id => openCEM(inventory.findIndex(c => c._dbId === id)), 'c1'); await wait(200);
check('switch off: no Marketplace section in Edit Card', !(await page.isVisible('#cem_mk_details')));
await page.evaluate(() => closeCEM());
check('switch off: no listing chips', !(await page.locator('.mk-chip').count()));

// ── Switch on (?marketplace=1) ──
await page.evaluate(() => signOut()); await wait(500);
await signIn('/app.html?marketplace=1');
check('test switch remembered', await page.evaluate(() => localStorage.getItem('marketplaceTest') === '1'));
check('Marketplace button shown to the seller', await page.isVisible('#mkBtn'));
await page.click('#mkBtn'); await wait(200);
check('panel opens', await page.isVisible('#mkOverlay.open .mk-modal'));
const listBtn = await page.textContent('#mkListBtn');
check('List button counts only listable cards (c1, c2, sealed c11)', /List 3 cards/.test(listBtn), listBtn);
check('panel uses the shared modal layout', await page.evaluate(() => {
  const m = document.querySelector('#mkOverlay .mk-modal');
  const pad = el => parseFloat(getComputedStyle(el).paddingLeft);
  return !!m.querySelector(':scope > .modal-header') && pad(m.querySelector(':scope > .modal-body')) >= 16
    && pad(m.querySelector(':scope > .modal-actions')) >= 16 && pad(m.querySelector(':scope > .modal-header')) >= 16; }));
const blocked = await page.textContent('#mkOverlay');
check('blocked cards grouped by reason', /No asking price · 1/.test(blocked) && /Stolen \/ lost report · 1/.test(blocked) && /Needs details · 1/.test(blocked));
check('card without a photo is blocked, with the reason', /No photo of the card · 1/.test(blocked) && /Photo Needed Card/.test(blocked) && /Buyers need to see the actual card/.test(blocked));
check('sealed product is not asked for a photo', !/Sealed Hobby Box/.test(blocked));
check('sold card not shown as blocked', !/Prizm Luka/.test(blocked));
check('take-off button hidden with nothing listed', await page.isDisabled('#mkDelistBtn') && !(await page.isVisible('#mkDelistBtn')));

// Bad percentages block listing
await page.fill('#mkMinPct', '90'); await page.fill('#mkAutoPct', '80');
await page.click('#mkListBtn'); await wait(300);
let S = await srv();
check('auto-accept below lowest offer is refused, nothing listed', /at or above/.test(await page.textContent('#mkErr')) && !S.inventory.some(r => r.listing_status === 'active'));

await page.fill('#mkMinPct', '80'); await page.fill('#mkAutoPct', '90'); await page.check('#mkPickup');
await page.click('#mkListBtn'); await wait(700);
S = await srv();
check('c1 and c2 listed on the server', row(S, 'c1').listing_status === 'active' && row(S, 'c2').listing_status === 'active');
check('blocked cards stay unlisted', ['c7', 'c8', 'c9', 'c10'].every(id => !row(S, id).listing_status));
check('sealed box listed without a photo', row(S, 'c11').listing_status === 'active');
check('offer settings from percentages of asking (c1 $120)', row(S, 'c1').min_offer_cents === 9600 && row(S, 'c1').auto_accept_cents === 10800, JSON.stringify(row(S, 'c1')));
check('ship + pickup saved', JSON.stringify(row(S, 'c2').sale_modes) === '["ship","local_pickup"]');
check('settings written before listing', await page.evaluate(() => {
  const L = window.__mockLog; const u = L.findIndex(e => e.table === 'inventory' && e.op === 'update' && e.payload && 'min_offer_cents' in e.payload);
  const p = L.findIndex(e => e.op === 'publish_listings'); return u >= 0 && p > u; }));
check('result message', /3 cards listed/.test(await page.textContent('.mk-result')));
check('listing never written directly from the app', await page.evaluate(() => !window.__mockLog.some(e => e.payload && 'listing_status' in Object(e.payload) && e.table === 'inventory')));
check('defaults remembered for next time', await page.evaluate(() => JSON.parse(localStorage.getItem('mkDefaults:tester')).minPct === '80'));
await page.click('.mk-x'); await wait(200);
check('LISTED chips in the table', (await page.locator('.mk-chip--on').count()) === 3);

// No sideways scroll with the panel open
await page.click('#mkBtn'); await wait(200);
check('no sideways scroll with the panel open', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

// Take off
await page.click('#mkDelistBtn'); await wait(600);
S = await srv();
check('all taken off', ['c1', 'c2', 'c11'].every(id => row(S, id).listing_status === 'delisted'));
check('chips gone', (await page.locator('.mk-chip--on').count()) === 0);
await page.click('.mk-x'); await wait(200);

// ── Edit Card section ──
await page.evaluate(id => openCEM(inventory.findIndex(c => c._dbId === id)), 'c1'); await wait(200);
check('Edit Card shows the Marketplace section', await page.isVisible('#cem_mk_details'));
check('Edit Card filled from the card', await page.evaluate(() => document.getElementById('cem_mk_min').value === '96' && document.getElementById('cem_mk_pickup').checked));
await page.evaluate(() => { document.getElementById('cem_mk_details').open = true; });
await page.fill('#cem_mk_auto', '500');
await page.evaluate(() => saveCEM()); await wait(300);
check('auto-accept above asking blocks Save', /above your asking/.test(await page.textContent('#cem_mk_err')) && await page.isVisible('#cardEditOverlay.open'));
await page.fill('#cem_mk_auto', '110'); await page.uncheck('#cem_mk_pickup');
await page.evaluate(() => saveCEM()); await wait(600);
S = await srv();
check('Edit Card saves offer settings', row(S, 'c1').auto_accept_cents === 11000 && JSON.stringify(row(S, 'c1').sale_modes) === '["ship"]', JSON.stringify(row(S, 'c1')));

await page.evaluate(id => openCEM(inventory.findIndex(c => c._dbId === id)), 'c2'); await wait(200);
await page.evaluate(() => { document.getElementById('cem_mk_details').open = true; });
check('Edit Card button offers to list', /List on marketplace/.test(await page.textContent('#cem_mk_btn')));
await page.click('#cem_mk_btn'); await wait(600);
S = await srv();
check('List from Edit Card', row(S, 'c2').listing_status === 'active' && /Take off/.test(await page.textContent('#cem_mk_btn')));
await page.click('#cem_mk_btn'); await wait(600);
S = await srv();
check('Take off from Edit Card', row(S, 'c2').listing_status === 'delisted');
await page.evaluate(() => closeCEM());

await page.evaluate(id => openCEM(inventory.findIndex(c => c._dbId === id)), 'c7'); await wait(200);
check('blocked card says why and has no List button', /No asking price/.test(await page.textContent('#cem_mk_status')) && !(await page.isVisible('#cem_mk_btn')));
await page.evaluate(() => closeCEM());

// ── Add a photo from Edit Card ──
await page.evaluate(id => openCEM(inventory.findIndex(c => c._dbId === id)), 'c10'); await wait(200);
await page.evaluate(() => { document.getElementById('cem_mk_details').open = true; });
check('no-photo card: says so, offers Add photo, no List button',
  /add a photo/i.test(await page.textContent('#cem_mk_status')) && await page.isVisible('#cem_mk_photo_btn') && !(await page.isVisible('#cem_mk_btn')));
const png = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 50; c.height = 70;
  const x = c.getContext('2d'); x.fillStyle = '#c33'; x.fillRect(0, 0, 50, 70); return c.toDataURL('image/png').split(',')[1]; }), 'base64');
await page.setInputFiles('#cem_mk_photo_input', { name: 'card.png', mimeType: 'image/png', buffer: png });
await wait(2500);
if (process.env.DEBUG) console.log('  toast:', await page.textContent('#toast'));
S = await srv();
check('photo saved and linked to the card on the server', row(S, 'c10').primary_capture_id && S.card_captures.some(c => c.id === row(S, 'c10').primary_capture_id && c.inventory_id === 'c10'), JSON.stringify(row(S, 'c10')));
check('photo uploaded', S.storage.some(k => k.includes(row(S, 'c10').primary_capture_id)) && S.card_captures.find(c => c.id === row(S, 'c10').primary_capture_id).uploaded_at);
check('Edit Card now offers List', await page.isVisible('#cem_mk_btn') && !(await page.isVisible('#cem_mk_photo_btn')));
await page.click('#cem_mk_btn'); await wait(600);
S = await srv();
check('card with its new photo lists', row(S, 'c10').listing_status === 'active');
await page.evaluate(() => closeCEM());

// ── Offline / not set up ──
await page.evaluate(() => localStorage.setItem('__offline', '1'));
await page.click('#mkBtn'); await wait(200);
await page.click('#mkListBtn'); await wait(300);
check('offline: listing asks for a signal', /needs a signal/i.test(await page.textContent('#toast')));
await page.evaluate(() => localStorage.setItem('__offline', '0'));
await page.evaluate(() => { window.__mkMissing = true; });
await page.click('#mkListBtn'); await wait(500);
check('migration not run: clear message', /isn.t set up/.test(await page.textContent('#mkOverlay')));
await page.evaluate(() => { window.__mkMissing = false; });
await page.click('.mk-x'); await wait(200);

// ── A card on hold for a buyer ──
await page.evaluate(() => { const S = JSON.parse(localStorage.getItem('__srv')); S.inventory.find(r => r.id === 'c2').listing_status = 'reserved'; localStorage.setItem('__srv', JSON.stringify(S)); });
await page.evaluate(() => signOut()); await wait(500);
await signIn('/app.html');
check('ON HOLD chip', (await page.locator('.mk-chip--hold').count()) === 1);
await page.evaluate(id => openCEM(inventory.findIndex(c => c._dbId === id)), 'c2'); await wait(200);
check('held card: settings locked, no List button', await page.evaluate(() => document.getElementById('cem_mk_accept').disabled) && !(await page.isVisible('#cem_mk_btn')));
await page.evaluate(() => closeCEM());

// ── Sign out hides it ──
await page.evaluate(() => signOut()); await wait(500);
check('signed out: button hidden', !(await page.isVisible('#mkBtn')));
check('no page errors', errors.length === 0, JSON.stringify(errors));

await browser.close();
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
