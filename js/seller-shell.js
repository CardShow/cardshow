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
    <div class="ss2-card" id="ss2HomeStats"></div>
    <div class="ss2-card ss2-actions">
      <button type="button" class="btn btn-primary ss2-cta" onclick="openQuickActions('add')">+ Add cards</button>
      <a class="btn btn-ghost ss2-cta" href="#/s/shows">Get ready for a show</a>
      <a class="btn btn-ghost ss2-cta" href="#/s/inventory">See your inventory</a>
    </div>`);
  panel('ss2Shows', `<div class="ss2-head"><h1 class="ss2-title">Shows</h1></div><div class="ss2-card" id="ss2ShowsBody"></div>`);
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
  _ss2Wrapped = true;
  const after = (name, fn) => {
    const orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function () { const r = orig.apply(this, arguments); try { if (_ss2On) fn.apply(this, arguments); } catch (e) { console.warn('[seller-shell]', e); } return r; };
  };
  ['updateStats', 'renderSellerShowsList', '_ordRenderStrip', '_moRenderStrip', '_mhRenderStrip'].forEach(n => after(n, ss2Refresh));
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
  }
  if (_ss2Route === 'qr' && typeof buildSellerQrPanel === 'function') buildSellerQrPanel();
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

  const lede = document.getElementById('ss2HomeLede');
  if (lede) {
    const day = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    lede.textContent = day + (soon ? ` · next show ${soon.label === 'Today' ? 'today' : soon.label}` : '');
  }
}

// ── Search (top bar) → the existing inventory filter ──
function ss2Search(v) {
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
