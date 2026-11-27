// ══════ SELLER DASHBOARD v2 SHELL (flag: seller_nav_v2) ══════
// Left nav (desktop) / bottom tab bar (phone) around the four seller jobs:
// add cards → get ready for shows → marketplace → sales. Build spec:
// "Seller Dashboard Redesign — Build Spec v1" + docs/seller-dashboard-v2-decisions.md.
//
// Phase 1: shell, routing, phone tab bar. It re-homes entry points only: every
// panel shows existing markup (moved, never copied, so IDs other code reads keep
// working) or calls an existing function. Off by default.
// Test switch: ?seller_nav=1 turns it on for this browser, ?seller_nav=0 off
// (localStorage sellerNavTest), same pattern as Show Mode.
//
// Routes: #/s/home · #/s/inventory · #/s/shows · #/s/market[/buyers] ·
// #/s/sales[/shows] · #/s/qr. Show Mode's #/sm/… hashes are never touched.
// Loaded before app.html's main script, so wrapping app functions happens in
// ss2Init() (first login), not at load time.

const SELLER_NAV_V2_ENABLED = false;
const SELLER_NAV_TEST_KEY = 'sellerNavTest';
function _ss2TestOverride() {
  try {
    const url = new URL(location.href);
    const p = url.searchParams.get('seller_nav');
    if (p === '1') localStorage.setItem(SELLER_NAV_TEST_KEY, '1');
    else if (p === '0') localStorage.removeItem(SELLER_NAV_TEST_KEY);
    if (p !== null) {
      url.searchParams.delete('seller_nav');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
    return localStorage.getItem(SELLER_NAV_TEST_KEY) === '1';
  } catch (_) { return false; }
}
const SELLER_NAV_ON = SELLER_NAV_V2_ENABLED || _ss2TestOverride();
function ss2IsEnabled() { return SELLER_NAV_ON; }

let _ss2On = false;            // shell mounted for the signed-in seller
let _ss2Route = 'home';
let _ss2Sub = '';
let _ss2Built = false;
let _ss2Wrapped = false;
let _ss2Routing = false;       // set while the router itself calls switchSellerTab()
let _ss2Moved = [];            // [{ el, parent, next }] for teardown
const SS2_HASH_RE = /^#\/s\/([a-z]+)(?:\/([a-z]+))?\/?$/;
const SS2_ROUTES = ['home', 'inventory', 'shows', 'market', 'sales', 'qr'];

function _ss2Mk() { return typeof mkEnabled === 'function' && mkEnabled(); }
function _ss2Esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Inline stroke icons (no emoji in the chrome).
const SS2_ICON = (() => {
  const s = p => `<svg class="ss2-ico" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  return {
    home: s('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>'),
    cards: s('<rect x="6" y="3" width="12" height="17" rx="2"/><path d="M3 7v12a2 2 0 0 0 2 2h10"/>'),
    shows: s('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
    market: s('<path d="M3 12V4h8l10 10-8 8L3 12z"/><circle cx="7.5" cy="8" r="1.4"/>'),
    sales: s('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
    more: s('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>'),
    plus: s('<path d="M12 5v14M5 12h14"/>'),
    qr: s('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>'),
    settings: s('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    help: s('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01"/>'),
    signout: s('<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3"/>'),
    search: s('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>'),
    play: s('<path d="M7 4v16l13-8z"/>'),
    user: s('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
    chev: s('<path d="m15 18-6-6 6-6"/>'),
  };
})();

// ── Counts shared by the nav badge, the phone Market tab and (Phase 3) Home ──
function ss2MarketCounts() {
  const toConfirm = typeof ordToConfirm === 'function' ? ordToConfirm().length : 0;
  const toShip = typeof ordToDo === 'function' ? ordToDo().filter(o => o.status === 'paid').length : 0;
  const offers = typeof moWaiting === 'function' ? moWaiting().length : 0;
  const soon = Date.now() + 24 * 3600 * 1000;
  const holds = typeof mhActive === 'function'
    ? mhActive().filter(h => h.expires_at && new Date(h.expires_at).getTime() <= soon).length : 0;
  return { toConfirm, toShip, offers, holds, total: toConfirm + toShip + offers + holds };
}

function _ss2MyShows() {
  return Object.values(typeof shows === 'object' && shows ? shows : {})
    .filter(s => s && s.sellers instanceof Set && s.sellers.has(currentSeller));
}
function _ss2ShowRange(s) {
  const start = s.startDate || (typeof _showDateISO === 'function' ? _showDateISO(s) : null);
  return start ? { start, end: s.endDate || start } : null;
}
// Nearest joined show that isn't over, if it starts within 7 days.
function ss2NextShowSoon() {
  const today = typeof _todayISO === 'function' ? _todayISO() : new Date().toLocaleDateString('en-CA');
  const limit = new Date(today + 'T12:00:00'); limit.setDate(limit.getDate() + 7);
  const lim = limit.toLocaleDateString('en-CA');
  let best = null;
  for (const s of _ss2MyShows()) {
    const r = _ss2ShowRange(s);
    if (!r || r.end < today || r.start > lim) continue;
    if (!best || r.start < best.r.start) best = { s, r };
  }
  if (!best) return null;
  const label = best.r.start <= today ? 'Today'
    : new Date(best.r.start + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return { show: best.s, label };
}
function ss2ShowToday() {
  return typeof _showIsToday === 'function' && _ss2MyShows().some(s => _showIsToday(s));
}

// ── Build (once) ──
function _ss2NavItem(route, icon, label, extra) {
  return `<a class="ss2-nav-item" href="#/s/${route}" data-route="${route}">${SS2_ICON[icon]}<span class="ss2-nav-label">${label}</span>${extra || ''}</a>`;
}
function _ss2Build() {
  if (_ss2Built) return;
  _ss2Built = true;
  const layout = document.querySelector('#view-seller .seller-layout');
  const main = layout && layout.querySelector('.main-content');
  if (!layout || !main) return;

  const nav = document.createElement('aside');
  nav.id = 'sellerNav';
  nav.innerHTML = `
    <button type="button" class="ss2-add-btn" onclick="openQuickActions('add')">${SS2_ICON.plus}<span>Add cards</span></button>
    <div class="ss2-nav" role="navigation" aria-label="Seller sections">
      ${_ss2NavItem('home', 'home', 'Home')}
      ${_ss2NavItem('inventory', 'cards', 'Inventory', '<span class="ss2-count" id="ss2InvCount"></span>')}
      ${_ss2NavItem('shows', 'shows', 'Shows', '<span class="ss2-chip" id="ss2ShowChip" style="display:none"></span>')}
      <div id="ss2NavMarket">
        ${_ss2NavItem('market', 'market', 'Marketplace', '<span class="ss2-badge" id="ss2MarketBadge" style="display:none"></span>')}
        <div class="ss2-nav-sub">
          <a class="ss2-nav-subitem" href="#" onclick="event.preventDefault();openMarketplacePanel()">Listings</a>
          <a class="ss2-nav-subitem" href="#/s/market/buyers" data-route="market" data-sub="buyers">Offers &amp; holds</a>
          <a class="ss2-nav-subitem" href="#" onclick="event.preventDefault();openOrdersPanel()">Orders</a>
        </div>
      </div>
      ${_ss2NavItem('sales', 'sales', 'Sales &amp; reports')}
    </div>
    <div class="ss2-nav-foot">
      ${_ss2NavItem('qr', 'qr', 'Table QR &amp; storefront')}
      <button type="button" class="ss2-nav-item" onclick="openProfile()">${SS2_ICON.settings}<span class="ss2-nav-label">Settings</span></button>
      <button type="button" class="ss2-nav-item" onclick="ss2OpenHelp(event)" aria-haspopup="true">${SS2_ICON.help}<span class="ss2-nav-label">Help &amp; tour</span></button>
      <div class="ss2-account">
        <span class="ss2-avatar" aria-hidden="true">${SS2_ICON.user}</span>
        <span class="ss2-account-name" id="ss2AccountName"></span>
        <button type="button" class="ss2-signout" onclick="signOut()" aria-label="Sign out" title="Sign out">${SS2_ICON.signout}</button>
      </div>
    </div>`;
  layout.insertBefore(nav, layout.firstChild);

  const top = document.createElement('div');
  top.id = 'sellerTopBar';
  top.innerHTML = `
    <label class="ss2-search">${SS2_ICON.search}
      <input type="search" id="ss2Search" placeholder="Search cards, players, codes…" autocomplete="off" aria-label="Search your cards" oninput="ss2Search(this.value)">
    </label>
    <button type="button" class="ss2-sm-btn" id="ss2ShowModeBtn" onclick="smOpenFromNav()"><span class="ss2-dot" id="ss2ShowModeDot" style="display:none"></span>${SS2_ICON.play}<span>Open Show Mode</span></button>
    <button type="button" class="ss2-avatar-btn" id="ss2AvatarBtn" onclick="ss2OpenMore()" aria-label="Account and settings" style="display:none">${SS2_ICON.user}</button>`;
  main.insertBefore(top, main.firstChild);

  const inv = document.getElementById('adminInventoryPanel');
  const panel = (id, html) => {
    const d = document.createElement('section');
    d.id = id; d.className = 'ss2-panel'; d.style.display = 'none'; d.innerHTML = html;
    main.insertBefore(d, inv);
    return d;
  };
  panel('ss2Home', `
    <div class="ss2-head"><h1 class="ss2-title">Home</h1><p class="ss2-lede" id="ss2HomeLede"></p></div>
    <div class="ss2-home" id="ss2HomeBody">
      <div class="ss2-card ss2-next" id="ss2NextShow"></div>
      <div class="ss2-card ss2-rows" id="ss2HomeNeeds" style="display:none"></div>
      <div class="ss2-card ss2-flow" id="ss2Flow" style="display:none"></div>
      <div class="ss2-kpis" id="ss2Kpis">
        <a class="ss2-kpi" href="#/s/inventory" id="ss2KpiAvail"><span class="ss2-kpi-lbl">Available</span><span class="ss2-kpi-val" id="ss2KpiAvailVal"></span><span class="ss2-kpi-sub" id="ss2KpiAvailSub"></span></a>
        <a class="ss2-kpi ss2-mk-only-block" href="#/s/inventory" onclick="ss2InvOpen('listed');return false" id="ss2KpiListed"><span class="ss2-kpi-lbl">Listed online</span><span class="ss2-kpi-val" id="ss2KpiListedVal">0</span><span class="ss2-kpi-sub" id="ss2KpiListedSub"></span></a>
        <a class="ss2-kpi" href="#/s/sales" id="ss2KpiSales"><span class="ss2-kpi-lbl">Sales this month</span><span class="ss2-kpi-val" id="ss2KpiSalesVal">$0</span><span class="ss2-kpi-sub" id="ss2KpiSalesSub"></span></a>
        <a class="ss2-kpi" href="#/s/sales/shows" id="ss2KpiProfit"><span class="ss2-kpi-lbl">Net profit this month</span><span class="ss2-kpi-val" id="ss2KpiProfitVal">—</span><span class="ss2-kpi-sub" id="ss2KpiProfitSub">on cards with a cost</span></a>
      </div>
    </div>
    <div id="ss2HomeChecklist" class="ss2-hidden-holder"></div>
    <div id="ss2HomeStats" class="ss2-hidden-holder"></div>`);
  panel('ss2Shows', `<div class="ss2-head"><h1 class="ss2-title">Shows</h1></div>
    <div class="ss2-card ss2-rows" id="ss2GetReady" style="display:none"></div>
    <div class="ss2-card" id="ss2ShowsBody"></div>`);
  panel('ss2Market', `
    <div class="ss2-head"><h1 class="ss2-title">Marketplace</h1></div>
    <div class="ss2-card ss2-rows">
      <button type="button" class="ss2-row" onclick="openOrdersPanel()"><span>Orders</span><span class="ss2-row-meta" id="ss2MkOrders"></span></button>
      <button type="button" class="ss2-row" onclick="openOffersPanel()"><span>Offers</span><span class="ss2-row-meta" id="ss2MkOffers"></span></button>
      <button type="button" class="ss2-row" onclick="openHoldsPanel()"><span>Holds</span><span class="ss2-row-meta" id="ss2MkHolds"></span></button>
      <button type="button" class="ss2-row" onclick="openMarketplacePanel()"><span>Listings</span><span class="ss2-row-meta">Choose what buyers can find</span></button>
      <button type="button" class="ss2-row" onclick="typeof openOfferRules==='function'&&openOfferRules()"><span>Offer rules</span><span class="ss2-row-meta">Automatic answers to offers</span></button>
    </div>`);
  panel('ss2Qr', `<div class="ss2-head"><h1 class="ss2-title">Table QR &amp; storefront</h1></div><div class="ss2-card" id="ss2QrBody"></div>`);
  panel('ss2SalesHead', `
    <div class="ss2-head ss2-head-row">
      <a class="ss2-back" href="#/s/home" aria-label="Back to Home">${SS2_ICON.chev}</a>
      <h1 class="ss2-title">Sales &amp; reports</h1>
      <div class="ss2-seg" role="tablist">
        <a role="tab" href="#/s/sales" data-sub="" class="ss2-seg-btn">Sales</a>
        <a role="tab" href="#/s/sales/shows" data-sub="shows" class="ss2-seg-btn">Show results</a>
      </div>
    </div>
    <div class="ss2-card ss2-baseline" id="ss2BaselineCard">
      <div class="ss2-baseline-text"><b>Inventory baseline</b><span id="ss2BaselineHolder"></span><span class="ss2-row-meta" id="ss2BaselineNone">Set a baseline to see how your inventory grows from today.</span></div>
      <button type="button" class="btn btn-ghost ss2-cta" onclick="shSetBaseline()">Set baseline</button>
    </div>`);

  const tabs = document.createElement('div');   // not <nav>: app.html styles every <nav> as the sticky top bar
  tabs.id = 'sellerTabBarV2';
  tabs.setAttribute('role', 'navigation');
  tabs.setAttribute('aria-label', 'Seller sections');
  tabs.innerHTML = `
    <a class="ss2-tab" href="#/s/home" data-route="home">${SS2_ICON.home}<span>Home</span></a>
    <a class="ss2-tab" href="#/s/inventory" data-route="inventory">${SS2_ICON.cards}<span>Cards</span></a>
    <button type="button" class="ss2-tab ss2-tab-plus" onclick="openQuickActions()" aria-label="Sell or add cards">${SS2_ICON.plus}</button>
    <a class="ss2-tab" href="#/s/shows" data-route="shows">${SS2_ICON.shows}<span>Shows</span></a>
    <a class="ss2-tab" href="#/s/market/buyers" data-route="market" id="ss2TabMarket">${SS2_ICON.market}<span>Market</span><span class="ss2-badge" id="ss2TabMarketBadge" style="display:none"></span></a>
    <button type="button" class="ss2-tab" data-route="more" id="ss2TabMore" onclick="ss2OpenMore()">${SS2_ICON.more}<span>More</span></button>`;
  document.body.appendChild(tabs);

  const sheet = document.createElement('div');
  sheet.id = 'ss2MoreSheet';
  sheet.className = 'ss2-sheet-overlay';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'More');
  sheet.addEventListener('click', e => { if (e.target === sheet) ss2CloseMore(); });
  sheet.innerHTML = `<div class="ss2-sheet">
    <div class="ss2-sheet-grab" aria-hidden="true"></div>
    <button type="button" class="ss2-sheet-row ss2-sheet-profile" onclick="ss2CloseMore();openProfile()">${SS2_ICON.user}<span><b id="ss2MoreName"></b><small>Profile &amp; how buyers reach you</small></span></button>
    <a class="ss2-sheet-row" href="#/s/sales" onclick="ss2CloseMore()">${SS2_ICON.sales}<span>Sales &amp; reports</span></a>
    <a class="ss2-sheet-row" href="#/s/qr" onclick="ss2CloseMore()">${SS2_ICON.qr}<span>Table QR &amp; storefront</span></a>
    <button type="button" class="ss2-sheet-row" onclick="ss2CloseMore();openProfile()">${SS2_ICON.settings}<span>Settings</span></button>
    <div class="ss2-sheet-label">Help &amp; tour</div>
    <button type="button" class="ss2-sheet-row" onclick="ss2CloseMore();replayOnboarding()">${SS2_ICON.play}<span>Replay the tour</span></button>
    <button type="button" class="ss2-sheet-row" onclick="ss2CloseMore();openFeatureGuide()">${SS2_ICON.help}<span>Feature guide</span></button>
    <button type="button" class="ss2-sheet-row" onclick="ss2CloseMore();tipsReset()">${SS2_ICON.help}<span>Show tips again</span></button>
    <a class="ss2-sheet-row" href="/downloads/CardShow_Inventory_Template.xlsx" download onclick="ss2CloseMore()">${SS2_ICON.cards}<span>Spreadsheet template</span></a>
    <a class="ss2-sheet-row" href="mailto:support@getcardshow.com?subject=CardShow%20help" onclick="ss2CloseMore()">${SS2_ICON.help}<span>Contact support</span></a>
    <button type="button" class="ss2-sheet-row" onclick="ss2CloseMore();signOut()">${SS2_ICON.signout}<span>Sign out</span></button>
    <button type="button" class="btn btn-ghost ss2-sheet-close" onclick="ss2CloseMore()">Close</button>
  </div>`;
  document.body.appendChild(sheet);

  document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheet.classList.contains('open')) ss2CloseMore(); });
}

// Wraps app functions so the shell hears about changes. Each wrapper calls the
// original unchanged, then refreshes the shell (only while it's mounted).
function _ss2Wrap() {
  if (_ss2Wrapped) return;
  if (typeof gsRender === 'function') {
    const orig = gsRender;
    window.gsRender = function () { const r = orig.apply(this, arguments); if (_ss2On) ss2RenderFlow(); return r; };
  }
  if (typeof gsShowAgain === 'function') {
    const orig = gsShowAgain;
    window.gsShowAgain = function () {
      if (!_ss2On) return orig.apply(this, arguments);
      if (typeof closeHelpMenu === 'function') closeHelpMenu();
      _gsSave({ dismissed: false, collapsed: false });
      ss2Go('home');
      ss2RenderFlow();
      const box = document.getElementById('ss2Flow');
      if (box && box.style.display !== 'none') box.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else showToast("✓ You've done every step");
    };
  }
  _ss2Wrapped = true;
  const after = (name, fn) => {
    const orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function () { const r = orig.apply(this, arguments); try { if (_ss2On) fn.apply(this, arguments); } catch (e) { console.warn('[seller-shell]', e); } return r; };
  };
  ['updateStats', 'renderSellerShowsList', '_ordRenderStrip', '_moRenderStrip', '_mhRenderStrip'].forEach(n => after(n, ss2Refresh));
  // Inventory (Phase 2): the shell picks the rows (view + filters + search) and keeps the selection.
  const origRender = window.renderSellerTable;
  if (typeof origRender === 'function') {
    window.renderSellerTable = function (rows) {
      if (!_ss2On || currentRole !== 'seller') return origRender.apply(this, arguments);
      return ss2InvRender(origRender);
    };
  }
  // Show Mode closing clears its hash; put the seller back where they were.
  after('closeShowMode', () => { if (!location.hash || location.hash === '#') _ss2Replace(_ss2Route + (_ss2Sub ? '/' + _ss2Sub : '')); });
  // Old callers (Feature guide, tips, tests) still switch tabs; keep the URL in step.
  after('switchSellerTab', tab => {
    if (_ss2Routing) return;
    const r = tab === 'report' ? 'sales' : tab === 'shows' ? 'sales/shows' : 'inventory';
    _ss2Replace(r);
  });
}

// ── Mount / unmount ──
function ss2Init() {
  if (!ss2IsEnabled() || currentRole !== 'seller') return;
  _ss2Build();
  _ss2Wrap();
  if (!document.getElementById('sellerNav')) return;
  _ss2On = true;
  document.body.classList.add('seller-v2');
  _ss2MoveInto('sellerShowsPanel', 'ss2ShowsBody');
  _ss2MoveInto('sellerQrPanel', 'ss2QrBody');
  _ss2MoveInto('sellerStatsRow', 'ss2HomeStats');
  _ss2MoveInto('statTotal', 'ss2KpiAvailVal');
  _ss2MoveInto('statValue', 'ss2KpiAvailSub');
  _ss2MoveInto('gsChecklist', 'ss2HomeChecklist');
  _ss2MoveInto('baselineStrip', 'ss2BaselineHolder');
  _ss2InvMount();
  const s = document.getElementById('sellerShowsPanel'); if (s) s.style.display = 'block';
  const name = document.getElementById('ss2AccountName'); if (name) name.textContent = '@' + currentSeller;
  const more = document.getElementById('ss2MoreName'); if (more) more.textContent = '@' + currentSeller;
  const m = location.hash.match(SS2_HASH_RE);
  if (/^#\/sm\//.test(location.hash)) {
    _ss2Show(_ss2Last());            // Show Mode is (re)opening on top; this is what's under it
  } else if (m) {
    ss2Route();
  } else {
    _ss2Replace(_ss2Last());
  }
  ss2Refresh();
}

function ss2Teardown() {
  if (!_ss2Built) return;
  _ss2ThumbIndexLoaded = false;
  _ss2Pl = null; _ss2PlAt = 0;
  _ss2InvUnmount();
  _ss2On = false;
  document.body.classList.remove('seller-v2');
  document.body.className = document.body.className.replace(/\bss2-route-\S+/g, '').trim();
  ss2CloseMore();
  for (const { el, parent, next } of _ss2Moved.reverse()) {
    if (next && next.parentNode === parent) parent.insertBefore(el, next); else parent.appendChild(el);
  }
  _ss2Moved = [];
  document.querySelectorAll('.ss2-panel').forEach(p => { p.style.display = 'none'; });
  if (SS2_HASH_RE.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  const inp = document.getElementById('ss2Search'); if (inp) inp.value = '';
  const menu = document.getElementById('navHelpMenu'); if (menu) { menu.style.left = ''; menu.style.display = 'none'; }
}

function _ss2MoveInto(id, targetId) {
  const el = document.getElementById(id), target = document.getElementById(targetId);
  if (!el || !target || target.contains(el)) return;
  _ss2Moved.push({ el, parent: el.parentNode, next: el.nextSibling });
  target.appendChild(el);
}

// ── Routing ──
function _ss2LastKey() { return 'ss2Last:' + (currentSeller || ''); }
function _ss2Last() {
  try {
    const v = localStorage.getItem(_ss2LastKey()) || 'home';
    return _ss2Valid(v.split('/')[0]) ? v : 'home';
  } catch (_) { return 'home'; }
}
function _ss2Valid(r) { return SS2_ROUTES.includes(r) && (r !== 'market' || _ss2Mk()); }
function _ss2Replace(path) {
  history.replaceState(null, '', location.pathname + location.search + '#/s/' + path);
  ss2Route();
}
function ss2Go(path) {
  if (location.hash === '#/s/' + path) ss2Route(); else location.hash = '#/s/' + path;
}

function ss2Route() {
  if (!_ss2On) return;
  const m = location.hash.match(SS2_HASH_RE);
  if (!m) return;
  const route = m[1], sub = m[2] || '';
  if (!_ss2Valid(route)) { _ss2Replace('home'); return; }
  _ss2Show(route + (sub ? '/' + sub : ''));
}

function _ss2Show(path) {
  const [route, sub = ''] = path.split('/');
  _ss2Route = _ss2Valid(route) ? route : 'home';
  _ss2Sub = sub;
  try { localStorage.setItem(_ss2LastKey(), _ss2Route + (sub ? '/' + sub : '')); } catch (_) {}
  document.body.className = document.body.className.replace(/\bss2-route-\S+/g, '').trim();
  document.body.classList.add('ss2-route-' + _ss2Route);

  if (_ss2Route !== 'inventory') ss2InvClearSelection();   // other pages act on all cards, never a stale selection
  const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
  show('ss2Home', _ss2Route === 'home');
  show('ss2Shows', _ss2Route === 'shows');
  show('ss2Market', _ss2Route === 'market');
  show('ss2Qr', _ss2Route === 'qr');
  show('ss2SalesHead', _ss2Route === 'sales');
  const invPanel = document.getElementById('adminInventoryPanel');
  const usesInv = _ss2Route === 'inventory' || _ss2Route === 'sales';
  if (invPanel) invPanel.style.display = usesInv ? 'block' : 'none';
  if (usesInv) {
    _ss2Routing = true;
    try { switchSellerTab(_ss2Route === 'inventory' ? 'inventory' : (sub === 'shows' ? 'shows' : 'report')); }
    finally { _ss2Routing = false; }
    if (_ss2Route === 'inventory' && typeof applyInventoryFilters === 'function') applyInventoryFilters();   // current view + filters
  }
  if (_ss2Route === 'qr' && typeof buildSellerQrPanel === 'function') buildSellerQrPanel();
  if (_ss2Route === 'sales' && typeof shRenderBaseline === 'function') {
    shRenderBaseline();
    const strip = document.getElementById('baselineStrip'), none = document.getElementById('ss2BaselineNone');
    if (none) none.style.display = strip && strip.style.display !== 'none' && strip.innerHTML ? 'none' : '';
  }
  document.querySelectorAll('#sellerNav [data-route], #sellerTabBarV2 [data-route]').forEach(a => {
    const on = a.dataset.route === _ss2Route && (a.dataset.sub === undefined || a.dataset.sub === sub);
    a.classList.toggle('active', on);
    if (on && !a.classList.contains('ss2-nav-subitem')) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.querySelectorAll('#ss2SalesHead .ss2-seg-btn').forEach(a => {
    const on = a.dataset.sub === sub;
    a.classList.toggle('active', on);
    a.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  ss2CloseMore();
  window.scrollTo(0, 0);
  ss2Refresh();
}

window.addEventListener('hashchange', () => {
  if (!_ss2On) return;
  if (/^#\/sm\//.test(location.hash)) return;          // Show Mode's own routes
  if (!location.hash || location.hash === '#') return;  // href="#" links: stay put
  if (SS2_HASH_RE.test(location.hash)) ss2Route();
});

// ── Refresh badges / counts (cheap, in-memory only) ──
function ss2Refresh() {
  if (!_ss2On) return;
  const mk = _ss2Mk();
  document.body.classList.toggle('ss2-mk', mk);
  const inv = typeof getSellerInventory === 'function' ? getSellerInventory() : [];
  const invCount = document.getElementById('ss2InvCount');
  if (invCount) invCount.textContent = inv.length ? inv.length.toLocaleString() : '';

  const soon = ss2NextShowSoon();
  const chip = document.getElementById('ss2ShowChip');
  if (chip) { chip.textContent = soon ? soon.label : ''; chip.style.display = soon ? '' : 'none'; }
  const dot = document.getElementById('ss2ShowModeDot');
  if (dot) dot.style.display = ss2ShowToday() ? '' : 'none';
  const smBtn = document.getElementById('ss2ShowModeBtn');
  if (smBtn) smBtn.style.display = (typeof smIsEnabled === 'function' && smIsEnabled()) ? '' : 'none';

  const c = ss2MarketCounts();
  const setBadge = (id, n) => { const b = document.getElementById(id); if (b) { b.textContent = n > 99 ? '99+' : String(n); b.style.display = mk && n ? '' : 'none'; } };
  setBadge('ss2MarketBadge', c.total);
  setBadge('ss2TabMarketBadge', c.total);
  const tm = document.getElementById('ss2TabMarket');
  if (tm) tm.setAttribute('aria-label', 'Market' + (c.total ? ', ' + c.total + ' need you' : ''));
  const txt = (id, t) => { const e = document.getElementById(id); if (e) e.textContent = t; };
  txt('ss2MkOrders', [c.toConfirm && c.toConfirm + ' to confirm', c.toShip && c.toShip + ' to ship'].filter(Boolean).join(' · ') || 'Nothing waiting');
  txt('ss2MkOffers', c.offers ? c.offers + ' waiting on you' : 'Nothing waiting');
  txt('ss2MkHolds', c.holds ? c.holds + ' ending within 24 hours' : (typeof mhActive === 'function' && mhActive().length ? mhActive().length + ' on hold' : 'None'));

  const needCount = _ss2RenderNeeds(c, mk);
  if (_ss2Route === 'inventory') ss2InvRefreshChrome();
  ss2RenderHome(needCount);
  ss2RenderGetReady();
}

// ── Search (top bar) → the existing inventory filter ──
function ss2Search(v) {
  _ss2Sel.clear();
  const inp = document.getElementById('sellerSearchInput');
  if (inp) inp.value = v;
  if (_ss2Route !== 'inventory') ss2Go('inventory');
  if (typeof applyInventoryFilters === 'function') applyInventoryFilters();
}

// ── More sheet (phone More tab; the avatar button when Market takes slot 5) ──
function ss2OpenMore() {
  const s = document.getElementById('ss2MoreSheet');
  if (!s) return;
  s.classList.add('open');
  setTimeout(() => s.querySelector('.ss2-sheet-row')?.focus(), 30);
}
function ss2CloseMore() {
  const s = document.getElementById('ss2MoreSheet');
  if (s) s.classList.remove('open');
}

// Desktop nav "Help & tour": the existing help menu, opened beside the button.
function ss2OpenHelp(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('navHelpMenu');
  if (!menu) return;
  if (menu.style.display !== 'none') { menu.style.display = 'none'; return; }
  const r = (e && e.currentTarget ? e.currentTarget : document.body).getBoundingClientRect();
  menu.style.right = 'auto';
  menu.style.left = (r.right + 8) + 'px';
  menu.style.top = Math.max(8, Math.min(r.top - 120, window.innerHeight - 280)) + 'px';
  menu.style.display = 'block';
  const close = ev => { if (!menu.contains(ev.target)) { menu.style.display = 'none'; menu.style.left = ''; document.removeEventListener('click', close, true); } };
  setTimeout(() => document.addEventListener('click', close, true), 0);
}

// ══════ Phase 2: Inventory — saved views, filter bar, bulk-action bar ══════
// The classic table renderer (renderSellerTable) is kept; the shell decides which
// rows it gets (view + filters + search, ss2InvRows) and keeps a selection that
// survives re-renders. Rows start unchecked in v2 (the classic view pre-checks every
// unsold card). Every bulk action calls an existing function, which reads the checked
// rows, so the selection is always what's checked in the table.

const SS2_VIEWS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'available', label: 'Available', test: c => c.Status !== 'Sold' },
  { id: 'atshow', label: 'At a show', test: c => c.Status !== 'Sold' && c._shows instanceof Set && c._shows.size > 0 },
  { id: 'listed', label: 'Listed online', mk: true, test: c => _ss2Listed(c) },
  { id: 'attention', label: 'Needs attention', test: c => c.Status !== 'Sold' && !!ss2AttentionReason(c) },
  { id: 'sold', label: 'Sold', test: c => c.Status === 'Sold' },
];
const SS2_REASONS = {
  trust_flag: 'Stolen / lost report', needs_details: 'Needs details', no_price: 'No asking price', no_photo: 'No photo',
};
const SS2_SORTS = { recent: 'Recently added', price_desc: 'Price: high to low', price_asc: 'Price: low to high', player: 'Player A–Z', code: 'Stock code' };

let _ss2Inv = { view: 'available', custom: null, sport: '', graded: '', show: '', sort: 'recent', reason: '' };
let _ss2Sel = new Set();          // selected card objects
let _ss2InvBuilt = false;
let _ss2InvMoved = [];

function _ss2Listed(c) {
  if (typeof mkListing !== 'function' || c.Status === 'Sold') return false;
  const l = mkListing(c);
  return l === 'active' || l === 'reserved' || (typeof ordForCard === 'function' && !!ordForCard(c));
}
// Why a card can't go on sale yet, most serious first (null = fine).
function ss2AttentionReason(c) {
  if (c._trustFlag === 'flagged') return 'trust_flag';
  if (c.IdentificationStatus === 'unidentified') return 'needs_details';
  if (!(Number(c.Price) > 0)) return 'no_price';
  if (_ss2Mk() && typeof mkImageOk === 'function' && !mkImageOk(c)) return 'no_photo';
  return null;
}
function _ss2SportOf(c) {
  const e = typeof _effectiveCardCategory === 'function' ? _effectiveCardCategory(c) : null;
  return e ? (e.subcategory || e.category || '') : '';
}
function _ss2Graded(c) { return c.Grade !== '' && c.Grade != null && !isNaN(Number(c.Grade)); }
function _ss2ViewsKey() { return 'ss2Views:' + (currentSeller || ''); }
function ss2CustomViews() { try { return JSON.parse(localStorage.getItem(_ss2ViewsKey()) || '[]'); } catch (_) { return []; } }
function _ss2SaveCustomViews(v) { try { localStorage.setItem(_ss2ViewsKey(), JSON.stringify(v)); } catch (_) {} }

function _ss2Query() { return (document.getElementById('sellerSearchInput')?.value || '').trim().toLowerCase(); }
function _ss2MatchQuery(r, q) {
  if (!q) return true;
  const qKey = typeof stockCodeQueryKey === 'function' ? stockCodeQueryKey(q) : '';
  const qNeeds = q.length >= 4 && 'needs details'.startsWith(q);
  return (qNeeds && r.IdentificationStatus === 'unidentified' && r.Status !== 'Sold')
    || (qKey && r.StockCode && stockCodeKey(r.StockCode).startsWith(qKey))
    || [r.Player, r['Card Title'], typeof getSet === 'function' ? getSet(r) : '', r['Cert #'], r['Parallel/Variant']]
         .some(v => String(v || '').toLowerCase().includes(q));
}

// The rows the table shows: base view, then filters, then search, then sort.
function ss2InvRows() {
  const all = typeof getSellerInventory === 'function' ? getSellerInventory() : [];
  const view = SS2_VIEWS.find(v => v.id === _ss2Inv.view) || SS2_VIEWS[1];
  const q = _ss2Query();
  let rows = all.filter(c => view.test(c)
    && (!_ss2Inv.reason || ss2AttentionReason(c) === _ss2Inv.reason)
    && (!_ss2Inv.sport || _ss2SportOf(c) === _ss2Inv.sport)
    && (!_ss2Inv.graded || (_ss2Inv.graded === 'graded') === _ss2Graded(c))
    && (!_ss2Inv.show || (_ss2Inv.show === '__none'
          ? !(c._shows instanceof Set && c._shows.size) : (c._shows instanceof Set && c._shows.has(_ss2Inv.show))))
    && _ss2MatchQuery(c, q));
  const pos = new Map(inventory.map((c, i) => [c, i]));
  const idx = c => pos.get(c) ?? -1;
  const by = {
    recent: (a, b) => idx(b) - idx(a),
    price_desc: (a, b) => (Number(b.Price) || 0) - (Number(a.Price) || 0),
    price_asc: (a, b) => (Number(a.Price) || 0) - (Number(b.Price) || 0),
    player: (a, b) => String(a.Player || a['Card Title'] || '').localeCompare(String(b.Player || b['Card Title'] || '')),
    code: (a, b) => String(a.StockCode || '~').localeCompare(String(b.StockCode || '~'), undefined, { numeric: true }),
  }[_ss2Inv.sort] || null;
  if (by) rows = rows.slice().sort(by);
  return rows;
}

// Replaces renderSellerTable's body while v2 is on (see _ss2Wrap).
function ss2InvRender(origRender) {
  const all = getSellerInventory();
  const rows = ss2InvRows();
  const tbody = document.getElementById('inventoryBody');
  if (!all.length || rows.length) origRender(rows);
  else if (tbody) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="ss2-empty"><b>No cards in this view</b>
      <span>${_ss2Query() || _ss2Inv.sport || _ss2Inv.graded || _ss2Inv.show || _ss2Inv.reason ? 'Try clearing the search or filters.' : 'Cards show up here as soon as they match.'}</span>
      <button type="button" class="btn btn-ghost ss2-cta" onclick="ss2InvResetFilters()">Clear filters</button></div></td></tr>`;
  }
  // Keep only selected cards that are still shown, then restore the ticks.
  const shown = new Set(rows);
  for (const c of [..._ss2Sel]) if (!shown.has(c)) _ss2Sel.delete(c);
  if (tbody) tbody.querySelectorAll('.card-check').forEach(cb => {
    const card = inventory[parseInt(cb.dataset.idx, 10)];
    cb.checked = _ss2Sel.has(card);
    cb.setAttribute('aria-label', 'Select ' + ((card && card['Card Title']) || 'card'));
  });
  rows.forEach(_ss2AddWhereChips);
  rows.forEach(_ss2AddThumb);
  rows.forEach(_ss2AddAsking);
  _ss2LoadThumbs();
  ss2InvRefreshChrome();
}

// Card thumbnail beside the title (spec 2.5). Same lookup as Show Mode:
// the seller's photo (this device, or another device via a signed URL), then
// the catalog image, then a blank tile. Tap it to open Edit Card.
function _ss2ThumbHTML(c, idx) {
  const img = typeof smCardImage === 'function' ? smCardImage(c) : null;
  const label = _ss2Esc('Edit ' + (c['Card Title'] || 'card'));
  const inner = img
    ? `<img src="${_ss2Esc(img.url)}" alt="" loading="lazy"${img.source === 'stock' ? ` data-catalog="${_ss2Esc(c.CatalogCardId || '')}"` : ''} onerror="_ss2ThumbFailed(this)">`
    : '';
  return `<button type="button" class="ss2-thumb${img && img.source === 'stock' ? ' ss2-thumb--stock' : ''}${img ? '' : ' ss2-thumb--none'}" aria-label="${label}" onclick="openCEM(${idx})">${inner}</button>`;
}
function _ss2ThumbFailed(img) {
  if (img.dataset.catalog && navigator.onLine && typeof _smStockMissing !== 'undefined') _smStockMissing.add(img.dataset.catalog);
  const b = img.parentElement;
  if (b) b.classList.add('ss2-thumb--none');
  img.remove();
}
function _ss2AddThumb(c) {
  const idx = inventory.indexOf(c);
  const tr = document.getElementById('inv-row-' + idx);
  const cell = tr && tr.children[1];
  if (!cell || cell.querySelector('.ss2-cardcell')) return;
  const wrap = document.createElement('div');
  wrap.className = 'ss2-cardcell';
  wrap.innerHTML = _ss2ThumbHTML(c, idx) + '<div class="ss2-cardtext"></div>';
  const text = wrap.lastChild;
  while (cell.firstChild) text.appendChild(cell.firstChild);
  cell.appendChild(wrap);
  if (c.Status === 'Sold') wrap.firstChild.style.opacity = '0.4';
}
// Asking column: the classic Price cell, tappable to change the price right in the table.
// A card with no price says "Add price" (it can't be listed or sold at an asking price).
function _ss2AddAsking(c) {
  const idx = inventory.indexOf(c);
  const tr = document.getElementById('inv-row-' + idx);
  const td = tr && tr.querySelector('td[data-label="Price"]');
  if (!td || td.querySelector('.ss2-ask') || c.Status === 'Sold') return;
  const price = Number(c.Price) || 0;
  td.innerHTML = `<button type="button" class="ss2-ask${price ? '' : ' ss2-ask--none'}" aria-label="Asking price for ${_ss2Esc(c['Card Title'] || 'card')}: ${price ? '$' + price.toLocaleString() : 'none'}. Tap to change"
    onclick="ss2AskEdit(${idx}, this)">${price ? '$' + price.toLocaleString() : 'Add price'}</button>`;
}
function ss2AskEdit(idx, btn) {
  const c = inventory[idx];
  const td = btn && btn.parentNode;
  if (!c || !td) return;
  const was = Number(c.Price) || 0;
  td.innerHTML = `<input type="number" inputmode="decimal" min="0" step="1" class="ss2-ask-input" value="${was || ''}" placeholder="$" aria-label="Asking price">`;
  const input = td.firstChild;
  input.focus(); input.select();
  let done = false;
  const finish = save => {
    if (done) return; done = true;
    const v = input.value.trim();
    const n = v === '' ? 0 : parseFloat(v);
    if (save && (!Number.isFinite(n) || n < 0)) { showToast('Enter a price of $0 or more'); done = false; input.focus(); return; }
    if (save && n !== was) {
      c.Price = n;
      updateCardInDB(c);
      if (typeof syncBuyerView === 'function') syncBuyerView();
      updateStats();
      showToast(n ? `Asking price set to $${n.toLocaleString()}` : 'Asking price cleared');
    }
    applyInventoryFilters();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

// Photos saved on this phone (once per sign-in) and signed URLs for photos
// taken on other devices; re-render only when something new arrived.
let _ss2ThumbIndexLoaded = false, _ss2ThumbBusy = false;
async function _ss2LoadThumbs() {
  if (_ss2ThumbBusy || typeof _smLoadRemoteThumbs !== 'function') return;
  _ss2ThumbBusy = true;
  let changed = false;
  try {
    if (!_ss2ThumbIndexLoaded && typeof _smLoadCaptureIndex === 'function') {
      _ss2ThumbIndexLoaded = true;
      const before = typeof _smThumbUrls !== 'undefined' ? _smThumbUrls.size : 0;
      await _smLoadCaptureIndex();
      changed = typeof _smThumbUrls !== 'undefined' && _smThumbUrls.size !== before;
    }
    if (await _smLoadRemoteThumbs()) changed = true;
  } catch (e) { console.warn('[seller-v2] thumbnails', e); }
  _ss2ThumbBusy = false;
  if (changed && _ss2On && _ss2Route === 'inventory' && typeof applyInventoryFilters === 'function') applyInventoryFilters();
}

// "Where it's for sale" chips under the card title: shows, and not-for-sale-yet.
function _ss2AddWhereChips(c) {
  const tr = document.getElementById('inv-row-' + inventory.indexOf(c));
  const cell = tr && tr.children[1];
  if (!cell || cell.querySelector('.ss2-where') || c.Status === 'Sold') return;
  const chips = [];
  if (c._shows instanceof Set) for (const id of c._shows) {
    const s = shows[id]; if (!s) continue;
    const r = _ss2ShowRange(s);
    const day = r ? new Date(r.start + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
    chips.push(`<span class="ss2-chip-show" title="${_ss2Esc(s.name || '')}">${_ss2Esc([day, (s.name || 'Show').slice(0, 18)].filter(Boolean).join(' · '))}</span>`);
  }
  if (_ss2Mk() && typeof mkImageOk === 'function' && !mkImageOk(c) && c.item_type !== 'sealed') chips.push('<span class="ss2-chip-warn">No photo</span>');
  if (!chips.length && !_ss2Listed(c)) chips.push('<span class="ss2-chip-muted">Not for sale yet</span>');
  const d = document.createElement('div');
  d.className = 'ss2-where';
  d.innerHTML = chips.join('');
  cell.appendChild(d);
}

function ss2InvSelected() { return [..._ss2Sel].filter(c => inventory.includes(c)); }
function ss2InvClearSelection() {
  _ss2Sel.clear();
  document.querySelectorAll('#inventoryBody .card-check').forEach(cb => { cb.checked = false; });
  _ss2ClosePop();
  ss2InvRefreshChrome();
}
function ss2InvToggleAll(on) {
  document.querySelectorAll('#inventoryBody .card-check').forEach(cb => {
    cb.checked = on;
    const card = inventory[parseInt(cb.dataset.idx, 10)];
    if (card) { if (on) _ss2Sel.add(card); else _ss2Sel.delete(card); }
  });
  ss2InvRefreshChrome();
}

// Counts, view tabs, filter options, header checkbox and the bulk bar. Never re-renders the table.
function ss2InvRefreshChrome() {
  if (!_ss2On || !_ss2InvBuilt) return;
  const all = getSellerInventory();
  const mk = _ss2Mk();
  const custom = ss2CustomViews();
  const tabs = document.getElementById('ss2Views');
  if (tabs) {
    tabs.innerHTML = SS2_VIEWS.filter(v => !v.mk || mk).map(v => {
      const on = !_ss2Inv.custom && _ss2Inv.view === v.id;
      return `<button type="button" role="tab" class="ss2-view${on ? ' active' : ''}" aria-selected="${on}" onclick="ss2InvSetView('${v.id}')">${v.label} <span class="ss2-view-n">${all.filter(v.test).length.toLocaleString()}</span></button>`;
    }).join('') + custom.map(v => {
      const on = _ss2Inv.custom === v.id;
      return `<span class="ss2-view-custom${on ? ' active' : ''}"><button type="button" role="tab" class="ss2-view${on ? ' active' : ''}" aria-selected="${on}" onclick="ss2InvApplyCustom('${_ss2Esc(v.id)}')">${_ss2Esc(v.name)}</button><button type="button" class="ss2-view-x" aria-label="Delete view ${_ss2Esc(v.name)}" onclick="ss2InvDeleteCustom('${_ss2Esc(v.id)}')">×</button></span>`;
    }).join('') + `<button type="button" class="ss2-view ss2-view-save" onclick="ss2InvSaveView()">+ Save view</button>`;
  }
  // Filter options from the cards the seller actually has.
  const setOpts = (id, opts, cur) => {
    const el = document.getElementById(id); if (!el) return;
    const html = opts.map(([v, l]) => `<option value="${_ss2Esc(v)}"${v === cur ? ' selected' : ''}>${_ss2Esc(l)}</option>`).join('');
    if (el.innerHTML !== html) el.innerHTML = html;
  };
  const sports = [...new Set(all.map(_ss2SportOf).filter(Boolean))].sort();
  setOpts('ss2FSport', [['', 'All sports'], ...sports.map(x => [x, x])], _ss2Inv.sport);
  setOpts('ss2FGraded', [['', 'Graded & raw'], ['graded', 'Graded'], ['raw', 'Raw']], _ss2Inv.graded);
  const myShows = _ss2MyShows().sort((a, b) => String((_ss2ShowRange(a) || {}).start || '').localeCompare(String((_ss2ShowRange(b) || {}).start || '')));
  setOpts('ss2FShow', [['', 'Any show'], ['__none', 'Not at a show'], ...myShows.map(s => [s.id, s.name || s.id])], _ss2Inv.show);
  setOpts('ss2FSort', Object.entries(SS2_SORTS), _ss2Inv.sort);
  const reason = document.getElementById('ss2Reason');
  if (reason) {
    reason.style.display = _ss2Inv.reason ? '' : 'none';
    reason.innerHTML = _ss2Inv.reason ? `Showing: ${_ss2Esc(SS2_REASONS[_ss2Inv.reason] || _ss2Inv.reason)} <button type="button" class="ss2-view-x" aria-label="Show all reasons" onclick="ss2InvSetReason('')">×</button>` : '';
  }

  const sel = ss2InvSelected();
  const boxes = [...document.querySelectorAll('#inventoryBody .card-check')];
  const head = document.getElementById('ss2SelAll');
  if (head) {
    head.checked = boxes.length > 0 && boxes.every(b => b.checked);
    head.indeterminate = !head.checked && boxes.some(b => b.checked);
  }
  const bar = document.getElementById('ss2BulkBar'), filters = document.getElementById('ss2FilterBar');
  document.body.classList.toggle('ss2-has-sel', sel.length > 0);
  if (bar) bar.style.display = sel.length ? '' : 'none';
  if (filters) filters.style.display = sel.length ? 'none' : '';
  const count = document.getElementById('ss2BulkCount');
  if (count) count.textContent = `${sel.length} selected`;
  const sell = document.getElementById('ss2BulkSell');
  if (sell) {
    const ok = sel.length === 1 && sel[0].Status !== 'Sold';
    sell.disabled = !ok;
    sell.title = sel.length > 1 ? 'Select one card to sell' : (sel.length === 1 && !ok ? 'This card is already sold' : '');
  }
}

// ── View / filter changes (each clears the selection) ──
function _ss2InvChanged() { _ss2Sel.clear(); if (typeof applyInventoryFilters === 'function') applyInventoryFilters(); }
function ss2InvSetView(id) { _ss2Inv.view = id; _ss2Inv.custom = null; _ss2Inv.reason = ''; _ss2InvChanged(); }
function ss2InvSetReason(r) { _ss2Inv.reason = r; if (r) { _ss2Inv.view = 'attention'; _ss2Inv.custom = null; } _ss2InvChanged(); }
function ss2InvFilter(key, value) { _ss2Inv[key] = value; if (key !== 'sort') _ss2Inv.custom = null; _ss2InvChanged(); }
function ss2InvResetFilters() {
  Object.assign(_ss2Inv, { custom: null, sport: '', graded: '', show: '', reason: '' });
  const q = document.getElementById('sellerSearchInput'); if (q) q.value = '';
  const top = document.getElementById('ss2Search'); if (top) top.value = '';
  _ss2InvChanged();
}
// Opens Inventory on a view, from another page (Home, Marketplace, Shows).
function ss2InvOpen(view, reason) {
  _ss2Inv.view = view || 'available'; _ss2Inv.custom = null; _ss2Inv.reason = reason || '';
  _ss2Sel.clear();
  if (_ss2Route === 'inventory') applyInventoryFilters(); else ss2Go('inventory');
}
function ss2InvSaveView() {
  const name = (prompt('Name this view (it\'s saved on this device):') || '').trim().slice(0, 30);
  if (!name) return;
  const views = ss2CustomViews();
  const v = { id: 'v' + Date.now().toString(36), name, view: _ss2Inv.view, reason: _ss2Inv.reason, sport: _ss2Inv.sport,
    graded: _ss2Inv.graded, show: _ss2Inv.show, sort: _ss2Inv.sort, q: _ss2Query() };
  views.push(v);
  _ss2SaveCustomViews(views.slice(-12));
  _ss2Inv.custom = v.id;
  ss2InvRefreshChrome();
  showToast(`View "${name}" saved`);
}
function ss2InvApplyCustom(id) {
  const v = ss2CustomViews().find(x => x.id === id); if (!v) return;
  Object.assign(_ss2Inv, { view: v.view || 'available', reason: v.reason || '', sport: v.sport || '', graded: v.graded || '',
    show: v.show || '', sort: v.sort || 'recent', custom: v.id });
  const q = document.getElementById('sellerSearchInput'); if (q) q.value = v.q || '';
  _ss2Sel.clear();
  applyInventoryFilters();
}
function ss2InvDeleteCustom(id) {
  _ss2SaveCustomViews(ss2CustomViews().filter(v => v.id !== id));
  if (_ss2Inv.custom === id) _ss2Inv.custom = null;
  ss2InvRefreshChrome();
}

// ── Bulk actions ──
function ss2BulkSell() {
  const sel = ss2InvSelected();
  if (sel.length !== 1 || sel[0].Status === 'Sold') return;
  openSellDrawer(inventory.indexOf(sel[0]));
}
function ss2BulkAddToShow(showId) {
  _ss2ClosePop();
  const sel = ss2InvSelected(), show = shows[showId];
  if (!sel.length || !show) return;
  const already = sel.filter(c => c._shows instanceof Set && c._shows.has(showId)).length;
  const flagged = sel.filter(c => !(c._shows instanceof Set && c._shows.has(showId)) && c._trustFlag === 'flagged').length;
  const details = sel.filter(c => !(c._shows instanceof Set && c._shows.has(showId)) && c._trustFlag !== 'flagged' && c.IdentificationStatus === 'unidentified').length;
  const sold = sel.filter(c => c.Status === 'Sold').length;
  sellerPublishToShow(showId);   // reads the checked rows; skips cards already there; makes this the active show
  const added = Math.max(0, sel.length - already - flagged - details - sold);
  showToast(`Added ${added} card${added !== 1 ? 's' : ''} to ${show.name || 'the show'}`
    + (already ? ` · ${already} ${already === 1 ? 'was' : 'were'} already there` : '')
    + (flagged ? ` · ${flagged} held back (stolen/lost report)` : '')
    + (details ? ` · ${details} need details first` : ''));
  ss2InvClearSelection();
  applyInventoryFilters();
}
function ss2BulkRemoveFromShow(showId) {
  _ss2ClosePop();
  const sel = ss2InvSelected().filter(c => c._shows instanceof Set && c._shows.has(showId));
  if (!sel.length) return;
  sellerRemoveFromShow(showId, sel);
  ss2InvClearSelection();
  applyInventoryFilters();
}
function ss2BulkRun(kind) {
  _ss2ClosePop();
  const sel = ss2InvSelected();
  if (kind === 'codes') return assignStockCodesBulk(sel.filter(c => c.Status !== 'Sold' && !c.StockCode && c._dbId));
  if (kind === 'sport') return runSportValidation(getSportValidationCards());
  if (kind === 'csv') return exportInventoryCSV();
  if (kind === 'xlsx') return exportInventoryXLSX();
  if (kind === 'delete') { confirmBulkDelete(); _ss2Sel = new Set(ss2InvSelected()); return ss2InvRefreshChrome(); }
}

// ── Small popover menus (Add to show, More, Import / Export) ──
function _ss2ClosePop() {
  const p = document.getElementById('ss2Pop');
  if (p) { p.style.display = 'none'; p.innerHTML = ''; }
  document.querySelectorAll('[aria-expanded="true"][data-ss2-menu]').forEach(b => b.setAttribute('aria-expanded', 'false'));
}
function ss2Menu(e, kind) {
  if (e) e.stopPropagation();
  const btn = e && e.currentTarget;
  let pop = document.getElementById('ss2Pop');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'ss2Pop'; pop.className = 'tc-dropdown ss2-pop'; pop.setAttribute('role', 'menu');
    document.body.appendChild(pop);
    document.addEventListener('click', ev => { if (!pop.contains(ev.target)) _ss2ClosePop(); });
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && pop.style.display !== 'none') _ss2ClosePop(); });
  }
  if (pop.style.display === 'block' && pop.dataset.kind === kind) { _ss2ClosePop(); return; }
  const item = (label, js, extra) => `<button type="button" role="menuitem" class="tc-dropdown-item ss2-pop-item" onclick="${js}"${extra || ''}>${label}</button>`;
  const today = typeof _todayISO === 'function' ? _todayISO() : new Date().toLocaleDateString('en-CA');
  const sel = ss2InvSelected();
  let html = '';
  if (kind === 'show') {
    const open = _ss2MyShows().filter(s => { const r = _ss2ShowRange(s); return !r || r.end >= today; });
    html = open.length
      ? '<div class="ss2-pop-label">Add the selected cards to</div>' + open.map(s => item(_ss2Esc(s.name || s.id), `ss2BulkAddToShow('${_ss2Esc(s.id)}')`)).join('')
      : '<div class="ss2-pop-label">You haven\'t joined a show that\'s coming up.</div>' + item('Join a show', 'ss2ClosePopAnd(openJoinShow)');
  } else if (kind === 'more') {
    const inShows = [...new Set(sel.flatMap(c => c._shows instanceof Set ? [...c._shows] : []))].filter(id => shows[id]);
    html = inShows.map(id => item('Take out of ' + _ss2Esc(shows[id].name || id), `ss2BulkRemoveFromShow('${_ss2Esc(id)}')`)).join('')
      + item('Assign stock codes', "ss2BulkRun('codes')")
      + item('Validate sport', "ss2BulkRun('sport')")
      + item('Export selected (CSV)', "ss2BulkRun('csv')")
      + item('Export selected (Excel)', "ss2BulkRun('xlsx')")
      + item('Delete selected', "ss2BulkRun('delete')", ' style="color:var(--danger)"');
  } else if (kind === 'io') {
    html = item('Upload a spreadsheet', "ss2ClosePopAnd(()=>document.querySelector('#uploadZone input[type=file]').click())")
      + `<a role="menuitem" class="tc-dropdown-item ss2-pop-item" href="/downloads/CardShow_Inventory_Template.xlsx" download onclick="_ss2ClosePop()">Download the template</a>`
      + item('Export inventory (CSV)', 'ss2ClosePopAnd(exportInventoryCSV)')
      + item('Export inventory (Excel)', 'ss2ClosePopAnd(exportInventoryXLSX)');
  }
  pop.innerHTML = html;
  pop.dataset.kind = kind;
  pop.style.display = 'block';
  if (btn) {
    btn.setAttribute('aria-expanded', 'true'); btn.setAttribute('data-ss2-menu', '');
    const r = btn.getBoundingClientRect(), w = Math.min(280, window.innerWidth - 16);
    pop.style.width = w + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    const h = pop.offsetHeight;
    pop.style.top = (r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6) + 'px';
  }
  pop.querySelector('.ss2-pop-item')?.focus();
}
// File pickers must open inside the click, so close the menu and run the action in the same turn.
function ss2ClosePopAnd(fn) { _ss2ClosePop(); try { fn(); } catch (e) { console.warn('[seller-shell]', e); } }

