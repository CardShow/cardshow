// ════════════════════════════════════════════════════════════════════════════
// Cost Tracking & Stock Codes — Phase 1 (see CLAUDE.md "Cost Tracking & Stock Codes")
//
// * Stock codes (S-12 graded, R-40 raw, B-3 sealed, L-1 lot, or the dealer's own)
//   live on inventory.stock_code. They're assigned by the assign_stock_codes()
//   RPC AFTER a card is saved, so a code never delays or blocks a save.
// * Cost lives only in inventory_costs / transaction_costs (owner-only RLS).
//   In memory: card.CostBasis, card.CostAcquiredAt, card.CostAcquiredFrom,
//   card.CostNotes. cardToDbRow() never writes them, so they can't reach
//   inventory, show_inventory or show_floor_transactions.
// * Every write is fire-and-forget. A network failure goes into Show Mode's
//   IndexedDB outbox (smEnqueue), which replays it in order when back online.
//   transaction_costs is keyed by the sale's client_sale_id, so a replay is
//   an upsert, never a duplicate.
//
// NEVER render cost or profit anywhere a buyer, organizer or share card can see.
// Loaded by app.html after js/show-mode.js.
// ════════════════════════════════════════════════════════════════════════════

let _costTablesMissing = false;   // migration not run → cost stays in memory only
let _stockCodesMissing = false;   // migration not run → no codes
let _costTrackingSeen  = false;   // this seller has entered a cost → offer "Add cost" after sales

