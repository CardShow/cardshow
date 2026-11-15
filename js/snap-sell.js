// ════════════════════════════════════════════════════════════════════════════
// Snap & Sell, Phase 1: capture now, resolve later (see CLAUDE.md "Snap & Sell").
//
// At the table the dealer takes an optional photo of the items and of the
// payment, types the total and taps Save. Nothing waits on the network or on
// identification: the sale is written to this phone (IndexedDB, Show Mode's
// store) and replayed through Show Mode's outbox. Card details are added later
// from "Needs details".
//
// Rules:
//   * The total the dealer typed is the sale's GMV. One ledger row
//     (show_floor_transactions, source 'snap', api_eligible = false) carries it.
//   * Payment photos are private (sale-photos bucket, owner-only) and are never
//     sent to any identification or vision call. NEVER put a sale photo, cost
//     or payment method in a share card, caption or buyer/organizer view.
//   * Item prices split from a lot total are 'allocated' (estimates), never comps.
//
// Loaded after js/show-mode.js and js/cost-tracking.js. Names start with ss.
// ════════════════════════════════════════════════════════════════════════════

const SS_PAYMENTS = ['Cash', 'Card', 'Venmo', 'Other'];
const SS_UNDO_WINDOW_MS = 10 * 60 * 1000;    // void_snap_sale() enforces the same
const SS_PHOTO_MAX_EDGE = 1600;
const SS_SEARCH_LIMIT = 30;

let _ssSales = new Map();         // clientSaleId → record (this seller's snap sales)
let _ssLoadedFor = null;
let _ssMissing = false;           // snap tables not installed → ledger row only, photos stay on the phone
let _ssStorageOk = true;          // false → IndexedDB unavailable, sales live in memory only
const _ssMemBlobs = new Map();    // photo id → Blob, when IndexedDB isn't available
const _ssUrls = new Map();        // photo id → object URL / signed URL
let _ssDraft = null;
let _ssEdit = null;               // Needs details editor state
let _ssToastTimer = null;

