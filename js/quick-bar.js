// ════════════════════════════════════════════════════════════════════════════
// Quick bar (Cost Tracking Phase 2 + Trades Phase 4): type a sale, lot, trade or buy
// on the Show Mode home screen instead of tapping through screens.
//
//   S12 120              sell S-12 for $120 (last payment used, or add "venmo" / "card")
//   slab 12 120 venmo    the same, by word
//   S12 120 R4 15        several cards, each with its own price
//   S12                  sell S-12 at its asking price
//   lot 120 [3 cards]    one total, card details later (Snap & Sell, no photos)
//   T S12 for wemby psa 10 +20     trade: S-12 out, one card in, $20 cash received (-20 = paid)
//   B 50 charizard psa 9           buy one card for $50
//
// Nothing is guessed silently: a preview line says what Enter will do, and a trade or buy
// the bar can't value on its own opens the trade screen pre-filled instead of saving.
// Saves go through the Show Mode outbox (offline-first): sales as 'sale' ops, lots as
// Snap & Sell, trades and buys through js/trade-log.js. Loaded after js/trade-log.js.
// ════════════════════════════════════════════════════════════════════════════

const QB_UNDO_MS = 10000;
let _qbText = '';
let _qbToastTimer = null;
let _qbBusy = false;

const QB_PAYMENTS = { cash: 'Cash', venmo: 'Venmo', card: 'Card', cc: 'Card', credit: 'Card', debit: 'Card',
  zelle: 'Other', paypal: 'Other', applepay: 'Other', other: 'Other' };

