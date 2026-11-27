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
// Registered after the catch-all above: Playwright tries the newest route first.
await ctx.route('**/.netlify/functions/card-image**', r => r.fulfill({ status: 200, contentType: 'image/png',
  body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64') }));
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
check('flag off: unsold rows start ticked, as before', await page.evaluate(() =>
  [...document.querySelectorAll('#inventoryBody .card-check')].filter(b => b.checked).length === 2));
await page.evaluate(() => signOut()); await wait(600);
// Two more cards for Phase 2: one not at any show, one with no asking price.
await page.evaluate(() => {
  const S = window.__srv;
  S.inventory.push({ id: 'c4', seller_id: 'u1', card_title: '2022 Topps Bobby Witt Jr.', player: 'Bobby Witt Jr.', year: 2022, card_set: 'Topps', price: 25, status: 'Available', catalog_card_id: '11111111-2222-4333-8444-555555555555' });
  S.inventory.push({ id: 'c5', seller_id: 'u1', card_title: '2021 Donruss Wander Franco', player: 'Wander Franco', year: 2021, card_set: 'Donruss', price: 0, status: 'Available' });
  localStorage.setItem('__srv', JSON.stringify(S));
});

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

// ── Phase 2: Inventory views, filters, bulk bar ──
await page.evaluate(() => { window.prompt = () => 'Graded only'; });
await go('inventory');
const rowsShown = () => page.locator('#inventoryBody tr[id^="inv-row-"]').count();
const tickRow = async id => {
  const idx = await page.evaluate(id => inventory.findIndex(c => c._dbId === id), id);
  await page.click(`#inventoryBody .card-check[data-idx="${idx}"]`); await wait(120);
};
check('inventory: classic toolbar and strips hidden', !(await vis('#adminInventoryPanel > .toolbar')) && !(await vis('#mhStrip')));
check('inventory: header, views and filter bar shown', await vis('#ss2InvChrome .ss2-inv-head') && await vis('#ss2Views') && await vis('#ss2FilterBar'));
check('Available view by default: 4 cards, none ticked', (await rowsShown()) === 4 && await page.evaluate(() => !document.querySelector('#inventoryBody .card-check:checked')), String(await rowsShown()));
const viewText = await page.textContent('#ss2Views');
check('view counts: All 5 · Available 4 · At a show 2 · Needs attention 1 · Sold 1',
  /All\s*5/.test(viewText) && /Available\s*4/.test(viewText) && /At a show\s*2/.test(viewText) && /Needs attention\s*1/.test(viewText) && /Sold\s*1/.test(viewText), viewText.replace(/\s+/g, ' '));
check('no Listed online view with the switch off', !/Listed online/.test(viewText));
await page.click('#ss2Views .ss2-view:has-text("At a show")'); await wait(200);
check('At a show view: 2 cards with a show chip', (await rowsShown()) === 2 && (await page.locator('#inventoryBody .ss2-chip-show').count()) === 2);
await page.click('#ss2Views .ss2-view:has-text("Needs attention")'); await wait(200);
check('Needs attention view: the card with no price', (await rowsShown()) === 1 && (await page.textContent('#inventoryBody')).includes('Wander Franco'));
await page.click('#ss2Views .ss2-view:has-text("Available")'); await wait(200);
await page.selectOption('#ss2FGraded', 'graded'); await wait(200);
check('Graded filter: 1 card', (await rowsShown()) === 1);
await page.click('#ss2Views .ss2-view-save'); await wait(200);
check('Save view adds a tab', (await page.textContent('#ss2Views')).includes('Graded only'));
await page.selectOption('#ss2FGraded', ''); await wait(200);
await page.fill('#sellerSearchInput', 'crews'); await wait(200);
check('search inside the filter bar: 1 card', (await rowsShown()) === 1);
await page.fill('#sellerSearchInput', ''); await page.dispatchEvent('#sellerSearchInput', 'input'); await wait(200);
await wait(600);
const thumbs = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#inventoryBody tr[id^="inv-row-"]')];
  const c4 = rows.find(tr => tr.id === 'inv-row-' + inventory.findIndex(c => c._dbId === 'c4'));
  const img = c4 && c4.querySelector('.ss2-thumb img');
  return { rows: rows.length, withThumb: rows.filter(tr => tr.querySelector('.ss2-thumb')).length,
           catalog: !!(img && img.complete && img.naturalWidth > 0 && /card-image\?id=/.test(img.src)),
           blank: rows.filter(tr => tr.querySelector('.ss2-thumb--none')).length };
});
check('every row has a thumbnail; catalog image for the card with a catalog id, blank tiles for the rest',
  thumbs.rows > 0 && thumbs.withThumb === thumbs.rows && thumbs.catalog && thumbs.blank === thumbs.rows - 1, JSON.stringify(thumbs));
const thumbBox = await page.locator('#inventoryBody .ss2-thumb').first().boundingBox();
check('thumbnail is at least 44px', thumbBox && thumbBox.width >= 44 && thumbBox.height >= 44, JSON.stringify(thumbBox));
await page.locator('#inventoryBody .ss2-thumb').first().click(); await wait(200);
check('tapping a thumbnail opens Edit Card', await page.evaluate(() => document.getElementById('cardEditOverlay').classList.contains('open')));
await page.evaluate(() => closeCEM()); await wait(150);
check('table header says Asking', await page.evaluate(() =>
  [...document.querySelectorAll('#adminInventoryPanel .table-wrap thead th')].some(t => t.textContent.trim() === 'Asking')));
check('card with no price shows Add price', await page.evaluate(() => {
  const tr = document.getElementById('inv-row-' + inventory.findIndex(c => c._dbId === 'c5'));
  return !!tr && /Add price/.test(tr.querySelector('.ss2-ask')?.textContent || '');
}));
const askSel = await page.evaluate(() => '#inv-row-' + inventory.findIndex(c => c._dbId === 'c4') + ' .ss2-ask');
await page.click(askSel); await wait(100);
await page.keyboard.press('Escape'); await wait(150);
check('Escape leaves the price unchanged', await page.evaluate(() => Number(inventory.find(c => c._dbId === 'c4').Price) === 25));
await page.click(askSel); await wait(100);
await page.fill('.ss2-ask-input', '30'); await page.keyboard.press('Enter'); await wait(400);
check('typing a price in the Asking column saves it', await page.evaluate(() =>
  Number(inventory.find(c => c._dbId === 'c4').Price) === 30 &&
  Number(window.__srv.inventory.find(r => r.id === 'c4').price) === 30 &&
  /\$30/.test(document.querySelector('#inv-row-' + inventory.findIndex(c => c._dbId === 'c4') + ' .ss2-ask').textContent)));
const askBox = await page.locator(askSel).boundingBox();
check('Asking button is at least 44px tall', askBox && askBox.height >= 44, JSON.stringify(askBox));
await page.click(askSel); await wait(100);
await page.fill('.ss2-ask-input', '25'); await page.keyboard.press('Enter'); await wait(300);
check('Not for sale yet chip on a card at no show', (await page.textContent('#inventoryBody')).includes('Not for sale yet'));

if (phone) {
  check('phone: no checkboxes until Select', !(await vis('#inventoryBody .card-check')));
  await page.click('#ss2SelectBtn'); await wait(150);
}
await tickRow('c4');
check('one ticked: bulk bar replaces the filter bar', await vis('#ss2BulkBar') && !(await vis('#ss2FilterBar')) && (await page.textContent('#ss2BulkCount')).includes('1 selected'));
if (phone) check('phone: bulk bar replaces the tab bar', !(await vis('#sellerTabBarV2')));
check('Mark sold enabled with one card', await page.isEnabled('#ss2BulkSell'));
await tickRow('c2');
check('Mark sold disabled with two cards', !(await page.isEnabled('#ss2BulkSell')) && (await page.getAttribute('#ss2BulkSell', 'title')) === 'Select one card to sell');
const before = await page.evaluate(() => window.__srv.show_inventory.length);
const errs0 = errors.length;
await page.click('#ss2BulkBar button:has-text("Add to show")'); await wait(150);
await page.click('#ss2Pop .ss2-pop-item:has-text("Monster Show")'); await wait(700);
const st = await page.evaluate(() => ({ rows: window.__srv.show_inventory.map(r => r.card_id), active: activeShowId, toast: document.getElementById('toast').textContent }));
check('Add to show: only the new card is published', st.rows.length === before + 1 && st.rows.includes('c4'), JSON.stringify(st.rows));
check('Add to show: toast says one was already there', /Added 1 card to Monster Show · 1 was already there/.test(st.toast), st.toast);
check('Add to show: that show becomes the active show', st.active === 'show_a');
check('Add to show: selection cleared, no errors', !(await vis('#ss2BulkBar')) && errors.length === errs0);
if (phone && !(await page.evaluate(() => document.body.classList.contains('ss2-selecting')))) { await page.click('#ss2SelectBtn'); await wait(150); }
await tickRow('c4');
await page.click('#ss2BulkBar button:has-text("More")'); await wait(150);
await page.click('#ss2Pop .ss2-pop-item:has-text("Take out of Monster Show")'); await wait(500);
check('Take out of show: just that card', await page.evaluate(() => {
  const c = id => inventory.find(x => x._dbId === id);
  return !c('c4')._shows.has('show_a') && c('c1')._shows.has('show_a') && !window.__srv.show_inventory.some(r => r.card_id === 'c4');
}));
if (phone && !(await page.evaluate(() => document.body.classList.contains('ss2-selecting')))) { await page.click('#ss2SelectBtn'); await wait(150); }
await tickRow('c2');
await page.click('#ss2BulkSell'); await wait(300);
check('Mark sold opens the Sell Drawer for that card', await page.evaluate(() => document.getElementById('sellDrawerOverlay').classList.contains('open')));
await page.evaluate(() => closeSellDrawer()); await wait(200);
await page.click('#ss2SelAll').catch(() => {}); await wait(150);
if (!phone) check('header checkbox selects every card in the view', (await page.textContent('#ss2BulkCount')).includes(String(await rowsShown())));
check('inventory: no sideways scroll with the bulk bar', await noSideScroll());
if (phone) { await page.click('#ss2SelectBtn'); await wait(150); check('phone: Done ends select mode and brings the tab bar back', await vis('#sellerTabBarV2')); }
await go('home');
check('leaving Inventory clears the selection', await page.evaluate(() => !document.querySelector('#inventoryBody .card-check:checked') && !document.body.classList.contains('ss2-has-sel')));
check('Home: Needs you lists the card with no price', (await page.textContent('#ss2HomeNeeds')).includes('no asking price'));
await page.click('#ss2HomeNeeds .ss2-row:has-text("no asking price")'); await wait(400);
check('Needs you → Inventory filtered to that reason', (await hash()) === '#/s/inventory' && (await rowsShown()) === 1 && await vis('#ss2Reason'));
check('Getting started checklist moved to Home', await page.evaluate(() => document.getElementById('ss2HomeChecklist').contains(document.getElementById('gsChecklist'))));
await go('sales');
check('Sales: Inventory baseline card with Set baseline', await vis('#ss2BaselineCard') && await vis('#ss2BaselineCard button:has-text("Set baseline")'));
await go('inventory');
check('saved view survives on the device', (await page.textContent('#ss2Views')).includes('Graded only'));
await page.click('#ss2Views .ss2-view:has-text("Graded only")'); await wait(200);
check('saved view reapplies its filters', (await rowsShown()) === 1 && (await page.inputValue('#ss2FGraded')) === 'graded');
await page.click('#ss2Views .ss2-view-x'); await wait(150);
check('saved view can be deleted', !(await page.textContent('#ss2Views')).includes('Graded only'));
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
  && document.getElementById('mainSidebar').contains(document.getElementById('sellerStatsRow'))
  && !!document.querySelector('#adminInventoryPanel > .toolbar #sellerSearchInput')
  && !document.getElementById('ss2SelAll')));

// Buyer view never mounts the shell
await page.evaluate(() => enterAsBuyer()); await wait(500);
check('buyer view: no v2 shell', !(await page.evaluate(() => document.body.classList.contains('seller-v2'))) && !(await vis('#sellerTabBarV2')));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
