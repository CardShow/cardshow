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
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const CAT = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
let catalogQueries = [];
let catalogNoMatch = false;
let catalogMode = '';
const catTile = (id, i) => ({ id, title: `2023 Topps Chrome Card ${i + 1}`, year: '2023', release: 'Topps Chrome', number: String(i + 1),
  imageUrl: '/.netlify/functions/card-image?id=' + id });
await ctx.route('**/.netlify/functions/catalog-image-search', async r => {
  catalogQueries.push(JSON.parse(r.request().postData() || '{}'));
  const body = catalogMode === 'busy' ? { success: false, error: 'cardsight_http_429' }
    : catalogMode === 'parallel' ? { success: true, results: [{ ...catTile(CAT[0], 0), parallel: 'Tie-Dye' }], others: [] }
    : catalogMode === 'noimage' ? { success: true, results: [catTile(CAT[2], 2)], others: [] }
    : catalogNoMatch ? { success: true, results: [], others: [catTile(CAT[3], 3)] }
    : { success: true, results: CAT.slice(0, 3).map(catTile), others: [catTile(CAT[3], 3)] };
  r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
});
// The third catalog card has no image: its tile should disappear.
await ctx.route('**/.netlify/functions/card-image**', r => r.request().url().includes(CAT[2])
  ? r.fulfill({ status: 404, body: 'none' }) : r.fulfill({ contentType: 'image/png', body: PNG }));

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
    { id: 'c12', seller_id: 'u1', card_title: 'Raw Catalog Card', player: 'Elly', year: 2023, card_set: 'Topps Chrome', card_number: '2', price: 30, status: 'Available' },
    { id: 'c13', seller_id: 'u1', card_title: 'Slab Without Photo', player: 'Q', grader: 'PSA', grade: 9, cert_number: '4444', price: 200, status: 'Available' },
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
check('cards without a photo are blocked, with the reason', /No photo · 3/.test(blocked) && /Photo Needed Card/.test(blocked) && /graded cards need a photo of the slab/.test(blocked));
check('sealed product is not asked for a photo', !/Sealed Hobby Box/.test(blocked));
check('sold card not shown as blocked', !/Prizm Luka/.test(blocked));
check('take-off button hidden with nothing listed', await page.isDisabled('#mkDelistBtn') && !(await page.isVisible('#mkDelistBtn')));

// Bad percentages block listing
await page.fill('#mkMinPct', '90'); await page.fill('#mkAutoPct', '80');
await page.click('#mkListBtn'); await wait(300);
let S = await srv();
check('auto-accept below lowest offer is refused, nothing listed', /at or above/.test(await page.textContent('#mkErr')) && !S.inventory.some(r => r.listing_status === 'active'));

await page.fill('#mkMinPct', '80'); await page.fill('#mkAutoPct', '90'); await page.check('#mkPickup');
check('pickup show list: shows the seller is in', await page.evaluate(() =>
  [...document.querySelectorAll('#mkPickupShow option')].map(o => o.value).join(',') === ',show_a'));
await page.fill('#mkShipPrice', '-3');
await page.click('#mkListBtn'); await wait(300);
check('negative shipping refused', /Shipping must be a price/.test(await page.textContent('#mkErr')));
await page.fill('#mkShipPrice', '4.50'); await page.selectOption('#mkPickupShow', 'show_a');
await page.click('#mkListBtn'); await wait(700);
S = await srv();
check('c1 and c2 listed on the server', row(S, 'c1').listing_status === 'active' && row(S, 'c2').listing_status === 'active');
check('blocked cards stay unlisted', ['c7', 'c8', 'c9', 'c10', 'c12', 'c13'].every(id => !row(S, id).listing_status));
check('sealed box listed without a photo', row(S, 'c11').listing_status === 'active');
check('offer settings from percentages of asking (c1 $120)', row(S, 'c1').min_offer_cents === 9600 && row(S, 'c1').auto_accept_cents === 10800, JSON.stringify(row(S, 'c1')));
check('ship + pickup saved', JSON.stringify(row(S, 'c2').sale_modes) === '["ship","local_pickup"]');
check('shipping price and pickup show saved', row(S, 'c2').shipping_options?.flat_cents === 450 && row(S, 'c2').pickup_show_id === 'show_a',
  JSON.stringify(row(S, 'c2')));
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
check('Edit Card filled from the card', await page.evaluate(() => document.getElementById('cem_mk_min').value === '96' && document.getElementById('cem_mk_pickup').checked
  && document.getElementById('cem_mk_ship_price').value === '4.5' && document.getElementById('cem_mk_pickup_show').value === 'show_a'));