function _ssEsc(v) { return typeof smEsc === 'function' ? smEsc(v) : String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function _ssMoney(n) {
  const v = Number(n) || 0;
  return '$' + (Math.round(v) === v ? v.toLocaleString() : v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}
function _ssParseMoney(v) {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : Math.round(n * 100) / 100;
}
function _ssLocalDate(ms) { return new Date(ms).toLocaleDateString('en-CA'); }
function _ssClock(ms) { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function _ssWhen(ms) {
  const d = new Date(ms);
  const today = _ssLocalDate(Date.now()) === _ssLocalDate(ms);
  return (today ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'short' })) + ' ' + _ssClock(ms);
}

// ── Local store ─────────────────────────────────────────────────────────────
async function _ssPut(rec) {
  _ssSales.set(rec.clientSaleId, rec);
  if (!_ssStorageOk) return;
  try { await smStore.put('snapSales', rec); }
  catch (e) {
    console.warn('[snap] IndexedDB unavailable — keeping sales in memory', e);
    _ssStorageOk = false;
    (rec.photos || []).forEach(p => { if (p.blob) _ssMemBlobs.set(p.id, p.blob); });
    _ssRenderStorageBanner();
  }
}
async function _ssDelete(id) {
  _ssSales.delete(id);
  try { await smStore.del('snapSales', id); } catch (_) {}
}
function _ssBlob(p) { return p.blob || _ssMemBlobs.get(p.id) || null; }

function ssMine() {
  return [..._ssSales.values()].filter(r => r.seller === currentSeller && !r.voided)
    .sort((a, b) => b.capturedAt - a.capturedAt);
}
function ssNeedsDetails() { return ssMine().filter(r => r.status === 'needs_review'); }
function ssSyncingCount() { return ssMine().filter(r => !r.synced).length; }
// The part of a snap sale not already shown by a linked inventory card (which
// is marked sold with its own price). Totals stay equal to what was entered.
function ssRemainder(rec) {
  const linked = (rec.items || []).filter(i => i.inventoryId).reduce((s, i) => s + (Number(i.price) || 0), 0);
  return Math.max(0, Math.round((Number(rec.amount) - linked) * 100) / 100);
}
function _ssLabel(rec) {
  if (rec.status === 'needs_review') return rec.isLot ? `Lot${rec.count ? ' · ' + rec.count + ' cards' : ''}` : 'Snap sale';
  const unlinked = (rec.items || []).filter(i => !i.inventoryId);
  if (unlinked.length) return unlinked.map(i => i.title).join(', ');
  return rec.status === 'unresolved_lot' ? `Lot${rec.count ? ' · ' + rec.count + ' cards' : ''}` : 'Snap sale';
}

// ── Load on login ───────────────────────────────────────────────────────────
async function ssLoad(handle) {
  _ssLoadedFor = handle;
  try {
    const local = await smStore.all('snapSales');
    local.filter(r => r.seller === handle).forEach(r => _ssSales.set(r.clientSaleId, r));
  } catch (_) { _ssStorageOk = false; }
  if (typeof db === 'undefined' || !navigator.onLine) { _ssAfterChange(); return; }
  try {
    const res = await db.from('snap_sales').select('*').is('voided_at', null)
      .order('captured_at', { ascending: false }).limit(500);
    if (res.error) {
      if (_smIsMissingTable(res)) _ssMissing = true;
      else console.warn('[snap] load failed', res.error.message);
      _ssAfterChange();
      return;
    }
    if (currentSeller !== handle) return;
    const rows = res.data || [];
    const keys = rows.map(r => r.client_sale_id);
    const [items, photos] = keys.length ? await Promise.all([
      dbSelectIn(ids => db.from('transaction_items').select('*').in('sale_key', ids), keys),
      dbSelectIn(ids => db.from('transaction_photos').select('*').in('sale_key', ids), keys),
    ]) : [{ data: [] }, { data: [] }];
    rows.forEach(row => {
      const local = _ssSales.get(row.client_sale_id);
      if (local && !local.synced) return;          // the phone's copy is newer
      const rec = Object.assign(local || {}, {
        clientSaleId: row.client_sale_id, seller: handle, showId: row.show_id,
        amount: Number(row.amount), payment: row.payment_method || '', count: row.item_count_hint || null,
        isLot: !!row.is_lot, note: row.note || '', capturedAt: Date.parse(row.captured_at),
        status: row.capture_status, transactionId: row.transaction_id, synced: true, voided: false,
        createdAt: Date.parse(row.created_at),
      });
      rec.items = (items.data || []).filter(i => i.sale_key === row.client_sale_id).map(i => ({
        id: i.id, inventoryId: i.inventory_id, title: i.card_title || 'Card', price: i.price != null ? Number(i.price) : null,
        basis: i.price_basis, status: i.identification_status,
      }));
      const localPhotos = (local && local.photos) || [];
      rec.photos = (photos.data || []).filter(p => p.sale_key === row.client_sale_id).map(p => {
        const lp = localPhotos.find(x => x.id === p.id);
        return { id: p.id, kind: p.kind, path: p.storage_path, uploaded: true, blob: lp && lp.blob };
      });
      _ssSales.set(rec.clientSaleId, rec);
    });
    // Sales undone from another phone.
    [..._ssSales.values()].forEach(r => {
      if (r.seller === handle && r.synced && !_ssMissing && !keys.includes(r.clientSaleId)) _ssDelete(r.clientSaleId);
    });
  } catch (e) { console.warn('[snap] load failed', e); }
  _ssAfterChange();
}

function ssReset() {
  _ssSales = new Map();
  _ssLoadedFor = null;
  _ssDraft = null;
  _ssEdit = null;
  _ssUrls.forEach(u => { if (u.startsWith('blob:')) URL.revokeObjectURL(u); });
  _ssUrls.clear();
  _ssHideToast();
}

function _ssAfterChange() {
  if (typeof smRefresh === 'function') smRefresh();
  if (typeof updateReport === 'function' && currentRole === 'seller') updateReport();
}

// ── Entry points ────────────────────────────────────────────────────────────
function ssStart(from) {
  _ssDraft = null;
  _smLogEvent('snap_opened', { from: from || 'home' });
  smGo('/snap');
}
// Classic Sell / Add menu: Snap & Sell lives in Show Mode (offline queue, undo).
function ssOpenFromClassic() {
  if (typeof smIsEnabled === 'function' && !smIsEnabled()) { showToast('Snap & Sell needs Show Mode', 'gold'); return; }
  const id = _smDefaultShowId() || (_smAuthorizedShows()[0] || {}).id;
  if (id) { openShowMode(id, '/snap'); return; }
  smOpenFromNav();
}

// ── Capture screen (#/sm/<show>/snap) ───────────────────────────────────────
function _ssLastPayment() {
  try { const v = localStorage.getItem('ssLastPay:' + currentSeller); return SS_PAYMENTS.includes(v) ? v : 'Cash'; }
  catch (_) { return 'Cash'; }
}

function ssRenderCapture() {
  if (!_ssDraft) _ssDraft = { amount: '', payment: _ssLastPayment(), count: 1, isLot: false, note: '', photos: {}, openedAt: Date.now() };
  const d = _ssDraft;
  const tile = kind => {
    const p = d.photos[kind];
    const label = kind === 'items' ? 'Items' : 'Payment';
    const inner = p && p.url
      ? `<img src="${_ssEsc(p.url)}" alt="${label} photo">`
      : (p && p.busy ? '<span class="sm-spinner" aria-hidden="true"></span>' : `${_smIcon('image')}<span>${label}</span>`);
    return `<label class="ss-tile ${p && p.url ? 'ss-tile--done' : ''}">
      <input type="file" accept="image/*" capture="environment" class="sm-sr-only" onchange="ssPhoto(this, '${kind}')" aria-label="${label} photo">
      ${inner}${p && p.url ? `<span class="ss-tile-tag">${label} · retake</span>` : ''}
    </label>`;
  };
  _smView().innerHTML = `
    <div class="sm-topbar">
      <button class="sm-icon-btn" onclick="ssCancel()" aria-label="Back">${_smIcon('back')}</button>
      <div class="sm-title">Snap &amp; Sell</div>
      <span style="width:44px"></span>
    </div>
    <div id="ssStorageBanner"></div>
    <div class="ss-tiles">${tile('items')}${tile('payment')}</div>
    <p class="sm-helper" style="margin-top:6px">Photos are optional. The payment photo is private to you.</p>
    <label class="ss-amount">
      <span class="sm-section-label">Sold for</span>
      <span class="ss-amount-box"><span aria-hidden="true">$</span>
        <input id="ssAmount" inputmode="decimal" autocomplete="off" placeholder="0" value="${_ssEsc(d.amount)}" oninput="ssDraftInput()" aria-label="Sale total in dollars"></span>
    </label>
    <div class="sm-section-label" style="margin-top:14px">Paid with</div>
    <div class="sm-chip-grid" role="group" aria-label="Payment method">
      ${SS_PAYMENTS.map(p => `<button class="sm-chip sm-chip--big" data-sspay="${p}" aria-pressed="${d.payment === p}" onclick="ssSetPayment('${p}')">${p}</button>`).join('')}
    </div>
    <div id="ssCountRow" style="display:${d.photos.items ? '' : 'none'}">
      <div class="sm-section-label" style="margin-top:14px">How many cards?</div>
      <div class="ss-count">
        <button class="sm-chip sm-chip--big" onclick="ssStep(-1)" aria-label="One fewer card">−</button>
        <span class="ss-count-num" id="ssCountNum" aria-live="polite">${d.count}</span>
        <button class="sm-chip sm-chip--big" onclick="ssStep(1)" aria-label="One more card">+</button>
        <button class="sm-chip sm-chip--big" id="ssLotChip" aria-pressed="${d.isLot || d.count > 1}" onclick="ssToggleLot()">Lot</button>
      </div>
    </div>
    <label class="sm-field"><span>Note (optional)</span>
      <input id="ssNote" autocomplete="off" value="${_ssEsc(d.note)}" oninput="ssDraftInput()"></label>
    <button class="sm-confirm-btn" id="ssSaveBtn" onclick="ssSave()"></button>
    <p class="sm-helper">Card details can wait. Find this sale later under Needs details.</p>`;
  _ssRenderStorageBanner();
  _ssUpdateSave();
  setTimeout(() => document.getElementById('ssAmount')?.focus(), 30);
}

function _ssRenderStorageBanner() {
  const el = document.getElementById('ssStorageBanner');
  if (el) el.innerHTML = _ssStorageOk ? '' : '<div class="sm-notice sm-notice--offline" role="alert">Not saved offline on this phone. Keep the app open until your sales sync.</div>';
}

function ssDraftInput() {
  if (!_ssDraft) return;
  _ssDraft.amount = document.getElementById('ssAmount')?.value || '';
  _ssDraft.note = document.getElementById('ssNote')?.value || '';
  _ssUpdateSave();
}
function _ssUpdateSave() {
  const btn = document.getElementById('ssSaveBtn');
  if (!btn || !_ssDraft) return;
  const amt = _ssParseMoney(_ssDraft.amount);
  btn.innerHTML = `${_smIcon('check')} Save sale${amt ? ' · ' + _ssMoney(amt) : ''}`;
  btn.disabled = !(amt > 0);
}
function ssSetPayment(p) {
  _ssDraft.payment = p;
  document.querySelectorAll('[data-sspay]').forEach(b => b.setAttribute('aria-pressed', b.dataset.sspay === p));
}
function ssStep(n) {
  const d = _ssDraft;
  d.count = Math.max(1, Math.min(99, d.count + n));
  document.getElementById('ssCountNum').textContent = d.count;
  document.getElementById('ssLotChip').setAttribute('aria-pressed', d.isLot || d.count > 1);
}
function ssToggleLot() {
  _ssDraft.isLot = !(_ssDraft.isLot || _ssDraft.count > 1);
  if (!_ssDraft.isLot && _ssDraft.count > 1) _ssDraft.count = 1;
  document.getElementById('ssCountNum').textContent = _ssDraft.count;
  document.getElementById('ssLotChip').setAttribute('aria-pressed', _ssDraft.isLot);
}

async function _ssCompress(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (_) { bmp = await createImageBitmap(file); }
  const canvas = _smDrawScaled(bmp, 0, 0, bmp.width, bmp.height, SS_PHOTO_MAX_EDGE);   // re-encoding strips EXIF
  if (bmp.close) bmp.close();
  return _smCanvasBlob(canvas, 0.82);
}

function ssPhoto(input, kind) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file || !_ssDraft) return;
  const d = _ssDraft;
  const old = d.photos[kind];
  if (old && old.url) URL.revokeObjectURL(old.url);
  const p = { id: _smUuid(), kind, busy: true };
  d.photos[kind] = p;
  p.ready = _ssCompress(file).then(blob => {
    p.blob = blob; p.busy = false; p.url = URL.createObjectURL(blob);
    if (_smScreen === 'snap' && _ssDraft === d) { ssDraftInput(); ssRenderCapture(); }
  }).catch(e => {
    console.warn('[snap] photo failed', e);
    if (d.photos[kind] === p) delete d.photos[kind];
    showToast('Couldn\'t read that photo — try again', 'var(--danger)');
    if (_smScreen === 'snap' && _ssDraft === d) ssRenderCapture();
  });
  if (_smScreen === 'snap') { ssDraftInput(); ssRenderCapture(); }
}

