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
  check('bad id → 404', res.status() === 404);

  // ── storefront ──
  res = await page.goto(BASE + '/d/dealer_a');
  check('storefront: name, count, Instagram, their cards', res.status() === 200 && /Dealer A/.test(await page.textContent('h1'))
    && /1 card listed/.test(await page.textContent('.store-head')) && (await tiles()) === 1);
  await page.goto(BASE + '/d/DEALER_A');
  check('storefront: handle case → canonical', page.url() === BASE + '/d/dealer_a');
  res = await page.goto(BASE + '/d/nobody');
  check('storefront: unknown dealer → 404', res.status() === 404);

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

  // ── search down ──
  mock.state.failSearch = true;
  res = await page.goto(BASE + '/search?q=down');
  check('search down → 503 with a message, not cached', res.status() === 503 && /isn’t available/.test(await page.textContent('main'))
    && /no-store/.test(res.headers()['netlify-cdn-cache-control'] || ''));
  mock.state.failSearch = false;

  check('no page errors', errors.length === 0, JSON.stringify(errors));
} catch (e) {
  fails++; console.log('FAIL  crashed:', e.message);
} finally {
  await browser.close(); try { process.kill(-dev.pid, 'SIGTERM'); } catch {} await mock.close();
}
if (fails && process.env.DEBUG) console.log(devLog.slice(-3000));
console.log(fails ? `${fails} FAILED (${deviceName})` : `all passed (${deviceName})`);
process.exit(fails ? 1 : 0);
