// CardShow Marketplace — Buy Now orders, dealer side (Phase 2). See CLAUDE.md "Buy Now and orders".
// A buyer taps Buy Now on the buyer site. Here the dealer sees the order (strip above the inventory, Orders panel):
// Confirm they still have it (in time, or it's cancelled) → the buyer pays through the dealer's own payment links
// or at the table → Mark paid (the card is sold) → for shipped orders, add tracking. No money passes through CardShow
// and no fees are charged during the pilot; the order's price is kept for later billing.
// "How buyers pay you" (Venmo / PayPal / Cash App / Zelle / a link / other) is saved with set_payment_methods().
// Data: dealer_orders(), confirm_order(), mark_order_paid(), ship_order(), dealer_cancel_order()
// (20261212120000_marketplace_orders.sql). Shown only with the marketplace switch on. Loaded after js/offer-rules.js.

let _ordOrders = [];
let _ordTimer = null;
let _ordMissing = false;
let _ordTab = 'inventory';
let _ordPay = null;          // { methods, note } or null
const ORD_POLL_MS = 60000;
const ORD_OPEN = ['awaiting_confirmation', 'awaiting_payment', 'paid', 'shipped'];

function _ordOn() { return typeof mkEnabled === 'function' && mkEnabled() && currentRole === 'seller' && !_ordMissing; }
function ordToConfirm() { return _ordOrders.filter(o => o.status === 'awaiting_confirmation'); }
function ordToDo() { return _ordOrders.filter(o => o.status === 'awaiting_confirmation' || (o.status === 'paid' && o.fulfillment === 'ship')); }
function ordForCard(card) {
  // Only orders that still hold the card (a paid / shipped order's card is already sold).
  return card && card._dbId ? _ordOrders.find(o => ['awaiting_confirmation', 'awaiting_payment'].includes(o.status)
    && (o.listing_ids || []).includes(card._dbId)) : null;
}
function _ordSeenKey() { return 'ordSeen:' + (currentSeller || ''); }
function _ordWhen(iso) { return new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }); }
function _ordMinutesLeft(iso) { return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000)); }
function _ordCents(v) { const n = parseFloat(String(v || '').replace(/[$,\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : NaN; }

// ── Loading + polling ──
async function ordLoad({ quiet } = {}) {
  if (!_ordOn() || typeof db === 'undefined' || !db) { _ordRenderStrip(); return; }
  try {
    const [{ data, error }, pay] = await Promise.all([
      db.rpc('dealer_orders'),
      _ordPay ? Promise.resolve(null) : db.from('dealer_payment_methods').select('methods, note').maybeSingle(),
    ]);
    if (error) {
      if (/dealer_orders|PGRST202|schema cache/i.test(error.message || '')) _ordMissing = true;
      else console.warn('[orders]', error.message);
      _ordRenderStrip(); return;
    }
    _ordOrders = Array.isArray(data) ? data : [];
    if (pay && !pay.error) _ordPay = pay.data || { methods: [], note: null };
  } catch (e) { console.warn('[orders]', e); return; }
  _ordRenderStrip();
  if (document.getElementById('ordOverlay')?.classList.contains('open')) _ordRenderPanel();
  if (!quiet) _ordToastNew();
}

function _ordToastNew() {
  let seen = [];
  try { seen = JSON.parse(localStorage.getItem(_ordSeenKey()) || '[]'); } catch (_) {}
  const fresh = ordToConfirm().filter(o => !seen.includes(o.id));
  if (!fresh.length) return;
  try { localStorage.setItem(_ordSeenKey(), JSON.stringify([...seen, ...fresh.map(o => o.id)].slice(-300))); } catch (_) {}
  const o = fresh[0];
  showToast(fresh.length === 1
    ? `🛍 New order: ${o.buyer_name || 'A buyer'} bought ${(o.cards || []).length > 1 ? (o.cards.length + ' cards') : (o.cards?.[0]?.title || 'a card')}. Confirm by ${_ordWhen(o.confirm_by)}.`
    : `🛍 ${fresh.length} new orders to confirm. Tap Orders.`, '#f59e0b');
}

function ordStart() {
  ordStop();
  if (!_ordOn()) { _ordRenderStrip(); return; }
  ordLoad({ quiet: true }).then(() => setTimeout(() => { if (_ordTimer) _ordToastNew(); }, 6000));
  _ordTimer = setInterval(() => { if (document.visibilityState === 'visible') ordLoad(); }, ORD_POLL_MS);
}
function ordStop() { if (_ordTimer) clearInterval(_ordTimer); _ordTimer = null; }
function ordReset() {
  ordStop(); _ordOrders = []; _ordMissing = false; _ordPay = null;
  _ordRenderStrip();
  document.getElementById('ordOverlay')?.classList.remove('open');
  document.getElementById('ordPayOverlay')?.classList.remove('open');
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && _ordTimer) ordLoad(); });

// ── Strip above the inventory table ──
function _ordRenderStrip(tab) {
  const el = document.getElementById('ordStrip');
  if (!el) return;
  if (tab) _ordTab = tab;
  const confirm = _ordOn() ? ordToConfirm() : [];
  const unpaid = _ordOn() ? _ordOrders.filter(o => o.status === 'awaiting_payment') : [];
  const toShip = _ordOn() ? _ordOrders.filter(o => o.status === 'paid' && o.fulfillment === 'ship') : [];
  _ordRenderButton(confirm.length + toShip.length);
  if ((!confirm.length && !unpaid.length && !toShip.length) || _ordTab !== 'inventory') { el.style.display = 'none'; return; }
  const parts = [];
  if (confirm.length) {
    const soonest = confirm.map(o => o.confirm_by).sort()[0];
    parts.push(`<b>${confirm.length} ${confirm.length === 1 ? 'order' : 'orders'} to confirm</b> · ${_ordMinutesLeft(soonest)} min left`);
  }
  if (unpaid.length) parts.push(`${unpaid.length} waiting for payment`);
  if (toShip.length) parts.push(`<b>${toShip.length} to ship</b>`);
  el.innerHTML = `<span>🛍 ${parts.join(' · ')}</span><button class="btn btn-ghost" type="button" onclick="openOrdersPanel()">View orders</button>`;
  el.style.display = '';
}

// Toolbar button: always there on My Inventory with the marketplace on, so the Orders panel can be opened with
// no open orders. The count is what needs the dealer: orders to confirm + paid orders to ship.
function _ordRenderButton(todo) {
  const btn = document.getElementById('ordBtn');
  if (!btn) return;
  btn.style.display = _ordOn() && _ordTab === 'inventory' ? '' : 'none';
  const c = document.getElementById('ordBtnCount');
  if (c) { c.textContent = todo > 0 ? String(todo) : ''; c.style.display = todo > 0 ? '' : 'none'; }
  btn.setAttribute('aria-label', todo > 0 ? `Orders, ${todo} to do` : 'Orders');
}

// ── Orders panel ──
function _ordOverlay(id, labelId) {
  let ov = document.getElementById(id);
  if (!ov) {
    ov = document.createElement('div');
    ov.id = id;
    ov.className = 'modal-overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-labelledby', labelId);
    ov.addEventListener('click', e => { if (e.target === ov) ov.classList.remove('open'); });
    document.body.appendChild(ov);
  }
  return ov;
}
function openOrdersPanel() {
  const ov = _ordOverlay('ordOverlay', 'ordTitle');
  _ordRenderPanel();
  ov.classList.add('open');
  ordLoad({ quiet: true });
}
function closeOrdersPanel() { document.getElementById('ordOverlay')?.classList.remove('open'); }
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (document.getElementById('ordPayOverlay')?.classList.contains('open')) closePaymentMethods();
  else if (document.getElementById('ordOverlay')?.classList.contains('open')) closeOrdersPanel();
});

