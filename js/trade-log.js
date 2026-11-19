// ════════════════════════════════════════════════════════════════════════════
// Trade logging (Trades + Show Home, Phase 4). Show Mode screens:
//   #/sm/<show>/trade   cards out + cards in + cash, balance bar
//   #/sm/<show>/buy     cards in + cash paid
// Saved on the phone first (Show Mode outbox, op 'trade_save' → record_trade()),
// undone with op 'trade_delete' (→ delete_dealer_trade()). New cards get their id on
// the phone, so they show in the case before the trade syncs. Trades never reach the
// ledger; organizers only get a count. Loaded after js/show-log-import.js.
// ════════════════════════════════════════════════════════════════════════════

const TL_UNDO_WINDOW_MS = 10 * 60 * 1000;
const TL_SEARCH_LIMIT = 30;
let _tlDraft = null;
let _tlMissing = false;         // record_trade not installed yet
let _tlToastTimer = null;
const _tlCodes = new Map();     // new card id → stock code the server gave it (survives an inventory reload)

function _tlEsc(v) { return smEsc(v); }
function _tlNum(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function _tlMoney(n) {
  const v = Number(n) || 0;
  return '$' + (Math.round(v) === v ? v.toLocaleString() : v.toFixed(2));
}
function _tlRecentKey() { return 'tlRecent:' + currentSeller; }
function tlRecent() {
  try { return JSON.parse(localStorage.getItem(_tlRecentKey()) || '[]'); } catch (_) { return []; }
}
function _tlSaveRecent(list) {
  try { localStorage.setItem(_tlRecentKey(), JSON.stringify(list.slice(0, 20))); } catch (_) {}
}
function _tlCardName(c) { return (c && (c.Player || c['Card Title'])) || 'Card'; }

// ── Entry ───────────────────────────────────────────────────────────────────
function tlStart(type) {
  _tlDraft = null;
  _smLogEvent('trade_opened', { type });
  smGo(type === 'buy' ? '/buy' : '/trade');
}

function _tlNewDraft(type) {
  return { type, outs: [], ins: [], cashDir: type === 'buy' ? 'out' : 'none', cash: '', query: '', note: '', openedAt: Date.now() };
}

// ── Math ────────────────────────────────────────────────────────────────────
// Out value + cash paid vs in value + cash received. A single card coming in with no
// value typed is worth whatever balances the trade (shown as an estimate). Several
// blank in-values are never split: the dealer types each one.
function tlTotals(d) {
  const outV = d.outs.reduce((s, o) => s + (_tlNum(o.value) || 0), 0);
  const cash = _tlNum(d.cash) || 0;
  const cashIn = d.cashDir === 'in' ? cash : 0;
  const cashOut = d.cashDir === 'out' ? cash : 0;
  const typed = d.ins.reduce((s, i) => s + (_tlNum(i.value) || 0), 0);
  const blanks = d.ins.filter(i => _tlNum(i.value) == null);
  let estimate = null;
  if (d.type === 'trade' && blanks.length === 1) {
    const e = Math.round((outV + cashOut - cashIn - typed) * 100) / 100;
    if (e > 0) estimate = e;
  }
  if (d.type === 'buy' && blanks.length === 1 && d.ins.length === 1 && _tlNum(d.cash) != null) estimate = cashOut;
  const inV = typed + (estimate || 0);
  const buyCash = d.type === 'buy' && _tlNum(d.cash) == null ? typed : null;   // blank cash on a buy = what the cards are worth
  const effCashOut = buyCash != null ? buyCash : cashOut;
  return { outV, inV, typed, blanks: blanks.length, estimate, cashIn, cashOut: effCashOut, buyCash,
           delta: Math.round((outV + effCashOut - inV - cashIn) * 100) / 100 };
}

// ── Screen ──────────────────────────────────────────────────────────────────
function tlRender(type) {
  if (!_tlDraft || _tlDraft.type !== type) _tlDraft = _tlNewDraft(type);
  const d = _tlDraft;
  const isTrade = d.type === 'trade';
  const t = tlTotals(d);
  const outRows = d.outs.map((o, k) => {
    const c = inventory.find(x => x._dbId === o.dbId);
    const code = c && c.StockCode ? `<span class="stock-chip">${_tlEsc(c.StockCode)}</span>` : '';
    return `<div class="sm-row ss-item">
      ${typeof _smCardThumb === 'function' && c ? _smCardThumb(c) : ''}
      <div class="sm-row-body">
        <div class="sm-row-title">${_tlEsc(_tlCardName(c))} ${code}</div>
        <div class="sm-row-meta">${_tlEsc([c && c.Year, c && c['Set '], c ? _smGradeLabel(c) : '', c && c.Price ? 'asking ' + _tlMoney(c.Price) : ''].filter(Boolean).join(' · '))}</div>
      </div>
      <label class="ss-price"><span class="sm-sr-only">Trade value for ${_tlEsc(_tlCardName(c))}</span>
        <span aria-hidden="true">$</span><input inputmode="decimal" autocomplete="off" data-tl="out:${k}" value="${_tlEsc(o.value ?? '')}" placeholder="0" oninput="tlSetOut(${k}, this.value)"></label>
      <button class="sm-icon-btn" onclick="tlRemoveOut(${k})" aria-label="Remove ${_tlEsc(_tlCardName(c))}">${_smIcon('close')}</button>
    </div>`;
  }).join('');
  const results = isTrade && d.query.trim() ? tlSearch(d.query) : [];
  const resultsHTML = isTrade && d.query.trim() ? (results.length ? results.slice(0, TL_SEARCH_LIMIT).map(c => `
      <button class="sm-row sm-row--button" onclick="tlAddOut('${_tlEsc(c._dbId)}')">
        <span class="sm-row-body"><span class="sm-row-title">${_tlEsc(_tlCardName(c))} ${c.StockCode ? `<span class="stock-chip">${_tlEsc(c.StockCode)}</span>` : ''}</span>
        <span class="sm-row-meta">${_tlEsc([c.Year, c['Set '], _smCardNum(c.Number), _smGradeLabel(c)].filter(Boolean).join(' · '))}</span></span>
        <span class="sm-row-price">${_tlMoney(c.Price)}</span>
      </button>`).join('') : '<div class="sm-empty">No unsold cards match that.</div>') : '';
  const inRows = d.ins.map((n, k) => {
    const est = t.estimate != null && _tlNum(n.value) == null;
    return `<div class="tl-in">
      <div class="sm-form-row">
        <label class="sm-field"><span>Card ${d.ins.length > 1 ? k + 1 : ''} — what is it?</span>
          <input autocomplete="off" data-tl="title:${k}" value="${_tlEsc(n.title)}" placeholder="e.g. Wemby Prizm RC PSA 10" oninput="tlSetIn(${k}, 'title', this.value)"></label>
        <button class="sm-icon-btn tl-in-x" onclick="tlRemoveIn(${k})" aria-label="Remove card ${k + 1}">${_smIcon('close')}</button>
      </div>
      <div class="sm-form-row">
        <label class="sm-field"><span>${isTrade ? 'Worth (agreed)' : 'You paid'}</span>
          <input inputmode="decimal" autocomplete="off" data-tl="value:${k}" class="${est ? 'tl-est' : ''}" value="${_tlEsc(n.value ?? '')}"
            placeholder="${est ? _tlEsc(t.estimate.toFixed(2)) : '0'}" oninput="tlSetIn(${k}, 'value', this.value)"></label>
        <label class="sm-field"><span>Your asking price</span>
          <input inputmode="decimal" autocomplete="off" data-tl="price:${k}" value="${_tlEsc(n.price ?? '')}" placeholder="later" oninput="tlSetIn(${k}, 'price', this.value)"></label>
      </div>
      <p class="sm-helper tl-est-note" data-tl="estnote:${k}" style="display:${est ? '' : 'none'}">Estimated from the trade: ${_tlMoney(t.estimate || 0)}. Type a value to change it.</p>
    </div>`;
  }).join('');

  _smView().innerHTML = `
    <div class="sm-topbar">
      <button class="sm-icon-btn" onclick="tlCancel()" aria-label="Back">${_smIcon('back')}</button>
      <div class="sm-title">${isTrade ? 'Log a trade' : 'Log a buy'}</div>
      <span style="width:44px"></span>
    </div>
    <div class="sm-chip-grid sm-chip-grid--2" role="group" aria-label="Trade or buy">
      <button class="sm-chip sm-chip--big" aria-pressed="${isTrade}" onclick="tlSwitch('trade')">Trade</button>
      <button class="sm-chip sm-chip--big" aria-pressed="${!isTrade}" onclick="tlSwitch('buy')">Buy</button>
    </div>
    ${isTrade ? `
    <div class="sm-section-label" style="margin-top:14px">Cards going out · ${_tlMoney(t.outV)}</div>
    <div class="sm-list">${outRows || '<div class="sm-empty">Find the cards you\'re giving up.</div>'}</div>
    <div class="sm-search sm-search--light" style="margin-top:8px">${_smIcon('search')}
      <input id="tlSearch" autocomplete="off" placeholder="Stock code (S12) or card name" value="${_tlEsc(d.query)}" oninput="tlQuery(this.value)" aria-label="Search your cards"></div>
    <div class="sm-list sm-list--light" id="tlResults">${resultsHTML}</div>` : ''}
    <div class="sm-section-label" style="margin-top:14px">Cards coming in · <span data-tl="inv">${_tlMoney(t.inV)}</span></div>
    ${inRows}
    <button class="sm-sec-btn" onclick="tlAddIn()">${_smIcon('plus')}${d.ins.length ? 'Another card coming in' : 'Add a card coming in'}</button>
    <div class="sm-section-label" style="margin-top:14px">Cash</div>
    ${isTrade ? `<div class="sm-chip-grid sm-chip-grid--3" role="group" aria-label="Cash in this trade">
      <button class="sm-chip sm-chip--big" data-tlcash="none" aria-pressed="${d.cashDir === 'none'}" onclick="tlCashDir('none')">No cash</button>
      <button class="sm-chip sm-chip--big" data-tlcash="in" aria-pressed="${d.cashDir === 'in'}" onclick="tlCashDir('in')">I got cash</button>
      <button class="sm-chip sm-chip--big" data-tlcash="out" aria-pressed="${d.cashDir === 'out'}" onclick="tlCashDir('out')">I paid cash</button>
    </div>` : ''}
    <label class="ss-amount" style="display:${isTrade && d.cashDir === 'none' ? 'none' : ''}" id="tlCashBox">
      <span class="sm-section-label">${isTrade ? (d.cashDir === 'in' ? 'Cash you got' : 'Cash you paid') : 'Cash you paid'}</span>
      <span class="ss-amount-box"><span aria-hidden="true">$</span>
        <input id="tlCash" inputmode="decimal" autocomplete="off" placeholder="${!isTrade && t.buyCash != null ? _tlEsc(String(t.buyCash)) : '0'}" value="${_tlEsc(d.cash)}" oninput="tlSetCash(this.value)" aria-label="Cash in dollars"></span>
    </label>
    <div id="tlBalance" role="status" aria-live="polite"></div>
    <label class="sm-field" style="margin-top:12px"><span>Note (optional)</span>
      <input id="tlNote" autocomplete="off" value="${_tlEsc(d.note)}" oninput="_tlDraft.note=this.value"></label>
    <button class="sm-confirm-btn" id="tlSaveBtn" onclick="tlSave()"></button>
    <p class="sm-helper">Cards that come in go in your case with "Needs details". Add the card details later.</p>`;
  _tlPaint();
}

function tlRenderTrade() { tlRender('trade'); }
function tlRenderBuy() { tlRender('buy'); }

// Update the numbers without redrawing (keeps focus while typing).
function _tlPaint() {
  const d = _tlDraft;
  if (!d) return;
  const t = tlTotals(d);
  const inv = document.querySelector('[data-tl="inv"]');
  if (inv) inv.textContent = _tlMoney(t.inV);
  d.ins.forEach((n, k) => {
    const est = t.estimate != null && _tlNum(n.value) == null;
    const inp = document.querySelector(`[data-tl="value:${k}"]`);
    if (inp) { inp.classList.toggle('tl-est', est); inp.placeholder = est ? t.estimate.toFixed(2) : '0'; }
    const note = document.querySelector(`[data-tl="estnote:${k}"]`);
    if (note) { note.style.display = est ? '' : 'none'; note.textContent = `Estimated from the trade: ${_tlMoney(t.estimate || 0)}. Type a value to change it.`; }
  });
  const cash = document.getElementById('tlCash');
  if (cash && d.type === 'buy') cash.placeholder = t.buyCash != null ? String(t.buyCash) : '0';
  const bal = document.getElementById('tlBalance');
  if (bal) {
    if (d.type === 'trade' && d.outs.length && d.ins.length && t.blanks <= (t.estimate != null ? 1 : 0)) {
      if (Math.abs(t.delta) < 0.01) bal.innerHTML = '<div class="tl-bal tl-bal--even">Even trade.</div>';
      else {
        const more = t.delta > 0 ? 'You\'re giving' : 'You\'re getting';
        const need = Math.round((t.outV - t.inV) * 100) / 100;   // cash in − cash out that would make it even
        const fix = need > 0 ? `I got ${_tlMoney(need)} cash` : `I paid ${_tlMoney(-need)} cash`;
        bal.innerHTML = `<div class="tl-bal">${more} ${_tlMoney(Math.abs(t.delta))} more.
          <button class="sm-link sm-link--dark" onclick="tlEvenOut()">${fix}</button>
          <span class="sm-row-meta">You can still save it as is.</span></div>`;
      }
    } else bal.innerHTML = '';
  }
  const btn = document.getElementById('tlSaveBtn');
  if (btn) {
    btn.innerHTML = `${_smIcon('check')} ${d.type === 'trade' ? 'Save trade' : 'Save buy'}`;
    btn.disabled = !_tlProblem(d, t) ? false : true;
    btn.title = _tlProblem(d, t) || '';
  }
}

// Why the trade can't be saved yet (null = ok). An unbalanced trade is fine.
function _tlProblem(d, t) {
  t = t || tlTotals(d);
  if (d.type === 'trade' && !d.outs.length) return 'Add the cards going out';
  if (!d.ins.length) return d.type === 'trade' ? 'Add what came back (no card back? use Sell a card)' : 'Add the cards you bought';
  if (d.outs.some(o => !(_tlNum(o.value) > 0))) return 'Enter a value for each card going out';
  if (t.blanks > (t.estimate != null ? 1 : 0)) return 'Enter what each card coming in is worth';
  if (d.type === 'trade' && d.cashDir !== 'none' && !(_tlNum(d.cash) > 0)) return 'Enter the cash amount';
  return null;
}

function tlSearch(q) {
  const taken = new Set(_tlDraft.outs.map(o => o.dbId));
  const codeKey = typeof stockCodeQueryKey === 'function' ? stockCodeQueryKey(q) : '';
  const avail = getSellerInventory().filter(c => c.Status !== 'Sold' && c._dbId && !taken.has(c._dbId));
  const exact = codeKey ? avail.filter(c => c.StockCode && stockCodeKey(c.StockCode) === codeKey) : [];
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const text = avail.filter(c => !exact.includes(c) && words.every(w => [c['Card Title'], c.Player, c.Year, c['Set '], c.Number,
    c['Parallel/Variant'], c.Grader, c.Grade, c['Cert #'], c.StockCode].map(v => String(v ?? '').toLowerCase()).join(' ').includes(w)));
  return exact.concat(text);
}

function _tlRedraw(focusSel) {
  const pos = focusSel && document.querySelector(focusSel) ? document.querySelector(focusSel).selectionStart : null;
  tlRender(_tlDraft.type);
  const el = focusSel && document.querySelector(focusSel);
  if (el) { el.focus(); if (pos != null) el.setSelectionRange(pos, pos); }
}
function tlQuery(v) { _tlDraft.query = v; _tlRedraw('#tlSearch'); }
function tlAddOut(dbId) {
  const c = inventory.find(x => x._dbId === dbId);
  if (!c) return;
  _tlDraft.outs.push({ dbId, value: Number(c.Price) > 0 ? String(Number(c.Price)) : '' });
  _tlDraft.query = '';
  _tlRedraw();
}
function tlRemoveOut(k) { _tlDraft.outs.splice(k, 1); _tlRedraw(); }
function tlSetOut(k, v) { _tlDraft.outs[k].value = v; _tlPaint(); }
function tlAddIn() {
  _tlDraft.ins.push({ title: '', value: '', price: '' });
  tlRender(_tlDraft.type);
  setTimeout(() => document.querySelector(`[data-tl="title:${_tlDraft.ins.length - 1}"]`)?.focus(), 30);
}
function tlRemoveIn(k) { _tlDraft.ins.splice(k, 1); _tlRedraw(); }
function tlSetIn(k, f, v) { _tlDraft.ins[k][f] = v; _tlPaint(); }
function tlSetCash(v) { _tlDraft.cash = v; _tlPaint(); }
function tlCashDir(dir) {
  _tlDraft.cashDir = dir;
  if (dir === 'none') _tlDraft.cash = '';
  tlRender('trade');
  if (dir !== 'none') setTimeout(() => document.getElementById('tlCash')?.focus(), 30);
}
function tlEvenOut() {
  const t = tlTotals(_tlDraft);
  const need = Math.round((t.outV - t.inV) * 100) / 100;
  _tlDraft.cashDir = need > 0 ? 'in' : need < 0 ? 'out' : 'none';
  _tlDraft.cash = need ? String(Math.abs(need)) : '';
  tlRender('trade');
}
function tlSwitch(type) {
  if (_tlDraft && _tlDraft.type === type) return;
  const keepIns = _tlDraft ? _tlDraft.ins : [];
  _tlDraft = _tlNewDraft(type);
  _tlDraft.ins = keepIns;
  smGo(type === 'buy' ? '/buy' : '/trade', true);
}
function tlCancel() { _tlDraft = null; smGoHome(); }

// ── Save ────────────────────────────────────────────────────────────────────
async function tlSave() {
  const d = _tlDraft;
  if (!d) return;
  const t = tlTotals(d);
  const problem = _tlProblem(d, t);
  if (problem) { showToast(problem, 'var(--danger)'); return; }
  const now = new Date();
  const clientId = _smUuid();
  const showId = _smShowId;
  const ins = d.ins.map(n => {
    const g = typeof imParseInCard === 'function' ? imParseInCard(n.title) : { title: n.title, grader: null, grade: null, code: null };
    return {
      id: _smUuid(), title: (g.title || n.title || '').trim() || (d.type === 'buy' ? 'Card from a buy' : 'Card from a trade'),
      value: _tlNum(n.value) != null ? _tlNum(n.value) : (t.estimate != null ? t.estimate : null),
      grader: g.grader, grade: g.grade, stock_code: g.code || null, price: _tlNum(n.price),
    };
  });
  const payload = {
    txn_type: d.type, occurred_at: now.toISOString(), local_date: _todayISO(),
    local_time: now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    cash_in: t.cashIn, cash_out: t.cashOut, payment_method: (t.cashIn || t.cashOut) ? 'Cash' : null,
    note: (d.note || '').trim() || null,
    out: d.outs.map(o => ({ inventory_id: o.dbId, value: _tlNum(o.value) })),
    in: ins,
  };
  const op = { type: 'trade_save', clientId, showId, payload, onShow: d.outs.filter(o => {
    const c = inventory.find(x => x._dbId === o.dbId); return c && c._shows instanceof Set && c._shows.has(showId);
  }).map(o => o.dbId) };
  if (typeof shEnsureShowStart === 'function') shEnsureShowStart(showId);   // before the trade changes inventory
  tlApply(op);
  await smEnqueue(op);
  const rec = { clientId, at: now.getTime(), type: d.type, showId, outs: payload.out.length, ins: ins.length,
    title: (d.type === 'trade' ? payload.out.map(o => _tlCardName(inventory.find(c => c._dbId === o.inventory_id))).join(', ') + ' → ' : '') + ins.map(i => i.title).join(', '),
    cashIn: t.cashIn, cashOut: t.cashOut, synced: false,
    outIds: payload.out.map(o => o.inventory_id), inIds: ins.map(i => i.id), onShow: op.onShow };
  _tlSaveRecent([rec].concat(tlRecent().filter(r => r.clientId !== clientId)));
  _smLogEvent('trade_saved', { type: d.type, out: payload.out.length, in: ins.length, cash: (t.cashIn || t.cashOut) > 0,
    balanced: Math.abs(t.delta) < 0.01, estimated: t.estimate != null, msFromOpen: Date.now() - d.openedAt, queuedOffline: !navigator.onLine });
  _tlDraft = null;
  if (navigator.vibrate) navigator.vibrate(30);
  smGoHome();
  _tlShowToast(rec);
}

// Show the trade on this phone straight away (also re-run after a reload while queued).
function tlApply(op) {
  const p = op.payload;
  p.out.forEach(o => {
    const c = inventory.find(x => x._dbId === o.inventory_id);
    if (!c) return;
    Object.assign(c, { Status: 'Sold', SoldPrice: o.value, PaymentMethod: 'Trade', SoldDate: p.local_date, SoldTime: p.local_time,
                       _tradeId: op.clientId, _smPending: true });
    if (c._shows instanceof Set) c._shows.delete(op.showId);
  });
  p.in.forEach(n => {
    if (inventory.some(c => c._dbId === n.id)) return;
    const card = validateAndNormalizeCard({
      Seller: currentSeller, 'Card Title': n.title, Player: '', Year: '', 'Set ': '', Number: '', 'Parallel/Variant': '',
      Grader: n.grader || '', Grade: n.grade || '', 'Cert #': null, Price: n.price || 0, Status: 'Available', Location: null, item_type: 'card',
    });
    Object.assign(card, { Seller: currentSeller, _dbId: n.id, _shows: new Set(), IdentificationStatus: 'unidentified',
      CostBasis: n.value, CostAcquiredFrom: p.txn_type === 'buy' ? 'Buy' : 'Trade', CostAcquiredAt: p.local_date,
      StockCode: _tlCodes.get(n.id) || n.stock_code || null, _tradeId: op.clientId, _tradeIn: true, _smPending: true });
    inventory.push(card);
  });
  _smAfterInventoryChange();
}

// Take a trade off this phone (undo before it synced, refused on the server, or deleted).
function _tlRevert(op) {
  const p = op.payload;
  p.out.forEach(o => {
    const c = inventory.find(x => x._dbId === o.inventory_id);
    if (!c || c.Status !== 'Sold' || (c._tradeId && c._tradeId !== op.clientId)) return;   // after a reload the flag is gone
    _smClearSold(c);
    c._tradeId = null; c._smPending = false;
    if ((op.onShow || []).includes(c._dbId) && op.showId) { if (!(c._shows instanceof Set)) c._shows = new Set(); c._shows.add(op.showId); }
  });
  const ids = new Set(p.in.map(n => n.id));
  for (let i = inventory.length - 1; i >= 0; i--) if (ids.has(inventory[i]._dbId)) inventory.splice(i, 1);
  _smAfterInventoryChange();
}

function _tlHideToast() {
  clearTimeout(_tlToastTimer);
  const t = document.getElementById('tlToast');
  if (t) t.remove();
}
function _tlShowToast(rec) {
  _tlHideToast();
  const t = document.createElement('div');
  t.id = 'tlToast';
  t.className = 'sm-toast';
  t.setAttribute('role', 'status');
  t.innerHTML = `<span>${rec.type === 'buy' ? 'Buy' : 'Trade'} saved · ${rec.ins} card${rec.ins === 1 ? '' : 's'} in your case</span>
    <button class="sm-toast-btn" onclick="tlUndo('${_tlEsc(rec.clientId)}')">Undo</button>`;
  document.getElementById('showModeRoot').appendChild(t);
  _tlToastTimer = setTimeout(_tlHideToast, 6000);
}

function tlCanUndo(rec) {
  if (!rec || rec.undone || (Date.now() - rec.at) >= TL_UNDO_WINDOW_MS) return false;
  // A card that came in and has since been sold or traded on can't be undone from here.
  const ins = new Set(rec.inIds || []);
  return !inventory.some(c => ins.has(c._dbId) && c.Status === 'Sold');
}

async function tlUndo(clientId) {
  _tlHideToast();
  const list = tlRecent();
  const rec = list.find(r => r.clientId === clientId);
  if (!rec || !tlCanUndo(rec)) { showToast('Can\'t undo this trade here — open it from Show results', 'var(--danger)'); return; }
  let pending = null;
  try { pending = (await smStore.all('outbox')).find(o => o.type === 'trade_save' && o.clientId === clientId) || null; } catch (_) {}
  if (pending && !_smDraining) {
    await smStore.del('outbox', pending.seq);     // never left the phone
    _tlRevert(pending);
  } else {
    const op = pending || { type: 'trade_save', clientId, showId: rec.showId, onShow: rec.onShow || [], payload: _tlOpFromRecord(rec) };
    _tlRevert(op);
    await smEnqueue({ type: 'trade_delete', clientId, showId: rec.showId, txnId: rec.txnId || null, revert: op });
  }
  rec.undone = true;
  _tlSaveRecent(list);
  _smLogEvent('trade_undone', { secondsAfter: Math.round((Date.now() - rec.at) / 1000) });
  showToast(rec.type === 'buy' ? 'Buy undone' : 'Trade undone');
  smRefresh();
}

// A synced trade's shape, from its record on this phone (enough to take it off the phone or put it back).
function _tlOpFromRecord(rec) {
  return {
    txn_type: rec.type,
    out: (rec.outIds || []).map(id => { const c = inventory.find(x => x._dbId === id); return { inventory_id: id, value: c ? c.SoldPrice : null }; }),
    in: (rec.inIds || []).map(id => { const c = inventory.find(x => x._dbId === id) || {}; return { id, title: c['Card Title'], grader: c.Grader, grade: c.Grade, price: c.Price, value: c.CostBasis }; }),
  };
}

// ── Outbox ops ──────────────────────────────────────────────────────────────
async function tlRunOp(op) {
  if (op.type === 'trade_save') return _tlOpSave(op);
  if (op.type === 'trade_delete') return _tlOpDelete(op);
  return 'done';
}

async function _tlOpSave(op) {
  const res = await db.rpc('record_trade', { p_client_id: op.clientId, p_show_id: op.showId || null, p_dealer_show_id: null, p_txn: op.payload });
  if (res.error) {
    if (_smIsNetworkError(res)) return 'retry';
    if (_smIsMissingFunction(res)) {
      _tlMissing = true;
      _tlRevert(op);
      showToast('Trade logging is still being set up — this trade wasn\'t saved', 'var(--danger)');
      return 'done';
    }
    console.warn('[trade] save failed', res.error.message);
    _tlRevert(op);
    showToast('Trade not saved — ' + res.error.message, 'var(--danger)');
    return 'done';
  }
  const r = res.data || {};
  if (r.error) {
    _tlRevert(op);
    const c = inventory.find(x => x._dbId === r.card);
    if (c && typeof _smRefetchCard === 'function') _smRefetchCard(c);   // the server knows how it was sold
    const name = r.title || (c && (c.StockCode || _tlCardName(c))) || 'a card';
    showToast(r.error === 'already_sold' ? `Trade not saved: ${name} was already sold` : 'Trade not saved — that card isn\'t in your case', 'var(--danger)');
    _markRecent(op.clientId, { undone: true });
    return 'done';
  }
  (r.created || []).forEach(x => {
    if (x.stock_code) _tlCodes.set(x.id, x.stock_code);
    const c = inventory.find(y => y._dbId === x.id);
    if (c) { c.StockCode = x.stock_code || c.StockCode; c._smPending = false; }
  });
  inventory.forEach(c => { if (c._tradeId === op.clientId) c._smPending = false; });
  _markRecent(op.clientId, { synced: true, txnId: r.id });
  if (typeof gtcrScheduleReconcile === 'function') gtcrScheduleReconcile();   // traded slabs leave the GTCR registry
  _smAfterInventoryChange();
  return 'done';
}

async function _tlOpDelete(op) {
  let txnId = op.txnId;
  if (!txnId) {
    const q = await db.from('dealer_transactions').select('id').eq('client_capture_id', op.clientId).maybeSingle();
    if (q.error) return _smIsNetworkError(q) ? 'retry' : 'done';
    txnId = q.data && q.data.id;
    if (!txnId) return 'done';                // never landed
  }
  const res = await db.rpc('delete_dealer_trade', { p_txn_id: txnId });
  if (res.error) return _smIsNetworkError(res) ? 'retry' : 'done';
  if (res.data && res.data.error === 'card_moved_on') {
    if (op.revert) tlApply(op.revert);        // put it back: the server kept the trade
    showToast(`Couldn't undo: ${res.data.title || 'a card from it'} has been sold or traded since`, 'var(--danger)');
  }
  return 'done';
}

function _markRecent(clientId, patch) {
  const list = tlRecent();
  const r = list.find(x => x.clientId === clientId);
  if (r) { Object.assign(r, patch); _tlSaveRecent(list); }
}

// Re-apply queued trades after the inventory reloads (called by smApplyPendingOps).
function tlApplyPending(op) {
  if (op.type === 'trade_save') tlApply(op);
  else if (op.type === 'trade_delete' && op.revert) _tlRevert(op.revert);
}

// ── Home: recent trades next to recent sales ────────────────────────────────
function tlHomeRows() {
  return tlRecent().filter(r => !r.undone && r.showId === _smShowId).slice(0, 5).map(r => {
    const cash = r.cashIn ? ' · got ' + _tlMoney(r.cashIn) : r.cashOut ? ' · paid ' + _tlMoney(r.cashOut) : '';
    const sync = r.synced ? '' : '<span class="sm-sync">Syncing</span>';
    const undo = tlCanUndo(r) ? `<button class="sm-row-btn sm-row-btn--ghost" onclick="tlUndo('${_tlEsc(r.clientId)}')">Undo</button>` : '';
    return { t: r.at, html: `<div class="sm-row">
      <span class="sm-thumb ss-thumb-empty" aria-hidden="true">${_smIcon('refresh')}</span>
      <div class="sm-row-body">
        <div class="sm-row-title"><span class="sm-badge">${r.type === 'buy' ? 'Buy' : 'Trade'}</span> ${_tlEsc(r.title)}</div>
        <div class="sm-row-meta">${_tlEsc(_smRelTime(new Date(r.at)) + cash)} ${sync}</div>
      </div>${undo}
    </div>` };
  });
}

function tlReset() { _tlDraft = null; _tlHideToast(); }

// Classic Sell / Add menu and the Feature guide: trades live in Show Mode (offline queue, undo).
function tlOpenFromClassic() {
  if (typeof smIsEnabled === 'function' && !smIsEnabled()) { showToast('Trade logging needs Show Mode', 'gold'); return; }
  const id = _smDefaultShowId() || (_smAuthorizedShows()[0] || {}).id;
  if (id) { openShowMode(id, '/trade'); return; }
  smOpenFromNav();
}
