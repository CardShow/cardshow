// Seller Dashboard v2, Phase 1: shell, routing, phone tab bar (js/seller-shell.js).
//   node seller-v2.e2e.mjs "iPhone 13"      (also "Pixel 7", "Desktop Chrome")
import { chromium, devices } from 'playwright';
import fs from 'fs';
const mock = fs.readFileSync(new URL('./mock-supabase.js', import.meta.url), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const deviceName = process.argv[2] || 'iPhone 13';
const phone = deviceName !== 'Desktop Chrome';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ ...devices[deviceName], serviceWorkers: 'block' });
const today = new Date().toLocaleDateString('en-CA');
await ctx.addInitScript(([today]) => {
  localStorage.setItem('smExited:tester', 'show_a|' + today);   // start in the seller view, not Show Mode
  localStorage.setItem('cardshowTipsOff', '1');                  // first-use tips would cover the buttons
  window.confirm = () => true;
}, [today]);
await ctx.route('**/.netlify/functions/**', r => r.fulfill({ contentType: 'application/json', body: '{"success":false}' }));
await ctx.route('**/supabase-js@2*', r => r.fulfill({ contentType: 'application/javascript', body: mock }));
await ctx.route('https://fonts.**', r => r.fulfill({ body: '' }));
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  [${deviceName}] ${label} ${extra}`); };
const wait = ms => page.waitForTimeout(ms);
const hash = () => page.evaluate(() => location.hash);
const vis = sel => page.isVisible(sel);
const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
async function login() {
  await page.fill('#authEmail', 't@x.com'); await page.fill('#authPassword', 'password1');
  await page.evaluate(() => submitAuth());
  await wait(2200);
}
async function go(route) {
  // Phone: tab bar or More sheet. Desktop: left nav.
  if (!phone) { await page.click(`#sellerNav .ss2-nav-item[data-route="${route}"]`); }
  else if (['home', 'inventory', 'shows'].includes(route)) { await page.click(`#sellerTabBarV2 [data-route="${route}"]`); }
  else if (route === 'market') { await page.click('#ss2TabMarket'); }
  else {
    if (await vis('#ss2TabMore')) await page.click('#ss2TabMore'); else { await go('home'); await page.click('#ss2AvatarBtn'); }
    await wait(150);
    await page.click(`#ss2MoreSheet a[href="#/s/${route}"]`);
  }
  await wait(350);
}

// ── Flag off: today's app, unchanged ──
await page.goto(BASE + '/app.html'); await wait(400);
await login();
check('flag off: no v2 class', !(await page.evaluate(() => document.body.classList.contains('seller-v2'))));
check('flag off: classic tab bar shown', await vis('#sellerTabBar'));
check('flag off: no left nav / tab bar', !(await vis('#sellerNav')) && !(await vis('#sellerTabBarV2')));
check('flag off: no #/s/ hash', !(await hash()).startsWith('#/s/'));
if (phone) check('flag off: FAB still there', await vis('#fabAddCard'));
await page.evaluate(() => signOut()); await wait(600);

// ── Flag on ──
await page.goto(BASE + '/app.html?seller_nav=1'); await wait(400);
check('test switch stripped from the URL and remembered', !(await page.evaluate(() => location.search.includes('seller_nav'))) && await page.evaluate(() => localStorage.getItem('sellerNavTest') === '1'));
if (!(await page.evaluate(() => document.body.classList.contains('seller-v2')))) await login();
check('flag on: v2 class', await page.evaluate(() => document.body.classList.contains('seller-v2')));
check('opens on Home', (await hash()) === '#/s/home' && await vis('#ss2Home'), await hash());
check('classic chrome hidden (sidebar, tab bar, FAB, ☰)', !(await vis('#mainSidebar')) && !(await vis('#sellerTabBar')) && !(await vis('#fabAddCard')) && !(await vis('#sidebarToggle')));
check(phone ? 'phone: bottom tab bar, no left nav' : 'desktop: left nav, no tab bar',
  phone ? (await vis('#sellerTabBarV2')) && !(await vis('#sellerNav')) : (await vis('#sellerNav')) && !(await vis('#sellerTabBarV2')));