const ORD_ENDED = {
  completed: 'Completed', cancelled: 'Cancelled', expired: 'Ran out',
};
const ORD_WHY = {
  buyer_cancelled: 'the buyer cancelled', not_available: 'you didn\'t have it', not_paid: 'not paid', dealer_cancelled: 'you cancelled',
  sold_elsewhere: 'sold at your table first', not_confirmed: 'not confirmed in time', auto_completed: 'delivered',
};

function _ordCardsHTML(o) {
  const cards = o.cards || [];
  return cards.map(c => `<div class="mh-card">${c.stock_code ? `<span class="mh-code">${_mkEsc(c.stock_code)}</span>` : ''}`
    + `<span class="mh-title">${_mkEsc(c.title || 'Card')}</span><span class="mh-price">${c.price_cents != null ? _mkMoney(c.price_cents) : ''}</span></div>`).join('');
}
function _ordTotalLine(o) {
  const ship = o.fulfillment === 'ship'
    ? (o.shipping_cents == null ? ' + shipping (you set it)' : o.shipping_cents ? ` + ${_mkMoney(o.shipping_cents)} shipping` : ' · free shipping') : '';
  return `${_mkMoney(o.subtotal_cents)}${ship}${o.from_offer ? ' · agreed in an offer' : ''}`;
}
function _ordDeliveryHTML(o) {
  if (o.fulfillment === 'ship') {
    const a = o.ship_to || {};
    return `<div class="ord-addr"><b>Ship to</b> ${_mkEsc([a.name, a.line1, a.line2, `${a.city || ''}, ${a.state || ''} ${a.postal || ''}`].filter(Boolean).join(', '))}</div>`;
  }
  const s = o.pickup_show;
  return `<div class="ord-addr"><b>Pickup</b> ${s ? _mkEsc(s.name) + (s.table_number ? ` · your table ${_mkEsc(s.table_number)}` : '') : 'arrange with the buyer'}</div>`;
}

