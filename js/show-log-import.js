// ════════════════════════════════════════════════════════════════════════════
// Show log import (Trades + Show Home, Phase 3). See CLAUDE.md "Trades + Show Home".
//
// Show Home → "Import show log": a CSV / Excel file, or a table pasted from Claude,
// with the columns Date, Time, Type (SOLD / TRADE / BUY), Cards Out (stock codes),
// Cards In (descriptions), Cash In, Cash Out, Payment Method, Notes.
//
//   read → review (fix highlighted fields; every trade shows its balance) → import
//
// The import is one call to import_show_log() (SQL), all or nothing. Each row has an
// import key (hash of date + time + cards out), so importing the same log again
// adds nothing; rows already in are greyed out in the review.
// "Cards In" become new cards with the next free stock code (or the code written at
// the start of the description, e.g. "S-67: Charizard PSA 9"), marked "Needs details".
// They aren't published to a show until the dealer edits them (Edit Card → Save).
//
// Needs a signal (the import isn't queued offline; retrying is safe).
// Loaded after js/show-home.js. Names start with im.
// ════════════════════════════════════════════════════════════════════════════

let _im = null;   // { showId, dealerShowId, name, startDate, endDate, rows: [...], ready }

function _imEsc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function _imMoney(v) { return typeof shMoney === 'function' ? shMoney(v) : '$' + Number(v || 0).toFixed(2); }

// ── Cards waiting for details (Show Mode "Needs details", Show Home strip) ──
function imNeedsCards() {
  if (typeof getSellerInventory !== 'function' || currentRole !== 'seller') return [];
  return getSellerInventory().filter(c => c.IdentificationStatus === 'unidentified' && c.Status !== 'Sold');
}

// Edit Card → Save on an imported card: it's identified now, and can go live.
function imMarkIdentified(card) {
  card.IdentificationStatus = null;
  if (card._dbId && typeof db !== 'undefined') {
    db.from('inventory').update({ identification_status: null }).eq('id', card._dbId)
      .then(r => { if (r.error) console.warn('[import] identified flag not cleared:', r.error.message); });
    if (activeShowId && card.Status !== 'Sold' && card._trustFlag !== 'flagged' && !(card._shows && card._shows.has(activeShowId))
        && typeof _autoPublishCardToShow === 'function') {
      _autoPublishCardToShow(card, card._dbId, activeShowId);
    }
  }
  if (typeof _smShowId !== 'undefined' && _smShowId && typeof smRefresh === 'function') smRefresh();
}

// Inventory tab, filtered to the cards that need details.
function imShowNeedsCards() {
  if (typeof switchSellerTab === 'function') switchSellerTab('inventory');
  const s = document.getElementById('sellerSearchInput');
  if (s) { s.value = 'needs details'; applyInventoryFilters(); }
}

// ── Parsing ─────────────────────────────────────────────────────────────────
// CSV (quoted fields, commas and line breaks inside quotes), tab-separated
// (pasted from a spreadsheet), or a Markdown table (pasted from Claude).
function imParseTable(text) {
  const t = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (!t) return [];
  const lines = t.split('\n');
  if (lines.filter(l => /^\s*\|/.test(l)).length >= 2) {
    return lines.filter(l => /^\s*\|/.test(l) && !/^\s*\|?[\s:|-]+\|?\s*$/.test(l))
      .map(l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));
  }
  const delim = (lines[0].match(/\t/g) || []).length > (lines[0].match(/,/g) || []).length ? '\t' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"' && t[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"' && cur === '') q = true;
    else if (c === delim) { row.push(cur.trim()); cur = ''; }
    else if (c === '\n') { row.push(cur.trim()); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  row.push(cur.trim()); rows.push(row);
  return rows.filter(r => r.some(v => v !== ''));
}

const IM_HEADERS = {
  date: /^(date|day)$/, time: /^(time|when)$/, type: /^(type|kind|txn|transaction(type)?)$/,
  out: /^(cards?out|out|codes?out|gave|outcards?)$/, in: /^(cards?in|in|got|received(cards?)?|incards?)$/,
  cashIn: /^(cashin|cashreceived|received|in\$|cashin\$)$/, cashOut: /^(cashout|cashpaid|paid|out\$|cashout\$)$/,
  pm: /^(paymentmethod|payment|method|paidwith)$/, note: /^(notes?|comments?|memo)$/,
};