await page.evaluate(() => { document.getElementById('cem_mk_details').open = true; });
await page.fill('#cem_mk_auto', '500');
await page.evaluate(() => saveCEM()); await wait(300);
check('auto-accept above asking blocks Save', /above your asking/.test(await page.textContent('#cem_mk_err')) && await page.isVisible('#cardEditOverlay.open'));
await page.fill('#cem_mk_auto', '110'); await page.uncheck('#cem_mk_pickup'); await page.fill('#cem_mk_ship_price', '0');
check('pickup show hidden when pickup is off', !(await page.isVisible('#cem_mk_pickup_row')));
await page.evaluate(() => saveCEM()); await wait(600);
S = await srv();
check('Edit Card saves offer settings', row(S, 'c1').auto_accept_cents === 11000 && JSON.stringify(row(S, 'c1').sale_modes) === '["ship"]', JSON.stringify(row(S, 'c1')));
check('Edit Card: free shipping, pickup show cleared', row(S, 'c1').shipping_options?.flat_cents === 0 && row(S, 'c1').pickup_show_id === null);

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

// ── Online comp + suggested price (pricing service) ──
await page.evaluate(() => { const c = inventory.find(x => x._dbId === 'c2'); c.CompValueCents = 21000;
  c.CompRefreshedAt = new Date(Date.now() - 2 * 86400000).toISOString(); c.Price = 180; c.ListingStatus = 'active'; });
await page.evaluate(id => openCEM(inventory.findIndex(c => c._dbId === id)), 'c2'); await wait(200);
await page.evaluate(() => { document.getElementById('cem_mk_details').open = true; });
const compTxt = await page.textContent('#cem_mk_comp');
check('Edit Card shows the online comp, % under and age', /Online comp: \$210/.test(compTxt) && /14% under/.test(compTxt) && /2 days ago/.test(compTxt), compTxt);
await page.click('.mk-comp-use'); await wait(150);
check('"Use $210" fills the asking price', await page.inputValue('#cem_price') === '210');
await page.evaluate(() => { const c = inventory.find(x => x._dbId === 'c2'); c.CompValueCents = null; c.ListingStatus = 'delisted'; });
await page.evaluate(() => closeCEM());

await page.evaluate(id => openCEM(inventory.findIndex(c => c._dbId === id)), 'c7'); await wait(200);
check('blocked card says why and has no List button', /No asking price/.test(await page.textContent('#cem_mk_status')) && !(await page.isVisible('#cem_mk_btn')));
await page.evaluate(() => closeCEM());

// ── Photo section in Edit Card ──
await page.evaluate(id => openCEM(inventory.findIndex(c => c._dbId === id)), 'c10'); await wait(300);
check('Photo section shown at the top of Edit Card', await page.isVisible('#cem_photo_box'));
check('no-photo raw card: offers a photo and a catalog image',
  /No photo yet/.test(await page.textContent('#cem_photo_status')) && await page.isVisible('#cem_photo_take') && await page.isVisible('#cem_photo_stock'));
await page.evaluate(() => { document.getElementById('cem_mk_details').open = true; });
check('marketplace section points to the photo, no List button',
  /add a photo or pick a catalog image/i.test(await page.textContent('#cem_mk_status')) && !(await page.isVisible('#cem_mk_btn')));
const pic = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 50; c.height = 70;
  const x = c.getContext('2d'); x.fillStyle = '#c33'; x.fillRect(0, 0, 50, 70); return c.toDataURL('image/png').split(',')[1]; }), 'base64');
await page.setInputFiles('#cem_photo_input', { name: 'card.png', mimeType: 'image/png', buffer: pic });
await wait(2500);
S = await srv();
const firstCap = row(S, 'c10').primary_capture_id;
check('photo saved and linked to the card on the server', firstCap && S.card_captures.some(c => c.id === firstCap && c.inventory_id === 'c10'), JSON.stringify(row(S, 'c10')));
check('photo uploaded', S.storage.some(k => k.includes(firstCap)) && S.card_captures.find(c => c.id === firstCap).uploaded_at);
check('thumbnail shows the photo; catalog option gone', await page.isVisible('#cem_photo_thumb img') && !(await page.isVisible('#cem_photo_stock'))
  && /Replace photo/.test(await page.textContent('#cem_photo_take')));
check('Edit Card now offers List', await page.isVisible('#cem_mk_btn'));
await page.click('#cem_mk_btn'); await wait(600);
S = await srv();
check('card with its new photo lists', row(S, 'c10').listing_status === 'active');
// Replace the photo
await page.setInputFiles('#cem_photo_input', { name: 'card2.png', mimeType: 'image/png', buffer: pic });
await wait(2500);
S = await srv();
check('Replace photo makes the new photo the card\'s photo', row(S, 'c10').primary_capture_id && row(S, 'c10').primary_capture_id !== firstCap);
await page.evaluate(() => closeCEM());

// Graded card: photo of the slab only
await page.evaluate(id => openCEM(inventory.findIndex(c => c._dbId === id)), 'c13'); await wait(300);
check('graded card: asks for the slab, no catalog option',
  /exact slab/.test(await page.textContent('#cem_photo_status')) && !(await page.isVisible('#cem_photo_stock')) && /slab/.test(await page.textContent('#cem_photo_take')));