function ssCancel() {
  if (_ssDraft) Object.values(_ssDraft.photos).forEach(p => { if (p.url) URL.revokeObjectURL(p.url); });
  _ssDraft = null;
  smGoHome();
}

async function ssSave() {
  const d = _ssDraft;
  if (!d) return;
  ssDraftInput();
  const amount = _ssParseMoney(d.amount);
  if (!(amount > 0)) { showToast('Enter the sale total', 'var(--danger)'); return; }
  const btn = document.getElementById('ssSaveBtn');
  if (btn) btn.disabled = true;
  await Promise.all(Object.values(d.photos).map(p => p.ready).filter(Boolean));
  const now = Date.now();
  const hasItems = !!(d.photos.items && d.photos.items.blob);
  const rec = {
    clientSaleId: _smUuid(), seller: currentSeller, showId: _smShowId,
    amount, payment: d.payment, count: hasItems ? d.count : null,
    isLot: !!(d.isLot || (hasItems && d.count > 1)), note: d.note.trim(),
    capturedAt: now, status: 'needs_review', items: [], synced: false, voided: false,
    photos: Object.values(d.photos).filter(p => p.blob).map(p => ({ id: p.id, kind: p.kind, blob: p.blob, uploaded: false })),
  };
  Object.values(d.photos).forEach(p => { if (p.url && p.blob) _ssUrls.set(p.id, p.url); });
  await _ssPut(rec);
  await smEnqueue({ type: 'snap_sale', clientSaleId: rec.clientSaleId });
  try { localStorage.setItem('ssLastPay:' + currentSeller, d.payment); } catch (_) {}
  _smLogEvent('snap_sale_saved', {
    hasItemsPhoto: hasItems, hasPaymentPhoto: !!(d.photos.payment && d.photos.payment.blob), isLot: rec.isLot,
    count: rec.count, msFromOpen: now - d.openedAt, queuedOffline: !navigator.onLine,
  });
  _ssDraft = null;
  if (navigator.vibrate) navigator.vibrate(30);
  smGoHome();
  _ssShowToast(rec);
}

function _ssHideToast() {
  clearTimeout(_ssToastTimer);
  const t = document.getElementById('ssToast');
  if (t) t.remove();
}
function _ssShowToast(rec) {
  _ssHideToast();
  const t = document.createElement('div');
  t.id = 'ssToast';
  t.className = 'sm-toast';
  t.setAttribute('role', 'status');
  t.innerHTML = `<span>Sale saved · ${_ssMoney(rec.amount)} · details later</span>
    <button class="sm-toast-btn" onclick="ssUndo('${_ssEsc(rec.clientSaleId)}')">Undo</button>`;
  document.getElementById('showModeRoot').appendChild(t);
  _ssToastTimer = setTimeout(_ssHideToast, 6000);
}

function ssCanUndo(rec) {
  return !!rec && rec.status === 'needs_review' && !rec.voided && (Date.now() - rec.capturedAt) < SS_UNDO_WINDOW_MS;
}