// Header row → { field: column index }. The header is the first row that has a Type
// column and a Cards Out or Date column.
function _imHeaderMap(rows) {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const map = {};
    rows[r].forEach((h, i) => {
      const k = String(h || '').toLowerCase().replace(/[^a-z$]/g, '');
      for (const [f, re] of Object.entries(IM_HEADERS)) if (map[f] == null && re.test(k)) { map[f] = i; break; }
    });
    if (map.type != null && (map.out != null || map.date != null)) return { map, at: r };
  }
  return null;
}

function _imCash(v) {
  const s = String(v ?? '').trim();
  if (!s || s === '-' || s === '—') return 0;
  const n = parseFloat(s.replace(/[$,\s]/g, ''));
  return isNaN(n) ? NaN : n;
}

const IM_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// 2026-11-07, 11/7/2026, 11/7/26, 11/7, Nov 7, 2026, Nov 7, 7 Nov 2026 → 'YYYY-MM-DD' (or null).
function imDate(s, year) {
  const t = String(s || '').trim().toLowerCase();
  if (!t) return null;
  let y, m, d, x;
  if ((x = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) [y, m, d] = [+x[1], +x[2], +x[3]];
  else if ((x = t.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/))) { m = +x[1]; d = +x[2]; y = x[3] ? +x[3] : year; }
  else if ((x = t.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?$/))) { m = IM_MONTHS[x[1]]; d = +x[2]; y = x[3] ? +x[3] : year; }
  else if ((x = t.match(/^(\d{1,2})\s+([a-z]{3})[a-z]*\.?,?(?:\s+(\d{4}))?$/))) { d = +x[1]; m = IM_MONTHS[x[2]]; y = x[3] ? +x[3] : year; }
  else return null;
  if (y && y < 100) y += 2000;
  if (!y || !m || !d || m > 12 || d > 31) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getMonth() !== m - 1) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// "2:15 PM", "2:15pm", "14:15", "2pm" → { h, m } (24h), or null.
function imTime(s) {
  const t = String(s || '').trim().toLowerCase().replace(/\s+/g, '');
  const x = t.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?(am|pm|a|p)?$/);
  if (!x) return null;
  let h = +x[1]; const m = x[2] ? +x[2] : 0;
  if (x[3]) { if (h < 1 || h > 12) return null; h = (h % 12) + (x[3][0] === 'p' ? 12 : 0); }
  if (h > 23 || m > 59) return null;
  return { h, m };
}
function _imTimeLabel(tm) { return tm ? `${tm.h % 12 || 12}:${String(tm.m).padStart(2, '0')} ${tm.h < 12 ? 'AM' : 'PM'}` : ''; }

function imType(s) {
  const t = String(s || '').trim().toLowerCase();
  if (/trade/.test(t)) return 'trade';
  if (/^(buy|bought|purchase|purchased|b)$/.test(t) || /\bbuy\b|bought|purchas/.test(t)) return 'buy';
  if (/sold|sale|sell|^lot/.test(t)) return 'sale';
  return null;
}

// A stock code at the start of a token: S12, S-12, "Slab 12", "single 4", R4.
const IM_CODE_RE = /^(slabs?|singles?|raw|box(?:es)?|sealed|lots?|bundles?|[srbl])\s*#?\s*-?\s*(\d+)\b/i;
function _imCodeOf(text) {
  const x = String(text || '').trim().match(IM_CODE_RE);
  if (!x) return null;
  const w = x[1].toLowerCase();
  const p = /^s(lab)?/.test(w) && w !== 'sealed' && !/^single/.test(w) ? 'S' : /^(single|raw|r)/.test(w) ? 'R' : /^(box|sealed|b)/.test(w) ? 'B' : 'L';
  return p + '-' + (+x[2]);
}
function imSplitOut(s) {
  return String(s || '').split(/[,;+&|\n]|\band\b/i).map(x => x.trim()).filter(Boolean);
}
function imSplitIn(s) {
  return String(s || '').split(/[;|\n]|,(?![^(]*\))/).map(x => x.trim()).filter(x => x && !/^(none|nothing|n\/a|-|—)$/i.test(x));
}
// "S-67: Charizard PSA 9" / "Slab 67 - Charizard" → { code: 'S-67', title: 'Charizard PSA 9' }.
// A bare "R2" needs a separator after it, so a title like "R2-D2 …" isn't read as a code.
function imParseInCard(s) {
  const t = String(s || '').trim();
  let x = t.match(/^((?:slabs?|singles?|raw|box(?:es)?|sealed|lots?|bundles?)\s*#?\s*\d+|[SRBL]-\d+)\s*[:\-–—)]?\s+(.+)$/i)
       || t.match(/^([SRBL]\d+)\s*[:\-–—)]\s+(.+)$/i);
  const code = x ? _imCodeOf(x[1]) : null;
  const title = (x ? x[2] : t).trim();
  const g = title.match(/\b(PSA|BGS|CGC|SGC|TAG|HGA|GMA)\s*(\d{1,2}(?:\.5)?)\b/i);
  return { code, title, grader: g ? g[1].toUpperCase() : null, grade: g ? g[2] : null };
}

async function _imHash(s) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return 'log:' + [...new Uint8Array(buf)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return 'log:' + (h >>> 0).toString(16) + ':' + s.length;
  }
}