await page.evaluate(() => closeCEM());

// Raw card: pick a catalog image
await page.evaluate(id => openCEM(inventory.findIndex(c => c._dbId === id)), 'c12'); await wait(300);
await page.click('#cem_photo_stock'); await wait(1200);
check('catalog search uses the card details, title and features', catalogQueries.length === 1 && catalogQueries[0].player === 'Elly' && catalogQueries[0].cardNumber === '2'
  && catalogQueries[0].title === 'Raw Catalog Card' && Array.isArray(catalogQueries[0].features), JSON.stringify(catalogQueries));
check('exact matches shown; the one with no image is dropped', (await page.locator('#cem_photo_grid .cp-opt').count()) === 2);
check('other cards shown apart, closed, labeled not a match', await page.isVisible('#cem_photo_others') && !(await page.isVisible('#cem_photo_others .cp-opt'))
  && /not an exact match/.test(await page.textContent('#cem_photo_others summary')));
await page.locator('#cem_photo_grid .cp-opt').nth(1).click(); await wait(600);
S = await srv();
check('chosen catalog image saved', row(S, 'c12').stock_image_id === CAT[1] && row(S, 'c12').catalog_card_id === CAT[1]);
check('thumbnail shows the catalog image, labeled', await page.isVisible('#cem_photo_thumb img') && /Catalog/.test(await page.textContent('#cem_photo_thumb'))
  && await page.isVisible('#cem_photo_stock_remove'));
// Switching the card to graded in the form takes the catalog option away.
await page.selectOption('#cem_grader', 'PSA'); await wait(150);
check('setting a grader in the form: catalog image no longer counts', /exact slab/.test(await page.textContent('#cem_photo_status')) && !(await page.isVisible('#cem_photo_stock')));
await page.selectOption('#cem_grader', ''); await wait(150);
await page.evaluate(() => { document.getElementById('cem_mk_details').open = true; });
await page.click('#cem_mk_btn'); await wait(600);
S = await srv();
check('raw card lists with its catalog image', row(S, 'c12').listing_status === 'active');
await page.click('#cem_photo_stock_remove'); await wait(500);
S = await srv();
check('Remove catalog image', !row(S, 'c12').stock_image_id && !(await page.isVisible('#cem_photo_thumb img')));
// No exact match: says so, other cards still apart
catalogNoMatch = true;
await page.click('#cem_photo_stock'); await wait(1000);
check('no exact match: says so, no match grid, others closed', await page.isVisible('#cem_photo_nomatch') && !(await page.isVisible('#cem_photo_grid'))
  && /No exact catalog match/.test(await page.textContent('#cem_photo_nomatch')) && await page.isVisible('#cem_photo_others'));
catalogNoMatch = false;
// Parallel: base image, labeled with the card's parallel
catalogMode = 'parallel';
await page.fill('#cem_parallel', '17/49');
await page.click('#cem_photo_stock'); await wait(1000);
check('parallel: tile says base image and names the parallel', /Base image · your parallel: Tie-Dye/.test(await page.textContent('#cem_photo_grid'))
  && /base version/.test(await page.textContent('#cem_photo_options')));
check('print run sent with the search', catalogQueries[catalogQueries.length - 1].parallel === '17/49');
// Exact match whose image is missing: says the catalog has it
catalogMode = 'noimage';
await page.fill('#cem_parallel', '');
await page.click('#cem_photo_stock'); await wait(1000);
check('exact match with no image: names the card, asks for a photo', /catalog has this card \(2023 Topps Chrome Card 3\) but no image/.test(await page.textContent('#cem_photo_nomatch')));
// Catalog busy: says so, offers Try again
catalogMode = 'busy';
await page.click('#cem_photo_stock'); await wait(1000);
check('catalog busy: says busy, not "no match"', /busy/.test(await page.textContent('#cem_photo_failed')) && !(await page.isVisible('#cem_photo_nomatch')));
catalogMode = '';
// A grader named in the title makes it a graded card
await page.fill('#cem_title', '2018 Leaf NSC Shohei Ohtani Rookie TAG'); await wait(150);
check('grader in the title: treated as graded, says so, no catalog option', /title says TAG/.test(await page.textContent('#cem_photo_status'))
  && !(await page.isVisible('#cem_photo_stock')) && !(await page.isVisible('#cem_photo_options .cp-opt')));
await page.fill('#cem_title', '2021 Topps Tag Team Insert'); await wait(150);
check('ordinary word "Tag" in the title: still a raw card', (await page.isVisible('#cem_photo_stock')) && !/title says/.test(await page.textContent('#cem_photo_status')));
await page.evaluate(() => closeCEM());

// ── Sign out hides it ──
await page.evaluate(() => signOut()); await wait(500);
check('signed out: button hidden', !(await page.isVisible('#mkBtn')));
check('no page errors', errors.length === 0, JSON.stringify(errors));

await browser.close();
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
