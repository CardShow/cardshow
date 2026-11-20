// CardShow Marketplace — dealer listing controls (Phase 1, step 1). See CLAUDE.md "CardShow Marketplace".
// Dealers choose which cards go on the marketplace, and how buyers may make offers or get the card.
// Listing status only ever changes through the database functions publish_listings() / delist_listings()
// (never written from here). Offer settings (min_offer_cents, auto_accept_cents, accepts_offers,
// sale_modes) are plain columns on the seller's own inventory rows. Loaded after js/quick-bar.js.

// Off until the buyer site exists. Test on one browser with ?marketplace=1 (?marketplace=0 to clear).
const MARKETPLACE_UI_LAUNCHED = false;

function mkEnabled() {
  if (MARKETPLACE_UI_LAUNCHED) return true;
  try { return localStorage.getItem('marketplaceTest') === '1'; } catch (_) { return false; }
}
(function mkReadTestSwitch() {
  try {
    const v = new URLSearchParams(location.search).get('marketplace');
    if (v === '1') localStorage.setItem('marketplaceTest', '1');
    if (v === '0') localStorage.removeItem('marketplaceTest');
  } catch (_) {}
})();

const MK_REASONS = {
  sold: 'Sold',
  reserved: 'On hold for a buyer',
  trust_flag: 'Stolen / lost report',
  needs_details: 'Needs details',
  no_price: 'No asking price',
  not_synced: 'Not saved yet',
  not_found: 'Not found',
};
const MK_MISSING_RE = /listing_status|min_offer_cents|auto_accept_cents|accepts_offers|sale_modes|publish_listings|delist_listings|PGRST202|PGRST204|schema cache/i;

let _mkBusy = false;

// ── Reading a card ──
function mkListing(card) { return (card && card.ListingStatus) || 'draft'; }

// Why this card can't be listed right now (same order as publish_listings()), or null.
function mkCantList(card) {
  if (!card) return 'not_found';
  if (card.Status === 'Sold' || mkListing(card) === 'sold') return 'sold';
  if (mkListing(card) === 'reserved') return 'reserved';
  if (card._trustFlag === 'flagged' || card._trustFlag === 'disputed') return 'trust_flag';
  if (card.IdentificationStatus === 'unidentified') return 'needs_details';
  if (!(Number(card.Price) > 0)) return 'no_price';
  if (!card._dbId) return 'not_synced';
  return null;
}

function mkChipHTML(card) {
  if (!mkEnabled() || currentRole !== 'seller') return '';
  const s = mkListing(card);
  if (s === 'active')   return '<span class="mk-chip mk-chip--on" title="Listed on the CardShow marketplace">LISTED</span>';
  if (s === 'reserved') return '<span class="mk-chip mk-chip--hold" title="A buyer is holding this card">ON HOLD</span>';
  return '';
}

// ── Toolbar button ──
function mkUpdateEntry(tab) {
  const btn = document.getElementById('mkBtn');
  if (!btn) return;
  const onInventory = tab ? tab === 'inventory'
    : !document.getElementById('sellerTabInventory') || document.getElementById('sellerTabInventory').classList.contains('active');
  btn.style.display = (mkEnabled() && currentRole === 'seller' && onInventory) ? '' : 'none';
}

// ── Defaults for cards listed from the panel (per seller, on this device) ──
function _mkDefaultsKey() { return 'mkDefaults:' + (currentSeller || ''); }
function mkDefaults() {
  const d = { acceptsOffers: true, minPct: '', autoPct: '', ship: true, pickup: false };
  try { Object.assign(d, JSON.parse(localStorage.getItem(_mkDefaultsKey()) || '{}')); } catch (_) {}
  return d;
}
function _mkSaveDefaults(d) { try { localStorage.setItem(_mkDefaultsKey(), JSON.stringify(d)); } catch (_) {} }