// Table rows → review rows.
async function imBuildRows(table, opts) {
  const head = _imHeaderMap(table);
  if (!head) return { error: 'Couldn\'t find the header row. The log needs at least Type and Cards Out (or Date) columns.' };
  const { map, at } = head;
  const year = Number(String(opts.startDate || '').slice(0, 4)) || new Date().getFullYear();
  const cell = (r, f) => (map[f] != null ? String(r[map[f]] ?? '').trim() : '');
  const rows = [];
  for (let n = at + 1; n < table.length; n++) {
    const r = table[n];
    if (!r.some(v => String(v).trim())) continue;
    const dateText = cell(r, 'date'), timeText = cell(r, 'time');
    const date = imDate(dateText, year) || (!dateText ? opts.startDate || null : null);
    const tm = imTime(timeText);
    const outs = imSplitOut(cell(r, 'out')).map(text => ({ text, code: _imCodeOf(text), value: null, est: false }));
    const ins = imSplitIn(cell(r, 'in')).map(text => Object.assign(imParseInCard(text), { value: null, est: false }));
    const row = {
      n: rows.length + 1, include: true, dup: false, dateText, timeText, date, tm, dateGuessed: !dateText && !!date,
      typeText: cell(r, 'type'), type: imType(cell(r, 'type')),
      cashIn: _imCash(cell(r, 'cashIn')), cashOut: _imCash(cell(r, 'cashOut')),
      pm: cell(r, 'pm'), note: cell(r, 'note'), outs, ins,
    };
    // Import key: date + time + cards out (cards in when nothing went out). A row with no
    // time uses its row number, so two untimed rows on one day stay apart.
    const outKey = outs.map(o => o.code || o.text.toLowerCase()).sort().join(',');
    row.key = await _imHash([date || dateText, tm ? _imTimeLabel(tm) : '#' + row.n, outKey,
                             outs.length ? '' : ins.map(i => i.title.toLowerCase()).join(',')].join('|'));
    rows.push(row);
  }
  rows.sort((a, b) => _imSortKey(a).localeCompare(_imSortKey(b)) || a.n - b.n);
  return { rows };
}
function _imSortKey(r) { return (r.date || '9999') + (r.tm ? String(r.tm.h).padStart(2, '0') + String(r.tm.m).padStart(2, '0') : '9999'); }

// Starting values. A row's values only come from the log or from the balance; anything
// estimated is marked and shown in amber. A split across several cards is never assumed:
// those values are left for the dealer.
function _imCardByCode(code) {
  if (!code) return null;
  const k = stockCodeKey(code);
  return getSellerInventory().find(c => c.StockCode && stockCodeKey(c.StockCode) === k) || null;
}
function _imAsk(o) { const c = _imCardByCode(o.code); return c && Number(c.Price) > 0 ? Number(c.Price) : null; }
function imAutoValues(row) {
  const cin = isNaN(row.cashIn) ? 0 : row.cashIn, cout = isNaN(row.cashOut) ? 0 : row.cashOut;
  row.outs.forEach(o => { o.value = null; o.est = false; });
  row.ins.forEach(i => { i.value = null; i.est = false; });
  if (row.type === 'sale') {
    if (row.outs.length === 1) row.outs[0].value = cin;
    else if (row.outs.length > 1 && typeof ssAllocate === 'function') {
      const split = ssAllocate(cin, row.outs.map(o => ({ typed: null, weight: _imAsk(o) })));
      row.outs.forEach((o, j) => { o.value = split[j]; o.est = true; });
    }
  } else if (row.type === 'buy') {
    if (row.ins.length === 1) row.ins[0].value = cout;
  } else if (row.type === 'trade') {
    if (row.outs.length === 1 && row.ins.length === 1) {
      const ask = _imAsk(row.outs[0]);
      if (ask != null) {
        row.outs[0].value = ask; row.outs[0].est = true;
        const v = Math.round((ask + cout - cin) * 100) / 100;
        if (v >= 0) { row.ins[0].value = v; row.ins[0].est = true; }
      }
    } else if (row.ins.length === 0) {
      row.outs.forEach(o => { const a = _imAsk(o); if (a != null) { o.value = a; o.est = true; } });
    }
  }
}