async function ssUndo(id) {
  _ssHideToast();
  const rec = _ssSales.get(id);
  if (!rec || !ssCanUndo(rec)) { showToast('Too late to undo — it\'s been more than 10 minutes', 'var(--danger)'); return; }
  let pending = null;
  try { pending = (await smStore.all('outbox')).find(o => o.type === 'snap_sale' && o.clientSaleId === id) || null; } catch (_) {}
  if (pending && !_smDraining) {
    await smStore.del('outbox', pending.seq);     // never left the phone
    await _ssDelete(id);
  } else {
    rec.voided = true;
    await _ssPut(rec);
    await smEnqueue({ type: 'snap_void', clientSaleId: id });
  }
  _smLogEvent('snap_sale_undone', { secondsAfterSale: Math.round((Date.now() - rec.capturedAt) / 1000) });
  showToast('Sale undone');
  _ssAfterChange();
  if (_smScreen === 'needs') smGo('/needs', true);
}

// ── Outbox ops ──────────────────────────────────────────────────────────────
async function ssRunOp(op) {
  switch (op.type) {
    case 'snap_sale':    return _ssOpSale(op);
    case 'snap_void':    return _ssOpVoid(op);
    case 'snap_resolve': return _ssOpResolve(op);
    default:             return 'done';
  }
}

function _ssLedgerRow(rec, uid, show) {
  let city = show.city || null, state = show.state || null;
  if (!city && show.location && typeof parseShowLocation === 'function') ({ city, state } = parseShowLocation(show.location));
  return {
    sold_at: new Date(rec.capturedAt).toISOString(),
    sold_price: rec.amount,
    asking_price: null,
    payment_method: rec.payment || 'Other',
    inventory_id: null,
    card_title: rec.isLot ? `Lot${rec.count ? ' · ' + rec.count + ' cards' : ''} (Snap & Sell)` : 'Snap & Sell sale',
    item_type: rec.isLot ? 'lot' : 'card',
    seller_id: uid, seller_handle: rec.seller,
    show_id: rec.showId, show_name: show.name, show_date: _showDateISO(show),
    show_location: show.location || null, show_city: city, show_state: state,
    table_number: (show.tables && show.tables[rec.seller]) || null,
    source: 'snap', client_sale_id: rec.clientSaleId,
    // A lot total is not a card price: keep it out of comps (v_comp_sales).
    is_test: false, api_eligible: false, data_version: 1,
  };
}

// The show the sale was made at. Usually loaded; after an offline reload the
// outbox can run before shows{} is, so read the row itself. null = show gone.
async function _ssShowFor(id) {
  if (shows[id]) return shows[id];
  const res = await db.from('shows').select('id, name, date, start_date, location, city, state').eq('id', id).maybeSingle();
  if (res.error) return _smIsNetworkError(res) ? 'retry' : null;
  const r = res.data;
  return r ? { id: r.id, name: r.name, date: r.date, startDate: r.start_date, location: r.location, city: r.city, state: r.state, tables: {} } : null;
}

async function _ssInsertLedger(rec, uid) {
  const show = await _ssShowFor(rec.showId);
  if (show === 'retry') return 'retry';
  if (!show) { console.warn('[snap] show not found — sale kept without a ledger row', rec.showId); return null; }
  const row = _ssLedgerRow(rec, uid, show);
  const insert = () => db.from('show_floor_transactions').insert(row).select('id').maybeSingle();
  let res = await insert();
  // Before the snap migration the source check doesn't allow 'snap'.
  if (res.error && res.error.code === '23514' && /source/i.test(res.error.message || '')) { row.source = 'manual'; res = await insert(); }
  if (res.error && /client_sale_id/.test(res.error.message || '') && res.error.code !== '23505') { delete row.client_sale_id; res = await insert(); }
  if (res.error && res.error.code === '23505') {   // already written by an earlier try
    const again = await db.from('show_floor_transactions').select('id').eq('client_sale_id', rec.clientSaleId).maybeSingle();
    if (again.error) return _smIsNetworkError(again) ? 'retry' : null;
    return (again.data && again.data.id) || null;
  }
  if (res.error) {
    if (_smIsNetworkError(res)) return 'retry';
    console.warn('[snap] ledger row failed', res.error.message);
    return null;
  }
  return (res.data && res.data.id) || null;
}

async function _ssOpSale(op) {
  let rec = _ssSales.get(op.clientSaleId);
  if (!rec) { try { rec = await smStore.get('snapSales', op.clientSaleId); } catch (_) {} }
  if (!rec || rec.synced) return 'done';
  const uid = await _smGetUid();
  if (!uid) return 'retry';

  if (!_ssMissing && !rec.headerSaved) {
    const res = await db.from('snap_sales').upsert({
      client_sale_id: rec.clientSaleId, show_id: rec.showId || null, amount: rec.amount,
      payment_method: rec.payment || null, is_lot: rec.isLot, item_count_hint: rec.count || null,
      note: rec.note || null, captured_at: new Date(rec.capturedAt).toISOString(),
    }, { onConflict: 'client_sale_id', ignoreDuplicates: true });
    if (res.error) {
      if (_smIsNetworkError(res)) return 'retry';
      if (_smIsMissingTable(res)) { _ssMissing = true; console.info('[snap] snap tables not installed — ledger row only, photos stay on this phone'); }
      else console.warn('[snap] header failed', res.error.message);
    } else { rec.headerSaved = true; await _ssPut(rec); }
  }

  if (rec.showId && !rec.transactionId) {
    const tx = await _ssInsertLedger(rec, uid);
    if (tx === 'retry') return 'retry';
    if (tx) { rec.transactionId = tx; await _ssPut(rec); }
  }
  if (rec.transactionId && rec.headerSaved && !rec.txLinked) {
    const res = await db.from('snap_sales').update({ transaction_id: rec.transactionId, updated_at: new Date().toISOString() })
      .eq('client_sale_id', rec.clientSaleId);
    if (res.error && _smIsNetworkError(res)) return 'retry';
    if (!res.error) { rec.txLinked = true; await _ssPut(rec); }
  }

  if (!_ssMissing && rec.headerSaved) {
    for (const p of rec.photos || []) {
      if (p.uploaded) continue;
      const blob = _ssBlob(p);
      if (!blob) continue;
      const path = `${uid}/${rec.clientSaleId}/${p.id}.jpg`;
      const up = await db.storage.from('sale-photos').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
      if (up.error && !/exists|duplicate/i.test(up.error.message || '')) {
        if (!navigator.onLine || /fetch|network/i.test(up.error.message || '')) return 'retry';
        console.warn('[snap] photo upload failed — kept on this phone', up.error.message);
        continue;
      }
      const meta = await db.from('transaction_photos')
        .upsert({ id: p.id, sale_key: rec.clientSaleId, kind: p.kind, storage_path: path }, { onConflict: 'id', ignoreDuplicates: true });
      if (meta.error) {
        if (_smIsNetworkError(meta)) return 'retry';
        console.warn('[snap] photo row failed', meta.error.message);
        continue;
      }
      p.uploaded = true;
      p.path = path;
      // Keep the items photo for the inbox; the payment photo leaves the phone once it's stored.
      if (p.kind === 'payment') { delete p.blob; _ssMemBlobs.delete(p.id); }
      await _ssPut(rec);
    }
  }
  rec.synced = true;
  await _ssPut(rec);
  _ssAfterChange();
  return 'done';
}

