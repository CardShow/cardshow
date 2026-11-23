// CardShow Marketplace — offers, dealer side (Phase 2, step 2). See CLAUDE.md "Offers".
// An offer can cover several cards for one price (a bundle, 20261209120000): the panel lists every card and the total.
// A buyer on the buyer site offers less than the asking price. Here the dealer sees the offers (strip above the
// inventory table, Offers panel) and accepts, declines or counters. An accepted offer becomes a hold for that
// buyer at the agreed price (Holds panel, "Sold to them" opens the Sell Drawer with that price filled in).
// The card's own settings (Edit Card → Marketplace: accept offers, lowest offer, auto-accept) answer some offers
// on the server without the dealer.
// Data: dealer_offers() / respond_offer() (20261208120000_marketplace_offers.sql).
// Shown only when the marketplace switch is on (mkEnabled(), js/marketplace-dealer.js). Loaded after
// js/marketplace-holds.js.

let _moOffers = [];        // from dealer_offers(): open first, then ended in the last 3 days
let _moTimer = null;
let _moMissing = false;    // migration not run yet
let _moTab = 'inventory';
const MO_POLL_MS = 120000;

function _moOn() { return typeof mkEnabled === 'function' && mkEnabled() && currentRole === 'seller' && !_moMissing; }
function moWaiting() { return _moOffers.filter(o => o.status === 'pending'); }        // the dealer's turn
function moCountered() { return _moOffers.filter(o => o.status === 'countered'); }    // the buyer's turn
function _moSeenKey() { return 'moSeen:' + (currentSeller || ''); }
function _moWhen(iso) { return new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }); }
function _moCents(v) { const n = parseFloat(String(v || '').replace(/[$,\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : NaN; }

// ── Loading + polling ──
async function moLoad({ quiet } = {}) {
  if (!_moOn() || typeof db === 'undefined' || !db) { _moRenderStrip(); return; }
  try {
    const { data, error } = await db.rpc('dealer_offers');
    if (error) {
      if (/dealer_offers|PGRST202|schema cache/i.test(error.message || '')) _moMissing = true;
      else console.warn('[offers]', error.message);
      _moRenderStrip(); return;
    }
    _moOffers = Array.isArray(data) ? data : [];
  } catch (e) { console.warn('[offers]', e); return; }
  _moRenderStrip();
  if (document.getElementById('moOverlay')?.classList.contains('open')) _moRenderPanel();
  if (!quiet) _moToastNew();
}

// A new offer, or a buyer's counter, is "new" once per offer and move.
function _moToastNew() {
  let seen = [];
  try { seen = JSON.parse(localStorage.getItem(_moSeenKey()) || '[]'); } catch (_) {}
  const key = o => o.id + ':' + o.moves;
  const fresh = moWaiting().filter(o => !seen.includes(key(o)));
  if (!fresh.length) return;
  try { localStorage.setItem(_moSeenKey(), JSON.stringify([...seen, ...fresh.map(key)].slice(-300))); } catch (_) {}
  const o = fresh[0];
  showToast(fresh.length === 1
    ? `💬 ${o.buyer_name || 'A buyer'} offered ${_mkMoney(o.amount_cents)} for ${moCards(o).length > 1 ? moCards(o).length + ' cards' : (o.card?.title || 'a card')}. Tap Offers to answer.`
    : `💬 ${fresh.length} offers waiting for you. Tap Offers to answer.`, '#f59e0b');
}

function moStart() {
  moStop();
  if (!_moOn()) { _moRenderStrip(); return; }
  moLoad({ quiet: true }).then(() => setTimeout(() => { if (_moTimer) _moToastNew(); }, 4500));
  _moTimer = setInterval(() => { if (document.visibilityState === 'visible') moLoad(); }, MO_POLL_MS);
}
function moStop() { if (_moTimer) clearInterval(_moTimer); _moTimer = null; }
function moReset() {
  moStop(); _moOffers = []; _moMissing = false;
  _moRenderStrip();
  document.getElementById('moOverlay')?.classList.remove('open');
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && _moTimer) moLoad(); });

// ── Strip above the inventory table ──
function _moRenderStrip(tab) {
  const el = document.getElementById('moStrip');
  if (!el) return;
  if (tab) _moTab = tab;
  const waiting = _moOn() ? moWaiting() : [];
  const countered = _moOn() ? moCountered() : [];
  if ((!waiting.length && !countered.length) || _moTab !== 'inventory') { el.style.display = 'none'; return; }
  const parts = [];
  if (waiting.length) parts.push(`<b>${waiting.length} ${waiting.length === 1 ? 'offer' : 'offers'} to answer</b>`);
  if (countered.length) parts.push(`${countered.length} waiting on the buyer`);
  el.innerHTML = `<span>💬 ${parts.join(' · ')}</span>`
    + `<button class="btn btn-ghost" type="button" onclick="openOffersPanel()">View offers</button>`;
  el.style.display = '';
}

// ── Offers panel ──
function openOffersPanel() {
  let ov = document.getElementById('moOverlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'moOverlay';
    ov.className = 'modal-overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-labelledby', 'moTitle');
    ov.addEventListener('click', e => { if (e.target === ov) closeOffersPanel(); });
    document.body.appendChild(ov);
  }
  _moRenderPanel();
  ov.classList.add('open');
  moLoad({ quiet: true });
}
function closeOffersPanel() { document.getElementById('moOverlay')?.classList.remove('open'); }
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('moOverlay')?.classList.contains('open')) closeOffersPanel();
});