// ── Checks: errors block the import, warnings don't ─────────────────────────
function imValidate() {
  if (!_im) return;
  const inv = new Map(getSellerInventory().filter(c => c.StockCode).map(c => [stockCodeKey(c.StockCode), c]));
  const fromLog = new Map();   // code → { ref } for cards that came in earlier in this log
  const used = new Map();      // code / card id → row number that took it out
  const start = _im.startDate, end = _im.endDate || _im.startDate;
  _im.rows.forEach(row => {
    row.errors = []; row.warns = [];
    row.outs.forEach(o => { o.ref = null; o.card = null; o.err = null; });
    if (!row.include || row.dup) return;
    const err = m => row.errors.push(m), warn = m => row.warns.push(m);
    if (!row.date) err(row.dateText ? `Can't read the date "${row.dateText}"` : 'Add a date');
    else if (start && (row.date < start || row.date > end)) warn(`Date ${row.date} is outside this show's dates`);
    if (row.dateGuessed) warn('No date in the log: using the show\'s date');
    if (row.timeText && !row.tm) err(`Can't read the time "${row.timeText}"`);
    if (!row.type) err(row.typeText ? `Unknown type "${row.typeText}" (use SOLD, TRADE or BUY)` : 'Add a type (SOLD, TRADE or BUY)');
    if (isNaN(row.cashIn) || row.cashIn < 0) err('Cash in must be a number');
    if (isNaN(row.cashOut) || row.cashOut < 0) err('Cash out must be a number');
    if ((row.type === 'sale' || row.type === 'trade') && !row.outs.length) err('No cards out');
    if (row.type === 'buy' && row.outs.length) err('A buy has no cards out. Change the type to Trade?');
    if (row.type === 'buy' && !row.ins.length) err('No cards in');
    if (row.type === 'sale' && row.ins.length) warn('Cards in on a sale are ignored. Change the type to Trade?');
    row.outs.forEach(o => {
      const label = o.code || o.text;
      if (!o.code) { o.err = `"${o.text}" isn't a stock code`; err(o.err); return; }
      const k = stockCodeKey(o.code);
      if (used.has(k)) { o.err = `${o.code} already went out in row ${used.get(k)}`; err(o.err); return; }
      if (fromLog.has(k)) { o.ref = fromLog.get(k); used.set(k, row.n); }
      else {
        const c = inv.get(k);
        if (!c) { o.err = `${o.code} isn't in your inventory`; err(o.err); return; }
        if (c.Status === 'Sold') { o.err = `${o.code} is already sold`; err(o.err); return; }
        if (!c._dbId) { o.err = `${o.code} hasn't synced yet`; err(o.err); return; }
        o.card = c; used.set(k, row.n);
      }
      if (o.value == null || isNaN(o.value) || o.value < 0) err(`Enter what ${label} went for`);
      else if (o.est) warn(`${label}: ${row.type === 'sale' ? 'split of the lot price, by asking price' : 'value is its asking price'}. Check it`);
    });
    if (row.type !== 'sale') row.ins.forEach((i, j) => {
      i.ref = row.key + ':in:' + j;
      if (!i.title.trim()) err('A card in has no description');
      if (i.value == null || isNaN(i.value) || i.value < 0) err(`Enter the ${row.type === 'buy' ? 'price paid for' : 'value of'} "${i.title || 'card in'}"`);
      else if (i.est) warn(`"${i.title}": value worked out from the balance. Check it`);
      if (i.code) {
        const k = stockCodeKey(i.code);
        if (inv.has(k) || fromLog.has(k)) { warn(`${i.code} is already used: "${i.title}" gets the next free code`); i.codeTaken = true; }
        else { i.codeTaken = false; fromLog.set(k, i.ref); }
      }
    });
    if (row.type === 'trade' && row.ins.length) {
      row.delta = imBalance(row);
      if (Math.abs(row.delta) >= 0.01) warn(`Doesn't balance: ${_imMoney(Math.abs(row.delta))} ${row.delta > 0 ? 'more went out' : 'more came in'}. Fine if that's what happened`);
    } else row.delta = 0;
  });
  _im.ready = _im.rows.filter(r => r.include && !r.dup);
  _im.blocked = _im.ready.filter(r => r.errors.length).length;
}
function imBalance(row) {
  const s = arr => arr.reduce((t, x) => t + (Number(x.value) || 0), 0);
  return Math.round((s(row.outs) + (Number(row.cashOut) || 0) - s(row.ins) - (Number(row.cashIn) || 0)) * 100) / 100;
}