// Cards the panel acts on: checked rows, else every unsold card (same rule as Check Comps).
function _mkScope() {
  const checked = [...document.querySelectorAll('.card-check:checked')]
    .map(el => inventory[Number(el.dataset.idx)]).filter(Boolean);
  const mine = c => c && c.Seller === currentSeller;
  return (checked.length ? checked : inventory.filter(c => c.Status !== 'Sold')).filter(mine);
}

function _mkEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function _mkMoney(cents) { return '$' + (cents / 100).toLocaleString(undefined, { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 }); }

// ── Panel ──
function openMarketplacePanel() {
  if (!mkEnabled()) return;
  let ov = document.getElementById('mkOverlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'mkOverlay';
    ov.className = 'modal-overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-labelledby', 'mkTitle');
    ov.addEventListener('click', e => { if (e.target === ov) closeMarketplacePanel(); });
    document.body.appendChild(ov);
  }
  _mkRenderPanel();
  ov.classList.add('open');
}
function closeMarketplacePanel() {
  const ov = document.getElementById('mkOverlay');
  if (ov) ov.classList.remove('open');
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('mkOverlay')?.classList.contains('open')) closeMarketplacePanel();
});

function _mkRenderPanel(result) {
  const ov = document.getElementById('mkOverlay');
  if (!ov) return;
  const scope = _mkScope();
  const all = inventory.filter(c => c.Seller === currentSeller);
  const listed = all.filter(c => mkListing(c) === 'active').length;
  const held = all.filter(c => mkListing(c) === 'reserved').length;
  const toList = scope.filter(c => mkListing(c) !== 'active' && !mkCantList(c));
  const toDelist = scope.filter(c => mkListing(c) === 'active');
  const blocked = {};
  scope.forEach(c => {
    if (mkListing(c) === 'active') return;
    const why = mkCantList(c);
    if (why && why !== 'sold') (blocked[why] = blocked[why] || []).push(c);
  });
  const checkedCount = document.querySelectorAll('.card-check:checked').length;
  const d = mkDefaults();

  const blockedHTML = Object.keys(blocked).length ? `
    <div class="mk-section">
      <div class="section-label">Can't list yet</div>
      ${Object.entries(blocked).map(([why, cards]) => `
        <div class="mk-blocked">
          <div class="mk-blocked-head">${_mkEsc(MK_REASONS[why] || why)} · ${cards.length}</div>
          <div class="mk-blocked-cards">${cards.slice(0, 5).map(c =>
            `<button type="button" class="mk-link" onclick="closeMarketplacePanel();openCEM(${inventory.indexOf(c)})">${_mkEsc(c['Card Title'] || c.Player || 'Card')}</button>`).join('')}
            ${cards.length > 5 ? `<span class="mk-more">+${cards.length - 5} more</span>` : ''}</div>
        </div>`).join('')}
    </div>` : '';

  const resultHTML = result ? `<div class="mk-result ${result.bad ? 'mk-result--bad' : ''}" role="status">${result.html}</div>` : '';

  ov.innerHTML = `
    <div class="modal mk-modal">
      <div class="mk-head">
        <h3 id="mkTitle">Marketplace listings</h3>
        <button type="button" class="mk-x" aria-label="Close" onclick="closeMarketplacePanel()">✕</button>
      </div>
      <p class="mk-intro">Listed cards appear in CardShow buyer search once the marketplace opens. You confirm every order, and a card sold at your table comes off automatically.</p>
      <div class="mk-stats">
        <div><b>${listed}</b><span>Listed</span></div>
        <div><b>${held}</b><span>On hold</span></div>
        <div><b>${all.filter(c => c.Status !== 'Sold' && mkListing(c) !== 'active' && mkListing(c) !== 'reserved').length}</b><span>Not listed</span></div>
      </div>
      ${resultHTML}
      <div class="mk-scope">${checkedCount ? `Working on the <b>${scope.length}</b> card${scope.length === 1 ? '' : 's'} you checked.` : `Working on all <b>${scope.length}</b> unsold cards. Check cards in the table to pick some.`}</div>

      <div class="mk-section">
        <div class="section-label">Offers and delivery for cards you list now</div>
        <label class="mk-check"><input type="checkbox" id="mkAccept" ${d.acceptsOffers ? 'checked' : ''} onchange="_mkToggleOfferRows()"> Accept offers</label>
        <div class="mk-grid" id="mkOfferRows" style="${d.acceptsOffers ? '' : 'display:none'}">
          <label>Lowest offer to consider
            <span class="mk-pct"><input type="number" id="mkMinPct" inputmode="decimal" min="1" max="100" step="1" placeholder="Any" value="${_mkEsc(d.minPct)}"><span>% of asking</span></span></label>
          <label>Accept automatically at
            <span class="mk-pct"><input type="number" id="mkAutoPct" inputmode="decimal" min="1" max="100" step="1" placeholder="Never" value="${_mkEsc(d.autoPct)}"><span>% of asking</span></span></label>
        </div>
        <div class="mk-row">
          <label class="mk-check"><input type="checkbox" id="mkShip" ${d.ship ? 'checked' : ''}> Ship to buyer</label>
          <label class="mk-check"><input type="checkbox" id="mkPickup" ${d.pickup ? 'checked' : ''}> Pickup at a show</label>
        </div>
        <div class="cost-field-err" id="mkErr"></div>
      </div>

      ${blockedHTML}

      <div class="mk-actions">
        <button type="button" class="btn btn-primary" id="mkListBtn" ${toList.length ? '' : 'disabled'} onclick="mkListFromPanel()">List ${toList.length} card${toList.length === 1 ? '' : 's'}</button>
        <button type="button" class="btn btn-ghost" id="mkDelistBtn" ${toDelist.length ? '' : 'disabled'} onclick="mkDelistFromPanel()">Take ${toDelist.length} off</button>
      </div>
    </div>`;
}