check('marketplace hidden while the switch is off', !(await vis('#ss2TabMarket')) && !(await vis('#ss2NavMarket')) && !(await page.evaluate(() => /market/i.test(document.getElementById(innerWidth < 768 ? 'sellerTabBarV2' : 'sellerNav').innerText))));
if (phone) check('phone: More tab shown', await vis('#ss2TabMore'));
check('stat chips moved onto Home and still updated', await page.evaluate(() => document.getElementById('ss2HomeStats').contains(document.getElementById('statTotal')) && document.getElementById('statTotal').textContent !== ''));
check('Home: no sideways scroll', await noSideScroll());

const routes = [
  ['inventory', async () => (await vis('.table-wrap')) && !(await vis('#ss2Home'))],
  ['shows', async () => (await vis('#ss2Shows')) && await page.evaluate(() => document.getElementById('ss2Shows').contains(document.getElementById('sellerShowsPanel'))) && await vis('#joinShowBtn')],
  ['sales', async () => (await vis('#adminReportPanel')) && (await vis('#ss2SalesHead')) && !(await vis('.table-wrap'))],
  ['qr', async () => (await vis('#ss2Qr')) && await vis('#sellerQrPanel')],
];
for (const [r, ok] of routes) {
  await go(r);
  check(`route ${r}: right panel`, (await hash()).startsWith('#/s/' + r) && await ok(), await hash());
  check(`route ${r}: no sideways scroll`, await noSideScroll());
  if (!phone) check(`route ${r}: nav item marked current`, await page.evaluate(r => document.querySelector(`#sellerNav .ss2-nav-item[data-route="${r}"]`)?.getAttribute('aria-current') === 'page', r));
}
await go('sales');
await page.click('#ss2SalesHead .ss2-seg-btn[data-sub="shows"]'); await wait(400);
check('Sales → Show results shows Show Home', (await hash()) === '#/s/sales/shows' && await vis('#showHomePanel'));
check('Sales: toolbar hidden', !(await vis('#adminInventoryPanel .toolbar')));

// back / forward
await page.goBack(); await wait(300);
check('back goes to the previous section', (await hash()) === '#/s/sales' && await vis('#adminReportPanel'), await hash());
await page.goForward(); await wait(300);
check('forward', (await hash()) === '#/s/sales/shows');

// Old callers of switchSellerTab keep the URL in step
await page.evaluate(() => switchSellerTab('inventory')); await wait(200);
check('switchSellerTab("inventory") → #/s/inventory', (await hash()) === '#/s/inventory' && await vis('.table-wrap'));

// href="#" links don't throw the seller back to Home
await page.evaluate(() => { location.hash = '#'; }); await wait(200);
check('a bare "#" leaves the current section alone', await vis('.table-wrap'));

// Unknown route and Market with the switch off → Home
await page.evaluate(() => { location.hash = '#/s/nope'; }); await wait(250);
check('unknown #/s/ route → Home', (await hash()) === '#/s/home');
await page.evaluate(() => { location.hash = '#/s/market'; }); await wait(250);
check('#/s/market with the switch off → Home', (await hash()) === '#/s/home');

// Search in the top bar filters the inventory
await page.fill('#ss2Search', 'zzzz-no-card'); await wait(300);
check('top bar search opens Inventory and filters', (await hash()) === '#/s/inventory' && await page.evaluate(() => document.getElementById('sellerSearchInput').value === 'zzzz-no-card'));
await page.fill('#ss2Search', ''); await wait(150);

// Refresh comes back to the same section
await go('shows');
await page.reload(); await wait(2500);
if (!(await page.evaluate(() => document.body.classList.contains('seller-v2')))) await login();
check('refresh returns to the same section', (await hash()) === '#/s/shows' && await vis('#ss2Shows'), await hash());