// Phone: checkboxes show only in select mode.
function ss2InvToggleSelectMode() {
  const on = !document.body.classList.contains('ss2-selecting');
  document.body.classList.toggle('ss2-selecting', on);
  const b = document.getElementById('ss2SelectBtn');
  if (b) { b.textContent = on ? 'Done' : 'Select'; b.setAttribute('aria-pressed', String(on)); }
  if (!on) ss2InvClearSelection();
}

// ── Build / mount ──
function _ss2InvBuild() {
  if (_ss2InvBuilt) return;
  const panel = document.getElementById('adminInventoryPanel');
  const toolbar = panel && panel.querySelector('.toolbar');
  if (!panel || !toolbar) return;
  _ss2InvBuilt = true;
  const box = document.createElement('div');
  box.id = 'ss2InvChrome';
  box.innerHTML = `
    <div class="ss2-head ss2-head-row ss2-inv-head">
      <h1 class="ss2-title">Inventory</h1>
      <div class="ss2-inv-actions">
        <button type="button" class="btn btn-ghost ss2-cta ss2-select-btn" id="ss2SelectBtn" aria-pressed="false" onclick="ss2InvToggleSelectMode()">Select</button>
        <button type="button" class="btn btn-ghost ss2-cta" aria-haspopup="menu" aria-expanded="false" onclick="ss2Menu(event,'io')">Import / Export ▾</button>
        <button type="button" class="btn btn-primary ss2-cta" onclick="openQuickActions('add')">+ Add cards</button>
      </div>
    </div>
    <div class="ss2-views" id="ss2Views" role="tablist" aria-label="Saved views"></div>
    <div class="ss2-reason" id="ss2Reason" style="display:none"></div>
    <div class="ss2-filterbar" id="ss2FilterBar">
      <div class="ss2-filter-search" id="ss2SearchSlot"></div>
      <select id="ss2FSport" class="filter-select" aria-label="Sport" onchange="ss2InvFilter('sport',this.value)"></select>
      <select id="ss2FGraded" class="filter-select" aria-label="Graded or raw" onchange="ss2InvFilter('graded',this.value)"></select>
      <select id="ss2FShow" class="filter-select" aria-label="Show" onchange="ss2InvFilter('show',this.value)"></select>
      <select id="ss2FSort" class="filter-select" aria-label="Sort" onchange="ss2InvFilter('sort',this.value)"></select>
    </div>
    <div class="ss2-bulk" id="ss2BulkBar" role="toolbar" aria-label="Actions for the selected cards" style="display:none">
      <span class="ss2-bulk-count" id="ss2BulkCount" aria-live="polite"></span>
      <button type="button" class="btn btn-primary ss2-cta" aria-haspopup="menu" aria-expanded="false" onclick="ss2Menu(event,'show')">Add to show ▾</button>
      <button type="button" class="btn btn-ghost ss2-cta ss2-mk-only" onclick="openMarketplacePanel()">List online</button>
      <button type="button" class="btn btn-ghost ss2-cta" onclick="runCompCheck(getCompCheckCards())">Check comps</button>
      <button type="button" class="btn btn-ghost ss2-cta" id="ss2BulkSell" onclick="ss2BulkSell()">Mark sold</button>
      <button type="button" class="btn btn-ghost ss2-cta" aria-haspopup="menu" aria-expanded="false" onclick="ss2Menu(event,'more')">More ▾</button>
      <button type="button" class="btn btn-ghost ss2-cta" onclick="ss2InvClearSelection()">Clear</button>
    </div>`;
  panel.insertBefore(box, toolbar);
  const tbody = document.getElementById('inventoryBody');
  if (tbody) tbody.addEventListener('change', e => {
    if (!_ss2On || !e.target.classList || !e.target.classList.contains('card-check')) return;
    const card = inventory[parseInt(e.target.dataset.idx, 10)];
    if (card) { if (e.target.checked) _ss2Sel.add(card); else _ss2Sel.delete(card); }
    ss2InvRefreshChrome();
  });
  const search = document.getElementById('sellerSearchInput');
  if (search) search.addEventListener('input', () => { if (_ss2On) { _ss2Sel.clear(); ss2InvRefreshChrome(); } });
}