function _mkToggleOfferRows() {
  const on = document.getElementById('mkAccept').checked;
  document.getElementById('mkOfferRows').style.display = on ? '' : 'none';
}

// Offer settings for a card from percentages of its asking price.
function mkSettingsFromPct(card, opts) {
  const price = Math.round(Number(card.Price || 0) * 100);
  const pct = p => (p === '' || p == null) ? null : Math.round(price * Number(p) / 100);
  const modes = [opts.ship && 'ship', opts.pickup && 'local_pickup'].filter(Boolean);
  return {
    accepts_offers: !!opts.acceptsOffers,
    min_offer_cents: opts.acceptsOffers ? pct(opts.minPct) : null,
    auto_accept_cents: opts.acceptsOffers ? pct(opts.autoPct) : null,
    sale_modes: modes,
  };
}

// Checks shared by the panel and the Edit Card section. Returns an error message or ''.
function mkValidate(s, priceCents) {
  if (!s.sale_modes.length) return 'Pick at least one way for buyers to get the card.';
  if (s.min_offer_cents != null && !(s.min_offer_cents > 0)) return 'The lowest offer must be more than $0.';
  if (s.min_offer_cents != null && priceCents && s.min_offer_cents > priceCents) return 'The lowest offer can\'t be above your asking price.';
  if (s.auto_accept_cents != null && !(s.auto_accept_cents > 0)) return 'The auto-accept price must be more than $0.';
  if (s.auto_accept_cents != null && priceCents && s.auto_accept_cents > priceCents) return 'Auto-accept can\'t be above your asking price.';
  if (s.min_offer_cents != null && s.auto_accept_cents != null && s.auto_accept_cents < s.min_offer_cents)
    return 'Auto-accept must be at or above the lowest offer you\'ll consider.';
  return '';
}