const MO_ENDED = {
  accepted: 'Accepted · now a hold', declined: 'Declined', withdrawn: 'Buyer withdrew it', expired: 'Ran out', closed: 'Closed',
};
const MO_WHY = {
  below_minimum: 'below your lowest offer', other_offer_accepted: 'another offer was accepted', sold: 'card sold',
  held: 'card on hold', unavailable: 'card no longer listed', no_answer: 'no answer in time',
};

function _moHistory(o) {
  return (o.history || []).map(h => `${h.by === 'buyer' ? 'Buyer' : 'You'} ${_mkMoney(h.cents)}`).join(' → ');
}

// Every card in the offer (a bundle has several), then the total for a bundle.
function moCards(o) { return (o.cards && o.cards.length) ? o.cards : (o.card ? [o.card] : []); }
function moAskingCents(o) { return moCards(o).reduce((s, c) => s + (c.price_cents || 0), 0); }
function _moCardHTML(o) {
  const cards = moCards(o);
  const rows = cards.map(c => `<div class="mh-card">${c.stock_code ? `<span class="mh-code">${_mkEsc(c.stock_code)}</span>` : ''}`
    + `<span class="mh-title">${_mkEsc(c.title || 'Card')}</span>`
    + `<span class="mh-price">${cards.length > 1 ? '' : 'asking '}${c.price_cents != null ? _mkMoney(c.price_cents) : '—'}`
    + `${c.comp_value_cents ? ` · comp ${_mkMoney(c.comp_value_cents)}` : ''}</span></div>`).join('');
  if (cards.length < 2) return rows;
  return `<div class="mo-bundle">Bundle · ${cards.length} cards</div>${rows}`
    + `<div class="mh-card mo-total"><span class="mh-title">Asking together</span><span class="mh-price">${_mkMoney(moAskingCents(o))}</span></div>`;
}