function _ordRenderPanel() {
  const ov = document.getElementById('ordOverlay');
  if (!ov) return;
  const confirm = ordToConfirm();
  const unpaid = _ordOrders.filter(o => o.status === 'awaiting_payment');
  const toShip = _ordOrders.filter(o => o.status === 'paid' && o.fulfillment === 'ship');
  const waiting = _ordOrders.filter(o => o.status === 'shipped' || (o.status === 'paid' && o.fulfillment !== 'ship'));
  const ended = _ordOrders.filter(o => !ORD_OPEN.includes(o.status));
  const noPay = !(_ordPay && (_ordPay.methods || []).length);
  const head = o => `<div class="mh-head"><b>${_mkEsc(o.buyer_name || 'A buyer')} · ${_mkEsc(_ordTotalLine(o))}</b>`;
  const contact = o => `<div class="mh-contact">${typeof mhContactHTML === 'function' ? mhContactHTML(o.buyer_contact) : _mkEsc(o.buyer_contact || '')}</div>`
    + (o.buyer_note ? `<div class="mh-note">“${_mkEsc(o.buyer_note)}”</div>` : '');
  const id = o => _mkEsc(o.id);

  const confirmHTML = confirm.map(o => `
    <div class="mh-hold ord-order" data-order="${id(o)}">
      ${head(o)}<span class="mh-left">confirm by ${_mkEsc(_ordWhen(o.confirm_by))} · ${_ordMinutesLeft(o.confirm_by)} min</span></div>
      ${_ordCardsHTML(o)}${_ordDeliveryHTML(o)}${contact(o)}
      ${o.fulfillment === 'ship' && o.shipping_cents == null ? `<label class="mo-counter-label ord-ship">Shipping you'll charge ($)
        <input type="text" inputmode="decimal" autocomplete="off" id="ordShip_${id(o)}" placeholder="0 for free"></label>` : ''}
      <div class="mo-err" id="ordErr_${id(o)}" role="alert"></div>
      <div class="mh-actions">
        <button class="btn btn-primary" type="button" onclick="ordConfirm('${id(o)}', this)">I have it · confirm</button>
        <button class="btn btn-ghost" type="button" onclick="ordCancel('${id(o)}', 'not_available', this)">Not available</button>
      </div>
      <div class="mo-line">Confirming tells ${_mkEsc(o.buyer_name || 'the buyer')} how to pay you${o.fulfillment === 'local_pickup' ? ' (or they can pay at pickup)' : ''}. "Not available" takes the card off the marketplace.</div>
    </div>`).join('');

  const unpaidHTML = unpaid.map(o => `
    <div class="mh-hold ord-order" data-order="${id(o)}">
      ${head(o)}<span class="mh-left">pay by ${_mkEsc(_ordWhen(o.pay_by))}</span></div>
      ${_ordCardsHTML(o)}${_ordDeliveryHTML(o)}${contact(o)}
      <div class="mo-line">Total ${_mkEsc(_mkMoney(o.total_cents))}. Mark it paid once the money is in your account${o.fulfillment === 'local_pickup' ? ', or when they pay you at the table' : ''}.</div>
      <div class="ord-paid-row">
        <select class="show-input" id="ordMethod_${id(o)}" aria-label="How they paid">${['Venmo', 'PayPal', 'Cash App', 'Zelle', 'Cash', 'Card', 'Other']
          .map(m => `<option>${m}</option>`).join('')}</select>
        ${o.fulfillment === 'local_pickup'
          ? `<button class="btn btn-primary" type="button" onclick="ordPaid('${id(o)}', true, this)">Paid &amp; picked up</button>
             <button class="btn btn-ghost" type="button" onclick="ordPaid('${id(o)}', false, this)">Paid</button>`
          : `<button class="btn btn-primary" type="button" onclick="ordPaid('${id(o)}', false, this)">Mark paid</button>`}
      </div>
      <div class="mo-err" id="ordErr_${id(o)}" role="alert"></div>
      <div class="mh-actions"><button class="btn btn-ghost" type="button" onclick="ordCancel('${id(o)}', 'not_paid', this)">They didn't pay · cancel</button></div>
    </div>`).join('');

  const shipHTML = toShip.map(o => `
    <div class="mh-hold ord-order" data-order="${id(o)}">
      ${head(o)}<span class="mh-left">paid ${_mkEsc(_ordWhen(o.paid_at))}</span></div>
      ${_ordCardsHTML(o)}${_ordDeliveryHTML(o)}
      <form class="mo-counter" onsubmit="ordShip(event, '${id(o)}')">
        <label class="mo-counter-label" style="flex:0 1 7rem">Carrier
          <select name="carrier" class="show-input" style="margin:0;min-height:44px">${['USPS', 'UPS', 'FedEx', 'Other'].map(c => `<option>${c}</option>`).join('')}</select></label>
        <label class="mo-counter-label">Tracking number<input name="tracking" type="text" autocomplete="off" required></label>
        <button class="btn btn-primary" type="submit">Shipped</button>
        <div class="mo-err" role="alert"></div>
      </form>
    </div>`).join('');

  const waitingHTML = waiting.map(o => `
    <div class="mh-hold">
      ${head(o)}<span class="mh-left">${o.status === 'shipped' ? `shipped${o.carrier ? ' · ' + _mkEsc(o.carrier) : ''} ${_mkEsc(o.tracking_number || '')}` : 'paid · waiting for pickup'}</span></div>
      ${_ordCardsHTML(o)}
      ${o.status === 'paid' && o.fulfillment === 'local_pickup' ? `<div class="mh-actions"><button class="btn btn-primary" type="button" onclick="ordPaid('${id(o)}', true, this)">Picked up</button></div>` : ''}
    </div>`).join('');

  const endedHTML = ended.map(o => `
    <div class="mh-hold mh-ended">
      ${head(o)}<span class="mh-left">${_mkEsc(ORD_ENDED[o.status] || 'Ended')}${ORD_WHY[o.end_reason] ? ' · ' + _mkEsc(ORD_WHY[o.end_reason]) : ''}</span></div>
      ${_ordCardsHTML(o)}
    </div>`).join('');

  ov.innerHTML = `
    <div class="modal" style="max-width:540px;text-align:left">
      <div class="modal-header">
        <div><div class="modal-player" id="ordTitle">Orders</div>
        <div class="mh-sub">Buyers who tapped Buy Now. Confirm you still have the card, they pay you directly, then mark it paid. CardShow takes no fee.</div></div>
        <button class="modal-close" type="button" onclick="closeOrdersPanel()" aria-label="Close">✕</button>
      </div>
      <div class="modal-body">
        <div class="or-summary">${noPay ? '<b>Add how buyers pay you</b> so they can pay as soon as you confirm. ' : _mkEsc('Buyers pay you by ' + _ordPayText()) + '. '}
          <button type="button" class="mk-link" onclick="openPaymentMethods()">${noPay ? 'Add payment methods' : 'Change'}</button></div>
        ${confirm.length ? `<div class="mh-section">To confirm</div>${confirmHTML}` : ''}
        ${toShip.length ? `<div class="mh-section">To ship</div>${shipHTML}` : ''}
        ${unpaid.length ? `<div class="mh-section">Waiting for payment</div>${unpaidHTML}` : ''}
        ${waiting.length ? `<div class="mh-section">Paid</div>${waitingHTML}` : ''}
        ${!confirm.length && !unpaid.length && !toShip.length && !waiting.length ? '<p class="mh-empty">No open orders.</p>' : ''}
        ${ended.length ? `<div class="mh-section">Ended this week</div>${endedHTML}` : ''}
        <p class="mh-help">An order not confirmed in time (2 hours, or 15 minutes while you're at a show) is cancelled and the card goes back on sale. Missed confirmations count against your standing on CardShow.</p>
      </div>
    </div>`;
}