async function _ssOpVoid(op) {
  if (_ssMissing) { await _ssDelete(op.clientSaleId); return 'done'; }
  const res = await db.rpc('void_snap_sale', { p_client_sale_id: op.clientSaleId });
  if (res.error) {
    if (_smIsNetworkError(res)) return 'retry';
    console.warn('[snap] undo failed', res.error.message);
    return 'done';
  }
  const out = res.data || {};
  if (out.error === 'undo_window_expired' || out.error === 'resolved') {
    const rec = _ssSales.get(op.clientSaleId);
    if (rec) { rec.voided = false; await _ssPut(rec); }
    showToast(out.error === 'resolved' ? 'That sale already has its details, so it can\'t be undone' : 'Too late to undo — it\'s been more than 10 minutes', 'var(--danger)');
  } else {
    await _ssDelete(op.clientSaleId);
  }
  _ssAfterChange();
  return 'done';
}

async function _ssOpResolve(op) {
  const p = op.payload;
  if (!_ssMissing) {
    const ids = p.items.map(i => i.id);
    let del = db.from('transaction_items').delete().eq('sale_key', p.clientSaleId);
    if (ids.length) del = del.not('id', 'in', `(${ids.join(',')})`);
    let res = await del;
    if (res.error) { if (_smIsNetworkError(res)) return 'retry'; if (_smIsMissingTable(res)) _ssMissing = true; }
    if (!_ssMissing && ids.length) {
      res = await db.from('transaction_items').upsert(p.items.map(i => ({
        id: i.id, sale_key: p.clientSaleId, transaction_id: p.transactionId || null, inventory_id: i.inventoryId || null,
        card_title: i.title, card_ref: i.cardRef || null, price: i.price, price_basis: i.basis, identification_status: i.status,
        updated_at: new Date().toISOString(),
      })), { onConflict: 'id' });
      if (res.error) { if (_smIsNetworkError(res)) return 'retry'; console.warn('[snap] items failed', res.error.message); }
    }
    if (!_ssMissing) {
      res = await db.from('snap_sales').update({ capture_status: p.status, updated_at: new Date().toISOString() })
        .eq('client_sale_id', p.clientSaleId);
      if (res.error) { if (_smIsNetworkError(res)) return 'retry'; console.warn('[snap] status failed', res.error.message); }
    }
  }
  // Linked inventory cards are sold. No ledger row: the snap sale's row already holds the total.
  for (const s of p.sold || []) {
    let row = { status: 'Sold', sold_price: s.price, payment_method: s.payment, sold_date: s.soldDate, sold_time: s.soldTime, sale_notes: 'Snap & Sell', updated_at: new Date().toISOString() };
    let res = await db.from('inventory').update(row).eq('id', s.inventoryId).neq('status', 'Sold');
    if (res.error && typeof _isMissingScanColumnError === 'function' && _isMissingScanColumnError(res.error)) {
      delete row.sold_date;
      res = await db.from('inventory').update(row).eq('id', s.inventoryId).neq('status', 'Sold');
    }
    if (res.error) { if (_smIsNetworkError(res)) return 'retry'; console.warn('[snap] mark sold failed', res.error.message); }
  }
  if ((p.sold || []).length && typeof gtcrScheduleReconcile === 'function') gtcrScheduleReconcile();
  return 'done';
}

// ── Lot price split (suggestion only; 'allocated') ──────────────────────────
// Typed prices are kept. The rest of the total is split by each card's asking
// price (even split when none have one; a card with no price weighs the
// average), rounded down to the cent; the
// leftover cents go to the highest-value card. Allocated + typed = total
// whenever the typed prices don't exceed it.
function ssAllocate(amount, items) {
  const total = Math.round((Number(amount) || 0) * 100);
  const typed = items.reduce((s, i) => s + (i.typed != null ? Math.round(i.typed * 100) : 0), 0);
  const open = items.map((i, idx) => ({ i, idx })).filter(x => x.i.typed == null);
  const out = items.map(i => (i.typed != null ? Math.round(i.typed * 100) : 0));
  let left = Math.max(0, total - typed);
  if (open.length) {
    // A card with no asking price (not in inventory) weighs the average of the others.
    const known = open.map(x => Number(x.i.weight) || 0).filter(w => w > 0);
    const avg = known.length ? known.reduce((s, w) => s + w, 0) / known.length : 1;
    const weights = open.map(x => (Number(x.i.weight) > 0 ? Number(x.i.weight) : avg));
    const sumW = weights.reduce((s, w) => s + w, 0);
    const shares = open.map((_, k) => sumW > 0 ? weights[k] / sumW : 1 / open.length);
    let given = 0;
    open.forEach((x, k) => { out[x.idx] = Math.floor(left * shares[k]); given += out[x.idx]; });
    let top = 0;
    open.forEach((x, k) => { if (weights[k] > weights[top]) top = k; });
    out[open[top].idx] += left - given;
  }
  return out.map(c => c / 100);
}