function _moRenderPanel() {
  const ov = document.getElementById('moOverlay');
  if (!ov) return;
  const waiting = moWaiting(), countered = moCountered();
  const ended = _moOffers.filter(o => o.status !== 'pending' && o.status !== 'countered');
  const waitingHTML = waiting.map(o => {
    const ask = moAskingCents(o);
    const pct = ask ? Math.round(o.amount_cents / ask * 100) : null;
    return `
    <div class="mh-hold mo-offer" data-offer="${_mkEsc(o.id)}">
      <div class="mh-head"><b>${_mkEsc(o.buyer_name || 'A buyer')} offers ${_mkEsc(_mkMoney(o.amount_cents))}</b>
        <span class="mh-left">answer by ${_mkEsc(_moWhen(o.expires_at))}</span></div>
      ${_moCardHTML(o)}
      <div class="mo-line">${pct != null ? `${pct}% of your price · ` : ''}${_mkEsc(_moHistory(o))}</div>
      <div class="mh-contact">${typeof mhContactHTML === 'function' ? mhContactHTML(o.buyer_contact) : _mkEsc(o.buyer_contact || '')}</div>
      ${o.buyer_note ? `<div class="mh-note">“${_mkEsc(o.buyer_note)}”</div>` : ''}
      <div class="mh-actions">
        <button class="btn btn-primary" type="button" onclick="moAccept('${_mkEsc(o.id)}', this)">Accept ${_mkEsc(_mkMoney(o.amount_cents))}</button>
        ${o.can_counter ? `<button class="btn btn-ghost" type="button" onclick="moShowCounter('${_mkEsc(o.id)}')">Counter</button>` : ''}
        <button class="btn btn-ghost" type="button" onclick="moDecline('${_mkEsc(o.id)}', this)">Decline</button>
      </div>
      ${o.can_counter ? `<form class="mo-counter" id="moCounter_${_mkEsc(o.id)}" style="display:none" onsubmit="moCounter(event, '${_mkEsc(o.id)}')">
        <label class="mo-counter-label">Your counter ($)
          <input type="text" inputmode="decimal" autocomplete="off" name="amount"
            placeholder="Between ${_mkEsc(_mkMoney(o.amount_cents))} and ${_mkEsc(_mkMoney(ask))}"></label>
        <button class="btn btn-primary" type="submit">Send counter</button>
        <div class="mo-err" role="alert"></div>
      </form>` : '<div class="mo-line">Last move: accept or decline.</div>'}
    </div>`;
  }).join('');
  const counteredHTML = countered.map(o => `
    <div class="mh-hold">
      <div class="mh-head"><b>${_mkEsc(o.buyer_name || 'A buyer')}</b>
        <span class="mh-left">you countered ${_mkEsc(_mkMoney(o.amount_cents))} · until ${_mkEsc(_moWhen(o.expires_at))}</span></div>
      ${_moCardHTML(o)}
      <div class="mo-line">${_mkEsc(_moHistory(o))} · waiting for the buyer</div>
    </div>`).join('');
  const endedHTML = ended.map(o => `
    <div class="mh-hold mh-ended">
      <div class="mh-head"><b>${_mkEsc(o.buyer_name || 'A buyer')} · ${_mkEsc(_mkMoney(o.amount_cents))}</b>
        <span class="mh-left">${_mkEsc(MO_ENDED[o.status] || 'Ended')}${o.decided_by === 'auto' ? ' automatically' : ''}${MO_WHY[o.end_reason] ? ' · ' + _mkEsc(MO_WHY[o.end_reason]) : ''}</span></div>
      ${_moCardHTML(o)}
    </div>`).join('');
  ov.innerHTML = `
    <div class="modal" style="max-width:520px">
      <div class="modal-header">
        <div><div class="modal-player" id="moTitle">Offers</div>
        <div class="mh-sub">Buyers offering less than your price. If you accept, the card is held for them for 24 hours at that price and they pay you when you meet.</div></div>
        <button class="modal-close" type="button" onclick="closeOffersPanel()" aria-label="Close">✕</button>
      </div>
      <div class="modal-body">
        ${waiting.length ? waitingHTML : '<p class="mh-empty">No offers to answer.</p>'}
        ${countered.length ? `<div class="mh-section">Waiting on the buyer</div>${counteredHTML}` : ''}
        ${ended.length ? `<div class="mh-section">Ended recently</div>${endedHTML}` : ''}
        <p class="mh-help">An offer waits 24 hours for an answer. You can counter once; the buyer can counter back once, then you accept or decline. Set a lowest offer and an auto-accept price per card in Edit Card → Marketplace, and turn offers off there for cards you won't negotiate on.</p>
      </div>
    </div>`;
}

async function _moNotify(offerId) {
  try {
    const { data } = await db.auth.getSession();
    const t = data && data.session && data.session.access_token;
    if (!t) return;
    fetch('/.netlify/functions/offer-notify-now', { method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: JSON.stringify({ offer_id: offerId }) }).catch(() => {});
  } catch (_) {}
}