function _mkReadPanelOpts() {
  const v = id => document.getElementById(id)?.value.trim() ?? '';
  return {
    acceptsOffers: document.getElementById('mkAccept').checked,
    minPct: v('mkMinPct'), autoPct: v('mkAutoPct'),
    ship: document.getElementById('mkShip').checked,
    pickup: document.getElementById('mkPickup').checked,
  };
}

function _mkNeedSignal() {
  if (navigator.onLine === false) { showToast('Listing needs a signal. Try again when you\'re online.', '#f59e0b'); return true; }
  if (typeof db === 'undefined') { showToast('Not connected', '#ef4444'); return true; }
  return false;
}

async function mkListFromPanel() {
  if (_mkBusy || _mkNeedSignal()) return;
  const opts = _mkReadPanelOpts();
  const err = document.getElementById('mkErr');
  for (const p of [opts.minPct, opts.autoPct]) {
    if (p !== '' && !(Number(p) > 0 && Number(p) <= 100)) { err.textContent = 'Percentages must be between 1 and 100.'; return; }
  }
  if (opts.acceptsOffers && opts.minPct !== '' && opts.autoPct !== '' && Number(opts.autoPct) < Number(opts.minPct)) {
    err.textContent = 'Auto-accept must be at or above the lowest offer you\'ll consider.'; return;
  }
  if (!opts.ship && !opts.pickup) { err.textContent = 'Pick at least one way for buyers to get the card.'; return; }
  err.textContent = '';
  _mkSaveDefaults(opts);
  const cards = _mkScope().filter(c => mkListing(c) !== 'active' && !mkCantList(c));
  if (!cards.length) return;
  await _mkRun(document.getElementById('mkListBtn'), 'Listing…', async () => {
    const res = await mkListCards(cards, c => mkSettingsFromPct(c, opts));
    _mkRenderPanel(res);
  });
}

async function mkDelistFromPanel() {
  if (_mkBusy || _mkNeedSignal()) return;
  const cards = _mkScope().filter(c => mkListing(c) === 'active');
  if (!cards.length) return;
  await _mkRun(document.getElementById('mkDelistBtn'), 'Taking off…', async () => {
    const res = await mkDelistCards(cards);
    _mkRenderPanel(res);
  });
}

async function _mkRun(btn, label, fn) {
  _mkBusy = true;
  if (btn) { btn.disabled = true; btn.textContent = label; }
  try { await fn(); }
  catch (e) {
    console.warn('[marketplace]', e);
    _mkRenderPanel({ bad: true, html: _mkErrText(e) });
  } finally { _mkBusy = false; }
}

function _mkErrText(e) {
  const m = (e && (e.message || e.code)) || String(e);
  return MK_MISSING_RE.test(m) ? 'The marketplace isn\'t set up on the server yet.' : 'Couldn\'t update your listings: ' + _mkEsc(m);
}

// Writes offer settings, then lists. settingsFor(card) → columns, or null to leave them as they are.
async function mkListCards(cards, settingsFor) {
  const byId = new Map(cards.map(c => [c._dbId, c]));
  // Offer settings first, a few at a time, so a listed card never goes live with old settings.
  const jobs = cards.map(c => [c, settingsFor ? settingsFor(c) : null]).filter(([, s]) => s);
  for (let i = 0; i < jobs.length; i += 20) {
    const res = await Promise.all(jobs.slice(i, i + 20).map(([c, s]) =>
      db.from('inventory').update(s).eq('id', c._dbId).then(r => ({ c, s, error: r.error }))));
    const bad = res.find(r => r.error);
    if (bad) throw bad.error;
    res.forEach(({ c, s }) => _mkApplySettings(c, s));
  }
  const published = [], skipped = [];
  const ids = [...byId.keys()];
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await db.rpc('publish_listings', { p_ids: ids.slice(i, i + 500) });
    if (error) throw error;
    (data && data.published || []).forEach(id => published.push(id));
    (data && data.skipped || []).forEach(s => skipped.push(s));
  }
  published.forEach(id => { const c = byId.get(id); if (c) c.ListingStatus = 'active'; });
  _mkAfterChange();
  let html = published.length ? `✓ ${published.length} card${published.length === 1 ? '' : 's'} listed.` : 'No cards were listed.';
  if (skipped.length) {
    const counts = {};
    skipped.forEach(s => { counts[s.reason] = (counts[s.reason] || 0) + 1; });
    html += ' Not listed: ' + Object.entries(counts).map(([r, n]) => `${_mkEsc(MK_REASONS[r] || r)} (${n})`).join(', ') + '.';
  }
  return { html, bad: !published.length, published, skipped };
}

