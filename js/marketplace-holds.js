// CardShow Marketplace — holds, dealer side (Phase 2, step 1). See CLAUDE.md "Holds".
// A buyer on the buyer site taps "Hold this card": the card is set aside for them for 24 hours and they pay
// the dealer when they meet. Here the dealer sees who is holding what (strip above the inventory table,
// Holds panel), can release a hold, and can record the sale to the person holding it ("Sold to them",
// which opens the Sell Drawer with the holder ticked so the hold ends as bought, not "sold to someone else").
// Data: dealer_holds() / release_hold() / complete_hold() (20261207120000_marketplace_holds.sql).
// Shown only when the marketplace switch is on (mkEnabled(), js/marketplace-dealer.js). Loaded after it.

let _mhHolds = [];          // from dealer_holds(): open first, then ended in the last 3 days
let _mhTimer = null;
let _mhMissing = false;     // migration not run yet
let _mhSdHoldId = null;     // the hold shown in the Sell Drawer
let _mhTab = 'inventory';   // seller tab, from mkUpdateEntry()
const MH_POLL_MS = 120000;

function _mhOn() { return typeof mkEnabled === 'function' && mkEnabled() && currentRole === 'seller' && !_mhMissing; }
function mhActive() { return _mhHolds.filter(h => h.status === 'active'); }
function mhHoldForCard(card) {
  const id = card && card._dbId;
  if (!id) return null;
  return mhActive().find(h => (h.cards || []).some(c => c.id === id)) || null;
}
function _mhSeenKey() { return 'mhSeen:' + (currentSeller || ''); }
function _mhWhen(iso) {
  const d = new Date(iso);
  return d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}
function _mhLeft(iso) {
  const m = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (m <= 0) return 'ending now';
  if (m < 60) return `${m} min left`;
  return `${Math.round(m / 60)} h left`;
}
// Phone → tap to call/text, email → mail, @handle → Instagram, else plain text.
function mhContactHTML(contact) {
  const c = String(contact || '').trim();
  const esc = _mkEsc;
  if (/^\S+@\S+\.\S+$/.test(c)) return `<a href="mailto:${esc(c)}">${esc(c)}</a>`;
  const digits = c.replace(/[^\d+]/g, '');
  if (/^[+(\d][\d\s().-]{6,}$/.test(c) && digits.replace(/\D/g, '').length >= 7) {
    return `<a href="sms:${esc(digits)}">${esc(c)}</a> · <a href="tel:${esc(digits)}">call</a>`;
  }
  const ig = /^@?([A-Za-z0-9._]{2,30})$/.exec(c);
  if (ig && c.startsWith('@')) return `<a href="https://instagram.com/${esc(ig[1])}" target="_blank" rel="noopener">${esc(c)}</a>`;
  return esc(c);
}

// ── Loading + polling ──
async function mhLoad({ quiet } = {}) {
  if (!_mhOn() || typeof db === 'undefined' || !db) { _mhRenderStrip(); return; }
  try {
    const { data, error } = await db.rpc('dealer_holds');
    if (error) {
      if (/dealer_holds|PGRST202|schema cache/i.test(error.message || '')) _mhMissing = true;
      else console.warn('[holds]', error.message);
      _mhRenderStrip(); return;
    }
    _mhHolds = Array.isArray(data) ? data : [];
  } catch (e) { console.warn('[holds]', e); return; }
  _mhSyncCards();
  _mhRenderStrip();
  if (document.getElementById('mhOverlay')?.classList.contains('open')) _mhRenderPanel();
  if (!quiet) _mhToastNew();
}

// Keep the cards on this phone in step with the server (ON HOLD chip, Edit Card lock).
function _mhSyncCards() {
  if (typeof inventory === 'undefined') return;
  const held = new Set(mhActive().flatMap(h => (h.cards || []).map(c => c.id)));
  const ended = new Set(_mhHolds.filter(h => h.status !== 'active').flatMap(h => (h.cards || [])
    .filter(c => c.listing_status !== 'reserved').map(c => c.id)));
  let changed = false;
  for (const card of inventory) {
    if (!card._dbId || card.Status === 'Sold') continue;
    if (held.has(card._dbId) && card.ListingStatus !== 'reserved') { card.ListingStatus = 'reserved'; changed = true; }
    else if (!held.has(card._dbId) && ended.has(card._dbId) && card.ListingStatus === 'reserved') { card.ListingStatus = 'active'; changed = true; }
  }
  if (changed && typeof _mkAfterChange === 'function') _mkAfterChange();
}

function _mhToastNew() {
  let seen = [];
  try { seen = JSON.parse(localStorage.getItem(_mhSeenKey()) || '[]'); } catch (_) {}
  const fresh = mhActive().filter(h => !seen.includes(h.id));
  if (!fresh.length) return;
  try { localStorage.setItem(_mhSeenKey(), JSON.stringify([...seen, ...fresh.map(h => h.id)].slice(-200))); } catch (_) {}
  const h = fresh[0];
  const what = (h.cards || [])[0]?.title || 'a card';
  showToast(fresh.length === 1 ? `🤝 ${h.buyer_name || 'A buyer'} is holding ${what}. Tap Holds to see their contact.`
                               : `🤝 ${fresh.length} new holds from buyers. Tap Holds to see them.`, '#f59e0b');
}

function mhStart() {
  mhStop();
  if (!_mhOn()) { _mhRenderStrip(); return; }
  // First load is quiet; the "new holds" toast waits until the login toasts have gone.
  mhLoad({ quiet: true }).then(() => setTimeout(() => { if (_mhTimer) _mhToastNew(); }, 3500));
  _mhTimer = setInterval(() => { if (document.visibilityState === 'visible') mhLoad(); }, MH_POLL_MS);
}
function mhStop() { if (_mhTimer) clearInterval(_mhTimer); _mhTimer = null; }
function mhReset() {
  mhStop(); _mhHolds = []; _mhMissing = false; _mhSdHoldId = null;
  _mhRenderStrip();
  document.getElementById('mhOverlay')?.classList.remove('open');
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && _mhTimer) mhLoad(); });