const ORD_ERR = {
  expired: 'That order ran out.', not_awaiting: 'That order already moved on. Reloading.', not_open: 'That order is already closed. Reloading.',
  unavailable: 'The card isn\'t reserved for this order any more (sold or taken down).', shipping_required: 'Enter the shipping you\'ll charge (0 for free).',
  bad_shipping: 'Shipping must be $0 to $1,000.', missing_tracking: 'Enter the tracking number.', not_found: 'That order is gone.',
};

async function _ordNotify(orderId) {
  try {
    const { data } = await db.auth.getSession();
    const t = data && data.session && data.session.access_token;
    if (!t) return;
    fetch('/.netlify/functions/order-notify-now', { method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: JSON.stringify({ order_id: orderId }) }).catch(() => {});
  } catch (_) {}
}

async function _ordCall(btn, fn, args, errId) {
  if (typeof _mkNeedSignal === 'function' && _mkNeedSignal()) return null;
  if (btn) btn.disabled = true;
  const errEl = errId ? document.getElementById(errId) : null;
  if (errEl) errEl.textContent = '';
  try {
    const { data, error } = await db.rpc(fn, args);
    if (error) throw error;
    if (data && data.error) {
      const msg = ORD_ERR[data.error] || 'Couldn\'t do that. Try again.';
      if (errEl) errEl.textContent = msg; else showToast(msg, '#f59e0b');
      if (!['shipping_required', 'bad_shipping', 'missing_tracking'].includes(data.error)) await ordLoad({ quiet: true });
      return null;
    }
    return data || {};
  } catch (e) {
    console.warn('[orders]', fn, e);
    showToast('Couldn\'t reach CardShow. Check your signal and try again.', '#ef4444');
    return null;
  } finally { if (btn) btn.disabled = false; }
}