// ── Needs details (#/sm/<show>/needs and /needs/<id>) ───────────────────────
function _ssPhotoUrl(p) {
  if (_ssUrls.has(p.id)) return _ssUrls.get(p.id);
  const blob = _ssBlob(p);
  if (blob) { const u = URL.createObjectURL(blob); _ssUrls.set(p.id, u); return u; }
  return null;
}
async function _ssSignPhotos(recs) {
  const need = [];
  recs.forEach(r => (r.photos || []).forEach(p => { if (p.path && !_ssPhotoUrl(p)) need.push(p); }));
  if (!need.length || typeof db === 'undefined' || !navigator.onLine) return false;
  const res = await db.storage.from('sale-photos').createSignedUrls(need.map(p => p.path), 3600);
  if (res.error) return false;
  (res.data || []).forEach((s, k) => { if (s && s.signedUrl) _ssUrls.set(need[k].id, s.signedUrl); });
  return true;
}
function _ssThumb(rec) {
  const p = (rec.photos || []).find(x => x.kind === 'items');
  const url = p && _ssPhotoUrl(p);
  return url ? `<img class="sm-thumb" src="${_ssEsc(url)}" alt="">` : `<div class="sm-thumb ss-thumb-empty" aria-hidden="true">${_smIcon('image')}</div>`;
}

// Recent-sales rows for Show Mode home: { t, html }.
function ssHomeRows() {
  return ssMine().filter(r => r.status === 'needs_review' || ssRemainder(r) > 0).map(r => {
    const badge = r.status === 'needs_review'
      ? '<span class="sm-badge sm-badge--warn">Needs details</span>' : '';
    const sync = r.synced ? '' : '<span class="sm-sync">Syncing</span>';
    const undo = ssCanUndo(r) ? `<button class="sm-row-btn sm-row-btn--ghost" onclick="event.stopPropagation();ssUndo('${_ssEsc(r.clientSaleId)}')">Undo</button>` : '';
    return { t: r.capturedAt, html: `<div class="sm-row ss-row" role="button" tabindex="0" onclick="ssOpenEditor('${_ssEsc(r.clientSaleId)}')">
      ${_ssThumb(r)}
      <div class="sm-row-body">
        <div class="sm-row-title">${_ssEsc(_ssLabel(r))} ${badge}</div>
        <div class="sm-row-meta">${[_ssMoney(r.status === 'needs_review' ? r.amount : ssRemainder(r)), r.payment, _smRelTime(new Date(r.capturedAt))].filter(Boolean).map(_ssEsc).join(' · ')} ${sync}</div>
      </div>${undo}
    </div>` };
  });
}
// Today's totals for the home stats: sales and money not already in inventory.
function ssTodayTotals() {
  const today = _ssLocalDate(Date.now());
  const rows = ssMine().filter(r => _ssLocalDate(r.capturedAt) === today && ssRemainder(r) > 0);
  return { count: rows.length, total: rows.reduce((s, r) => s + ssRemainder(r), 0) };
}

function ssRenderNeedsList() {
  const list = ssNeedsDetails();
  const byShow = new Map();
  list.forEach(r => { const k = r.showId || ''; if (!byShow.has(k)) byShow.set(k, []); byShow.get(k).push(r); });
  const groups = [...byShow.entries()].map(([showId, rows]) => `
    <div class="sm-section-label">${_ssEsc((shows[showId] && shows[showId].name) || 'Off-show')}</div>
    <div class="sm-list">${rows.map(r => `
      <button class="sm-row sm-row--button" onclick="ssOpenEditor('${_ssEsc(r.clientSaleId)}')">
        ${_ssThumb(r)}
        <span class="sm-row-body">
          <span class="sm-row-title">${_ssMoney(r.amount)} · ${_ssEsc(r.payment || '')}</span>
          <span class="sm-row-meta">${_ssEsc([_ssWhen(r.capturedAt), r.count ? r.count + ' card' + (r.count > 1 ? 's' : '') : (r.isLot ? 'Lot' : ''), r.note].filter(Boolean).join(' · '))} ${r.synced ? '' : '<span class="sm-sync">Syncing</span>'}</span>
        </span>${_smIcon('chev', 'sm-chev')}
      </button>`).join('')}</div>`).join('');
  _smView().innerHTML = `
    <div class="sm-topbar">
      <button class="sm-icon-btn" onclick="smGoHome()" aria-label="Back">${_smIcon('back')}</button>
      <div class="sm-title">Needs details</div>
      <span style="width:44px"></span>
    </div>
    ${list.length ? groups : '<div class="sm-empty">All caught up. Snap & Sell sales waiting for card details show up here.</div>'}`;
  _ssSignPhotos(list).then(changed => { if (changed && _smScreen === 'needs' && !_ssEdit) ssRenderNeedsList(); });
}

function ssOpenEditor(id) { smGo('/needs/' + encodeURIComponent(id)); }

function ssRenderEditor(id) {
  const rec = _ssSales.get(id);
  if (!rec || rec.voided) { _ssEdit = null; smGo('/needs', true); return; }
  if (!_ssEdit || _ssEdit.id !== id) {
    _ssEdit = {
      id, query: '', showPayment: false, unknownText: '', addingUnknown: false,
      items: (rec.items || []).map(i => ({ id: i.id, inventoryId: i.inventoryId, title: i.title,
        typed: i.basis === 'observed' ? i.price : null, status: i.status })),
    };
  }
  _ssDrawEditor();
  _ssSignPhotos([rec]).then(changed => { if (changed && _smScreen === 'needs' && _ssEdit && _ssEdit.id === id) _ssDrawEditor(); });
}

function _ssEditCard(item) { return item.inventoryId ? inventory.find(c => c._dbId === item.inventoryId) : null; }
function _ssEditPrices(rec) {
  return ssAllocate(rec.amount, _ssEdit.items.map(i => ({ typed: i.typed, weight: (_ssEditCard(i) || {}).Price })));
}