function _ss2InvMount() {
  _ss2InvBuild();
  if (!_ss2InvBuilt) return;
  // Search box into the filter bar, header checkbox into the table head.
  const search = document.getElementById('sellerSearchInput'), slot = document.getElementById('ss2SearchSlot');
  if (search && slot && !slot.contains(search)) {
    _ss2InvMoved.push({ el: search, parent: search.parentNode, next: search.nextSibling, placeholder: search.placeholder });
    search.placeholder = 'Search player, set, cert or code…';
    search.setAttribute('aria-label', 'Search your cards');
    slot.appendChild(search);
  }
  const th = document.querySelector('#adminInventoryPanel .table-wrap thead th');
  if (th && !document.getElementById('ss2SelAll')) {
    th.innerHTML = '<input type="checkbox" id="ss2SelAll" aria-label="Select every card in this view" onchange="ss2InvToggleAll(this.checked)">';
  }
  const priceTh = [...document.querySelectorAll('#adminInventoryPanel .table-wrap thead th')].find(t => t.textContent.trim() === 'Price');
  if (priceTh) { priceTh.textContent = 'Asking'; priceTh.setAttribute('data-ss2-asking', '1'); }
  _ss2Sel.clear();
  _ss2Inv = { view: 'available', custom: null, sport: '', graded: '', show: '', sort: 'recent', reason: '' };
}
function _ss2InvUnmount() {
  _ss2Sel.clear();
  _ss2ClosePop();
  document.body.classList.remove('ss2-selecting', 'ss2-has-sel');
  for (const m of _ss2InvMoved.reverse()) {
    m.el.placeholder = m.placeholder;
    if (m.next && m.next.parentNode === m.parent) m.parent.insertBefore(m.el, m.next); else m.parent.appendChild(m.el);
  }
  _ss2InvMoved = [];
  const askTh = document.querySelector('#adminInventoryPanel .table-wrap thead th[data-ss2-asking]');
  if (askTh) { askTh.textContent = 'Price'; askTh.removeAttribute('data-ss2-asking'); }
  const head = document.getElementById('ss2SelAll'); if (head) head.parentNode.innerHTML = '';
}