function _costEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function costUuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ── Stock codes ──────────────────────────────────────────────────────────────
// Same normalization as the DB's generated stock_code_key.
function stockCodeKey(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

// "slab 12" → S12, "single 40" / "raw 40" → R40, "box 3" → B3, "lot 1" → L1.
// Word aliases only apply when a number follows.
function stockCodeQueryKey(q) {
  const s = String(q || '').toLowerCase()
    .replace(/\bslabs?\s*(?=\d)/g, 's')
    .replace(/\b(?:singles?|raw)\s*(?=\d)/g, 'r')
    .replace(/\b(?:box(?:es)?|sealed)\s*(?=\d)/g, 'b')
    .replace(/\b(?:lots?|bundles?)\s*(?=\d)/g, 'l');
  return stockCodeKey(s);
}

// S = numeric grade (the app's graded test), B = sealed, L = lot, R = everything else.
function stockCodePrefixFor(card) {
  if (!card) return 'R';
  if (card.item_type === 'sealed') return 'B';
  if (card.item_type === 'lot') return 'L';
  if (card.Grade != null && card.Grade !== '' && !isNaN(Number(card.Grade))) return 'S';
  return 'R';
}

function _costMyCards() {
  return (typeof inventory !== 'undefined' ? inventory : []).filter(c => c.Seller === currentSeller);
}

// A guess for the placeholder ("Auto: S-13"); the server picks the real one.
function stockCodeNextGuess(prefix) {
  const re = new RegExp('^' + prefix + '(\\d+)$');
  let max = 0;
  _costMyCards().forEach(c => { const m = stockCodeKey(c.StockCode).match(re); if (m) max = Math.max(max, +m[1]); });
  return `${prefix}-${max + 1}`;
}

// Another of this seller's cards already using this code (case/punctuation-insensitive).
function stockCodeFindDuplicate(code, exceptCard) {
  const key = stockCodeKey(code);
  if (!key) return null;
  return _costMyCards().find(c => c !== exceptCard && c.StockCode && stockCodeKey(c.StockCode) === key) || null;
}

function stockCodeChipHTML(card) {
  return (card && card.StockCode ? `<span class="stock-chip" title="Stock code">${_costEsc(card.StockCode)}</span>` : '')
    + (card && card.IdentificationStatus === 'unidentified' && card.Status !== 'Sold' ? '<span class="stock-chip im-needs-chip" title="From a show-log import. Edit the card to add its details; it goes live after that.">Needs details</span>' : '');
}

// ── Money ────────────────────────────────────────────────────────────────────
function costMoney(n) {
  const v = Number(n) || 0;
  return '$' + v.toLocaleString(undefined, { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
}
function costSigned(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return (v < 0 ? '−' : '+') + costMoney(Math.abs(v));
}
function costParse(v) {
  if (v == null) return null;
  const s = String(v).replace(/[$,\s]/g, '');
  if (s === '') return null;
  const n = parseFloat(s);
  return isNaN(n) || n < 0 ? null : Math.round(n * 100) / 100;
}
function costHas(card) { return !!card && card.CostBasis != null && !isNaN(Number(card.CostBasis)); }

// ── Load on login ────────────────────────────────────────────────────────────
async function costHydrate() {
  if (typeof db === 'undefined' || _costTablesMissing || !currentSeller) return;
  const seller = currentSeller;
  const { data, error } = await dbSelectAllPages(() =>
    db.from('inventory_costs').select('inventory_id, cost_basis, acquired_at, acquired_from, notes').order('inventory_id'));
  if (error) {
    if (_costIsMissingTable(error)) { _costTablesMissing = true; console.info('[cost] cost tables not installed — costs stay on this device for this session'); }
    else console.warn('[cost] load failed', error.message);
    return;
  }
  if (seller !== currentSeller) return;
  const byId = new Map((data || []).map(r => [r.inventory_id, r]));
  _costMyCards().forEach(c => {
    const r = c._dbId && byId.get(c._dbId);
    if (!r) return;
    c.CostBasis        = r.cost_basis != null ? Number(r.cost_basis) : null;
    c.CostAcquiredAt   = r.acquired_at || null;
    c.CostAcquiredFrom = r.acquired_from || null;
    c.CostNotes        = r.notes || null;
  });
  if ((data || []).some(r => r.cost_basis != null)) _costTrackingSeen = true;
}

// ── Writes ───────────────────────────────────────────────────────────────────
function _costIsMissingTable(e) {
  return !!e && (e.code === '42P01' || e.code === 'PGRST205' || /relation .* does not exist|could not find the table/i.test(e.message || ''));
}
function _costIsMissingFn(e) {
  return !!e && (e.code === 'PGRST202' || /could not find the function/i.test(e.message || ''));
}
function _costIsNetwork(res) {
  if (typeof _smIsNetworkError === 'function') return _smIsNetworkError(res);
  return !navigator.onLine;
}

// Runs one queued cost/code write. 'done' or 'retry' (network) — the same
// contract as Show Mode's outbox ops, which delegate here.
async function costRunOp(op) {
  if (typeof db === 'undefined') return 'done';
  let res;
  switch (op.type) {
    case 'cost_upsert':
      if (_costTablesMissing) return 'done';
      res = await db.from('inventory_costs').upsert(Object.assign({ inventory_id: op.inventoryId }, op.fields), { onConflict: 'inventory_id' });
      break;
    case 'sale_cost':
      if (_costTablesMissing) return 'done';
      res = await db.from('transaction_costs').upsert(op.row, { onConflict: 'client_sale_id' });
      break;
    case 'sale_cost_delete':
      if (_costTablesMissing) return 'done';
      res = await db.from('transaction_costs').delete().eq('client_sale_id', op.clientSaleId);
      break;
    case 'stock_codes':
      if (_stockCodesMissing) return 'done';
      res = await db.rpc('assign_stock_codes', { p_ids: op.ids });
      if (!res.error) _stockCodesApply(res.data, op);
      break;
    case 'stock_code_set':
      if (_stockCodesMissing) return 'done';
      res = await db.rpc('set_stock_code', { p_id: op.inventoryId, p_code: op.code || '' });
      if (!res.error) _stockCodeSetResult(res.data, op);
      break;
    default:
      return 'done';
  }
  if (res && res.error) {
    if (_costIsNetwork(res)) return 'retry';
    if (_costIsMissingTable(res.error)) { _costTablesMissing = true; console.info('[cost] cost tables not installed'); return 'done'; }
    if (_costIsMissingFn(res.error) || (op.type.startsWith('stock_code') && /stock_code/.test(res.error.message || '') && res.error.code === 'PGRST204')) {
      _stockCodesMissing = true; console.info('[cost] stock codes not installed'); return 'done';
    }
    console.warn('[cost]', op.type, 'failed:', res.error.message);
  }
  return 'done';
}

// Try now; on a network failure, queue in the outbox (replays when back online).
async function _costWrite(op) {
  let outcome;
  try { outcome = await costRunOp(op); }
  catch (e) { outcome = navigator.onLine ? 'done' : 'retry'; console.warn('[cost] write error', e); }
  if (outcome === 'retry') _costQueue(op);
}
function _costQueue(op) {
  if (typeof smEnqueue === 'function') smEnqueue(op);
  else console.warn('[cost] no offline queue — write dropped', op.type);
}

// Saves a card's private cost. Before the card has an id, the fields wait on
// the card (card._pendingCost) and costAfterInsert() writes them.
function costSave(card, fields) {
  if (!card) return;
  const f = {
    cost_basis:    fields.cost_basis    != null ? fields.cost_basis    : null,
    acquired_at:   fields.acquired_at   || null,
    acquired_from: fields.acquired_from || null,
    notes:         fields.notes         || null,
  };
  card.CostBasis        = f.cost_basis;
  card.CostAcquiredAt   = f.acquired_at;
  card.CostAcquiredFrom = f.acquired_from;
  card.CostNotes        = f.notes;
  if (f.cost_basis != null) _costTrackingSeen = true;
  if (!card._dbId) { card._pendingCost = f; return; }
  _costWrite({ type: 'cost_upsert', inventoryId: card._dbId, fields: f });
}

// Called once a card has a DB id (insertCardToDB, Show Mode add_item / new-item
// sale, CSV import). Writes a waiting cost and gives the card a stock code.
function costAfterInsert(card, id) {
  if (!card || !id) return;
  if (card._pendingCost) {
    const f = card._pendingCost; card._pendingCost = null;
    _costWrite({ type: 'cost_upsert', inventoryId: id, fields: f });
  }
  if (card._pendingStockCode) {
    const code = card._pendingStockCode; card._pendingStockCode = null;
    _costWrite({ type: 'stock_code_set', inventoryId: id, code, prev: '', fallbackAuto: true });
  } else if (!card.StockCode && card.Status !== 'Sold') {
    stockCodeQueueAssign(card, id);
  }
}

// Batches auto-assignment (bulk scan / CSV insert many cards at once) into one RPC.
let _stkPending = [];
let _stkTimer = null;
function stockCodeQueueAssign(card, id) {
  if (_stockCodesMissing) return;
  _stkPending.push({ card, id });
  clearTimeout(_stkTimer);
  _stkTimer = setTimeout(_stockCodeFlush, 400);
}
function _stockCodeFlush() {
  const items = _stkPending; _stkPending = [];
  if (!items.length) return;
  const order = c => { const i = inventory.indexOf(c); return i < 0 ? 1e9 : i; };
  items.sort((a, b) => order(a.card) - order(b.card));
  const ids = [...new Set(items.map(x => x.id))];
  for (let i = 0; i < ids.length; i += 200) _costWrite({ type: 'stock_codes', ids: ids.slice(i, i + 200) });
}

function _costCardById(id) { return inventory.find(c => c._dbId === id) || null; }

function _stockCodesApply(rows) {
  if (!Array.isArray(rows)) return 0;
  rows.forEach(r => { const c = _costCardById(r.id); if (c) c.StockCode = r.stock_code; });
  if (rows.length) _costRerender();
  return rows.length;
}

function _stockCodeSetResult(out, op) {
  const card = _costCardById(op.inventoryId);
  if (out && out.ok) { if (card) card.StockCode = out.stock_code || ''; _costRerender(); return; }
  const err = out && out.error;
  if (card) card.StockCode = op.prev || '';
  if (err === 'duplicate') {
    showToast(`${op.code} is already used${out.card_title ? ' by ' + out.card_title : ''}${op.fallbackAuto ? ' — gave it an automatic code' : ''}`, 'var(--danger)');
  } else if (err) {
    showToast(`Couldn't set code ${op.code} (${err})`, 'var(--danger)');
  }
  if (op.fallbackAuto && card && !card.StockCode) stockCodeQueueAssign(card, op.inventoryId);
  _costRerender();
}

// Sets (or clears, with '') a card's code from the Edit Card modal.
function stockCodeSet(card, code) {
  const prev = card.StockCode || '';
  card.StockCode = code;
  if (!card._dbId) { card._pendingStockCode = code; return; }
  _costWrite({ type: 'stock_code_set', inventoryId: card._dbId, code, prev });
}

// "Assign codes": every unsold card shown in the table that has no code, in table order.
// onlyCards (optional, seller dashboard v2 bulk bar): code just these cards, in this order.
async function assignStockCodesBulk(onlyCards) {
  if (_stockCodesMissing) { showToast('Stock codes aren\'t set up yet', 'gold'); return; }
  const order = Array.isArray(onlyCards) ? onlyCards
    : [...document.querySelectorAll('#inventoryBody .card-check')].map(cb => inventory[parseInt(cb.dataset.idx, 10)]);
  const cards = order.filter(c => c && c.Status !== 'Sold' && !c.StockCode && c._dbId);
  if (!cards.length) { showToast('Every unsold card shown already has a stock code'); return; }
  if (!confirm(`Give stock codes to ${cards.length} card${cards.length !== 1 ? 's' : ''}?\n\nSlabs get S-1, S-2…, raw singles R-1…, sealed B-1…, lots L-1…, continuing from your highest number.`)) return;
  const btn = document.getElementById('assignCodesBtn');
  if (btn) btn.disabled = true;
  let done = 0, failed = false;
  try {
    for (let i = 0; i < cards.length; i += 200) {
      const res = await db.rpc('assign_stock_codes', { p_ids: cards.slice(i, i + 200).map(c => c._dbId) });
      if (res.error) {
        if (_costIsMissingFn(res.error)) _stockCodesMissing = true;
        failed = true; console.warn('[cost] assign codes failed', res.error.message); break;
      }
      done += _stockCodesApply(res.data);
    }
  } catch (e) { failed = true; console.warn('[cost] assign codes error', e); }
  if (btn) btn.disabled = false;
  if (failed && !done) showToast(navigator.onLine ? 'Couldn\'t assign codes — try again' : 'No signal — try again when you\'re back online', 'var(--danger)');
  else showToast(`Stock codes added to ${done} card${done !== 1 ? 's' : ''}`);
}

function _costRerender() {
  if (currentRole !== 'seller') return;
  if (typeof applyInventoryFilters === 'function' && document.getElementById('inventoryBody')) applyInventoryFilters();
}

// ── Sales ────────────────────────────────────────────────────────────────────
// Copies the card's cost at the moment of sale into transaction_costs (keyed by
// clientSaleId). Editing the card's cost later never changes this copy.
// queue:true always goes through the outbox (Show Mode: keeps it after the sale op).
function costRecordSale(card, clientSaleId, opts) {
  if (!card || !clientSaleId) return;
  const o = opts || {};
  const price = Number(o.price != null ? o.price : card.SoldPrice) || 0;
  card._lastSale = { clientSaleId, showId: o.showId || null, price, soldAt: new Date().toISOString(), inventoryId: card._dbId || null };
  if (!costHas(card)) return;
  const op = { type: 'sale_cost', clientSaleId, row: _costSaleRow(card, Number(card.CostBasis)) };
  if (o.queue) _costQueue(op); else _costWrite(op);
}
function _costSaleRow(card, cost) {
  const s = card._lastSale;
  return {
    client_sale_id: s.clientSaleId,
    inventory_id:   card._dbId || s.inventoryId || null,
    show_id:        s.showId,
    sale_price:     s.price,
    cost_at_sale:   cost,
    sold_at:        s.soldAt,
  };
}
function costDeleteSale(clientSaleId) {
  if (clientSaleId) _costWrite({ type: 'sale_cost_delete', clientSaleId });
}

// " · Profit +$35" for a sale toast, or ''.
function costProfitSuffix(card, price) {
  if (!costHas(card)) return '';
  const p = (Number(price != null ? price : card.SoldPrice) || 0) - Number(card.CostBasis);
  return ` · ${p < 0 ? 'Loss' : 'Profit'} ${costSigned(p)}`;
}

// Show Mode sold screen line (dealer's own phone only).
function costSoldLineHTML(card) {
  if (costHas(card)) {
    const p = (Number(card.SoldPrice) || 0) - Number(card.CostBasis);
    return `<div class="sm-sold-profit ${p < 0 ? 'neg' : ''}">🔒 ${p < 0 ? 'Loss' : 'Profit'} ${costSigned(p)} <span>· cost ${costMoney(card.CostBasis)}</span></div>`;
  }
  if (_costTrackingSeen && card._lastSale) {
    return `<button class="sm-sold-addcost" onclick="costOpenQuick('${_costEsc(card._lastSale.clientSaleId)}')">🔒 Add cost</button>`;
  }
  return '';
}

// After a sale with no cost: "Sold $85 · Add cost" (only for sellers who track cost).
let _costBarTimer = null;
function costMaybePromptAdd(card) {
  if (!card || costHas(card) || !_costTrackingSeen || !card._lastSale) return;
  let bar = document.getElementById('costAddBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'costAddBar';
    bar.setAttribute('role', 'status');
    document.body.appendChild(bar);
  }
  bar.innerHTML = `<span>Sold ${costMoney(card._lastSale.price)}</span>
    <button type="button" class="cost-bar-btn" onclick="costOpenQuick('${_costEsc(card._lastSale.clientSaleId)}')">🔒 Add cost</button>
    <button type="button" class="cost-bar-x" aria-label="Dismiss" onclick="costHideBar()">✕</button>`;
  bar.classList.add('show');
  clearTimeout(_costBarTimer);
  _costBarTimer = setTimeout(costHideBar, 8000);
}
function costHideBar() {
  clearTimeout(_costBarTimer);
  const bar = document.getElementById('costAddBar');
  if (bar) bar.classList.remove('show');
}

let _costQuickCard = null;
function costOpenQuick(clientSaleId) {
  costHideBar();
  const card = inventory.find(c => c._lastSale && c._lastSale.clientSaleId === clientSaleId);
  if (!card) return;
  _costQuickCard = card;
  let ov = document.getElementById('costQuickOverlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'costQuickOverlay';
    ov.className = 'cost-quick-overlay';
    ov.innerHTML = `<div class="cost-quick" role="dialog" aria-modal="true" aria-labelledby="costQuickTitle">
        <div class="cost-quick-title" id="costQuickTitle">🔒 What did you pay?</div>
        <div class="cost-quick-sub" id="costQuickSub"></div>
        <div class="cost-input-wrap"><span>$</span><input id="costQuickInput" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00"></div>
        <div class="cost-private-note">Only you can see this.</div>
        <div class="cost-quick-actions">
          <button type="button" class="btn btn-primary" onclick="costSaveQuick()">Save</button>
          <button type="button" class="btn-modal-close" onclick="costCloseQuick()">Cancel</button>
        </div>
      </div>`;
    ov.addEventListener('click', e => { if (e.target === ov) costCloseQuick(); });
    ov.querySelector('#costQuickInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') costSaveQuick();
      if (e.key === 'Escape') costCloseQuick();
    });
    document.body.appendChild(ov);
  }
  ov.querySelector('#costQuickSub').textContent =
    `${card.StockCode ? card.StockCode + ' · ' : ''}${card['Card Title'] || card.Player || 'Card'} · sold ${costMoney(card._lastSale.price)}`;
  const input = ov.querySelector('#costQuickInput');
  input.value = '';
  ov.classList.add('open');
  setTimeout(() => input.focus(), 50);
}
function costCloseQuick() {
  const ov = document.getElementById('costQuickOverlay');
  if (ov) ov.classList.remove('open');
  _costQuickCard = null;
}
function costSaveQuick() {
  const card = _costQuickCard;
  const cost = costParse(document.getElementById('costQuickInput')?.value);
  if (!card) return costCloseQuick();
  if (cost == null) { showToast('Enter what you paid', 'var(--danger)'); return; }
  costSave(card, { cost_basis: cost, acquired_at: card.CostAcquiredAt, acquired_from: card.CostAcquiredFrom, notes: card.CostNotes });
  if (card._lastSale) _costWrite({ type: 'sale_cost', clientSaleId: card._lastSale.clientSaleId, row: _costSaleRow(card, cost) });
  costCloseQuick();
  const p = card._lastSale ? card._lastSale.price - cost : null;
  showToast(p == null ? 'Cost saved' : `Cost saved · ${p < 0 ? 'Loss' : 'Profit'} ${costSigned(p)}`);
  if (typeof _smShowId !== 'undefined' && _smShowId && typeof smRefresh === 'function') smRefresh();
  _costRerender();
}

// Reset on sign-out.
function costReset() {
  _costTrackingSeen = false;
  _stkPending = []; clearTimeout(_stkTimer);
  costHideBar(); costCloseQuick();
}

// ── Add Card / Edit Card form (prefix 'ac' or 'cem') ─────────────────────────
function _costEl(pfx, f) { return document.getElementById(`${pfx}_${f}`); }

function costFormFill(pfx, card) {
  const set = (f, v) => { const el = _costEl(pfx, f); if (el) el.value = v == null ? '' : v; };
  set('code', card ? card.StockCode : '');
  set('cost', card && costHas(card) ? card.CostBasis : '');
  set('cost_date', card ? (card.CostAcquiredAt || '') : (typeof _todayISO === 'function' ? _todayISO() : ''));
  set('cost_from', card ? card.CostAcquiredFrom : '');
  set('cost_notes', card ? card.CostNotes : '');
  const err = _costEl(pfx, 'code_err'); if (err) err.textContent = '';
  const codeEl = _costEl(pfx, 'code'); if (codeEl) codeEl.classList.remove('cost-input-bad');
  const det = _costEl(pfx, 'cost_details'); if (det) det.open = !!(card && costHas(card));
  if (pfx === 'ac') acRefreshCodePlaceholder();
  else if (codeEl) codeEl.placeholder = 'None';
  costFormHint(pfx);
}

function acRefreshCodePlaceholder() {
  const el = document.getElementById('ac_code');
  if (!el) return;
  const type = typeof _acItemType !== 'undefined' ? _acItemType : 'card';
  const grade = (document.getElementById('ac_grader')?.value && document.getElementById('ac_grade')?.value) || '';
  el.placeholder = 'Auto: ' + stockCodeNextGuess(stockCodePrefixFor({ item_type: type, Grade: grade === '' ? null : grade }));
}

function costCodeInput(pfx) {
  const el = _costEl(pfx, 'code'), err = _costEl(pfx, 'code_err');
  if (!el || !err) return;
  const card = pfx === 'cem' && typeof _cemIdx !== 'undefined' && _cemIdx !== null ? inventory[_cemIdx] : null;
  const dup = stockCodeFindDuplicate(el.value.trim(), card);
  err.textContent = dup ? `${el.value.trim()} is already used by ${dup['Card Title'] || dup.Player || 'another card'}` : '';
  el.classList.toggle('cost-input-bad', !!dup);
}

function costFormHint(pfx) {
  const hint = _costEl(pfx, 'cost_hint'), sum = _costEl(pfx, 'cost_summary');
  const cost = costParse(_costEl(pfx, 'cost')?.value);
  const price = costParse(document.getElementById(pfx + '_price')?.value);
  if (sum) sum.textContent = cost != null ? costMoney(cost) : '';
  if (!hint) return;
  if (cost != null && price) {
    const d = price - cost;
    hint.innerHTML = `Unrealized: <b class="${d < 0 ? 'neg' : ''}">${costSigned(d)}</b> at your asking price`;
  } else hint.textContent = '';
}

// Reads the form. Returns null (and shows the inline error) on a duplicate code.
function costFormRead(pfx, card) {
  const codeEl = _costEl(pfx, 'code');
  const code = (codeEl?.value || '').trim();
  if (code) {
    const dup = stockCodeFindDuplicate(code, card);
    if (dup || !stockCodeKey(code)) {
      costCodeInput(pfx);
      const err = _costEl(pfx, 'code_err');
      if (err && !dup) err.textContent = 'Use letters or numbers';
      codeEl.classList.add('cost-input-bad');
      codeEl.focus();
      return null;
    }
  }
  const f = {
    cost_basis:    costParse(_costEl(pfx, 'cost')?.value),
    acquired_at:   _costEl(pfx, 'cost_date')?.value || null,
    acquired_from: (_costEl(pfx, 'cost_from')?.value || '').trim() || null,
    notes:         _costEl(pfx, 'cost_notes') ? ((_costEl(pfx, 'cost_notes').value || '').trim() || null) : (card ? card.CostNotes || null : null),
  };
  const changed = card
    ? (f.cost_basis !== (costHas(card) ? Number(card.CostBasis) : null) ||
       f.acquired_at !== (card.CostAcquiredAt || null) ||
       f.acquired_from !== (card.CostAcquiredFrom || null) ||
       f.notes !== (card.CostNotes || null))
    : (f.cost_basis != null || !!f.acquired_from);
  return { code, fields: f, costChanged: changed };
}

function costFormApply(card, form) {
  if (!card || !form) return;
  const prevCode = card.StockCode || '';
  if (!card._dbId) {   // new card: written by costAfterInsert() once it has an id
    if (form.code) { card.StockCode = form.code; card._pendingStockCode = form.code; }
  } else if (form.code !== prevCode) {
    stockCodeSet(card, form.code);
  }
  if (form.costChanged) costSave(card, form.fields);
}