// Show Mode: opens on top with its own hash, and closing it returns here
await page.evaluate(() => openShowMode('show_a')); await wait(500);
check('Show Mode opens with its own #/sm/ route', /^#\/sm\//.test(await hash()) && await vis('#showModeRoot'));
await page.evaluate(() => { location.hash = '#/sm/show_a/inventory'; }); await wait(300);
check('Show Mode routes still work under v2', await vis('#showModeRoot') && (await hash()) === '#/sm/show_a/inventory');
await page.evaluate(() => closeShowMode({ remember: true })); await wait(300);
check('closing Show Mode returns to the section', (await hash()) === '#/s/shows' && await vis('#ss2Shows'), await hash());

// Phone: touch targets
if (phone) {
  const small = await page.evaluate(() => [...document.querySelectorAll('#sellerTabBarV2 .ss2-tab, #sellerTopBar button, #sellerTopBar .ss2-search')]
    .filter(e => e.offsetParent).map(e => e.getBoundingClientRect()).filter(r => r.height < 44 || r.width < 44).length);
  check('tab bar and top bar targets ≥ 44px', small === 0, small + ' too small');
  await page.click('#ss2TabMore'); await wait(200);
  const rows = await page.evaluate(() => [...document.querySelectorAll('#ss2MoreSheet .ss2-sheet-row')].filter(r => r.getBoundingClientRect().height < 44).length);
  check('More sheet open, rows ≥ 44px', await vis('#ss2MoreSheet .ss2-sheet') && rows === 0);
  await page.keyboard.press('Escape'); await wait(150);
  check('Escape closes More', !(await vis('#ss2MoreSheet .ss2-sheet')));
}

// Marketplace switch on: Market tab replaces More (phone), nav item + badge (desktop)
await page.evaluate(() => localStorage.setItem('marketplaceTest', '1'));
await page.reload(); await wait(2500);
if (!(await page.evaluate(() => document.body.classList.contains('seller-v2')))) await login();
if (phone) {
  check('switch on: Market tab, no More tab', (await vis('#ss2TabMarket')) && !(await vis('#ss2TabMore')));
  await go('home');
  check('switch on: avatar button on Home', await vis('#ss2AvatarBtn'));
  await page.click('#ss2AvatarBtn'); await wait(200);
  check('avatar menu: Sales & reports and Table QR reachable', await vis('#ss2MoreSheet a[href="#/s/sales"]') && await vis('#ss2MoreSheet a[href="#/s/qr"]'));
  await page.click('#ss2MoreSheet a[href="#/s/sales"]'); await wait(350);
  check('Sales in 2 taps from Home', (await hash()) === '#/s/sales');
  await page.click('#ss2TabMarket'); await wait(350);
  check('Market tab → #/s/market/buyers', (await hash()) === '#/s/market/buyers' && await vis('#ss2Market'));
} else {
  check('switch on: Marketplace in the nav', await vis('#ss2NavMarket'));
  await go('market');
  check('Marketplace route', (await hash()).startsWith('#/s/market') && await vis('#ss2Market'));
}
const badge = await page.evaluate(() => {
  const c = ss2MarketCounts();
  return c.total === 0 && document.getElementById(innerWidth < 768 ? 'ss2TabMarketBadge' : 'ss2MarketBadge').style.display === 'none';
});
check('no badge when nothing needs the dealer', badge);
await page.evaluate(() => localStorage.removeItem('marketplaceTest'));

// Sign out puts everything back for the next user
await page.evaluate(() => signOut()); await wait(600);
check('sign out: v2 removed, moved panels back in the sidebar', await page.evaluate(() =>
  !document.body.classList.contains('seller-v2') && !location.hash.startsWith('#/s/')
  && document.getElementById('mainSidebar').contains(document.getElementById('sellerShowsPanel'))
  && document.getElementById('mainSidebar').contains(document.getElementById('sellerQrPanel'))
  && document.getElementById('mainSidebar').contains(document.getElementById('sellerStatsRow'))));

// Buyer view never mounts the shell
await page.evaluate(() => enterAsBuyer()); await wait(500);
check('buyer view: no v2 shell', !(await page.evaluate(() => document.body.classList.contains('seller-v2'))) && !(await vis('#sellerTabBarV2')));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