// ══════ Phase 3: Home ══════
// Needs you: one list, most urgent first; each row opens the place where it's fixed
// (the existing panels until the Phase 5 Marketplace page exists). Counts come from
// the strips' own in-memory lists (no new poller). Returns the number of items.
function _ss2RenderNeeds(c, mk) {
  const el = document.getElementById('ss2HomeNeeds');
  if (!el) return 0;
  const rows = [];
  let total = 0;
  const row = (n, label, meta, js, urgent) => {
    total += n;
    rows.push(`<button type="button" class="ss2-row${urgent ? ' ss2-row-urgent' : ''}" onclick="${js}"><span>${label}</span><span class="ss2-row-meta">${meta}</span></button>`);
  };
  const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
  if (mk) {
    if (c.toConfirm) {
      const soonest = ordToConfirm().map(o => o.confirm_by).filter(Boolean).sort()[0];
      const left = soonest && typeof _ordMinutesLeft === 'function' ? _ordMinutesLeft(soonest) : null;
      const leftTxt = left == null ? 'Confirm or say it\'s not available'
        : left >= 120 ? `Confirm within ${Math.round(left / 60)} hours` : `${left} min left to confirm`;
      row(c.toConfirm, plural(c.toConfirm, 'order') + ' to confirm', leftTxt, 'openOrdersPanel()', true);
    }
    if (c.offers) row(c.offers, plural(c.offers, 'offer') + ' waiting on you', 'Accept, counter or decline', 'openOffersPanel()');
    if (c.holds) row(c.holds, plural(c.holds, 'hold') + ' ending in 24 hours', 'Sold to them or release', 'openHoldsPanel()');
    if (c.toShip) row(c.toShip, plural(c.toShip, 'order') + ' to ship', 'Add tracking', 'openOrdersPanel()');
  }
  const snap = typeof ssNeedsDetails === 'function' ? ssNeedsDetails().length : 0;
  if (snap) row(snap, plural(snap, 'Snap &amp; Sell sale') + ' need card details', 'Add what you sold', 'ss2OpenSnapNeeds()');
  const counts = {};
  let blocked = 0;
  getSellerInventory().forEach(card => {
    if (card.Status === 'Sold') return;
    const r = ss2AttentionReason(card);
    if (r) { counts[r] = (counts[r] || 0) + 1; blocked++; }
  });
  if (blocked) {
    // Most serious reason first (stolen/lost report), else the most common one.
    const top = counts.trust_flag ? 'trust_flag' : Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    const label = blocked === 1 ? '1 card can\'t go on sale' : `${blocked} cards can't go on sale`;
    const meta = blocked === counts[top] ? SS2_REASONS[top] : `${SS2_REASONS[top]} (${counts[top]}) and more`;
    row(blocked, label, meta, `ss2InvOpen('attention'${blocked === counts[top] ? `,'${top}'` : ''})`, top === 'trust_flag');
  }
  const hasCards = getSellerInventory().length > 0;
  if (rows.length) {
    el.innerHTML = '<div class="ss2-card-title">Needs you</div>' + rows.join('');
    el.style.display = '';
  } else if (hasCards) {
    el.innerHTML = '<div class="ss2-caught-up">You\'re all caught up</div>';
    el.style.display = '';
  } else {
    el.innerHTML = '';
    el.style.display = 'none';
  }
  return total;
}