// ── Strip above the inventory table ──
function _mhRenderStrip(tab) {
  const el = document.getElementById('mhStrip');
  if (!el) return;
  if (tab) _mhTab = tab;
  const open = _mhOn() ? mhActive() : [];
  const onInventory = _mhTab === 'inventory';
  if (!open.length || !onInventory) { el.style.display = 'none'; return; }
  const n = open.reduce((s, h) => s + (h.cards || []).length, 0);
  const next = open.reduce((a, h) => (!a || h.expires_at < a.expires_at ? h : a), null);
  el.innerHTML = `<span>🤝 <b>${n} ${n === 1 ? 'card' : 'cards'} on hold</b> for ${open.length === 1 ? _mkEsc(open[0].buyer_name || 'a buyer') : open.length + ' buyers'}`
    + ` · next one ends ${_mkEsc(_mhWhen(next.expires_at))}</span>`
    + `<button class="btn btn-ghost" type="button" onclick="openHoldsPanel()">View holds</button>`;
  el.style.display = '';
}

// ── Holds panel ──
function openHoldsPanel() {
  let ov = document.getElementById('mhOverlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'mhOverlay';
    ov.className = 'modal-overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-labelledby', 'mhTitle');
    ov.addEventListener('click', e => { if (e.target === ov) closeHoldsPanel(); });
    document.body.appendChild(ov);
  }
  _mhRenderPanel();
  ov.classList.add('open');
  mhLoad({ quiet: true });
}
function closeHoldsPanel() { document.getElementById('mhOverlay')?.classList.remove('open'); }
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('mhOverlay')?.classList.contains('open')) closeHoldsPanel();
});

const MH_ENDED = {
  buyer_cancelled: 'Buyer cancelled', dealer_released: 'You released it', 'hold expired': 'Expired',
  sold_to_holder: 'Sold to them', sold_elsewhere: 'Sold to someone else',
};

function _mhCardLine(c) {
  return `<div class="mh-card">${c.stock_code ? `<span class="mh-code">${_mkEsc(c.stock_code)}</span>` : ''}`
    + `<span class="mh-title">${_mkEsc(c.title || 'Card')}</span>`
    + `<span class="mh-price">${c.price_cents != null ? _mkMoney(c.price_cents) : ''}</span></div>`;
}