// ── Screens ─────────────────────────────────────────────────────────────────
function imOpen() {
  const k = typeof _shKey !== 'undefined' ? _shKey : null;
  if (!k) return;
  const listRow = (typeof _shList !== 'undefined' && _shList || []).find(x => x.show_id === k.showId && x.dealer_show_id === k.dealerShowId) || {};
  const s = k.showId && shows[k.showId];
  _im = { showId: k.showId || null, dealerShowId: k.dealerShowId || null, name: k.name,
          startDate: listRow.start_date || (s && s.startDate) || null, endDate: listRow.end_date || (s && (s.endDate || s.startDate)) || null, rows: [] };
  _imOverlay(`
    <div class="im-head"><div class="sh-card-title">Import show log · ${_imEsc(_im.name)}</div>
      <button class="sm-x im-x" onclick="imClose()" aria-label="Close">✕</button></div>
    <p class="sh-muted">Columns: <strong>Date, Time, Type</strong> (SOLD / TRADE / BUY), <strong>Cards Out</strong> (stock codes, e.g. S12, Slab 12),
      <strong>Cards In</strong> (what you got), <strong>Cash In, Cash Out</strong>, Payment Method, Notes.
      A CSV or Excel file, or paste the table straight from Claude.</p>
    <div class="im-pick">
      <button class="btn btn-primary" onclick="document.getElementById('imFile').click()">Choose file</button>
      <input type="file" id="imFile" accept=".csv,.txt,.tsv,.xlsx,.xls,text/csv" style="display:none" onchange="imReadFile(this)">
    </div>
    <label class="im-paste-label" for="imPaste">Or paste the log</label>
    <textarea id="imPaste" class="im-paste" rows="7" placeholder="Date,Time,Type,Cards Out,Cards In,Cash In,Cash Out,Payment Method,Notes"></textarea>
    <div class="sh-actions"><button class="btn btn-ghost" onclick="imClose()">Cancel</button>
      <button class="btn btn-primary" onclick="imReadPasted()">Read log</button></div>
    <div id="imMsg" class="im-msg" role="alert"></div>`);
}

function _imOverlay(html) {
  let ov = document.getElementById('imOverlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'imOverlay';
    ov.className = 'modal-overlay open im-ov';
    document.body.appendChild(ov);
  }
  ov.innerHTML = `<div class="modal im-modal" role="dialog" aria-label="Import show log">${html}</div>`;
}
function imClose() { document.getElementById('imOverlay')?.remove(); _im = null; }
function _imMsg(m) { const el = document.getElementById('imMsg'); if (el) el.textContent = m; else showToast(m, 'var(--danger)'); }

async function imReadFile(input) {
  const f = input.files && input.files[0];
  input.value = '';
  if (!f) return;
  let table;
  if (/\.xlsx?$/i.test(f.name)) {
    if (typeof XLSX === 'undefined') { _imMsg('Excel isn\'t available. Save the log as CSV.'); return; }
    const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
    table = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' }).map(r => r.map(v => String(v)));
  } else table = imParseTable(await f.text());
  await imLoadTable(table);
}
async function imReadPasted() { await imLoadTable(imParseTable(document.getElementById('imPaste')?.value || '')); }

async function imLoadTable(table) {
  if (!_im) return;
  if (!table.length) { _imMsg('That log is empty.'); return; }
  const res = await imBuildRows(table, { startDate: _im.startDate });
  if (res.error) { _imMsg(res.error); return; }
  if (!res.rows.length) { _imMsg('No rows under the header.'); return; }
  res.rows.forEach(imAutoValues);
  _im.rows = res.rows;
  const keys = await db.rpc('show_log_imported_keys', { p_keys: res.rows.map(r => r.key) });
  if (keys.error) {
    if (typeof _shRpcMissing === 'function' && _shRpcMissing(keys)) { _imMsg('Importing show logs is being set up. Check back soon.'); return; }
    _imMsg('Couldn\'t check for rows already imported — ' + keys.error.message); return;
  }
  const done = new Set(keys.data || []);
  _im.rows.forEach(r => { if (done.has(r.key)) { r.dup = true; r.include = false; } });
  imValidate();
  imRenderReview();
}