// Nearest joined show that isn't over (any distance away).
function ss2NextShow() {
  const today = typeof _todayISO === 'function' ? _todayISO() : new Date().toLocaleDateString('en-CA');
  let best = null;
  for (const s of _ss2MyShows()) {
    const r = _ss2ShowRange(s);
    if (!r || r.end < today) continue;
    if (!best || r.start < best.r.start) best = { s, r };
  }
  if (!best) return null;
  const days = Math.round((new Date(best.r.start + 'T12:00:00') - new Date(today + 'T12:00:00')) / 86400000);
  return { show: best.s, start: best.r.start, end: best.r.end, days: Math.max(0, days), today: best.r.start <= today };
}

function ss2RenderHome(needCount) {
  const body = document.getElementById('ss2HomeBody');
  if (!body) return;
  const inv = getSellerInventory();
  const isNew = inv.length === 0;
  body.classList.toggle('ss2-home-new', isNew);
  const next = ss2NextShow();

  const lede = document.getElementById('ss2HomeLede');
  if (lede) {
    const parts = [new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })];
    if (needCount) parts.push(needCount === 1 ? '1 thing needs you' : `${needCount} things need you`);
    if (next) parts.push(next.today ? 'show day today' : next.days === 1 ? 'next show tomorrow' : `next show in ${next.days} days`);
    lede.textContent = parts.join(' · ');
  }

  const card = document.getElementById('ss2NextShow');
  if (card) {
    if (isNew) {
      card.innerHTML = `<div class="ss2-next-empty"><b>Add your first cards</b>
        <span>Take a photo of a card or a whole case, upload a spreadsheet, or type one in.</span></div>
        <button type="button" class="btn btn-primary ss2-cta" onclick="openQuickActions('add')">+ Add cards</button>`;
    } else if (!next) {
      card.innerHTML = `<div class="ss2-next-empty"><b>No show coming up</b>
        <span>Join the show you're selling at, then choose which cards to bring.</span></div>
        <button type="button" class="btn btn-primary ss2-cta" onclick="openJoinShow()">Find a show to sell at</button>`;
    } else {
      const s = next.show;
      const d = new Date(next.start + 'T12:00:00');
      const avail = inv.filter(c => c.Status !== 'Sold');
      const atShow = avail.filter(c => c._shows instanceof Set && c._shows.has(s.id)).length;
      const table = s.tables && s.tables[currentSeller];
      const where = s.venue || (typeof parseShowLocation === 'function' && s.location ? parseShowLocation(s.location).venue : '') || s.location || '';
      const when = next.today ? 'Today' : next.days === 1 ? 'Tomorrow' : `In ${next.days} days`;
      const smOk = typeof smIsEnabled === 'function' && smIsEnabled() && typeof openShowMode === 'function';
      const btn = next.today && smOk
        ? `<button type="button" class="btn btn-primary ss2-cta" onclick="openShowMode('${_ss2Esc(s.id)}')">Open Show Mode</button>`
        : `<a class="btn btn-primary ss2-cta" href="#/s/shows">Choose cards for this show</a>`;
      card.innerHTML = `
        <div class="ss2-next-date" aria-hidden="true"><span>${d.toLocaleDateString(undefined, { month: 'short' })}</span><b>${d.getDate()}</b></div>
        <div class="ss2-next-main">
          <span class="ss2-next-when">${when}${table ? ` · Table ${_ss2Esc(table)}` : ''}</span>
          <b class="ss2-next-name">${_ss2Esc(s.name || 'Show')}</b>
          ${where ? `<span class="ss2-next-where">${_ss2Esc(where)}</span>` : ''}
          <span class="ss2-next-progress">Cards at this show <b>${atShow}</b> / ${avail.length} available</span>
          <span class="ss2-bar" aria-hidden="true"><span style="width:${avail.length ? Math.round(atShow / avail.length * 100) : 0}%"></span></span>
        </div>
        <div class="ss2-next-cta">${btn}</div>`;
    }
  }
  ss2RenderFlow();
  _ss2RenderKpis(inv);
}