async function mkDelistCards(cards) {
  const byId = new Map(cards.map(c => [c._dbId, c]));
  const { data, error } = await db.rpc('delist_listings', { p_ids: [...byId.keys()] });
  if (error) throw error;
  const done = (data && data.delisted) || [], skipped = (data && data.skipped) || [];
  done.forEach(id => { const c = byId.get(id); if (c && mkListing(c) === 'active') c.ListingStatus = 'delisted'; });
  _mkAfterChange();
  let html = `✓ ${done.length} card${done.length === 1 ? '' : 's'} taken off the marketplace.`;
  if (skipped.length) html += ` ${skipped.length} couldn't be taken off (on hold for a buyer or sold).`;
  return { html, bad: !done.length, delisted: done, skipped };
}

function _mkApplySettings(card, s) {
  card.AcceptsOffers = s.accepts_offers;
  card.MinOfferCents = s.min_offer_cents;
  card.AutoAcceptCents = s.auto_accept_cents;
  card.SaleModes = s.sale_modes;
}

function _mkAfterChange() {
  if (typeof applyInventoryFilters === 'function') applyInventoryFilters();
  else if (typeof renderSellerTable === 'function') renderSellerTable(getSellerInventory());
}

// ── Edit Card section (#cem_mk_details) ──
function mkCemFill(card) {
  const box = document.getElementById('cem_mk_details');
  if (!box) return;
  const on = mkEnabled() && currentRole === 'seller';
  box.style.display = on ? '' : 'none';
  if (!on) return;
  box.dataset.dbid = card._dbId || '';
  const s = mkListing(card);
  const why = mkCantList(card);
  const status = document.getElementById('cem_mk_status');
  const btn = document.getElementById('cem_mk_btn');
  const sum = document.getElementById('cem_mk_summary');
  const label = s === 'active' ? 'Listed' : s === 'reserved' ? 'On hold for a buyer' : s === 'sold' ? 'Sold' : 'Not listed';
  sum.textContent = label;
  status.textContent = s === 'active' ? 'Listed on the marketplace.'
    : s === 'reserved' ? 'A buyer is holding this card. It can\'t be changed until the hold ends.'
    : why && why !== 'sold' ? `Can't list yet: ${MK_REASONS[why] || why}.` : s === 'sold' ? 'Sold.' : 'Not listed.';
  btn.style.display = (s === 'active' || (!why && s !== 'reserved')) ? '' : 'none';
  btn.textContent = s === 'active' ? 'Take off marketplace' : 'List on marketplace';
  btn.dataset.action = s === 'active' ? 'delist' : 'list';
  const accepts = card.AcceptsOffers !== false;
  document.getElementById('cem_mk_accept').checked = accepts;
  document.getElementById('cem_mk_min').value = card.MinOfferCents != null ? (card.MinOfferCents / 100) : '';
  document.getElementById('cem_mk_auto').value = card.AutoAcceptCents != null ? (card.AutoAcceptCents / 100) : '';
  const modes = Array.isArray(card.SaleModes) && card.SaleModes.length ? card.SaleModes : ['ship'];
  document.getElementById('cem_mk_ship').checked = modes.includes('ship');
  document.getElementById('cem_mk_pickup').checked = modes.includes('local_pickup');
  document.getElementById('cem_mk_offer_rows').style.display = accepts ? '' : 'none';
  document.getElementById('cem_mk_err').textContent = '';
  box.querySelectorAll('input').forEach(i => { i.disabled = s === 'reserved' || s === 'sold'; });
  box.open = s === 'active';
}