const IM_TYPE_LABEL = { sale: 'Sold', trade: 'Trade', buy: 'Buy' };
function _imRowHTML(row, i) {
  if (row.dup) {
    return `<div class="im-row im-row--dup" data-i="${i}"><div class="im-row-head"><span class="im-n">Row ${row.n}</span>
      <span>${_imEsc([row.date, _imTimeLabel(row.tm), IM_TYPE_LABEL[row.type] || row.typeText].filter(Boolean).join(' · '))}</span>
      <span class="im-pill im-pill--dup">Already imported</span></div></div>`;
  }
  const typeSel = `<select class="filter-select im-type" onchange="imSet(${i},'type',this.value)" aria-label="Type">
      ${!row.type ? `<option value="">${_imEsc(row.typeText || 'Type?')}</option>` : ''}
      ${['sale', 'trade', 'buy'].map(t => `<option value="${t}"${row.type === t ? ' selected' : ''}>${IM_TYPE_LABEL[t]}${t === 'sale' && row.outs.length > 1 ? ' (lot)' : ''}</option>`).join('')}
    </select>`;
  const outRows = row.outs.map((o, j) => {
    const c = o.card || _imCardByCode(o.code);
    return `<div class="im-card${o.err ? ' im-bad' : ''}">
      <input class="filter-select im-code${o.err ? ' im-field-bad' : ''}" value="${_imEsc(o.code || o.text)}" aria-label="Stock code" onchange="imSet(${i},'outCode',this.value,${j})">
      <span class="im-card-title">${o.ref ? 'Came in earlier in this log' : _imEsc(c ? c['Card Title'] : (o.err || ''))}</span>
      <input class="filter-select im-val${o.est ? ' im-est' : ''}${o.value == null ? ' im-field-bad' : ''}" inputmode="decimal" value="${o.value == null ? '' : o.value}" placeholder="$" aria-label="Value" data-f="outVal-${j}" oninput="imSet(${i},'outVal',this.value,${j})">
    </div>`;
  }).join('');
  const inRows = row.type === 'sale' ? '' : row.ins.map((n, j) => `<div class="im-card">
      ${n.code && !n.codeTaken ? `<span class="stock-chip">${_imEsc(n.code)}</span>` : ''}
      <input class="filter-select im-in-title${n.title.trim() ? '' : ' im-field-bad'}" value="${_imEsc(n.title)}" aria-label="Card in" data-f="inTitle-${j}" oninput="imSet(${i},'inTitle',this.value,${j})">
      <input class="filter-select im-val${n.est ? ' im-est' : ''}${n.value == null ? ' im-field-bad' : ''}" inputmode="decimal" value="${n.value == null ? '' : n.value}" placeholder="$" aria-label="Value" data-f="inVal-${j}" oninput="imSet(${i},'inVal',this.value,${j})">
      <button class="sh-link" onclick="imSet(${i},'inRemove',null,${j})" aria-label="Remove">✕</button>
    </div>`).join('');
  return `<div class="im-row${row.include ? '' : ' im-row--off'}" data-i="${i}">
    <div class="im-row-head">
      <label class="im-inc"><input type="checkbox" ${row.include ? 'checked' : ''} onchange="imSet(${i},'include',this.checked)"> Row ${row.n}</label>
      <span class="${row.date ? '' : 'im-text-bad'}">${_imEsc(row.date || row.dateText || 'No date')}${row.tm ? ' · ' + _imTimeLabel(row.tm) : (row.timeText ? ' · ' + _imEsc(row.timeText) : '')}</span>
      ${typeSel}
      <span class="im-pill" data-pill></span>
    </div>
    ${row.include ? `
    <div class="im-sides">
      ${row.type !== 'buy' ? `<div><div class="sh-side">Out</div>${outRows || '<div class="sh-muted">None</div>'}</div>` : ''}
      ${row.type && row.type !== 'sale' ? `<div><div class="sh-side">In</div>${inRows || '<div class="sh-muted">Nothing recorded coming back</div>'}
        <button class="sh-link" onclick="imSet(${i},'inAdd')">+ Add card in</button></div>` : ''}
    </div>
    <div class="im-cash">
      <label>You received <input class="filter-select im-val${isNaN(row.cashIn) ? ' im-field-bad' : ''}" inputmode="decimal" value="${isNaN(row.cashIn) ? '' : row.cashIn}" data-f="cashIn-0" oninput="imSet(${i},'cashIn',this.value)"></label>
      <label>You paid <input class="filter-select im-val${isNaN(row.cashOut) ? ' im-field-bad' : ''}" inputmode="decimal" value="${isNaN(row.cashOut) ? '' : row.cashOut}" data-f="cashOut-0" oninput="imSet(${i},'cashOut',this.value)"></label>
      ${row.pm ? `<span class="sh-muted">${_imEsc(row.pm)}</span>` : ''}
    </div>
    <div class="im-balance" data-balance></div>
    <ul class="im-msgs" data-msgs></ul>
    ${row.note ? `<div class="sh-muted im-note">${_imEsc(row.note)}</div>` : ''}` : ''}
  </div>`;
}