function _mhRenderPanel() {
  const ov = document.getElementById('mhOverlay');
  if (!ov) return;
  const open = mhActive(), ended = _mhHolds.filter(h => h.status !== 'active');
  const openHTML = open.map(h => `
    <div class="mh-hold" data-hold="${_mkEsc(h.id)}">
      <div class="mh-head"><b>${_mkEsc(h.buyer_name || 'A buyer')}</b><span class="mh-left">${_mkEsc(_mhLeft(h.expires_at))} · until ${_mkEsc(_mhWhen(h.expires_at))}</span></div>
      <div class="mh-contact">${mhContactHTML(h.buyer_contact)}</div>
      ${h.agreed_cents ? `<div class="mo-line">From an offer: agreed ${_mkEsc(_mkMoney(h.agreed_cents))}</div>` : ''}
      ${h.buyer_note ? `<div class="mh-note">“${_mkEsc(h.buyer_note)}”</div>` : ''}
      ${(h.cards || []).map(_mhCardLine).join('')}
      <div class="mh-actions">
        <button class="btn btn-primary" type="button" onclick="mhSellToHolder('${_mkEsc(h.id)}')">Sold to them</button>
        <button class="btn btn-ghost" type="button" onclick="mhRelease('${_mkEsc(h.id)}', this)">Release</button>
      </div>
    </div>`).join('');
  const endedHTML = ended.map(h => `
    <div class="mh-hold mh-ended">
      <div class="mh-head"><b>${_mkEsc(h.buyer_name || 'A buyer')}</b><span class="mh-left">${_mkEsc(MH_ENDED[h.end_reason] || 'Ended')}</span></div>
      ${(h.cards || []).map(_mhCardLine).join('')}
    </div>`).join('');
  ov.innerHTML = `
    <div class="modal" style="max-width:520px">
      <div class="modal-header">
        <div><div class="modal-player" id="mhTitle">Holds</div>
        <div class="mh-sub">Buyers asked you to set these aside. They pay you when you meet; nothing is charged on CardShow.</div></div>
        <button class="modal-close" type="button" onclick="closeHoldsPanel()" aria-label="Close">✕</button>
      </div>
      <div class="modal-body">
        ${open.length ? openHTML : '<p class="mh-empty">No open holds.</p>'}
        ${ended.length ? `<div class="mh-section">Ended recently</div>${endedHTML}` : ''}
        <p class="mh-help">A hold lasts 24 hours. <b>Sold to them</b> records the sale like any table sale. <b>Release</b> puts the card back on sale and emails the buyer. If you sell a held card to someone else, the hold ends and the buyer is told.</p>
      </div>
    </div>`;
}

async function _mhNotify(reservationId) {
  try {
    const { data } = await db.auth.getSession();
    const t = data && data.session && data.session.access_token;
    if (!t) return;
    fetch('/.netlify/functions/hold-notify-now', { method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: JSON.stringify({ reservation_id: reservationId }) }).catch(() => {});
  } catch (_) {}
}

async function mhRelease(holdId, btn) {
  const h = _mhHolds.find(x => x.id === holdId);
  if (!h || _mkNeedSignal()) return;
  if (!confirm(`Release ${h.buyer_name || 'this buyer'}'s hold? The card goes back on sale and they get an email.`)) return;
  if (btn) btn.disabled = true;
  try {
    const { data, error } = await db.rpc('release_hold', { p_reservation_id: holdId });
    if (error || data?.error) throw new Error(error?.message || data.error);
    showToast('Hold released. The card is back on sale.');
    _mhNotify(holdId);
    await mhLoad({ quiet: true });
  } catch (e) {
    console.warn('[holds] release', e);
    showToast('Couldn\'t release the hold. Try again.', '#ef4444');
    if (btn) btn.disabled = false;
  }
}

// "Sold to them": open the Sell Drawer on the held card with the holder ticked. A hold over several cards
// (an accepted bundle offer) opens the bundle sale dialog instead, which records every card.
function mhSellToHolder(holdId) {
  const h = _mhHolds.find(x => x.id === holdId);
  if (h && (h.cards || []).length > 1) { _mhOpenBundleSale(h); return; }
  const cardId = h && (h.cards || [])[0]?.id;
  const idx = cardId ? inventory.findIndex(c => c._dbId === cardId) : -1;
  if (idx < 0) { showToast('That card isn\'t loaded on this device. Refresh and try again.', '#f59e0b'); return; }
  closeHoldsPanel();
  _mhSdHoldId = holdId;
  openSellDrawer(idx);
}