async function ordConfirm(orderId, btn) {
  const o = _ordOrders.find(x => x.id === orderId);
  if (!o) return;
  let ship = null;
  const shipEl = document.getElementById('ordShip_' + orderId);
  if (shipEl) {
    ship = _ordCents(shipEl.value);
    if (!(ship >= 0 && ship <= 100000)) { document.getElementById('ordErr_' + orderId).textContent = ORD_ERR.shipping_required; return; }
  }
  if (o.fulfillment === 'ship' && !(_ordPay && (_ordPay.methods || []).length)) {
    if (!confirm('You haven\'t added how buyers pay you yet, so the buyer will be told to contact you to pay. Confirm anyway?')) { openPaymentMethods(); return; }
  }
  const r = await _ordCall(btn, 'confirm_order', { p_order_id: orderId, p_shipping_cents: ship }, 'ordErr_' + orderId);
  if (!r) return;
  showToast(`Confirmed. ${o.buyer_name || 'The buyer'} has until ${_ordWhen(r.pay_by)} to pay you.`);
  _ordNotify(orderId);
  await ordLoad({ quiet: true });
}

async function ordCancel(orderId, reason, btn) {
  const o = _ordOrders.find(x => x.id === orderId);
  if (!o) return;
  const q = reason === 'not_available'
    ? `Cancel ${o.buyer_name || 'this buyer'}'s order because you don't have it? The card comes off the marketplace and they get an email.`
    : `Cancel ${o.buyer_name || 'this buyer'}'s order because they didn't pay? The card goes back on sale and they get an email.`;
  if (!confirm(q)) return;
  const r = await _ordCall(btn, 'dealer_cancel_order', { p_order_id: orderId, p_reason: reason });
  if (!r) return;
  (o.listing_ids || []).forEach(id => { const c = inventory.find(x => x._dbId === id); if (c) c.ListingStatus = reason === 'not_available' ? 'delisted' : 'active'; });
  if (typeof _mkAfterChange === 'function') _mkAfterChange();
  showToast('Order cancelled.');
  _ordNotify(orderId);
  await ordLoad({ quiet: true });
}