function imRenderReview() {
  if (!_im) return;
  _imOverlay(`
    <div class="im-head"><div class="sh-card-title">Review · ${_imEsc(_im.name)}</div>
      <button class="sm-x im-x" onclick="imClose()" aria-label="Close">✕</button></div>
    <p class="sh-muted">Fix anything in red. Amber values were worked out for you: check them. Untick a row to leave it out.</p>
    <div class="im-rows">${_im.rows.map(_imRowHTML).join('')}</div>
    <div class="im-foot">
      <span class="im-summary" data-summary></span>
      <button class="btn btn-ghost" onclick="imOpen()">Back</button>
      <button class="btn btn-primary" id="imImportBtn" onclick="imCommit()">Import</button>
    </div>`);
  imPaint();
}

// Status, balance and messages only, so typing in a field keeps its focus.
function imPaint() {
  if (!_im) return;
  _im.rows.forEach((row, i) => {
    const el = document.querySelector(`#imOverlay .im-row[data-i="${i}"]`);
    if (!el || row.dup) return;
    const pill = el.querySelector('[data-pill]');
    if (pill) {
      pill.className = 'im-pill ' + (!row.include ? 'im-pill--off' : row.errors.length ? 'im-pill--bad' : row.warns.length ? 'im-pill--warn' : 'im-pill--ok');
      pill.textContent = !row.include ? 'Left out' : row.errors.length ? `Fix ${row.errors.length}` : row.warns.length ? 'Check' : 'Ready';
    }
    const bal = el.querySelector('[data-balance]');
    if (bal) {
      const s = arr => arr.reduce((t, x) => t + (Number(x.value) || 0), 0);
      bal.innerHTML = row.type === 'trade' && row.ins.length
        ? `Out ${_imMoney(s(row.outs))}${row.cashOut ? ' + paid ' + _imMoney(row.cashOut) : ''} · In ${_imMoney(s(row.ins))}${row.cashIn ? ' + received ' + _imMoney(row.cashIn) : ''}
           → <strong class="${Math.abs(row.delta) >= 0.01 ? 'im-text-warn' : 'im-text-ok'}">${Math.abs(row.delta) >= 0.01 ? _imMoney(Math.abs(row.delta)) + ' unaccounted' : 'balanced'}</strong>`
        : row.type === 'trade' ? '<span class="sh-muted">Nothing recorded coming back: counted as cards traded with no record of what came back.</span>' : '';
    }
    const msgs = el.querySelector('[data-msgs]');
    if (msgs) msgs.innerHTML = row.errors.map(m => `<li class="im-text-bad">${_imEsc(m)}</li>`).join('') + row.warns.map(m => `<li class="im-text-warn">${_imEsc(m)}</li>`).join('');
  });
  const dups = _im.rows.filter(r => r.dup).length;
  const sum = document.querySelector('#imOverlay [data-summary]');
  if (sum) sum.textContent = [`${_im.ready.length} to import`, _im.blocked ? `${_im.blocked} to fix` : null, dups ? `${dups} already imported` : null].filter(Boolean).join(' · ');
  const btn = document.getElementById('imImportBtn');
  if (btn) { btn.disabled = !_im.ready.length || _im.blocked > 0; btn.textContent = `Import ${_im.ready.length}`; }
}

function imSet(i, what, v, j) {
  const row = _im && _im.rows[i];
  if (!row) return;
  const num = x => { const s = String(x ?? '').trim(); if (!s) return null; const n = parseFloat(s.replace(/[$,\s]/g, '')); return isNaN(n) ? NaN : n; };
  let redraw = false;
  if (what === 'include') { row.include = !!v; redraw = true; }
  else if (what === 'type') { row.type = v || null; imAutoValues(row); redraw = true; }
  else if (what === 'cashIn' || what === 'cashOut') { const n = num(v); row[what] = n == null ? 0 : n; }
  else if (what === 'outCode') { const o = row.outs[j]; o.text = String(v || '').trim(); o.code = _imCodeOf(o.text); redraw = true; }
  else if (what === 'outVal') { const o = row.outs[j]; o.value = num(v); o.est = false; }
  else if (what === 'inTitle') { const n = row.ins[j]; const p = imParseInCard(v); n.title = String(v || ''); n.grader = p.grader; n.grade = p.grade; }
  else if (what === 'inVal') { const n = row.ins[j]; n.value = num(v); n.est = false; }
  else if (what === 'inAdd') { row.ins.push({ code: null, title: '', grader: null, grade: null, value: null, est: false }); redraw = true; }
  else if (what === 'inRemove') { row.ins.splice(j, 1); redraw = true; }
  imValidate();
  if (redraw) {
    const el = document.querySelector(`#imOverlay .im-row[data-i="${i}"]`);
    if (el) el.outerHTML = _imRowHTML(row, i);
  } else {
    // Typing in a field: update its own highlight only, so it keeps focus.
    const inp = document.querySelector(`#imOverlay .im-row[data-i="${i}"] [data-f="${what}-${j || 0}"]`);
    if (inp) {
      const item = what === 'outVal' ? row.outs[j] : (what === 'inVal' || what === 'inTitle') ? row.ins[j] : null;
      const bad = what === 'inTitle' ? !item.title.trim() : item ? (item.value == null || isNaN(item.value) || item.value < 0) : isNaN(row[what]) || row[what] < 0;
      inp.classList.toggle('im-field-bad', bad);
      inp.classList.remove('im-est');
    }
  }
  imPaint();
}