function mkCemToggleOffers() {
  document.getElementById('cem_mk_offer_rows').style.display = document.getElementById('cem_mk_accept').checked ? '' : 'none';
}

// Reads the section. Returns the settings to save, null when nothing changed or the section is off,
// or false when invalid (error shown; Save is blocked).
function mkCemRead(card) {
  const box = document.getElementById('cem_mk_details');
  if (!box || box.style.display === 'none' || !card || ['reserved', 'sold'].includes(mkListing(card))) return null;
  const dollars = id => { const v = document.getElementById(id).value.trim(); return v === '' ? null : Math.round(Number(v) * 100); };
  const accepts = document.getElementById('cem_mk_accept').checked;
  const s = {
    accepts_offers: accepts,
    min_offer_cents: accepts ? dollars('cem_mk_min') : null,
    auto_accept_cents: accepts ? dollars('cem_mk_auto') : null,
    sale_modes: [document.getElementById('cem_mk_ship').checked && 'ship',
                 document.getElementById('cem_mk_pickup').checked && 'local_pickup'].filter(Boolean),
  };
  const priceInput = document.getElementById('cem_price');
  const priceCents = Math.round(Number((priceInput && priceInput.value) || card.Price || 0) * 100);
  const err = (Number.isNaN(s.min_offer_cents) || Number.isNaN(s.auto_accept_cents)) ? 'Enter prices as numbers.' : mkValidate(s, priceCents);
  document.getElementById('cem_mk_err').textContent = err;
  if (err) { box.open = true; return false; }
  const same = (card.AcceptsOffers !== false) === s.accepts_offers
    && (card.MinOfferCents ?? null) === s.min_offer_cents
    && (card.AutoAcceptCents ?? null) === s.auto_accept_cents
    && JSON.stringify(Array.isArray(card.SaleModes) && card.SaleModes.length ? card.SaleModes : ['ship']) === JSON.stringify(s.sale_modes);
  return same ? null : s;
}

// Saves the settings read by mkCemRead() (own write, separate from updateCardInDB()).
async function mkCemApply(card, s) {
  if (!s || !card || !card._dbId || typeof db === 'undefined') return;
  const { error } = await db.from('inventory').update(s).eq('id', card._dbId);
  if (error) { console.warn('[marketplace] offer settings not saved', error); showToast('Marketplace settings not saved: ' + _mkErrText(error).replace(/<[^>]+>/g, ''), '#ef4444'); return; }
  _mkApplySettings(card, s);
}

// List / take off from the Edit Card section. Saves its settings first.
async function mkCemListToggle() {
  if (_mkBusy || _mkNeedSignal()) return;
  const card = inventory.find(c => c._dbId && c._dbId === document.getElementById('cem_mk_details').dataset.dbid);
  if (!card) return;
  const btn = document.getElementById('cem_mk_btn');
  const delist = btn.dataset.action === 'delist';
  let s = null;
  if (!delist) { s = mkCemRead(card); if (s === false) return; }
  _mkBusy = true; btn.disabled = true;
  try {
    const res = delist ? await mkDelistCards([card]) : await mkListCards([card], () => s);
    showToast(res.html.replace(/<[^>]+>/g, ''), res.bad ? '#f59e0b' : undefined);
  } catch (e) {
    console.warn('[marketplace]', e);
    showToast(_mkErrText(e).replace(/<[^>]+>/g, ''), '#ef4444');
  } finally {
    _mkBusy = false; btn.disabled = false;
    mkCemFill(card);
  }
}
