// Buyer site end to end: `astro dev` against test/mock-supabase.mjs, driven by Playwright.
//   node test/site.e2e.mjs ["iPhone 13" | "Desktop Chrome"]      (from buyer/, after npm install)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium, devices } = createRequire(import.meta.url)('playwright'); // pre-installed globally
import { start } from './mock-supabase.mjs';

const deviceName = process.argv[2] || 'iPhone 13';
const PORT = 4300 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${ok ? '' : extra}`); };
const wait = ms => new Promise(r => setTimeout(r, ms));

const mock = await start();
const dev = spawn('npx', ['astro', 'dev', '--port', String(PORT), '--host', 'localhost', '--ignore-lock'], {
  detached: true,
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, SUPABASE_URL: mock.url, SUPABASE_ANON_KEY: 'anon-test', MARKETPLACE_SITE_URL: mock.url, ASTRO_TELEMETRY_DISABLED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let devLog = '';
dev.stdout.on('data', d => { devLog += d; }); dev.stderr.on('data', d => { devLog += d; });
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/search')).status) break; } catch {} await wait(500); }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ ...devices[deviceName], serviceWorkers: 'block' });
await ctx.route('https://fonts.**', r => r.fulfill({ body: '' }));
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const tiles = () => page.locator('.grid .tile').count();
const CHAR = '11111111-1111-4111-8111-111111111111';
const CHAR_URL = `/c/${CHAR}-1999-pokemon-base-set-charizard-holo-psa-10`;

try {
  // ── search ──
  let res = await page.goto(BASE + '/search');
  check('search: 200, noindex until launch (meta + header)', res.status() === 200
    && (await page.getAttribute('meta[name=robots]', 'content')) === 'noindex, nofollow' && res.headers()['x-robots-tag'] === 'noindex, nofollow');
  check('search: CDN caches the page for a minute', /s-maxage=60/.test(res.headers()['netlify-cdn-cache-control'] || ''), JSON.stringify(res.headers()));
  check('search: active listings only, with the count', (await tiles()) === 2 && /2 cards/.test(await page.textContent('.results-head')));
  const t0 = page.locator(`.tile[data-listing="${CHAR}"]`);
  const t0text = await t0.textContent();
  check('tile: grade, deal, GTCR, price, market and % under, show', /PSA 10/.test(t0text) && /Deal/.test(t0text) && /GTCR/.test(t0text)
    && /\$18,000/.test(t0text) && /Market \$21,000/.test(t0text) && /14% under market/.test(t0text) && /Monster Show/.test(t0text), t0text);
  check('tile: dealer photo from the public bucket', (await t0.locator('img').getAttribute('src')) === `${mock.url}/storage/v1/object/public/listing-photos/${CHAR}/cap.jpg`);
  check('tile: catalog image is labeled', /Catalog image/.test(await page.locator('.tile[data-listing^="2222"]').textContent()));
  const catImg = page.locator('.tile[data-listing^="2222"] img');
  await catImg.evaluate(img => img.complete || new Promise(r => { img.onload = r; img.onerror = r; }));
  const catW = await catImg.evaluate(img => [img.getBoundingClientRect().width, img.naturalWidth]);
  check('tile: catalog image shown at most its own size, not stretched', catW[1] === 160 && catW[0] <= 160.5, JSON.stringify(catW));
  check('search: no sideways scroll', await noSideScroll());

  await page.fill('#headQ', 'charizard'); await page.press('#headQ', 'Enter'); await page.waitForURL(/q=charizard/);
  check('header search: one result, heading shows the query', (await tiles()) === 1 && /charizard/.test(await page.textContent('h1')));
  await page.goto(BASE + '/search?q=zzzz');
  check('no results: explained, with save-search nudge', (await tiles()) === 0 && /No cards match yet/.test(await page.textContent('main')));

  // filters
  await page.goto(BASE + '/search');
  if (!(await page.isVisible('#filterForm'))) await page.click('#filterBox summary');
  await page.selectOption('select[name=graded]', 'raw');
  await Promise.all([page.waitForNavigation(), page.click('#filterForm button[type=submit]')]);
  const u = new URL(page.url());
  check('filters: only filled fields in the URL', u.searchParams.get('graded') === 'raw' && !u.searchParams.has('category') && !u.searchParams.has('miles') && !u.searchParams.has('min'), u.search);
  check('filters: raw only → the raw card, Clear shown', (await tiles()) === 1 && await page.isVisible('a.btn:has-text("Clear")'));
  check('filtered pages are noindex anyway', (await page.getAttribute('meta[name=robots]', 'content')).startsWith('noindex'));

  // near a ZIP code or city
  mock.state.calls.length = 0;
  await page.goto(BASE + '/search?loc=95814&miles=25');
  const nearCall = mock.state.calls.find(c => c.path.endsWith('/search_listings'));
  check('near a ZIP: looked up, searched by distance, heading names it', nearCall && Math.abs(nearCall.body.p.near.lat - 38.58) < 0.05
    && nearCall.body.p.near.miles === 25 && /Cards near 95814/.test(await page.textContent('h1')) && /3\.2 mi/.test(await page.textContent('.grid')),
    JSON.stringify(nearCall?.body));
  check('near a ZIP: Nearest sort offered, box keeps the ZIP', (await page.locator('select[name=sort] option[value=distance]').count()) === 1
    && (await page.inputValue('#locInput')) === '95814');
  await page.goto(BASE + '/search?loc=Nowhereville%2C%20CA');
  check('unknown place: explained, searches everywhere', /couldn’t find “Nowhereville, CA”/.test(await page.textContent('#locError')) && (await tiles()) === 2);
  await page.goto(BASE + '/search?loc=springfield');
  check('city in several states: asks for the state', /Add the state/.test(await page.textContent('#locError')));
  await page.goto(BASE + '/search');
  if (!(await page.isVisible('#filterForm'))) await page.click('#filterBox summary');
  await page.fill('#locInput', 'Sacramento, CA');
  await Promise.all([page.waitForNavigation(), page.click('#filterForm button[type=submit]')]);
  const nu = new URL(page.url());
  check('typing a city in the filters', nu.searchParams.get('loc') === 'Sacramento, CA' && nu.searchParams.get('miles') === '50' && /Cards near Sacramento, CA/.test(await page.textContent('h1')), nu.search);

  // ── listing page ──
  res = await page.goto(BASE + CHAR_URL);
  check('listing: 200, title, price', res.status() === 200 && /Charizard Holo PSA 10/.test(await page.textContent('h1')) && (await page.textContent('.price')).trim() === '$18,000');
  const comp = await page.textContent('.comp');
  check('listing: market value, % under, range, sales, updated', /\$21,000/.test(comp) && /14% under market/.test(comp) && /\$19,000–\$23,000/.test(comp)
    && /last 30 days\s*6/.test(comp.replace(/\s+/g, ' ')) && /2 days ago/.test(comp), comp);
  check('listing: GTCR clear with the cert', /No stolen or lost report/.test(await page.textContent('.gtcr')) && /12345678/.test(await page.textContent('.gtcr')));
  const buy = await page.textContent('.buy');
  check('listing: how to buy — show, dates, table', /Monster Show/.test(buy) && /Table 12/.test(buy) && /Sacramento, CA/.test(buy), buy);
  const wa = await page.getAttribute('a:has-text("WhatsApp")', 'href');
  check('listing: WhatsApp link with a prefilled message', wa.startsWith('https://wa.me/15551234567?text=') && decodeURIComponent(wa).includes('$18,000'), wa);
  const del = await page.textContent('.delivery');
  check('listing: shipping price and pickup show', /Ships for \$5\.00/.test(del) && /Pick up at Monster Show/.test(del), del);
  check('listing: show links to its show page', (await page.getAttribute('.show a', 'href')) === '/s/monster-show-2026' && /Pickup show/.test(buy));
  check('listing: Instagram link', (await page.getAttribute('a:has-text("Instagram")', 'href')) === 'https://instagram.com/dealer_a');
  const ld = JSON.parse(await page.textContent('script[type="application/ld+json"]'));
  check('listing: schema.org Product + Offer', ld['@type'] === 'Product' && ld.offers.price === '18000.00' && ld.offers.priceCurrency === 'USD'
    && ld.offers.availability === 'https://schema.org/InStock' && ld.sku === CHAR && ld.offers.seller.name === 'Dealer A', JSON.stringify(ld));
  check('listing: canonical + link preview image', (await page.getAttribute('link[rel=canonical]', 'href')).endsWith(CHAR_URL)
    && (await page.getAttribute('meta[property="og:image"]', 'content')).includes('/listing-photos/'));
  check('listing: details table', /Card #\s*4/.test((await page.textContent('.details')).replace(/\s+/g, ' ')) && /RC/.test(await page.textContent('.details')));
  await wait(500);
  check('listing: asks for a fresh market value', mock.state.refresh.includes(CHAR));
  check('listing: no sideways scroll', await noSideScroll());

  res = await page.goto(BASE + `/c/${CHAR}-wrong-slug?ref=x`);
  check('old slug → canonical URL (301), query kept', page.url() === BASE + CHAR_URL + '?ref=x');
  await page.goto(BASE + '/c/33333333-3333-4333-8333-333333333333-wemby-prizm-bgs-9-5');
  check('on hold: chip, few-sales note, over market, no WhatsApp, LimitedAvailability', /On hold/.test(await page.textContent('.chips'))
    && /less certain/.test(await page.textContent('.comp')) && /12% over market/.test(await page.textContent('.comp'))
    && !(await page.isVisible('a:has-text("WhatsApp")'))
    && JSON.parse(await page.textContent('script[type="application/ld+json"]')).offers.availability.endsWith('LimitedAvailability'));
  mock.state.refresh.length = 0;
  await page.goto(BASE + '/c/22222222-2222-4222-8222-222222222222-2024-prizm-jayden-daniels-silver');
  const lp = page.locator('.media.is-catalog .frame img');
  await lp.evaluate(img => img.complete || new Promise(r => { img.onload = r; img.onerror = r; }));
  const lpW = await lp.evaluate(img => [img.getBoundingClientRect().width, img.naturalWidth]);
  check('listing: catalog image framed at its own size, not stretched', lpW[1] === 160 && lpW[0] <= 160.5
    && /Catalog image/.test(await page.textContent('.media')), JSON.stringify(lpW));
  check('listing: no sideways scroll with a catalog image', await noSideScroll());
  await wait(300); const refreshBefore = mock.state.refresh.length;
  await page.goto(BASE + '/c/44444444-4444-4444-8444-444444444444-sold-card'); await wait(300);
  check('sold: chip, no how-to-buy, SoldOut, no refresh asked', /Sold/.test(await page.textContent('.chips')) && !(await page.isVisible('.buy'))
    && JSON.parse(await page.textContent('script[type="application/ld+json"]')).offers.availability.endsWith('SoldOut') && mock.state.refresh.length === refreshBefore);
  res = await page.goto(BASE + '/c/55555555-5555-4555-8555-555555555555-gone');
  check('unknown listing → 404 page', res.status() === 404 && /isn’t listed any more/.test(await page.textContent('h1')));
  res = await page.goto(BASE + '/c/not-a-uuid');
  check('bad id → 404', res.status() === 404, String(res.status()));

  // ── storefront ──
  res = await page.goto(BASE + '/d/dealer_a');
  check('storefront: name, count, Instagram, their cards', res.status() === 200 && /Dealer A/.test(await page.textContent('h1'))
    && /1 card listed/.test(await page.textContent('.store-head')) && (await tiles()) === 1);
  await page.goto(BASE + '/d/DEALER_A');
  check('storefront: handle case → canonical', page.url() === BASE + '/d/dealer_a');
  res = await page.goto(BASE + '/d/nobody');
  check('storefront: unknown dealer → 404', res.status() === 404);

  // ── show page ──
  res = await page.goto(BASE + '/s/monster-show-2026');
  check('show page: 200, name, dates, place, card count', res.status() === 200 && /Monster Show/.test(await page.textContent('h1'))
    && /Cal Expo, Sacramento, CA/.test(await page.textContent('.when')) && /1\s*card listed/.test(await page.textContent('.count')));
  check('show page: dealers with table numbers', (await page.locator('.dealer-chip').count()) === 2 && /Table 12/.test(await page.textContent('.dealer-chip >> nth=0')));
  check('show page: its cards', (await tiles()) === 1 && (await page.locator(`.tile[data-listing="${CHAR}"]`).count()) === 1);
  check('show page: links to the floor map and website', (await page.getAttribute('.links a >> nth=0', 'href')).endsWith('/show.html?id=show_monster')
    && (await page.getAttribute('.links a >> nth=1', 'href')) === 'https://monster.example');
  const ev = JSON.parse(await page.textContent('script[type="application/ld+json"]'));
  check('show page: schema.org Event', ev['@type'] === 'Event' && ev.location.address.addressLocality === 'Sacramento' && ev.startDate, JSON.stringify(ev));
  check('show page: no sideways scroll', await noSideScroll());
  await Promise.all([page.waitForNavigation(), page.click('.dealer-chip >> nth=1')]);
  check('show page: tap a dealer → only their cards here', /dealer=dealer_b/.test(page.url()) && (await tiles()) === 0 && /from Dealer B/.test(await page.textContent('#showResults')));
  await page.goto(BASE + '/s/monster-show-2026?q=zzz');
  check('show page: search within the show', (await tiles()) === 0 && /No cards match/.test(await page.textContent('main')));
  await page.goto(BASE + '/s/show_monster?x=1');
  check('show page: id → slug (301)', page.url() === BASE + '/s/monster-show-2026?x=1');
  res = await page.goto(BASE + '/s/nope');
  check('show page: unknown show → 404', res.status() === 404);

  // ── storefront filters ──
  await page.goto(BASE + '/d/dealer_a');
  await page.fill('#storeFilters [name=q]', 'zzz');
  await Promise.all([page.waitForNavigation(), page.click('#storeFilters button[type=submit]')]);
  let su = new URL(page.url());
  check('storefront: search within a dealer, empty fields left out of the URL', su.pathname === '/d/dealer_a' && su.searchParams.get('q') === 'zzz'
    && !su.searchParams.has('category') && !su.searchParams.has('sort') && (await tiles()) === 0 && /No cards match/.test(await page.textContent('main')), su.search);
  check('storefront: filtered page is noindex, with a clear link', (await page.getAttribute('meta[name=robots]', 'content')).startsWith('noindex')
    && (await page.getAttribute('#storeResults a', 'href')) === '/d/dealer_a');
  mock.state.calls.length = 0;
  await page.goto(BASE + '/d/dealer_a?category=TCG&graded=graded&max=20000');
  const sc = mock.state.calls.find(c => c.path.endsWith('/search_listings'));
  check('storefront: category, graded and price go to search with the dealer', sc && sc.body.p.dealer === 'dealer_a' && sc.body.p.category === 'TCG'
    && sc.body.p.raw === false && sc.body.p.price_max_cents === 2000000 && (await tiles()) === 1, JSON.stringify(sc?.body));
  await page.goto(BASE + '/d/dealer_a?graded=raw');
  check('storefront: raw only → none for this dealer', (await tiles()) === 0);
  check('storefront: no sideways scroll with filters', await noSideScroll());

  // ── upcoming shows ──
  res = await page.goto(BASE + '/shows');
  check('shows: 200, the show with dates, place and card count, linked to its page', res.status() === 200
    && /Upcoming card shows/.test(await page.textContent('h1')) && (await page.locator('.show-card').count()) === 1
    && /Cal Expo · Sacramento, CA/.test(await page.textContent('.show-card')) && /1\s*card listed/.test(await page.textContent('.show-card'))
    && (await page.getAttribute('.show-card .show-main', 'href')) === '/s/monster-show-2026');
  check('header links to Shows', (await page.getAttribute('.site-head a[href="/shows"]', 'href')) === '/shows');
  check('shows: no sideways scroll', await noSideScroll());
  await page.fill('#showFilters [name=loc]', '95814');
  await Promise.all([page.waitForNavigation(), page.click('#showFilters button[type=submit]')]);
  check('shows near a ZIP: looked up, distance shown, heading names it', Math.abs(mock.state.showArgs.near.lat - 38.58) < 0.05
    && mock.state.showArgs.near.miles === 50 && /near 95814/.test(await page.textContent('h1')) && /4\.1 mi/.test(await page.textContent('.show-card'))
    && !new URL(page.url()).searchParams.has('state'));
  await page.goto(BASE + '/shows?state=TX');
  check('shows in another state: none, explained', (await page.locator('.show-card').count()) === 0 && /No listed shows match/.test(await page.textContent('main'))
    && mock.state.showArgs.state === 'TX');
  await page.goto(BASE + '/shows?when=weekend');
  check('shows this weekend: date window sent', !!mock.state.showArgs.date_from && !!mock.state.showArgs.date_to);
  await page.goto(BASE + '/shows?loc=Nowhereville%2C%20CA');
  check('shows: unknown place explained', /couldn’t find/.test(await page.textContent('#locError')) && (await page.locator('.show-card').count()) === 1);

  // ── save a search (sign in first) ──
  await page.goto(BASE + '/search?q=charizard&deals=1');
  await page.click('#saveSearch');
  await page.waitForURL(/\/account\?next=save/);
  check('save while signed out → sign in page', await page.isVisible('#signedOut'));
  await page.fill('#authForm [name=email]', 'buyer@example.test');
  await page.fill('#authForm [name=password]', 'wrong-pass');
  await page.click('#authSubmit'); await wait(400);
  check('wrong password explained', /Wrong email or password/.test(await page.textContent('#acctMsg')));
  await page.fill('#authForm [name=password]', 'password123');
  await page.click('#authSubmit');
  await page.waitForSelector('#signedIn:not([hidden])');
  await wait(400);
  check('after sign-in the search is saved', mock.state.saved.length === 1 && mock.state.saved[0].name === '"charizard" · deals'
    && JSON.stringify(mock.state.saved[0].params) === '{"q":"charizard","deals_only":true}' && /Saved/.test(await page.textContent('#acctMsg')), JSON.stringify(mock.state.saved));
  check('account lists it; header says Account', (await page.locator('.saved-row').count()) === 1 && (await page.textContent('#headAccount')) === 'Account');
  await page.uncheck('.saved-row [data-act=alerts]'); await wait(300);
  check('turn off email alerts', mock.state.saved[0].alerts === false);
  await Promise.all([page.waitForNavigation(), page.click('.saved-row a.name')]);
  check('open a saved search', /q=charizard/.test(page.url()) && /deals=1/.test(page.url()));

  // signed in: saves straight away
  await page.goto(BASE + '/search?graded=raw');
  await page.click('#saveSearch'); await wait(500);
  check('signed in: Save search saves right away', mock.state.saved.length === 2 && /Saved/.test(await page.textContent('#saveMsg')));
  // alert-email link
  await page.goto(BASE + `/search?saved=${mock.state.saved[1].id}`);
  await page.waitForURL(/graded=raw/);
  check('alert email link opens the saved search', /sort=newest/.test(page.url()));
  await page.goto(BASE + '/account'); await page.waitForSelector('.saved-row');
  await page.click('.saved-row >> nth=0 >> [data-act=delete]'); await wait(300);
  check('remove a saved search', mock.state.saved.length === 1);
  await page.click('#signOut'); await wait(300);
  check('sign out', await page.isVisible('#signedOut'));
  check('account: no sideways scroll', await noSideScroll());

  // ── holds ──
  const notifies = [];
  await page.route('**/.netlify/functions/hold-notify-now', r => { notifies.push(JSON.parse(r.request().postData() || '{}')); r.fulfill({ body: '{}' }); });
  page.on('dialog', dlg => dlg.accept());
  await page.goto(BASE + CHAR_URL);
  check('hold: button and how it works shown on an active card', await page.isVisible('#holdBtn')
    && /Nothing is charged on CardShow/.test(await page.textContent('#holdStart')));
  await page.click('#holdBtn');
  await page.waitForURL(/\/account\?next=/);
  await page.fill('#authForm [name=email]', 'buyer@example.test'); await page.fill('#authForm [name=password]', 'password123');
  await page.click('#authSubmit');
  await page.waitForURL(/hold=1/);
  await page.waitForSelector('#holdForm:not([hidden])');
  check('hold: after sign-in, back on the card with the form open, contact prefilled with the email',
    (await page.inputValue('#holdForm [name=contact]')) === 'buyer@example.test');
  await page.fill('#holdForm [name=name]', '');
  await page.click('#holdSubmit');
  check('hold: name required', mock.state.holdCalls.length === 0);
  await page.fill('#holdForm [name=name]', 'Alex P'); await page.fill('#holdForm [name=note]', 'Saturday works');
  await page.click('#holdSubmit');
  await page.waitForSelector('#holdMine:not([hidden])');
  await wait(300);
  check('hold: placed with name, contact, note; shown as yours with the end time; dealer emailed at once',
    mock.state.holdCalls[0]?.p_name === 'Alex P' && mock.state.holdCalls[0]?.p_contact === 'buyer@example.test'
    && mock.state.holdCalls[0]?.p_note === 'Saturday works' && /Until /.test(await page.textContent('#holdUntil'))
    && /Done/.test(await page.textContent('#holdMsg')) && notifies[0]?.reservation_id === mock.state.holds[0].id
    && await page.isHidden("#holdForm"), JSON.stringify({ msg: await page.textContent("#holdMsg"), until: await page.textContent("#holdUntil"), form: await page.isHidden("#holdForm") }));
  await page.goto(BASE + CHAR_URL);
  await page.waitForSelector('#holdMine:not([hidden])');
  check('hold: reopening the card shows it is held for you, not for "another buyer"', await page.isHidden('#holdOther')
    && (await page.locator('.chip-hold').count()) === 0);
  check('hold: no sideways scroll', await noSideScroll());
  await page.goto(BASE + '/account');
  await page.waitForSelector('.hold-row');
  const hr = await page.textContent('.hold-row');
  check('account: your holds lists it with dealer contact and the end time', /Charizard/.test(hr) && /On hold until/.test(hr) && /WhatsApp/.test(hr) && /Table 12/.test(hr), hr);
  await page.click('.hold-row [data-act=cancel]');
  await page.waitForSelector('.hold-row.ended');
  check('account: cancel a hold; the dealer is told', mock.state.holds[0].status === 'released' && /You cancelled/.test(await page.textContent('.hold-row'))
    && notifies.length === 2);
  await page.goto(BASE + '/c/33333333-3333-4333-8333-333333333333-wemby-prizm-bgs-9-5');
  check('a card someone else holds: no Hold button, says so', (await page.locator('#holdBtn').count()) === 0
    && /Another buyer is holding/.test(await page.textContent('#holdBox')));
  await page.goto(BASE + '/c/44444444-4444-4444-8444-444444444444-sold-card');
  check('a sold card has no hold box', (await page.locator('#holdBox').count()) === 0);
  await page.goto(BASE + '/account'); await page.click('#signOut'); await wait(300);

  // ── offers ──
  const onotes = [];
  await page.route('**/.netlify/functions/offer-notify-now', r => { onotes.push(JSON.parse(r.request().postData() || '{}')); r.fulfill({ body: '{}' }); });
  await page.goto(BASE + CHAR_URL);
  check('offer: Make an offer shown on an active card that takes offers', await page.isVisible('#offerBtn'));
  await page.click('#offerBtn');
  await page.waitForURL(/\/account\?next=/);
  await page.fill('#authForm [name=email]', 'buyer@example.test'); await page.fill('#authForm [name=password]', 'password123');
  await page.click('#authSubmit');
  await page.waitForURL(/offer=1/);
  await page.waitForSelector('#offerForm:not([hidden])');
  check('offer: after sign-in, back on the card with the offer form open and contact prefilled',
    (await page.inputValue('#offerForm [name=contact]')) === 'buyer@example.test' && (await page.inputValue('#offerForm [name=name]')) === 'Alex P');
  await page.fill('#offerForm [name=amount]', '20,000');
  await page.click('#offerSubmit');
  check('offer: above the asking price stopped on the page', /more than the asking price/.test(await page.textContent('#offerMsg')) && mock.state.offerCalls.filter(c => c.name === 'make_offer').length === 0,
    JSON.stringify({ msg: await page.textContent('#offerMsg'), calls: mock.state.offerCalls }));
  await page.fill('#offerForm [name=amount]', '$15,000');
  await page.click('#offerSubmit');
  await page.waitForSelector('#offerMine:not([hidden])'); await wait(300);
  check('offer: sent in cents; shown as waiting for the dealer; dealer emailed at once',
    mock.state.offerCalls.find(c => c.name === 'make_offer')?.p_amount_cents === 1500000 && /Your offer: \$15,000/.test(await page.textContent('#offerHead'))
    && /Waiting for the dealer/.test(await page.textContent('#offerSub')) && onotes[0]?.offer_id === mock.state.offers[0].id
    && await page.isHidden('#offerStart') && await page.isVisible('#holdBtn'),
    JSON.stringify({ calls: mock.state.offerCalls, head: await page.textContent('#offerHead'), sub: await page.textContent('#offerSub'), onotes }));
  await page.goto(BASE + '/account'); await page.waitForSelector('#offers .hold-row');
  check('account: your offers lists it as waiting', /waiting for the dealer/.test(await page.textContent('#offers')));
  await page.click('#offers [data-act=withdraw]'); await wait(400);
  check('account: withdraw an offer', mock.state.offers[0].status === 'withdrawn' && /You withdrew it/.test(await page.textContent('#offers')));
  await page.goto(BASE + CHAR_URL); await page.waitForSelector('#offerBtn');
  await page.click('#offerBtn'); await page.waitForSelector('#offerForm:not([hidden])');
  await page.fill('#offerForm [name=amount]', '15000'); await page.click('#offerSubmit');
  await page.waitForSelector('#offerMine:not([hidden])');
  const o2 = mock.state.offers[1];
  Object.assign(o2, { status: 'countered', amount_cents: 1700000, last_by: 'dealer', moves: 2, history: [...o2.history, { by: 'dealer', cents: 1700000 }] });
  await page.goto(BASE + CHAR_URL); await page.waitForSelector('#offerAnswer:not([hidden])');
  check('offer: dealer counter shown with Accept / Counter / Decline and your offer',
    /countered at \$17,000/.test(await page.textContent('#offerHead')) && /You offered \$15,000/.test(await page.textContent('#offerSub'))
    && (await page.textContent('#offerAccept')) === 'Accept $17,000' && await page.isVisible('#offerCounterBtn'));
  await page.click('#offerCounterBtn'); await page.fill('#offerCounterForm [name=amount]', '18000');
  await page.click('#offerCounterSend'); await wait(300);
  check('offer: counter above the dealer\'s is refused', /less than the dealer/.test(await page.textContent('#offerMsg')));
  await page.fill('#offerCounterForm [name=amount]', '16000'); await page.click('#offerCounterSend');
  await page.waitForFunction(() => /Your offer: \$16,000/.test(document.getElementById('offerHead')?.textContent || ''));
  check('offer: counter sent; back to waiting; dealer emailed', o2.amount_cents === 1600000 && o2.status === 'pending' && onotes.some(n => n.offer_id === o2.id));
  Object.assign(o2, { status: 'countered', amount_cents: 1650000, last_by: 'dealer', moves: 3, history: [...o2.history, { by: 'dealer', cents: 1650000 }] });
  await page.goto(BASE + CHAR_URL); await page.waitForSelector('#offerAnswer:not([hidden])');
  check('offer: no counter button on the last move', await page.isHidden('#offerCounterBtn'));
  await page.click('#offerAccept');
  await page.waitForSelector('#holdMine:not([hidden])');
  check('offer: accepting makes it a hold for you at the agreed price', /agreed price of \$16,500/.test(await page.textContent('#holdMine'))
    && await page.isHidden('#offerBox') && /on hold for you at \$16,500/.test(await page.textContent('#holdMsg')));
  check('offer: no sideways scroll', await noSideScroll());
  await page.goto(BASE + CHAR_URL); await page.waitForSelector('#holdMine:not([hidden])');
  check('offer: reopening shows the hold at the agreed price', /agreed price of \$16,500/.test(await page.textContent('#holdMine')));
  await page.goto(BASE + '/account'); await page.waitForSelector('#offers .hold-row');
  check('account: accepted offer and the hold with its price', /Accepted · now a hold/.test(await page.textContent('#offers'))
    && /agreed \$16,500/.test(await page.textContent('#holds')));
  await page.click('#holds .hold-row:not(.ended) [data-act=cancel]'); await page.waitForFunction(() => !document.querySelector('#holds .hold-row:not(.ended)'));
  check('account: an offer hold can be cancelled like any hold', mock.state.holds.at(-1).status === 'released');
  await page.goto(BASE + '/c/22222222-2222-4222-8222-222222222222-2024-prizm-jayden-daniels-silver');
  check('offer: no offer box on a card that takes no offers', (await page.locator('#offerBox').count()) === 0 && await page.isVisible('#holdBtn'));
  await page.goto(BASE + '/c/33333333-3333-4333-8333-333333333333-wemby-prizm-bgs-9-5');
  check('offer: no offer box on a held card', (await page.locator('#offerBox').count()) === 0);
  await page.goto(BASE + '/account'); await page.click('#signOut'); await wait(300);

  // ── bundle offers: several cards from one dealer, one price ──
  const JAY = '22222222-2222-4222-8222-222222222222', WEM = '33333333-3333-4333-8333-333333333333';
  const JAY_URL = '/c/22222222-2222-4222-8222-222222222222-2024-prizm-jayden-daniels-silver';
  const WEM_URL = '/c/33333333-3333-4333-8333-333333333333-wemby-prizm-bgs-9-5';
  const jay = mock.all.find(x => x.id === JAY), wem = mock.all.find(x => x.id === WEM);
  jay.accepts_offers = true; wem.listing_status = 'active';
  await page.goto(BASE + '/account'); await page.waitForSelector('#authForm');
  await page.fill('#authForm [name=email]', 'buyer@example.test'); await page.fill('#authForm [name=password]', 'password123');
  await page.click('#authSubmit'); await page.waitForSelector('#signedIn:not([hidden])');
  await page.goto(BASE + CHAR_URL); await page.waitForSelector('#bundleBtn');
  await page.click('#bundleBtn'); await wait(200);
  check('bundle: add a card; the bar shows the bundle from this dealer', /Bundle: 1 card from Dealer A · asking \$18,000/.test(await page.textContent('#bundleBar'))
    && (await page.textContent('#bundleBtn')).includes('In your bundle'));
  await page.goto(BASE + JAY_URL); await page.waitForSelector('#bundleBtn');
  check('bundle: another dealer\'s card shows no bar for the first dealer\'s bundle', await page.isHidden('#bundleBar'));
  await page.click('#bundleBtn'); await wait(200);   // confirm "start a new bundle" (dialogs are accepted)
  await page.goto(BASE + WEM_URL); await page.waitForSelector('#bundleBtn');
  await page.click('#bundleBtn'); await wait(200);
  check('bundle: a second card from the same dealer; total asking', /Bundle: 2 cards from Dealer B · asking \$945/.test(await page.textContent('#bundleBar')),
    await page.textContent('#bundleBar'));
  await page.goto(BASE + '/d/dealer_b'); await wait(300);
  check('bundle: the bar shows on the dealer\'s storefront too', /2 cards from Dealer B/.test(await page.textContent('#bundleBar')));
  await page.click('#bundleBar a'); await page.waitForURL(/\/bundle$/);
  await page.waitForFunction(() => document.querySelectorAll('#bList li').length === 2);
  check('bundle page: both cards, the total, name and contact prefilled', /\$945/.test(await page.textContent('#bTotal'))
    && (await page.inputValue('#bForm [name=contact]')) === 'buyer@example.test' && (await page.inputValue('#bForm [name=name]')) === 'Alex P');
  await page.fill('#bForm [name=amount]', '1,000'); await page.click('#bSubmit'); await wait(200);
  check('bundle page: above the total stopped on the page', /more than the cards/.test(await page.textContent('#bMsg'))
    && !mock.state.offerCalls.some(c => c.name === 'make_bundle_offer'));
  await page.fill('#bForm [name=amount]', '800'); await page.click('#bSubmit');
  await page.waitForSelector('#bDone:not([hidden])'); await wait(300);
  const bcall = mock.state.offerCalls.find(c => c.name === 'make_bundle_offer');
  check('bundle page: one offer for both cards in cents; dealer emailed; bundle cleared',
    JSON.stringify(bcall?.p_listing_ids) === JSON.stringify([JAY, WEM]) && bcall.p_amount_cents === 80000
    && /Offer sent/.test(await page.textContent('#bMsg')) && onotes.some(n => n.offer_id === mock.state.offers.at(-1).id)
    && (await page.evaluate(() => localStorage.getItem('cardshowBundle'))) === null, JSON.stringify(bcall));
  await page.goto(BASE + WEM_URL); await page.waitForSelector('#offerMine:not([hidden])');
  check('listing page: shows the bundle offer the card is in', /Your offer on a bundle: \$800 for 2 cards/.test(await page.textContent('#offerHead')));
  await page.goto(BASE + '/account'); await page.waitForSelector('#offers .hold-row');
  check('account: the bundle offer, "+ 1 more", bundle of 2', /\+ 1 more/.test(await page.textContent('#offers')) && /Bundle of 2 cards/.test(await page.textContent('#offers')));
  check('bundle: no sideways scroll on the account page', await noSideScroll());
  // a card in a saved bundle that's no longer for sale is marked and blocks sending
  wem.listing_status = 'reserved';
  await page.evaluate(([a, b]) => localStorage.setItem('cardshowBundle', JSON.stringify({ dealer: { handle: 'dealer_b', name: 'Dealer B' },
    items: [{ id: a, title: 'JD', price_cents: 4500, url: '/c/' + a }, { id: b, title: 'Wemby', price_cents: 90000, url: '/c/' + b }] })), [JAY, WEM]);
  await page.goto(BASE + '/bundle'); await page.waitForFunction(() => /No longer for sale/.test(document.getElementById('bList')?.textContent || ''));
  check('bundle page: a card no longer for sale is marked; sending is blocked until it\'s taken out', await page.isDisabled('#bSubmit')
    && /Take out the card/.test(await page.textContent('#bWarn')));
  await page.click('#bList li.gone [data-act=drop]'); await wait(200);
  check('bundle page: one card left → asks for another card', await page.isDisabled('#bSubmit') && /at least one more card/.test(await page.textContent('#bWarn')));
  check('bundle page: no sideways scroll', await noSideScroll());
  await page.evaluate(() => localStorage.removeItem('cardshowBundle'));
  jay.accepts_offers = false; wem.listing_status = 'reserved';
  await page.goto(BASE + '/account'); await page.click('#signOut'); await wait(300);

  // ── + Bundle on search / storefront / show tiles ──
  await page.goto(BASE + '/search'); await page.waitForSelector('.grid .tile');
  check('tiles: + Bundle only on active cards that take offers', (await page.locator(`.tile-bundle[data-id="${CHAR}"]`).count()) === 1
    && (await page.locator(`.tile-bundle[data-id="${JAY}"]`).count()) === 0 && (await page.locator('.grid .tile').count()) >= 2);
  await page.click(`.tile-bundle[data-id="${CHAR}"]`); await wait(250);
  check('tiles: tapping + Bundle adds the card without opening it; bar + message', /\/search$/.test(page.url())
    && (await page.getAttribute(`.tile-bundle[data-id="${CHAR}"]`, 'aria-pressed')) === 'true'
    && /1 card from Dealer A/.test(await page.textContent('#bundleBar')) && /Added/.test(await page.textContent('#bundleMsg')));
  check('tiles: no sideways scroll with the bundle bar', await noSideScroll());
  jay.accepts_offers = true; wem.listing_status = 'active';
  await page.goto(BASE + '/search'); await page.waitForSelector(`.tile-bundle[data-id="${JAY}"]`);
  check('tiles: the bundle is remembered across pages', (await page.getAttribute(`.tile-bundle[data-id="${CHAR}"]`, 'aria-pressed')) === 'true');
  await page.click(`.tile-bundle[data-id="${JAY}"]`); await wait(250);   // another dealer → "start a new bundle?" (accepted)
  const nb = await page.evaluate(() => JSON.parse(localStorage.getItem('cardshowBundle') || 'null'));
  check('tiles: a card from another dealer starts a new bundle instead of mixing dealers', nb?.dealer?.handle === 'dealer_b'
    && JSON.stringify(nb.items.map(i => i.id)) === JSON.stringify([JAY])
    && (await page.getAttribute(`.tile-bundle[data-id="${CHAR}"]`, 'aria-pressed')) === 'false', JSON.stringify(nb));
  await page.goto(BASE + '/d/dealer_b'); await page.waitForSelector(`.tile-bundle[data-id="${WEM}"]`);
  await page.click(`.tile-bundle[data-id="${WEM}"]`); await wait(250);
  check('storefront tiles: second card from the same dealer → 2 cards, total', /2 cards from Dealer B · asking \$945/.test(await page.textContent('#bundleBar')));
  await page.click(`.tile-bundle[data-id="${WEM}"]`); await wait(250);
  check('storefront tiles: tapping again takes it out', /1 card from Dealer B/.test(await page.textContent('#bundleBar'))
    && (await page.getAttribute(`.tile-bundle[data-id="${WEM}"]`, 'aria-pressed')) === 'false');
  await page.click(`.tile-bundle[data-id="${WEM}"]`); await wait(250);
  await page.goto(BASE + '/d/dealer_a'); await wait(300);
  check('another dealer\'s storefront doesn\'t show dealer B\'s bundle bar', await page.isHidden('#bundleBar'));
  // an old saved bundle that mixes dealers: the bundle page marks the stray card and won't send
  await page.evaluate(([a, c]) => localStorage.setItem('cardshowBundle', JSON.stringify({ dealer: { handle: 'dealer_b', name: 'Dealer B' },
    items: [{ id: a, title: 'JD', price_cents: 4500, url: '/c/' + a }, { id: c, title: 'Charizard', price_cents: 1800000, url: '/c/' + c }] })), [JAY, CHAR]);
  await page.goto(BASE + '/bundle'); await page.waitForFunction(() => /one dealer’s cards/.test(document.getElementById('bList')?.textContent || ''));
  check('bundle page: a card from another dealer is marked and sending is blocked', await page.isDisabled('#bSubmit')
    && /From Dealer A, not Dealer B/.test(await page.textContent('#bList')));
  await page.goto(BASE + '/search'); await page.waitForSelector('#bundleBar:not([hidden])');
  await page.click('#bundleClear'); await wait(250);
  check('bundle bar: Clear empties the bundle', await page.isHidden('#bundleBar') && (await page.evaluate(() => localStorage.getItem('cardshowBundle'))) === null);
  jay.accepts_offers = false; wem.listing_status = 'reserved';

  // ── search down ──
  mock.state.failSearch = true;
  res = await page.goto(BASE + '/search?q=down');
  check('search down → 503 with a message, not cached', res.status() === 503 && /isn’t available/.test(await page.textContent('main'))
    && /no-store/.test(res.headers()['netlify-cdn-cache-control'] || ''));
  mock.state.failSearch = false;

  // robots.txt and sitemap.xml (served at getcardshow.com through the main site's proxy rules)
  let rr = await page.request.get(BASE + '/robots.txt');
  const robots = await rr.text();
  check('robots.txt before launch: marketplace closed, no sitemap line, private pages closed', rr.status() === 200
    && /text\/plain/.test(rr.headers()['content-type']) && /^Disallow: \/c\/$/m.test(robots) && /^Disallow: \/s\/$/m.test(robots) && /^Disallow: \/shows$/m.test(robots) && /^Disallow: \/account$/m.test(robots)
    && !/Sitemap:/.test(robots), robots);
  rr = await page.request.get(BASE + '/sitemap.xml');
  const sm = await rr.text();
  check('sitemap.xml: active listings, their dealers, search and the landing page; no sold or unlisted cards', rr.status() === 200
    && /xml/.test(rr.headers()['content-type']) && /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/.test(sm)
    && sm.includes(`${mock.url}/c/${CHAR}-`) && sm.includes(`${mock.url}/d/`) && sm.includes(`<loc>${mock.url}/search</loc>`)
    && sm.includes(`<loc>${mock.url}/</loc>`) && sm.includes(`<loc>${mock.url}/s/monster-show-2026</loc>`) && sm.includes(`<loc>${mock.url}/shows</loc>`) && !sm.includes('44444444-4444-4444-8444-444444444444'), sm);
  check('no page errors', errors.length === 0, JSON.stringify(errors));
} catch (e) {
  fails++; console.log('FAIL  crashed:', e.message);
} finally {
  await browser.close(); try { process.kill(-dev.pid, 'SIGTERM'); } catch {} await mock.close();
}
if (fails && process.env.DEBUG) console.log(devLog.slice(-3000));
console.log(fails ? `${fails} FAILED (${deviceName})` : `all passed (${deviceName})`);
process.exit(fails ? 1 : 0);