// ── Import ──────────────────────────────────────────────────────────────────
function imPayload() {
  return _im.ready.map(row => {
    const at = new Date(...row.date.split('-').map((x, k) => (k === 1 ? +x - 1 : +x)), row.tm ? row.tm.h : 12, row.tm ? row.tm.m : 0);
    const type = row.type === 'sale' && row.outs.length > 1 ? 'lot_sale' : row.type;
    return {
      key: row.key, occurred_at: at.toISOString(), local_date: row.date, local_time: row.tm ? _imTimeLabel(row.tm) : '',
      txn_type: type, cash_in: row.cashIn || 0, cash_out: row.cashOut || 0,
      payment_method: row.pm || null, note: row.note || null,
      out: row.type === 'buy' ? [] : row.outs.map(o => (o.ref ? { ref: o.ref, value: o.value } : { inventory_id: o.card._dbId, value: o.value })),
      in: row.type === 'sale' ? [] : row.ins.map(n => ({ ref: n.ref, title: n.title.trim(), value: n.value, grader: n.grader, grade: n.grade,
                                                         stock_code: n.code && !n.codeTaken ? n.code : null })),
    };
  });
}

const IM_ERRORS = {
  already_sold: 'was sold while you were reviewing. Read the log again.',
  not_your_card: 'isn\'t one of your cards.',
  unknown_card: 'couldn\'t be matched.',
  show_not_found: 'This show couldn\'t be found.',
};
async function imCommit() {
  if (!_im) return;
  imValidate();
  if (_im.blocked || !_im.ready.length) { imPaint(); return; }
  const btn = document.getElementById('imImportBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
  const res = await db.rpc('import_show_log', { p_show_id: _im.showId, p_dealer_show_id: _im.dealerShowId, p_txns: imPayload() });
  if (res.error || !res.data) {
    const m = (res.error && res.error.message) || 'unknown error';
    const x = m.match(/^(already_sold|not_your_card|unknown_card)\s+(\S+)/);
    const net = typeof _smIsNetworkError === 'function' && _smIsNetworkError(res);
    showToast(net ? 'No signal — try again when you\'re online. Nothing was imported.'
      : x ? `${x[2]} ${IM_ERRORS[x[1]]} Nothing was imported.` : (IM_ERRORS[m] || 'Import failed — ' + m), 'var(--danger)');
    imPaint();
    return;
  }
  const d = res.data, made = (d.created || []).length, dup = (d.duplicates || []).length;
  const show = { showId: _im.showId, dealerShowId: _im.dealerShowId };
  imClose();
  showToast(`✓ Imported ${d.imported} transaction${d.imported === 1 ? '' : 's'}`
    + (made ? ` · ${made} new card${made === 1 ? '' : 's'} need details` : '') + (dup ? ` · ${dup} already in` : ''));
  await imReloadAfter();
  if (typeof shOpenShow === 'function') shOpenShow(show.showId, show.dealerShowId);
}

async function imReloadAfter() {
  const handle = currentSeller;
  if (!handle) return;
  try {
    await fetchSellerInventoryFromDB(handle);
    if (typeof hydrateCardShowMembership === 'function') await hydrateCardShowMembership(handle);
    if (typeof costHydrate === 'function') await costHydrate();
  } catch (e) { console.warn('[import] reload', e.message); }
  if (typeof _smAfterInventoryChange === 'function') _smAfterInventoryChange();
  else { renderSellerTable(getSellerInventory()); updateStats(); }
  if (typeof _costRerender === 'function') _costRerender();
  if (typeof gtcrScheduleReconcile === 'function') gtcrScheduleReconcile();   // sold slabs leave the GTCR registry
}