function _qbMoney(n) {
  const v = Number(n) || 0;
  return '$' + (Math.round(v) === v ? v.toLocaleString() : v.toFixed(2));
}
function _qbAmount(t) {
  const m = String(t).match(/^\$?(\d+(?:\.\d{1,2})?)$/);
  return m ? Number(m[1]) : null;
}
// "slab 12" / "single 4" / "box 3" → s12 / r4 / b3. "lot" stays a word (lot 120 = a lot sale).
function _qbNormCodes(s) {
  return s.replace(/\bslabs?\s*#?\s*(?=\d)/g, 's')
          .replace(/\b(?:singles?|raw)\s*#?\s*(?=\d)/g, 'r')
          .replace(/\b(?:box(?:es)?|sealed)\s*#?\s*(?=\d)/g, 'b')
          .replace(/\b([srbl])\s*-\s*(\d)/g, '$1$2');
}
function _qbIsCode(t) { return /^[srbl]\d+$/i.test(t); }
function _qbCodeLabel(t) { return t.toUpperCase().replace(/^([SRBL])(\d+)$/, '$1-$2'); }
function _qbFindCard(code) {
  const key = stockCodeKey(code);
  const mine = getSellerInventory().filter(c => c.StockCode && stockCodeKey(c.StockCode) === key);
  return mine.find(c => c.Status !== 'Sold') || mine[0] || null;
}
function _qbName(c) { return (c && (c.Player || c['Card Title'])) || 'Card'; }
// Payment word anywhere ("apple pay" too); returns [payment|null, text without it].
function _qbTakePayment(s) {
  let pay = null;
  const out = s.replace(/\bapple\s*pay\b/g, () => { pay = 'Other'; return ' '; })
    .replace(/\b(cash|venmo|card|cc|credit|debit|zelle|paypal|other)\b/g, (w) => { pay = QB_PAYMENTS[w]; return ' '; });
  return [pay, out.replace(/\s+/g, ' ').trim()];
}

// Returns null (empty), { error }, or { kind, action: 'save'|'open', summary, ... }.
function qbParse(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const low = text.toLowerCase();
  let m;
  if ((m = low.match(/^(?:t|trade|traded)\s+(.+)$/))) return _qbParseTrade(m[1], text.slice(text.length - m[1].length));
  if ((m = low.match(/^(?:b|buy|bought)\s+(.+)$/))) return _qbParseBuy(text.slice(text.length - m[1].length));
  if ((m = low.match(/^(?:lots?|bundles?)\s+(.+)$/))) return _qbParseLot(m[1]);
  return _qbParseSale(low);
}

function _qbParseSale(low) {
  const [pay, rest] = _qbTakePayment(_qbNormCodes(low));
  const tokens = rest.split(/[\s,;]+/).filter(Boolean);
  const lines = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (_qbIsCode(t)) { lines.push({ code: t, price: null }); continue; }
    const a = _qbAmount(t);
    if (a != null && lines.length && lines[lines.length - 1].price == null) { lines[lines.length - 1].price = a; continue; }
    if (a != null) return { error: lines.length ? `Two prices in a row — give each card one price` : `Start with a stock code, like S12 ${t}` };
    return { error: `Didn't understand "${t}". Try S12 120, lot 120, T S12 for …, or B 50 …` };
  }
  if (!lines.length) return { error: 'Start with a stock code, like S12 120' };
  const priced = lines.filter(l => l.price != null).length;
  if (lines.length > 1 && priced === 1 && lines[lines.length - 1].price != null) {
    return { error: 'One price for several cards: give each card its own price (S12 120 R4 15), or type lot ' + lines[lines.length - 1].price };
  }
  const items = [];
  const seen = new Set();
  for (const l of lines) {
    const label = _qbCodeLabel(l.code);
    if (seen.has(label)) return { error: `${label} is in there twice` };
    seen.add(label);
    const c = _qbFindCard(l.code);
    if (!c) return { error: `No card ${label} in your inventory` };
    if (c.Status === 'Sold') return { error: `${label} is already sold` };
    if (!c._dbId) return { error: `${label} hasn't synced yet — try again in a moment` };
    let price = l.price;
    let atAsking = false;
    if (price == null) {
      if (!(Number(c.Price) > 0)) return { error: `${label} has no asking price — type the price (${label.replace('-', '')} 50)` };
      price = Math.round(Number(c.Price) * 100) / 100;
      atAsking = true;
    }
    if (!(price > 0)) return { error: `Enter a price for ${label}` };
    items.push({ card: c, label, price, atAsking });
  }
  const payment = pay || _smLastPayment();
  const total = items.reduce((s, i) => s + i.price, 0);
  const summary = items.map(i => `${i.label} ${_qbName(i.card)} · ${_qbMoney(i.price)}${i.atAsking ? ' (asking)' : ''}`).join(' + ')
    + (items.length > 1 ? ` = ${_qbMoney(total)}` : '') + ` · ${payment}`;
  return { kind: 'sale', action: 'save', items, payment, summary: 'Sell ' + summary };
}

function _qbParseLot(rest) {
  const [pay, r] = _qbTakePayment(rest);
  const m = r.match(/^\$?(\d+(?:\.\d{1,2})?)(?:\s+(?:x\s*)?(\d+)(?:\s*cards?)?)?(?:\s+(.*))?$/);
  if (!m) return { error: 'Lot sale: type lot and the total, like lot 120 (or lot 120 3 cards)' };
  const amount = Number(m[1]);
  if (!(amount > 0)) return { error: 'Enter the lot total' };
  const count = m[2] ? Math.min(99, Number(m[2])) : null;
  const payment = pay || _ssLastPaymentSafe();
  return { kind: 'lot', action: 'save', amount, count, payment, note: m[3] || '',
    summary: `Lot sale · ${_qbMoney(amount)}${count ? ` · ${count} cards` : ''} · ${payment} · card details later` };
}
function _ssLastPaymentSafe() {
  try { return typeof _ssLastPayment === 'function' ? _ssLastPayment() : 'Cash'; } catch (_) { return 'Cash'; }
}

// T <codes> for <title>[, <title>] [+N | -N]
function _qbParseTrade(lowRest, rest) {
  let cashDir = 'none', cash = '';
  // "+20" (you got cash) or "-15" (you paid), anywhere in the line.
  const cm = rest.match(/(^|\s)([+-])\s*\$?(\d+(?:\.\d{1,2})?)(?:\s*cash)?(?=\s|$)/i);
  if (cm) {
    cashDir = cm[2] === '+' ? 'in' : 'out'; cash = cm[3];
    rest = (rest.slice(0, cm.index) + ' ' + rest.slice(cm.index + cm[0].length)).replace(/\s+/g, ' ').trim();
  }
  const parts = rest.split(/\s+(?:for|->|→|=>)\s+/i);
  const outPart = _qbNormCodes(parts[0].toLowerCase());
  const inPart = parts.slice(1).join(' for ').trim();
  const outs = [];
  for (const t of outPart.split(/[\s,;+&]+/).filter(Boolean)) {
    if (t === 'and') continue;
    if (!_qbIsCode(t)) return { error: `Trade: list the stock codes going out, then "for" and what came back (T S12 for wemby psa 10 +20)` };
    const label = _qbCodeLabel(t);
    const c = _qbFindCard(t);
    if (!c) return { error: `No card ${label} in your inventory` };
    if (c.Status === 'Sold') return { error: `${label} is already sold` };
    if (outs.some(o => o.card === c)) return { error: `${label} is in there twice` };
    outs.push({ card: c, label });
  }
  if (!outs.length) return { error: 'Trade: start with the stock codes going out (T S12 for …)' };
  const ins = inPart ? inPart.split(/[,;]/).map(s => s.trim()).filter(Boolean) : [];
  const draft = _tlNewDraft('trade');
  draft.outs = outs.map(o => ({ dbId: o.card._dbId, value: Number(o.card.Price) > 0 ? String(Number(o.card.Price)) : '' }));
  draft.ins = ins.map(t => ({ title: t, value: '', price: '' }));
  draft.cashDir = cashDir; draft.cash = cash;
  const outTxt = outs.map(o => `${o.label} ${_qbName(o.card)}`).join(' + ');
  const cashTxt = cashDir === 'in' ? ` + you got ${_qbMoney(cash)}` : cashDir === 'out' ? ` + you paid ${_qbMoney(cash)}` : '';
  const problem = outs.some(o => !o.card._dbId) ? 'not synced' : (typeof _tlProblem === 'function' ? _tlProblem(draft) : 'x');
  if (!ins.length) return { kind: 'trade', action: 'open', draft, summary: `Trade ${outTxt} — Enter to add what came back` };
  if (problem) {
    const why = outs.some(o => !(Number(o.card.Price) > 0)) ? 'a card going out has no asking price'
      : ins.length > 1 ? 'several cards came in — enter what each is worth' : 'the values need a look';
    return { kind: 'trade', action: 'open', draft, summary: `Trade ${outTxt} for ${ins.join(', ')}${cashTxt} — Enter to finish (${why})` };
  }
  const t = tlTotals(draft);
  return { kind: 'trade', action: 'save', draft,
    summary: `Trade ${outTxt} (${_qbMoney(t.outV)}) for ${ins[0]} (worth ${_qbMoney(t.inV)})${cashTxt}` };
}

// B [$]N <title> | B <title> $N | B <title> N
function _qbParseBuy(rest) {
  let words = rest.replace(/\b(cash|venmo|zelle|paypal)\b/ig, ' ').trim().split(/\s+/).filter(Boolean);
  let amount = null;
  const dollar = words.findIndex(w => /^\$\d/.test(w));
  if (dollar >= 0) { amount = _qbAmount(words[dollar]); words.splice(dollar, 1); }
  else if (words.length && _qbAmount(words[0]) != null) { amount = _qbAmount(words[0]); words.shift(); }
  else if (words.length > 1 && _qbAmount(words[words.length - 1]) != null) { amount = _qbAmount(words[words.length - 1]); words.pop(); }
  const titles = words.join(' ').split(/[,;]/).map(s => s.trim()).filter(Boolean);
  if (!titles.length) return { error: 'Buy: type what you bought and what you paid (B 50 charizard psa 9)' };
  const draft = _tlNewDraft('buy');
  draft.ins = titles.map(t => ({ title: t, value: '', price: '' }));
  draft.cash = amount != null ? String(amount) : '';
  if (amount == null) return { kind: 'buy', action: 'open', draft, summary: `Buy ${titles.join(', ')} — Enter to add what you paid` };
  if (titles.length > 1) return { kind: 'buy', action: 'open', draft, summary: `Buy ${titles.join(', ')} for ${_qbMoney(amount)} — Enter to say what each is worth` };
  return { kind: 'buy', action: 'save', draft, summary: `Buy ${titles[0]} for ${_qbMoney(amount)} · goes in your case with Needs details` };
}

// ── UI (on the Show Mode home screen) ───────────────────────────────────────
function qbHTML() {
  return `<div class="qb" role="search">
    <form class="qb-form" onsubmit="event.preventDefault(); qbSubmit();">
      <label class="sm-sr-only" for="qbInput">Quick entry</label>
      <input id="qbInput" class="qb-input" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="done"
        placeholder="Quick: S12 120 · lot 120 · T S12 for … · B 50 …" value="${smEsc(_qbText)}" oninput="qbOnInput(this.value)"
        aria-describedby="qbPreview">
      <button class="qb-go" id="qbGo" type="submit" aria-label="Save">${_smIcon('check')}</button>
    </form>
    <div class="qb-preview" id="qbPreview" aria-live="polite"></div>
    <button class="sm-link qb-help" type="button" onclick="qbToggleHelp()" aria-expanded="false" id="qbHelpBtn">What can I type?</button>
    <div class="qb-help-box" id="qbHelp" hidden>
      <div><b>S12 120</b> sell S-12 for $120 · add <b>venmo</b> or <b>card</b> for the payment</div>
      <div><b>slab 12 120</b> the same · <b>S12</b> alone sells at the asking price</div>
      <div><b>S12 120 R4 15</b> two cards, a price each</div>
      <div><b>lot 120</b> one total for a pile of cards (add <b>3 cards</b>); details later</div>
      <div><b>T S12 for wemby psa 10 +20</b> trade, you got $20 (<b>-20</b> = you paid)</div>
      <div><b>B 50 charizard psa 9</b> bought a card for $50</div>
    </div>
  </div>`;
}

function qbToggleHelp() {
  const box = document.getElementById('qbHelp');
  const btn = document.getElementById('qbHelpBtn');
  if (!box) return;
  box.hidden = !box.hidden;
  if (btn) btn.setAttribute('aria-expanded', String(!box.hidden));
}

function qbOnInput(v) { _qbText = v; qbPaint(); }

function qbPaint() {
  const el = document.getElementById('qbPreview');
  const go = document.getElementById('qbGo');
  if (!el) return;
  const r = qbParse(_qbText);
  el.className = 'qb-preview' + (r && r.error ? ' qb-preview--error' : r && r.action === 'open' ? ' qb-preview--open' : '');
  el.textContent = !r ? '' : r.error ? r.error : (r.action === 'open' ? r.summary : r.summary + ' — Enter to save');
  if (go) go.disabled = !r || !!r.error;
}

// Keep the typed text and focus across home re-renders (smRefresh redraws the screen).
function qbBeforeRender() {
  const el = document.getElementById('qbInput');
  if (!el || document.activeElement !== el) return null;
  return { start: el.selectionStart, end: el.selectionEnd };
}
function qbAfterRender(state) {
  qbPaint();
  if (!state) return;
  const el = document.getElementById('qbInput');
  if (el) { el.focus({ preventScroll: true }); try { el.setSelectionRange(state.start, state.end); } catch (_) {} }
}

async function qbSubmit() {
  if (_qbBusy) return;
  const r = qbParse(_qbText);
  if (!r) return;
  if (r.error) {
    const el = document.getElementById('qbInput');
    if (el) { el.classList.remove('qb-shake'); void el.offsetWidth; el.classList.add('qb-shake'); }
    return;
  }
  _qbBusy = true;
  try {
    if (r.kind === 'sale') await _qbSaveSales(r);
    else if (r.kind === 'lot') {
      _qbText = '';
      await ssQuickLot(r.amount, r.payment, r.count, r.note);
    } else if (r.action === 'open') {
      _qbText = '';
      _tlDraft = r.draft;
      _smLogEvent('quick_bar', { kind: r.kind, action: 'open' });
      smGo(r.kind === 'buy' ? '/buy' : '/trade');
      return;
    } else {
      _qbText = '';
      _tlDraft = r.draft;
      _smLogEvent('quick_bar', { kind: r.kind, action: 'save' });
      await tlSave();
    }
  } finally { _qbBusy = false; }
}

// Same writes as Show Mode's Mark sold (smMarkSold), one 'sale' op per card, no screen change.
async function _qbSaveSales(r) {
  if (typeof shEnsureShowStart === 'function') shEnsureShowStart(_smShowId);   // before the sale changes inventory
  const now = new Date();
  const soldTime = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const soldDate = _todayISO();
  const ids = [];
  for (const it of r.items) {
    const card = it.card;
    if (card.Status === 'Sold') continue;
    const clientSaleId = _smUuid();
    Object.assign(card, { Status: 'Sold', SoldPrice: it.price, PaymentMethod: r.payment, SoldTime: soldTime, SoldDate: soldDate,
      _clientSaleId: clientSaleId, _saleAt: now.getTime(), _smPending: true });
    if (!(card._shows instanceof Set)) card._shows = new Set();
    card._shows.add(_smShowId);
    await smEnqueue({
      type: 'sale', clientSaleId, cardSnapshot: _smSnapshot(card),
      payload: { inventoryId: card._dbId, newItem: null, showId: _smShowId, price: it.price, payment: r.payment,
        buyerHandle: '', soldDate, soldTime, captureId: null, source: 'show_mode' },
    });
    if (typeof costRecordSale === 'function') costRecordSale(card, clientSaleId, { showId: _smShowId, price: it.price, queue: true });
    ids.push(clientSaleId);
  }
  try { localStorage.setItem(_smLastPaymentKey(), r.payment); } catch (_) {}
  _smLogEvent('sale_confirmed', { from: 'quick_bar', cards: ids.length, paymentMethod: r.payment, queuedOffline: !navigator.onLine });
  _qbText = '';
  if (navigator.vibrate) navigator.vibrate(30);
  _smAfterInventoryChange();
  smRefresh();
  _qbShowToast(ids, r);
}

function _qbHideToast() {
  clearTimeout(_qbToastTimer);
  const t = document.getElementById('qbToast');
  if (t) t.remove();
}
function _qbShowToast(ids, r) {
  _qbHideToast();
  const total = r.items.reduce((s, i) => s + i.price, 0);
  const cards = r.items.length === 1 ? r.items[0].label : r.items.length + ' cards';
  const profit = r.items.length === 1 && typeof costProfitSuffix === 'function' ? costProfitSuffix(r.items[0].card, r.items[0].price) : '';
  const t = document.createElement('div');
  t.id = 'qbToast';
  t.className = 'sm-toast';
  t.setAttribute('role', 'status');
  t.innerHTML = `<span>Sold ${smEsc(cards)} · ${_qbMoney(total)} · ${smEsc(r.payment)}${smEsc(profit)}</span>
    <button class="sm-toast-btn" onclick="qbUndo('${ids.map(smEsc).join(',')}')">Undo</button>`;
  document.getElementById('showModeRoot').appendChild(t);
  _qbToastTimer = setTimeout(_qbHideToast, QB_UNDO_MS);
}

async function qbUndo(idList) {
  _qbHideToast();
  for (const id of String(idList).split(',').filter(Boolean)) await smUndoSale(id);
}

function qbReset() { _qbText = ''; _qbHideToast(); }