function _ssDrawEditor() {
  const rec = _ssSales.get(_ssEdit.id);
  if (!rec) return;
  const e = _ssEdit;
  const itemsPhoto = (rec.photos || []).find(p => p.kind === 'items');
  const payPhoto = (rec.photos || []).find(p => p.kind === 'payment');
  const itemsUrl = itemsPhoto && _ssPhotoUrl(itemsPhoto);
  const prices = _ssEditPrices(rec);
  const sum = Math.round(prices.reduce((s, v) => s + v, 0) * 100) / 100;
  const mismatch = e.items.length && Math.abs(sum - rec.amount) >= 0.01;
  const rows = e.items.map((it, k) => {
    const card = _ssEditCard(it);
    const code = card && typeof stockCodeChipHTML === 'function' ? stockCodeChipHTML(card) : (card && card.StockCode ? `<span class="stock-chip">${_ssEsc(card.StockCode)}</span>` : '');
    const meta = card ? [card.Year, card['Set '], _smGradeLabel(card), card.Price ? 'asking ' + _ssMoney(card.Price) : ''].filter(Boolean).join(' · ') : 'Not in your inventory';
    return `<div class="sm-row ss-item">
      <div class="sm-row-body">
        <div class="sm-row-title">${_ssEsc(it.title)} ${code}</div>
        <div class="sm-row-meta">${_ssEsc(meta)}</div>
      </div>
      <label class="ss-price"><span class="sm-sr-only">Price for ${_ssEsc(it.title)}</span>
        <span aria-hidden="true">$</span><input inputmode="decimal" autocomplete="off" value="${it.typed != null ? _ssEsc(it.typed) : ''}" placeholder="${_ssEsc(prices[k].toFixed(2))}" oninput="ssEditPrice(${k}, this.value)" aria-describedby="ssPriceHelp"></label>
      <button class="sm-icon-btn" onclick="ssEditRemove(${k})" aria-label="Remove ${_ssEsc(it.title)}">${_smIcon('close')}</button>
    </div>`;
  }).join('');
  const results = e.query.trim() ? _ssSearch(e.query) : [];
  const resultsHTML = e.query.trim() ? (results.length ? results.slice(0, SS_SEARCH_LIMIT).map(c => `
      <button class="sm-row sm-row--button" onclick="ssEditAddCard('${_ssEsc(c._dbId)}')">
        <span class="sm-row-body"><span class="sm-row-title">${_ssEsc(c.Player || c['Card Title'] || 'Card')} ${c.StockCode ? `<span class="stock-chip">${_ssEsc(c.StockCode)}</span>` : ''}</span>
        <span class="sm-row-meta">${_ssEsc([c.Year, c['Set '], _smCardNum(c.Number), _smGradeLabel(c)].filter(Boolean).join(' · '))}</span></span>
        <span class="sm-row-price">${_ssMoney(c.Price)}</span>
      </button>`).join('') : '<div class="sm-empty">No unsold cards match that.</div>') : '';

  _smView().innerHTML = `
    <div class="sm-topbar">
      <button class="sm-icon-btn" onclick="ssCloseEditor()" aria-label="Back">${_smIcon('back')}</button>
      <div class="sm-title">Sale details</div>
      <span style="width:44px"></span>
    </div>
    ${itemsUrl ? `<a href="${_ssEsc(itemsUrl)}" target="_blank" rel="noopener" class="ss-photo"><img src="${_ssEsc(itemsUrl)}" alt="Photo of the items sold"></a>`
      : (itemsPhoto ? '<div class="sm-empty">Items photo is loading…</div>' : '<div class="sm-empty">No items photo for this sale.</div>')}
    <div class="ss-meta">
      <div class="ss-meta-amount">${_ssMoney(rec.amount)}</div>
      <div class="sm-row-meta">${_ssEsc([rec.payment, _ssWhen(rec.capturedAt), shows[rec.showId] && shows[rec.showId].name, rec.count ? rec.count + ' cards' : ''].filter(Boolean).join(' · '))}</div>
      ${rec.note ? `<div class="sm-row-meta">Note: ${_ssEsc(rec.note)}</div>` : ''}
      ${payPhoto ? (e.showPayment && _ssPhotoUrl(payPhoto)
        ? `<img class="ss-pay-photo" src="${_ssEsc(_ssPhotoUrl(payPhoto))}" alt="Payment photo"><button class="sm-link sm-link--dark" onclick="ssTogglePayment()">Hide payment photo</button>`
        : '<button class="sm-link sm-link--dark" onclick="ssTogglePayment()">Show payment photo</button>') : ''}
    </div>
    <div class="sm-section-label" style="margin-top:14px">Cards in this sale</div>
    <div class="sm-list">${rows || '<div class="sm-empty">No cards added yet.</div>'}</div>
    <p class="sm-helper" id="ssPriceHelp">Blank prices are an estimate split from the total.</p>
    <div class="ss-total ${mismatch ? 'ss-total--warn' : ''}" role="status">${e.items.length ? `Cards ${_ssMoney(sum)} of ${_ssMoney(rec.amount)}${mismatch ? ' — doesn\'t match the total. The total you entered is kept.' : ''}` : ''}</div>
    <div class="sm-section-label" style="margin-top:14px">Add a card</div>
    <div class="sm-search sm-search--light">${_smIcon('search')}
      <input id="ssEditSearch" autocomplete="off" placeholder="Search your cards or a stock code (S12)" value="${_ssEsc(e.query)}" oninput="ssEditSearch(this.value)" aria-label="Search your cards"></div>
    <div class="sm-list sm-list--light" id="ssEditResults">${resultsHTML}</div>
    ${e.addingUnknown ? `
      <div class="sm-form-row" style="align-items:flex-end">
        <label class="sm-field"><span>What was it? (optional)</span><input id="ssUnknown" autocomplete="off" value="${_ssEsc(e.unknownText)}" oninput="_ssEdit.unknownText=this.value"></label>
        <button class="sm-chip sm-chip--big" onclick="ssEditAddUnknown()">Add</button>
      </div>`
      : '<button class="sm-sec-btn" onclick="ssEditStartUnknown()">' + _smIcon('plus') + 'Card not in my inventory</button>'}
    <button class="sm-confirm-btn" onclick="ssEditComplete()" ${e.items.length ? '' : 'disabled'}>${_smIcon('check')} Mark complete</button>
    <button class="sm-sec-btn" style="margin-top:10px" onclick="ssEditKeepLot()">Keep as lot (skip card details)</button>
    ${ssCanUndo(rec) ? `<button class="sm-link sm-link--dark" onclick="ssUndo('${_ssEsc(rec.clientSaleId)}')">Undo this sale</button>` : ''}`;
}

function _ssSearch(q) {
  const taken = new Set(_ssEdit.items.map(i => i.inventoryId).filter(Boolean));
  const codeKey = typeof stockCodeQueryKey === 'function' ? stockCodeQueryKey(q) : '';
  const avail = getSellerInventory().filter(c => c.Status !== 'Sold' && c._dbId && !taken.has(c._dbId));
  const exact = codeKey ? avail.filter(c => c.StockCode && stockCodeKey(c.StockCode) === codeKey) : [];
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const text = avail.filter(c => !exact.includes(c) && words.every(w => [c['Card Title'], c.Player, c.Year, c['Set '], c.Number,
    c['Parallel/Variant'], c.Grader, c.Grade, c['Cert #'], c.StockCode].map(v => String(v ?? '').toLowerCase()).join(' ').includes(w)));
  return exact.concat(text);
}