// Your selling flow: 4 steps over the Getting started list's own state (gs).
// Hide and collapse are the same saved flags as before.
function _ss2FlowSteps() {
  if (typeof _gsSteps !== 'function') return [];
  const g = {}; _gsSteps().forEach(x => { g[x.id] = x; });
  const mk = _ss2Mk();
  const joined = _ss2MyShows().length > 0;
  const steps = [
    { id: 'card', label: 'Add your cards', hint: 'Take a photo, upload a spreadsheet, or type one in.',
      done: !!(g.card && g.card.done), go: 'Add', js: "openQuickActions('add')" },
    { id: 'show', label: 'Join a show', hint: joined ? 'Choose which of your cards go to the show.' : 'Join the show you\'re selling at.',
      done: !!(g.show && g.show.done), go: joined ? 'Choose cards' : 'Join', js: joined ? "ss2Go('shows')" : 'openJoinShow()' },
  ];
  if (mk) steps.push({ id: 'listed', label: 'List cards on the marketplace', hint: 'Buyers can find, hold and buy them online.',
    done: getSellerInventory().some(_ss2Listed), go: 'List', js: 'openMarketplacePanel()' });
  const sale = !!(g.sale && g.sale.done), report = !!(g.report && g.report.done);
  steps.push({ id: 'sale', label: 'Record a sale & read your report', hint: sale ? 'See your sales and totals.' : 'Pick the card, then the price and how they paid.',
    done: sale && report, go: sale ? 'Open report' : 'Sell', js: sale ? "ss2Go('sales')" : "openQuickActions('sell')" });
  return steps;
}
function ss2RenderFlow() {
  const box = document.getElementById('ss2Flow');
  if (!box) return;
  const st = typeof _gsState === 'function' ? (_gsState() || {}) : {};
  const ready = typeof _gsDataReady !== 'undefined' && _gsDataReady && (typeof _obStateLoaded === 'undefined' || _obStateLoaded);
  const steps = _ss2FlowSteps();
  const done = steps.filter(x => x.done).length;
  if (!ready || !steps.length || st.dismissed || done === steps.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = '';
  box.classList.toggle('collapsed', !!st.collapsed);
  box.innerHTML = `
    <div class="ss2-flow-head">
      <button type="button" class="ss2-flow-toggle" onclick="gsToggleCollapse()" aria-expanded="${st.collapsed ? 'false' : 'true'}">
        <b>Your selling flow</b><span class="ss2-row-meta">${done} of ${steps.length} done</span></button>
      <button type="button" class="ss2-flow-hide" onclick="gsDismiss()">Hide</button>
    </div>
    <span class="ss2-bar" aria-hidden="true"><span style="width:${Math.round(done / steps.length * 100)}%"></span></span>
    <ol class="ss2-flow-list">${steps.map((x, i) => `
      <li class="ss2-flow-item${x.done ? ' done' : ''}">
        <span class="ss2-flow-check" aria-hidden="true">${x.done ? '✓' : i + 1}</span>
        <span class="ss2-flow-text"><b>${x.label}${x.done ? '<span class="sr-only"> (done)</span>' : ''}</b><small>${x.hint}</small></span>
        ${x.done ? '' : `<button type="button" class="btn btn-ghost ss2-cta ss2-flow-go" onclick="${x.js}">${x.go}</button>`}
      </li>`).join('')}</ol>`;
}

// Shows page "Get ready": profile and table QR, the two Getting started steps
// that aren't in the selling flow. Hidden once both are done.
function ss2RenderGetReady() {
  const el = document.getElementById('ss2GetReady');
  if (!el || typeof _gsSteps !== 'function') return;
  const g = {}; _gsSteps().forEach(x => { g[x.id] = x; });
  const items = [
    { s: g.profile, label: 'Fill in your profile', meta: 'Name plus WhatsApp or Instagram, so buyers can reach you', js: 'openProfile()' },
    { s: g.qr, label: 'Get your table QR code', meta: 'Buyers scan it at your table', js: "ss2Go('qr')" },
  ].filter(x => x.s);
  if (!items.length || items.every(x => x.s.done)) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';
  el.innerHTML = '<div class="ss2-card-title">Get ready</div>' + items.map(x => `
    <button type="button" class="ss2-row${x.s.done ? ' ss2-row-done' : ''}" onclick="${x.js}">
      <span>${x.s.done ? '✓ ' : ''}${x.label}</span><span class="ss2-row-meta">${x.s.done ? 'Done' : x.meta}</span></button>`).join('');
}

// KPI row. Available keeps the classic #statTotal / #statValue (moved in, updateStats writes them).
function _ss2Money(n) { return '$' + Math.round(Number(n) || 0).toLocaleString(); }
function _ss2MonthKey() { return (typeof _todayISO === 'function' ? _todayISO() : new Date().toLocaleDateString('en-CA')).slice(0, 7); }
function ss2MonthSales() {
  const m = _ss2MonthKey();
  const cards = getSellerInventory().filter(c => (typeof isSoldForCash === 'function' ? isSoldForCash(c) : c.Status === 'Sold') && String(c.SoldDate || '').slice(0, 7) === m);
  const snaps = typeof ssReportRows === 'function' ? ssReportRows(null).filter(r => String(r.SoldDate || '').slice(0, 7) === m) : [];
  const rows = cards.concat(snaps);
  return { count: rows.length, total: rows.reduce((t, r) => t + (Number(r.SoldPrice) || 0), 0) };
}
let _ss2Pl = null, _ss2PlAt = 0, _ss2PlBusy = false;
function _ss2RenderKpis(inv) {
  const avail = inv.filter(c => c.Status !== 'Sold');
  const sub = document.getElementById('ss2KpiAvailSub');
  if (sub && !sub.querySelector('.ss2-kpi-suffix')) sub.insertAdjacentHTML('beforeend', '<span class="ss2-kpi-suffix"> asking</span>');
  const listed = avail.filter(_ss2Listed).length;
  const set = (id, t) => { const e = document.getElementById(id); if (e) e.textContent = t; };
  set('ss2KpiListedVal', listed.toLocaleString());
  set('ss2KpiListedSub', avail.length ? `${Math.round(listed / avail.length * 100)}% of available` : 'of available');
  const ms = ss2MonthSales();
  set('ss2KpiSalesVal', _ss2Money(ms.total));
  set('ss2KpiSalesSub', ms.count === 1 ? '1 sale' : `${ms.count} sales`);
  if (_ss2Pl) {
    const pl = _ss2Pl;
    set('ss2KpiProfitVal', pl.shows ? (pl.net > 0 ? '+' : pl.net < 0 ? '−' : '') + _ss2Money(Math.abs(pl.net)) : '$0');
    const v = document.getElementById('ss2KpiProfitVal');
    if (v) v.className = 'ss2-kpi-val' + (pl.net > 0 ? ' ss2-pos' : pl.net < 0 ? ' ss2-neg' : '');
    set('ss2KpiProfitSub', pl.missing ? `on cards with a cost · ${pl.missing} without one` : 'on cards with a cost');
  }
  if (_ss2Route === 'home' && Date.now() - _ss2PlAt > 120000) _ss2LoadPl();
}
// Net profit this month = the Show Home P/L of this month's shows (dealer_show_list()).
async function _ss2LoadPl() {
  if (_ss2PlBusy || typeof db === 'undefined' || !db) return;
  _ss2PlBusy = true; _ss2PlAt = Date.now();
  try {
    const res = await db.rpc('dealer_show_list');
    if (!res.error && Array.isArray(res.data)) {
      const m = _ss2MonthKey();
      const mine = res.data.filter(x => String(x.start_date || '').slice(0, 7) === m);
      _ss2Pl = { shows: mine.length, net: mine.reduce((t, x) => t + (Number(x.net_pl) || 0), 0), missing: mine.reduce((t, x) => t + (Number(x.missing_cost) || 0), 0) };
      if (_ss2On) _ss2RenderKpis(getSellerInventory());
    } else if (res.error) {
      const sub = document.getElementById('ss2KpiProfitSub'); if (sub) sub.textContent = 'See Show results';
    }
  } catch (e) { console.warn('[seller-shell] show P/L', e); }
  _ss2PlBusy = false;
}
function ss2OpenSnapNeeds() {
  const rec = typeof ssNeedsDetails === 'function' ? ssNeedsDetails()[0] : null;
  const showId = (rec && rec.showId) || (typeof _smDefaultShowId === 'function' && _smDefaultShowId()) || (_ss2MyShows()[0] || {}).id;
  if (showId && typeof openShowMode === 'function') openShowMode(showId, '/needs');
}