// The cards as the server now has them (sold, price, payment), so the Report and stats show the sale.
async function _ordRefreshCards(ids) {
  try {
    const { data } = await db.from('inventory').select('id, status, listing_status, sold_price, payment_method, sold_date, sold_time').in('id', ids);
    // mark_order_paid() doesn't set sold_time, so write it here in the same format as Sell Drawer sales
    // ("01:25 PM"); otherwise the Report's Time column is blank after a reload.
    const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const noTime = (data || []).filter(r => r.status === 'Sold' && !r.sold_time).map(r => r.id);
    if (noTime.length) {
      const { error } = await db.from('inventory').update({ sold_time: stamp }).in('id', noTime);
      if (error) console.warn('[orders] sold_time', error.message);
    }
    (data || []).forEach(row => {
      const c = inventory.find(x => x._dbId === row.id);
      if (!c) return;
      c.Status = row.status; c.ListingStatus = row.listing_status;
      c.SoldPrice = row.sold_price != null ? Number(row.sold_price) : c.SoldPrice;
      c.PaymentMethod = row.payment_method || c.PaymentMethod;
      if (row.sold_date) c.SoldDate = row.sold_date;
      c.SoldTime = row.sold_time || (noTime.includes(row.id) ? stamp : c.SoldTime);
    });
  } catch (e) { console.warn('[orders] refresh cards', e); }
  if (typeof _mkAfterChange === 'function') _mkAfterChange();
  if (typeof updateStats === 'function') updateStats();
  if (typeof updateReport === 'function') try { updateReport(); } catch (_) {}
  if (typeof gtcrScheduleReconcile === 'function') gtcrScheduleReconcile();
}

async function ordPaid(orderId, pickedUp, btn) {
  const o = _ordOrders.find(x => x.id === orderId);
  if (!o) return;
  const method = document.getElementById('ordMethod_' + orderId)?.value || null;
  const r = await _ordCall(btn, 'mark_order_paid', { p_order_id: orderId, p_payment_method: method, p_picked_up: !!pickedUp }, 'ordErr_' + orderId);
  if (!r) return;
  showToast(r.status === 'completed' ? 'Sold and picked up. Order complete.'
    : o.fulfillment === 'ship' ? 'Marked paid. Ship it and add the tracking number here.' : 'Marked paid.');
  _ordNotify(orderId);
  await _ordRefreshCards(o.listing_ids || []);
  await ordLoad({ quiet: true });
}

async function ordShip(e, orderId) {
  e.preventDefault();
  const f = e.target;
  const err = f.querySelector('.mo-err');
  const tracking = f.elements.tracking.value.trim();
  if (tracking.length < 4) { err.textContent = ORD_ERR.missing_tracking; return; }
  if (typeof _mkNeedSignal === 'function' && _mkNeedSignal()) return;
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true; err.textContent = '';
  try {
    const { data, error } = await db.rpc('ship_order', { p_order_id: orderId, p_carrier: f.elements.carrier.value, p_tracking: tracking });
    if (error) throw error;
    if (data && data.error) { err.textContent = ORD_ERR[data.error] || 'Couldn\'t save. Try again.'; return; }
    showToast('Shipped. The buyer gets the tracking number by email.');
    _ordNotify(orderId);
    await ordLoad({ quiet: true });
  } catch (ex) {
    console.warn('[orders] ship', ex);
    err.textContent = 'Couldn\'t save. Check your signal and try again.';
  } finally { btn.disabled = false; }
}