function ssEditSearch(v) {
  _ssEdit.query = v;
  const box = document.getElementById('ssEditResults');
  if (!box) return;
  _ssDrawEditor();
  const input = document.getElementById('ssEditSearch');
  if (input) { input.focus(); input.setSelectionRange(v.length, v.length); }
}
function ssEditAddCard(dbId) {
  const c = inventory.find(x => x._dbId === dbId);
  if (!c) return;
  _ssEdit.items.push({ id: _smUuid(), inventoryId: dbId, title: c.Player || c['Card Title'] || 'Card', typed: null, status: 'confirmed' });
  _ssEdit.query = '';
  _ssDrawEditor();
}
function ssEditStartUnknown() { _ssEdit.addingUnknown = true; _ssDrawEditor(); setTimeout(() => document.getElementById('ssUnknown')?.focus(), 30); }
function ssEditAddUnknown() {
  const t = (_ssEdit.unknownText || '').trim();
  _ssEdit.items.push({ id: _smUuid(), inventoryId: null, title: t || 'Unidentified card', typed: null, status: 'manual' });
  _ssEdit.addingUnknown = false;
  _ssEdit.unknownText = '';
  _ssDrawEditor();
}
function ssEditRemove(k) { _ssEdit.items.splice(k, 1); _ssDrawEditor(); }
function ssEditPrice(k, v) {
  _ssEdit.items[k].typed = String(v).trim() === '' ? null : _ssParseMoney(v);
  // Update placeholders and the total without redrawing (keeps focus).
  const rec = _ssSales.get(_ssEdit.id);
  const prices = _ssEditPrices(rec);
  document.querySelectorAll('.ss-price input').forEach((inp, i) => { inp.placeholder = prices[i].toFixed(2); });
  const sum = Math.round(prices.reduce((s, x) => s + x, 0) * 100) / 100;
  const mismatch = Math.abs(sum - rec.amount) >= 0.01;
  const t = document.querySelector('.ss-total');
  if (t) { t.classList.toggle('ss-total--warn', mismatch); t.textContent = `Cards ${_ssMoney(sum)} of ${_ssMoney(rec.amount)}${mismatch ? ' — doesn\'t match the total. The total you entered is kept.' : ''}`; }
}
function ssTogglePayment() { _ssEdit.showPayment = !_ssEdit.showPayment; _ssDrawEditor(); }
function ssCloseEditor() { _ssEdit = null; smGo('/needs'); }

async function _ssEditFinish(status) {
  const rec = _ssSales.get(_ssEdit.id);
  if (!rec) return;
  if (status === 'complete' && !_ssEdit.items.length) { showToast('Add the cards in this sale first', 'var(--danger)'); return; }
  const prices = _ssEditPrices(rec);
  const soldDate = _ssLocalDate(rec.capturedAt);
  const soldTime = new Date(rec.capturedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const items = _ssEdit.items.map((it, k) => {
    const card = _ssEditCard(it);
    return {
      id: it.id, inventoryId: it.inventoryId || null, title: it.title, price: prices[k],
      basis: it.typed != null ? 'observed' : 'allocated', status: it.inventoryId ? 'confirmed' : 'manual',
      cardRef: card ? { player: card.Player || null, year: card.Year || null, card_set: card['Set '] || null, card_number: card.Number || null,
        parallel: card['Parallel/Variant'] || null, grader: card.Grader || null, grade: card.Grade || null, cert_number: card['Cert #'] || null,
        stock_code: card.StockCode || null } : null,
    };
  });
  const sold = [];
  items.forEach(i => {
    if (!i.inventoryId) return;
    const card = inventory.find(c => c._dbId === i.inventoryId);
    if (!card || card.Status === 'Sold') return;
    card.Status = 'Sold';
    card.SoldPrice = i.price;
    card.PaymentMethod = rec.payment;
    card.SoldDate = soldDate;
    card.SoldTime = soldTime;
    card.SaleNotes = 'Snap & Sell';
    card._snapSaleId = rec.clientSaleId;
    sold.push({ inventoryId: i.inventoryId, price: i.price, payment: rec.payment, soldDate, soldTime });
  });
  rec.items = items.map(({ cardRef, ...rest }) => rest);
  rec.status = status;
  await _ssPut(rec);
  await smEnqueue({ type: 'snap_resolve', payload: { clientSaleId: rec.clientSaleId, transactionId: rec.transactionId || null, status, items, sold } });
  _smLogEvent('snap_sale_resolved', { status, items: items.length, linked: sold.length, observed: items.filter(i => i.basis === 'observed').length });
  _ssEdit = null;
  _smAfterInventoryChange();
  showToast(status === 'complete' ? 'Sale complete' : 'Kept as a lot');
  _ssAfterChange();
  smGo(ssNeedsDetails().length ? '/needs' : '', true);
}
function ssEditComplete() { return _ssEditFinish('complete'); }
function ssEditKeepLot() { return _ssEditFinish('unresolved_lot'); }

// ── Seller Report tab (classic) ─────────────────────────────────────────────
// Snap sales as report rows. Only the part not already shown by a linked
// inventory card, so the report total equals what the dealer entered.
function ssReportRows(showId) {
  if (currentRole !== 'seller') return [];
  return ssMine().filter(r => (!showId || r.showId === showId) && ssRemainder(r) > 0).map(r => ({
    Player: 'Snap & Sell', 'Card Title': _ssLabel(r) + (r.status === 'needs_review' ? ' · needs details' : ''),
    Price: 0, SoldPrice: ssRemainder(r), PaymentMethod: r.payment || 'Other',
    SoldDate: _ssLocalDate(r.capturedAt), SoldTime: _ssClock(r.capturedAt).replace(/\s+/g, ' ').toUpperCase(),
    _snap: true, _snapId: r.clientSaleId, _needsDetails: r.status === 'needs_review',
  }));
}

// Show Mode header pill: sales still on this phone.
function ssSyncPillHTML() {
  const n = ssSyncingCount();
  return n ? `<span class="sm-sync" role="status">${n} sale${n > 1 ? 's' : ''} syncing</span>` : '';
}