const MO_ERR = {
  expired: 'That offer ran out.', not_your_turn: 'The buyer already answered. Reloading.', unavailable: 'That card isn\'t available any more (sold, held or taken down).',
  bad_counter: 'Your counter has to be more than the offer and less than your asking price.', no_more_counters: 'No more counters on this one: accept or decline.',
  not_found: 'That offer is gone.',
};

async function _moRespond(offerId, action, cents) {
  const { data, error } = await db.rpc('respond_offer', { p_offer_id: offerId, p_action: action, p_counter_cents: cents ?? null });
  if (error) throw new Error(error.message);
  return data || {};
}

async function moAccept(offerId, btn) {
  const o = _moOffers.find(x => x.id === offerId);
  if (!o || _mkNeedSignal()) return;
  const n = moCards(o).length;
  if (!confirm(`Accept ${_mkMoney(o.amount_cents)} from ${o.buyer_name || 'this buyer'}${n > 1 ? ` for ${n} cards` : ''}? `
    + `${n > 1 ? 'The cards are' : 'The card is'} held for them for 24 hours at that price and other offers on ${n > 1 ? 'them' : 'it'} close.`)) return;
  if (btn) btn.disabled = true;
  try {
    const r = await _moRespond(offerId, 'accept');
    if (r.error) { showToast(MO_ERR[r.error] || 'Couldn\'t accept. Try again.', '#f59e0b'); await moLoad({ quiet: true }); return; }
    showToast(`Accepted. ${n > 1 ? `${n} cards are` : `${o.card?.title || 'The card'} is`} on hold for ${o.buyer_name || 'the buyer'} at ${_mkMoney(r.agreed_cents)}.`);
    _moNotify(offerId);
    await moLoad({ quiet: true });
    if (typeof mhLoad === 'function') mhLoad({ quiet: true });
  } catch (e) {
    console.warn('[offers] accept', e);
    showToast('Couldn\'t accept. Try again.', '#ef4444');
  } finally { if (btn) btn.disabled = false; }
}

async function moDecline(offerId, btn) {
  const o = _moOffers.find(x => x.id === offerId);
  if (!o || _mkNeedSignal()) return;
  if (!confirm(`Decline ${_mkMoney(o.amount_cents)} from ${o.buyer_name || 'this buyer'}? They get an email; the card stays on sale.`)) return;
  if (btn) btn.disabled = true;
  try {
    const r = await _moRespond(offerId, 'decline');
    if (r.error) { showToast(MO_ERR[r.error] || 'Couldn\'t decline. Try again.', '#f59e0b'); await moLoad({ quiet: true }); return; }
    showToast('Offer declined.');
    _moNotify(offerId);
    await moLoad({ quiet: true });
  } catch (e) {
    console.warn('[offers] decline', e);
    showToast('Couldn\'t decline. Try again.', '#ef4444');
  } finally { if (btn) btn.disabled = false; }
}

function moShowCounter(offerId) {
  const f = document.getElementById('moCounter_' + offerId);
  if (!f) return;
  f.style.display = '';
  f.querySelector('input')?.focus();
}

async function moCounter(e, offerId) {
  e.preventDefault();
  const o = _moOffers.find(x => x.id === offerId);
  const f = e.target;
  const err = f.querySelector('.mo-err');
  const cents = _moCents(f.querySelector('input').value);
  if (!o) return;
  const price = moAskingCents(o);
  if (!(cents > o.amount_cents && cents < price)) {
    err.textContent = `Enter more than ${_mkMoney(o.amount_cents)} and less than ${_mkMoney(price)}.`;
    return;
  }
  if (_mkNeedSignal()) return;
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true; err.textContent = '';
  try {
    const r = await _moRespond(offerId, 'counter', cents);
    if (r.error) { err.textContent = MO_ERR[r.error] || 'Couldn\'t send the counter. Try again.'; if (r.error !== 'bad_counter') await moLoad({ quiet: true }); return; }
    showToast(`Counter of ${_mkMoney(cents)} sent to ${o.buyer_name || 'the buyer'}.`);
    _moNotify(offerId);
    await moLoad({ quiet: true });
  } catch (ex) {
    console.warn('[offers] counter', ex);
    err.textContent = 'Couldn\'t send the counter. Check your signal and try again.';
  } finally { btn.disabled = false; }
}