// ── How buyers pay you ──
const ORD_PAY_KINDS = [
  { kind: 'venmo', label: 'Venmo', ph: '@your-venmo' },
  { kind: 'paypal', label: 'PayPal', ph: 'paypal.me/yourname' },
  { kind: 'cashapp', label: 'Cash App', ph: '$cashtag' },
  { kind: 'zelle', label: 'Zelle', ph: 'email or phone' },
  { kind: 'link', label: 'Payment link', ph: 'https://…' },
  { kind: 'other', label: 'Other', ph: 'e.g. Cash at my table' },
];
function _ordPayText() {
  const m = (_ordPay && _ordPay.methods) || [];
  return m.map(x => (ORD_PAY_KINDS.find(k => k.kind === x.kind)?.label || x.kind)).join(', ');
}
function openPaymentMethods() {
  const ov = _ordOverlay('ordPayOverlay', 'ordPayTitle');
  const cur = {};
  ((_ordPay && _ordPay.methods) || []).forEach(m => { if (!cur[m.kind]) cur[m.kind] = m.value; });
  ov.innerHTML = `
    <div class="modal" style="max-width:460px;text-align:left">
      <div class="modal-header">
        <div><div class="modal-player" id="ordPayTitle">How buyers pay you</div>
        <div class="mh-sub">Shown to a buyer once you confirm their order, with the amount filled in where the app allows. Money goes straight to you; CardShow never touches it.</div></div>
        <button class="modal-close" type="button" onclick="closePaymentMethods()" aria-label="Close">✕</button>
      </div>
      <form class="modal-body" id="ordPayForm" onsubmit="savePaymentMethods(event)">
        ${ORD_PAY_KINDS.map(k => `<label class="or-row"><span class="or-label">${k.label}</span>
          <input type="text" class="show-input ord-pay-input" name="${k.kind}" autocomplete="off" placeholder="${_mkEsc(k.ph)}" value="${_mkEsc(cur[k.kind] || '')}"></label>`).join('')}
        <label class="or-row"><span class="or-label">Note to buyers</span>
          <input type="text" class="show-input ord-pay-input" name="note" maxlength="200" placeholder="e.g. Put your order # in the note" value="${_mkEsc((_ordPay && _ordPay.note) || '')}"></label>
        <div class="mo-err" id="ordPayErr" role="alert"></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" onclick="closePaymentMethods()">Cancel</button>
          <button type="submit" class="btn btn-primary" id="ordPaySave">Save</button>
        </div>
      </form>
    </div>`;
  ov.classList.add('open');
}
function closePaymentMethods() { document.getElementById('ordPayOverlay')?.classList.remove('open'); }
async function savePaymentMethods(e) {
  e.preventDefault();
  const f = document.getElementById('ordPayForm');
  const methods = ORD_PAY_KINDS.map(k => ({ kind: k.kind, value: f.elements[k.kind].value.trim() })).filter(m => m.value);
  const err = document.getElementById('ordPayErr');
  if (typeof _mkNeedSignal === 'function' && _mkNeedSignal()) return;
  const btn = document.getElementById('ordPaySave');
  btn.disabled = true; err.textContent = '';
  try {
    const { data, error } = await db.rpc('set_payment_methods', { p_methods: methods, p_note: f.elements.note.value.trim() || null });
    if (error) throw error;
    if (data && data.error) {
      const label = ORD_PAY_KINDS.find(k => k.kind === data.kind)?.label;
      err.textContent = data.error === 'bad_method' && label ? `Check your ${label}: that doesn't look right.` : 'Couldn\'t save. Try again.';
      return;
    }
    _ordPay = { methods: data.methods || [], note: f.elements.note.value.trim() || null };
    closePaymentMethods();
    showToast(_ordPay.methods.length ? 'Saved. Buyers see these when you confirm their order.' : 'Payment methods cleared.');
    if (document.getElementById('ordOverlay')?.classList.contains('open')) _ordRenderPanel();
  } catch (ex) {
    console.warn('[orders] payment methods', ex);
    err.textContent = /set_payment_methods|PGRST202|schema cache/i.test(ex.message || '') ? 'Orders are still being set up.' : 'Couldn\'t save. Check your signal and try again.';
  } finally { btn.disabled = false; }
}