// Called by openSellDrawer(): shows who holds the card, ticked when opened from "Sold to them".
function mhSdFill(card) {
  const wrap = document.getElementById('sdHoldWrap');
  if (!wrap) return;
  const h = _mhOn() ? mhHoldForCard(card) : null;
  if (!h) { wrap.style.display = 'none'; _mhSdHoldId = null; return; }
  const ticked = _mhSdHoldId === h.id;
  _mhSdHoldId = h.id;
  document.getElementById('sdHoldTo').checked = ticked;
  document.getElementById('sdHoldText').textContent = `Sold to ${h.buyer_name || 'the buyer'} (holding this card until ${_mhWhen(h.expires_at)}`
    + `${h.agreed_cents ? `, agreed ${_mkMoney(h.agreed_cents)}` : ''})`;
  // "Sold to them" on a hold from an accepted offer: the agreed price goes in the sold price.
  if (ticked && h.agreed_cents) document.getElementById('sdPrice').value = String(h.agreed_cents / 100);
  document.getElementById('sdHoldNote').textContent = ticked ? ''
    : `Not ticked: the card goes to someone else, ${h.buyer_name || 'the buyer'}'s hold ends and they get an email.`;
  wrap.style.display = '';
}
function mhSdToggle() {
  const h = _mhHolds.find(x => x.id === _mhSdHoldId);
  document.getElementById('sdHoldNote').textContent = document.getElementById('sdHoldTo').checked ? ''
    : `Not ticked: the card goes to someone else, ${h?.buyer_name || 'the buyer'}'s hold ends and they get an email.`;
}
function mhSdClosed() { _mhSdHoldId = null; }
// sdConfirm() asks this before saving: the hold id when the sale is to the holder, else null.
function mhTakeSdHold() {
  const wrap = document.getElementById('sdHoldWrap');
  const id = wrap && wrap.style.display !== 'none' && document.getElementById('sdHoldTo').checked ? _mhSdHoldId : null;
  _mhSdHoldId = null;
  if (wrap) wrap.style.display = 'none';
  return id;
}
// End the hold as bought, then let the sale save (it must reach the server after this, or the hold
// counts as sold to someone else). Gives up after 6s so a slow signal never blocks the sale.
async function mhCompleteHold(holdId) {
  try {
    await Promise.race([
      db.rpc('complete_hold', { p_reservation_id: holdId }).then(({ data, error }) => {
        if (error || data?.error) console.warn('[holds] complete', error?.message || data.error);
      }),
      new Promise(r => setTimeout(r, 6000)),
    ]);
  } catch (e) { console.warn('[holds] complete', e); }
  _mhNotify(holdId);
  mhLoad({ quiet: true });
}

// ── Bundle sale: every card in a hold from an accepted bundle offer, at the agreed total ──
// The total is split by asking price (whole cents, leftover to the priciest card); each card is then
// recorded like a Sell Drawer sale (inventory, show ledger, private cost copy), after complete_hold has
// ended the hold as bought, so the buyer isn't emailed that the cards sold to someone else.
const MH_PAY = ['Cash', 'Venmo', 'Zelle', 'PayPal', 'Square', 'Other'];
let _mhBundle = null;   // { hold, cards: [{card, cents}], pay }

function mhSplitCents(totalCents, asks) {
  const sum = asks.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  const out = asks.map(a => sum > 0 ? Math.floor(totalCents * (a > 0 ? a : 0) / sum) : Math.floor(totalCents / asks.length));
  let left = totalCents - out.reduce((a, b) => a + b, 0);
  const order = asks.map((a, i) => i).sort((i, j) => (asks[j] || 0) - (asks[i] || 0));
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k]] += 1;
  return out;
}

function _mhOpenBundleSale(h) {
  const cards = (h.cards || []).map(c => inventory.find(x => x._dbId === c.id));
  if (cards.some(c => !c)) { showToast('Some of these cards aren\'t loaded on this device. Refresh and try again.', '#f59e0b'); return; }
  const asks = (h.cards || []).map(c => c.price_cents || Math.round(Number(cards.find(x => x._dbId === c.id)?.Price || 0) * 100));
  const total = h.agreed_cents || asks.reduce((a, b) => a + b, 0);
  const split = mhSplitCents(total, asks);
  _mhBundle = { hold: h, cards: cards.map((card, i) => ({ card, cents: split[i] })), pay: null };
  closeHoldsPanel();
  let ov = document.getElementById('mhSaleOverlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'mhSaleOverlay';
    ov.className = 'modal-overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-labelledby', 'mhSaleTitle');
    ov.addEventListener('click', e => { if (e.target === ov) mhCloseBundleSale(); });
    document.body.appendChild(ov);
  }
  ov.innerHTML = `
    <div class="modal" style="max-width:520px">
      <div class="modal-header">
        <div><div class="modal-player" id="mhSaleTitle">Sold to ${_mkEsc(h.buyer_name || 'the buyer')}</div>
        <div class="mh-sub">${cards.length} cards${h.agreed_cents ? ` · agreed ${_mkEsc(_mkMoney(h.agreed_cents))}` : ''}. The total is split by asking price; change any line.</div></div>
        <button class="modal-close" type="button" onclick="mhCloseBundleSale()" aria-label="Close">✕</button>
      </div>
      <div class="modal-body">
        ${_mhBundle.cards.map((x, i) => `
          <label class="mh-sale-row"><span class="mh-title">${x.card.StockCode ? `<span class="mh-code">${_mkEsc(x.card.StockCode)}</span> ` : ''}${_mkEsc(x.card['Card Title'] || x.card.Player || 'Card')}</span>
            <span class="mh-sale-price">$<input type="text" inputmode="decimal" data-i="${i}" value="${(x.cents / 100).toFixed(2)}" oninput="mhBundleTotal()" aria-label="Price for ${_mkEsc(x.card['Card Title'] || 'card')}"></span></label>`).join('')}
        <div class="mh-card mo-total"><span class="mh-title">Total</span><span class="mh-price" id="mhSaleTotal"></span></div>
        <div class="mh-section">Payment</div>
        <div class="mh-pay-row">${MH_PAY.map(p => `<button type="button" class="btn btn-ghost mh-pay" aria-pressed="false" onclick="mhBundlePay(this,'${p}')">${p}</button>`).join('')}</div>
        <div class="mo-err" id="mhSaleErr" role="alert"></div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-primary" type="button" id="mhSaleBtn" onclick="mhConfirmBundleSale()">Record sale</button>
        <button class="btn btn-ghost" type="button" onclick="mhCloseBundleSale()">Cancel</button>
      </div>
    </div>`;
  mhBundleTotal();
  ov.classList.add('open');
}
function mhCloseBundleSale() { document.getElementById('mhSaleOverlay')?.classList.remove('open'); _mhBundle = null; }
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('mhSaleOverlay')?.classList.contains('open')) mhCloseBundleSale();
});
function _mhBundlePrices() {
  return [...document.querySelectorAll('#mhSaleOverlay input[data-i]')].map(el => {
    const n = parseFloat(String(el.value).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? Math.round(n * 100) : NaN;
  });
}
function mhBundleTotal() {
  const c = _mhBundlePrices();
  const el = document.getElementById('mhSaleTotal');
  if (el) el.textContent = c.every(Number.isFinite) ? _mkMoney(c.reduce((a, b) => a + b, 0)) : '—';
}
function mhBundlePay(btn, p) {
  if (!_mhBundle) return;
  _mhBundle.pay = p;
  document.querySelectorAll('#mhSaleOverlay .mh-pay').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
}

function _mhRecordSale(card, price, pay, note) {
  const showId = typeof _resolveSaleShowId === 'function' ? _resolveSaleShowId(card) : null;
  card.Status = 'Sold';
  card.ListingStatus = 'sold';
  card.SoldPrice = price;
  card.PaymentMethod = pay;
  card.SaleNotes = note;
  card.SoldTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  card.SoldDate = _todayISO();
  card._clientSaleId = costUuid();
  updateCardInDB(card);
  if (showId && card._dbId && !(card._shows instanceof Set && card._shows.has(showId))) _autoPublishCardToShow(card, card._dbId, showId);
  recordShowTransaction(card, showId);
  if (typeof costRecordSale === 'function') costRecordSale(card, card._clientSaleId, { showId, price });
  return showId;
}

async function mhConfirmBundleSale() {
  const b = _mhBundle;
  if (!b) return;
  const err = document.getElementById('mhSaleErr');
  const cents = _mhBundlePrices();
  if (!cents.every(c => Number.isFinite(c) && c > 0)) { err.textContent = 'Enter a price above $0 for every card.'; return; }
  if (!b.pay) { err.textContent = 'Pick how they paid.'; return; }
  err.textContent = '';
  const btn = document.getElementById('mhSaleBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  // First sale at a show today: inventory snapshot, before these sales change it.
  const firstShow = typeof _resolveSaleShowId === 'function' ? _resolveSaleShowId(b.cards[0].card) : null;
  if (firstShow && typeof shEnsureShowStart === 'function') shEnsureShowStart(firstShow);
  await mhCompleteHold(b.hold.id);   // end the hold as bought before the cards are saved as sold
  const note = `Bundle sale to ${b.hold.buyer_name || 'buyer'} (marketplace offer)`;
  b.cards.forEach((x, i) => _mhRecordSale(x.card, cents[i] / 100, b.pay, note));
  const total = cents.reduce((a, c) => a + c, 0);
  mhCloseBundleSale();
  if (typeof syncBuyerView === 'function') syncBuyerView();
  updateStats(); updateReport();
  renderSellerTable(getSellerInventory());
  showToast(`✓ Sold ${b.cards.length} cards to ${b.hold.buyer_name || 'the buyer'} · ${_mkMoney(total)} · ${b.pay}`);
}
