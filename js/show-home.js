// ════════════════════════════════════════════════════════════════════════════
// Show Home (Trades + Show Home, Phase 2). See CLAUDE.md "Trades + Show Home".
//
// Seller tab "Shows": the dealer's shows with net P/L each, and for one show the
// Show Home report (Tito's Show Report): KPIs, what left / results donuts, trades vs
// cash sales, what came in / still on hand, inventory start vs end, every card out,
// data-quality warnings, CSV export. Every number comes from dealer_show_report()
// and dealer_show_list() (SQL); nothing is recomputed here except display rounding.
//
// Also: inventory snapshots (show_start when a show starts, show_end from "End show"
// or the hourly close-show-snapshots job, and an inventory baseline with "growth
// since baseline").
//
// PRIVATE: Show Home is the dealer's own view. NEVER render it, or its numbers, in
// an organizer view, buyer page, share card, caption or OG tag. No payment photos.
//
// Loaded after js/snap-sell.js. Names start with sh.
// ════════════════════════════════════════════════════════════════════════════

let _shList = null;          // dealer_show_list() result
let _shKey = null;           // { showId, dealerShowId, name, date, venue }
let _shReport = null;        // dealer_show_report() result
let _shSort = { k: 'at', dir: 1 };
let _shDonut = 'cards';      // What left: 'cards' | 'value'
let _shOnlyMissingCost = false;
let _shBaseline = null;      // latest baseline snapshot row
let _shMissing = false;      // Phase 1/2 migrations not run

function _shEsc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function _shNum(v) { const n = Number(v); return isFinite(n) ? n : 0; }
// $1,234 or $1,234.50 — whole dollars when the amount is whole.
function shMoney(v) {
  const n = Math.abs(_shNum(v));
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
}
// +$240 / −$90 / $0
function shSigned(v) { const n = _shNum(v); return (n > 0 ? '+' : n < 0 ? '−' : '') + shMoney(n); }
// 0.0744 → 7.4%  (null → —)
function shPct(v) { return v == null ? '—' : (Math.round(_shNum(v) * 1000) / 10).toFixed(1).replace(/\.0$/, '.0') + '%'; }
function _shCls(v) { const n = _shNum(v); return n > 0 ? 'sh-pos' : n < 0 ? 'sh-neg' : ''; }
function _shDate(s) {
  if (!s) return '';
  const d = new Date(String(s).length === 10 ? s + 'T12:00:00' : s);
  return isNaN(d) ? String(s) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function _shRpcMissing(res) {
  const e = res && res.error;
  return !!e && (e.code === 'PGRST202' || /could not find the function/i.test(e.message || '') || e.code === '42P01');
}
function _shPanel() { return document.getElementById('showHomePanel'); }

// ── Tab entry ───────────────────────────────────────────────────────────────
function shOpenTab() {
  if (_shKey) return shOpenShow(_shKey.showId, _shKey.dealerShowId);
  return shRenderListView();
}

async function shRenderListView() {
  _shKey = null; _shReport = null;
  const el = _shPanel();
  if (!el) return;
  el.innerHTML = '<div class="sh-loading">Loading your shows…</div>';
  const res = await db.rpc('dealer_show_list');
  if (res.error) {
    _shMissing = _shRpcMissing(res);
    el.innerHTML = `<div class="sh-empty">${_shMissing ? 'Show results are being set up. Check back soon.' : 'Couldn\'t load your shows — ' + _shEsc(res.error.message)}</div>`;
    return;
  }
  _shList = res.data || [];
  const total = _shList.reduce((s, x) => s + _shNum(x.net_pl), 0);
  const cards = _shList.reduce((s, x) => s + _shNum(x.cards_out), 0);
  const rows = _shList.map((x, i) => {
    const when = x.kind === 'private' ? _shDate(x.start_date) : (x.start_date ? _shDate(x.start_date) : (x.date_text || ''));
    return `<button class="sh-show-row" onclick="shOpenShowAt(${i})">
      <span class="sh-show-main"><span class="sh-show-name">${_shEsc(x.name)}${x.kind === 'private' ? ' <span class="sh-tag">Your show</span>' : ''}</span>
        <span class="sh-show-meta">${_shEsc(when)} · ${x.cards_out} card${x.cards_out === 1 ? '' : 's'} out</span></span>
      <span class="sh-show-pl ${_shCls(x.net_pl)}">${x.cards_out ? shSigned(x.net_pl) : '—'}</span>
    </button>`;
  }).join('');
  el.innerHTML = `
    <div class="sh-list-head">
      <div><h3 class="sh-h">Your shows</h3><div class="sh-muted">Profit on every card that left: sales and trades, against what you paid.</div></div>
      <div class="sh-alltime"><span class="sh-muted">All shows</span><strong class="${_shCls(total)}">${shSigned(total)}</strong><span class="sh-muted">${cards} cards out</span></div>
    </div>
    <div class="sh-show-list">${rows || '<div class="sh-empty">No shows yet. Join a show, or add one you did outside CardShow.</div>'}</div>
    <details class="sh-add" id="shAddShow">
      <summary>+ Add a show you did outside CardShow</summary>
      <div class="sh-add-form">
        <label>Show name<input id="shNewName" class="filter-select" placeholder="Mall Show"></label>
        <label>Date<input id="shNewDate" type="date" class="filter-select" value="${_todayISO()}"></label>
        <label>Venue (optional)<input id="shNewVenue" class="filter-select"></label>
        <button class="btn btn-primary" onclick="shAddPrivateShow()">Add show</button>
      </div>
    </details>`;
}

function shOpenShowAt(i) {
  const x = _shList && _shList[i];
  if (!x) return;
  _shKey = { showId: x.show_id, dealerShowId: x.dealer_show_id, name: x.name, kind: x.kind,
             date: x.kind === 'private' ? _shDate(x.start_date) : (x.start_date ? _shDate(x.start_date) : (x.date_text || '')),
             endDate: x.end_date || x.start_date };
  shOpenShow(x.show_id, x.dealer_show_id);
}

async function shAddPrivateShow() {
  const name = (document.getElementById('shNewName')?.value || '').trim();
  const date = document.getElementById('shNewDate')?.value || '';
  const venue = (document.getElementById('shNewVenue')?.value || '').trim();
  if (!name || !date) { showToast('Add the show name and date', 'var(--danger)'); return; }
  const { data: { user } } = await db.auth.getUser();
  const res = await db.from('dealer_shows').insert({ owner_id: user && user.id, name, show_date: date, venue: venue || null });
  if (res.error) { showToast('Couldn\'t add the show — ' + res.error.message, 'var(--danger)'); return; }
  showToast(`✓ ${name} added`);
  shRenderListView();
}

// ── Show Home ───────────────────────────────────────────────────────────────
async function shOpenShow(showId, dealerShowId) {
  const el = _shPanel();
  if (!el) return;
  if (!_shKey || _shKey.showId !== showId || _shKey.dealerShowId !== dealerShowId) {
    const s = showId && shows[showId];
    _shKey = { showId, dealerShowId, name: s ? s.name : 'Show', date: s ? (s.date || '') : '', kind: showId ? 'cardshow' : 'private',
               endDate: s ? (s.endDate || s.startDate) : null };
  }
  el.innerHTML = '<div class="sh-loading">Loading show results…</div>';
  const res = await db.rpc('dealer_show_report', { p_show_id: showId || null, p_dealer_show_id: dealerShowId || null });
  if (res.error || !res.data || res.data.error) {
    el.innerHTML = `<button class="btn btn-ghost sh-back" onclick="shRenderListView()">← Shows</button>
      <div class="sh-empty">Couldn't load this show — ${_shEsc((res.error && res.error.message) || (res.data && res.data.error) || 'unknown error')}</div>`;
    return;
  }
  _shReport = res.data;
  shRenderHome();
}

function _shKpi(label, value, cls, sub) {
  return `<div class="sh-kpi"><div class="sh-kpi-label">${label}</div><div class="sh-kpi-value ${cls || ''}">${value}</div>${sub ? `<div class="sh-kpi-sub">${sub}</div>` : ''}</div>`;
}

// Inline SVG donut. segments: [{ label, value, color, text }]. Labels are always written
// out in the legend (never colour alone), and an all-zero chart draws an empty ring.
function shDonut(segments, center, centerSub) {
  const total = segments.reduce((s, x) => s + Math.max(0, _shNum(x.value)), 0);
  const R = 42, C = 2 * Math.PI * R;
  let off = 0;
  const arcs = total > 0 ? segments.filter(x => _shNum(x.value) > 0).map(x => {
    const len = (_shNum(x.value) / total) * C;
    const a = `<circle r="${R}" cx="60" cy="60" fill="none" stroke="${x.color}" stroke-width="16"
      stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 60 60)"><title>${_shEsc(x.label)}: ${_shEsc(x.text)}</title></circle>`;
    off += len;
    return a;
  }).join('') : '';
  const legend = segments.map(x => `<li><span class="sh-swatch" style="background:${x.color}"></span>${_shEsc(x.label)} <strong>${_shEsc(x.text)}</strong></li>`).join('');
  return `<div class="sh-donut">
    <svg viewBox="0 0 120 120" role="img" aria-label="${_shEsc(segments.map(x => x.label + ' ' + x.text).join(', '))}">
      <circle r="${R}" cx="60" cy="60" fill="none" stroke="var(--border)" stroke-width="16"></circle>${arcs}
      <text x="60" y="58" text-anchor="middle" class="sh-donut-num">${_shEsc(center)}</text>
      <text x="60" y="74" text-anchor="middle" class="sh-donut-sub">${_shEsc(centerSub || '')}</text>
    </svg>
    <ul class="sh-legend">${legend}</ul>
  </div>`;
}

function _shStat(label, value, cls) { return `<div class="sh-stat"><span>${label}</span><strong class="${cls || ''}">${value}</strong></div>`; }

function shRenderHome() {
  const r = _shReport, k = _shKey, el = _shPanel();
  if (!r || !k || !el) return;
  const m = r.mix || {};
  const mixSeg = [
    { label: 'Traded',    color: 'var(--accent2)', c: m.traded },
    { label: 'Cash sale', color: 'var(--accent)',  c: m.cash_sale },
    { label: 'Lot',       color: 'var(--success)', c: m.lot },
  ].map(x => ({ label: x.label, color: x.color,
                value: _shDonut === 'value' ? _shNum(x.c && x.c.value) : _shNum(x.c && x.c.cards),
                text: _shDonut === 'value' ? shMoney(x.c && x.c.value) : String(_shNum(x.c && x.c.cards)) }));
  const resSeg = [
    { label: 'Win',  color: 'var(--success)', value: r.wins,   text: String(r.wins) },
    { label: 'Loss', color: 'var(--danger)',  value: r.losses, text: String(r.losses) },
    { label: 'Even', color: 'var(--muted)',   value: r.even,   text: String(r.even) },
  ];
  const s0 = r.snapshot_start, s1 = r.snapshot_end;
  const ended = !!s1;
  const inv = `
    <div class="sh-card">
      <div class="sh-card-title">Inventory</div>
      ${s0 || s1 ? `<table class="sh-mini">
        <tr><th></th><th>Cards</th><th>Cost</th><th>Ask</th></tr>
        <tr><td>Start</td><td>${s0 ? s0.card_count : '—'}</td><td>${s0 ? shMoney(s0.cost_total) : '—'}</td><td>${s0 ? shMoney(s0.ask_total) : '—'}</td></tr>
        <tr><td>End</td><td>${s1 ? s1.card_count : '—'}</td><td>${s1 ? shMoney(s1.cost_total) : '—'}</td><td>${s1 ? shMoney(s1.ask_total) : '—'}</td></tr>
        ${s0 && s1 ? `<tr class="sh-change"><td>Change</td><td class="${_shCls(r.growth_cards)}">${r.growth_cards > 0 ? '+' : ''}${r.growth_cards}</td>
          <td class="${_shCls(r.growth_cost)}">${shSigned(r.growth_cost)}</td><td class="${_shCls(r.growth_ask)}">${shSigned(r.growth_ask)}</td></tr>` : ''}
      </table>` : '<div class="sh-muted">Inventory snapshot not taken for this show.</div>'}
      <div class="sh-actions">
        ${!s0 ? '<button class="btn btn-ghost" onclick="shTakeSnapshot(\'show_start\')">Take start snapshot now</button>' : ''}
        ${s0 && !ended ? '<button class="btn btn-ghost" onclick="shEndShow()">End show</button>' : ''}
      </div>
    </div>`;

  // Transactions table
  let rows = (r.rows || []).slice();
  if (_shOnlyMissingCost) rows = rows.filter(x => x.cost == null);
  const sk = _shSort.k, dir = _shSort.dir;
  rows.sort((a, b) => {
    const va = a[sk], vb = b[sk];
    if (typeof va === 'number' || typeof vb === 'number' || ['cost', 'value', 'profit'].includes(sk)) return (_shNum(va) - _shNum(vb)) * dir;
    return String(va ?? '').localeCompare(String(vb ?? ''), undefined, { numeric: true }) * dir;
  });
  const th = (key, label) => `<th class="sh-sort${sk === key ? ' on' : ''}" onclick="shSortBy('${key}')" aria-sort="${sk === key ? (dir > 0 ? 'ascending' : 'descending') : 'none'}">${label}${sk === key ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  const TYPE = { trade: 'Trade', sale: 'Sale', lot_sale: 'Lot', buy: 'Buy' };
  const tbody = rows.map(x => `<tr onclick="shOpenTxn('${_shEsc(x.txn_id)}')" tabindex="0">
      <td class="sh-code">${_shEsc(x.code || '')}</td>
      <td class="sh-title">${_shEsc(x.title || 'Card')}<div class="sh-muted">${TYPE[x.type] || _shEsc(x.type)}</div></td>
      <td>${x.cost == null ? `<button class="sh-addcost" onclick="event.stopPropagation();shFixCost('${_shEsc(x.item_id)}')">Add cost</button>` : shMoney(x.cost)}</td>
      <td>${shMoney(x.value)}</td>
      <td class="${_shCls(x.profit)}">${x.cost == null ? '—' : shSigned(x.profit)}</td>
      <td><span class="sh-chip sh-chip--${(x.result || '').toLowerCase()}">${x.cost == null ? '?' : _shEsc(x.result)}</span></td>
    </tr>`).join('');

  // Data quality
  const q = [];
  if (r.unbalanced_trades) q.push(`<button class="sh-q" onclick="shOpenTxn('${_shEsc((r.unbalanced[0] || {}).txn_id || '')}', true)">${r.unbalanced_trades} trade${r.unbalanced_trades > 1 ? 's don\'t' : ' doesn\'t'} balance</button>`);
  if (r.ungrouped_cards) q.push(`<button class="sh-q" onclick="shOpenTxn('${_shEsc((r.ungrouped_txn_ids || [])[0] || '')}')">${r.ungrouped_cards} card${r.ungrouped_cards > 1 ? 's' : ''} traded with no record of what came back</button>`);
  if (r.needs_review) q.push(`<button class="sh-q" onclick="shOpenNeedsDetails()">${r.needs_review} sale${r.needs_review > 1 ? 's need' : ' needs'} details</button>`);
  if (r.cards_missing_cost) q.push(`<button class="sh-q" onclick="shToggleMissingCost(true)">Cost missing on ${r.cards_missing_cost} card${r.cards_missing_cost > 1 ? 's' : ''}</button>`);

  const empty = !r.cards_out && !r.in_cards;
  el.innerHTML = `
    <button class="btn btn-ghost sh-back" onclick="shRenderListView()">← Shows</button>
    <div class="sh-head">
      <h3 class="sh-h">${_shEsc(k.name)}</h3>
      <div class="sh-muted">${_shEsc([k.date, k.kind === 'private' ? 'Your show' : null].filter(Boolean).join(' · '))}</div>
    </div>
    ${empty ? `<div class="sh-empty">Nothing logged at this show yet.<br>
        <button class="btn btn-primary" style="margin-top:0.75rem" onclick="openQuickActions('sell')">Log your first sale or trade</button></div>${inv}` : `
    <div class="sh-kpis">
      ${_shKpi('Net P/L', shSigned(r.net_pl), _shCls(r.net_pl), `${r.cards_out} cards out`)}
      ${_shKpi('Margin on cost', shPct(r.margin_on_cost), _shCls(r.margin_on_cost))}
      ${_shKpi('Trade value gained', shSigned(r.trade_value_gained), _shCls(r.trade_value_gained))}
      ${_shKpi('Cash sale profit', shSigned(r.cash_sale_profit), _shCls(r.cash_sale_profit))}
      ${_shKpi('Win rate', shPct(r.win_rate), '', `${r.wins} / ${r.losses} / ${r.even}`)}
    </div>
    <div class="sh-grid2">
      <div class="sh-card">
        <div class="sh-card-title">What left
          <span class="sh-toggle" role="group" aria-label="Show by">
            <button aria-pressed="${_shDonut === 'cards'}" onclick="shSetDonut('cards')">Cards</button>
            <button aria-pressed="${_shDonut === 'value'}" onclick="shSetDonut('value')">Value</button>
          </span></div>
        ${shDonut(mixSeg, _shDonut === 'value' ? shMoney(mixSeg.reduce((s, x) => s + x.value, 0)) : String(r.cards_out), _shDonut === 'value' ? 'value' : 'cards')}
      </div>
      <div class="sh-card">
        <div class="sh-card-title">Results</div>
        ${shDonut(resSeg, shPct(r.win_rate), 'win rate')}
      </div>
    </div>
    <div class="sh-grid2">
      <div class="sh-card"><div class="sh-card-title">Trades</div>
        ${_shStat('Cards traded', r.trade_cards)}${_shStat('Paid', shMoney(r.trade_cost))}${_shStat('Traded for', shMoney(r.trade_value))}
        ${_shStat('Gain', shSigned(r.trade_gain), _shCls(r.trade_gain))}${_shStat('Gain on cost', shPct(r.trade_gain_on_cost), _shCls(r.trade_gain_on_cost))}</div>
      <div class="sh-card"><div class="sh-card-title">Cash sales</div>
        ${_shStat('Cards sold', r.cash_cards)}${_shStat('Paid', shMoney(r.cash_cost))}${_shStat('Sold for', shMoney(r.cash_value))}
        ${_shStat('Profit', shSigned(r.cash_profit), _shCls(r.cash_profit))}${_shStat('Margin', shPct(r.cash_margin), _shCls(r.cash_margin))}</div>
    </div>
    <div class="sh-grid2">
      <div class="sh-card"><div class="sh-card-title">What came in</div>
        ${_shStat('Cards', r.in_cards)}${_shStat('Cost', shMoney(r.in_cost))}${_shStat('Asking', shMoney(r.in_ask))}
        ${_shStat('Gain at ask', shSigned(r.in_ask_gain), _shCls(r.in_ask_gain))}${_shStat('Gain on cost', shPct(r.in_ask_gain_pct), _shCls(r.in_ask_gain_pct))}</div>
      <div class="sh-card"><div class="sh-card-title">Still on hand</div>
        ${_shStat('Cards', r.onhand_cards)}${_shStat('Cost', shMoney(r.onhand_cost))}${_shStat('Asking', shMoney(r.onhand_ask))}
        ${_shStat('Gain on cost', shPct(r.onhand_ask_gain_pct), _shCls(r.onhand_ask_gain_pct))}</div>
    </div>
    ${inv}
    <div class="sh-card">
      <div class="sh-card-title">Every card that left${_shOnlyMissingCost ? ' · missing cost <button class="sh-link" onclick="shToggleMissingCost(false)">Show all</button>' : ''}</div>
      <div class="sh-table-wrap"><table class="sh-table">
        <thead><tr>${th('code', 'Code')}${th('title', 'Card')}${th('cost', 'Paid')}${th('value', 'Sold / traded for')}${th('profit', 'Profit')}${th('result', 'Result')}</tr></thead>
        <tbody>${tbody || '<tr><td colspan="6" class="sh-muted">No cards.</td></tr>'}</tbody>
      </table></div>
    </div>
    ${q.length ? `<div class="sh-quality" role="status"><strong>Check these</strong>${q.join('')}</div>` : ''}
    <div class="sh-actions"><button class="btn btn-ghost" onclick="shExportCsv()">⬇ Export CSV</button></div>`}`;
}

function shSortBy(k) { _shSort = { k, dir: _shSort.k === k ? -_shSort.dir : 1 }; shRenderHome(); }
function shSetDonut(m) { _shDonut = m; shRenderHome(); }
function shToggleMissingCost(on) { _shOnlyMissingCost = !!on; shRenderHome(); }
function shOpenNeedsDetails() {
  if (_shKey && _shKey.showId && typeof openShowMode === 'function') openShowMode(_shKey.showId, '/needs');
}

// ── One transaction: both sides and the cash ────────────────────────────────
async function shOpenTxn(txnId, balanceHelp) {
  if (!txnId) return;
  const [dtx, items] = await Promise.all([
    db.from('dealer_transactions').select('*').eq('id', txnId).maybeSingle(),
    db.from('transaction_items').select('id, direction, card_title, price, price_basis, card_ref, inventory_id').or(`sale_key.eq.${txnId},dealer_txn_id.eq.${txnId},transaction_id.eq.${txnId}`),
  ]);
  let head = dtx.data;
  if (!head) {
    const l = await db.from('show_floor_transactions').select('id, txn_type, sold_price, sold_at, payment_method').eq('id', txnId).maybeSingle();
    head = l.data ? { txn_type: l.data.txn_type || 'sale', cash_in: l.data.sold_price, cash_out: 0, occurred_at: l.data.sold_at, payment_method: l.data.payment_method } : {};
  }
  const list = items.data || [];
  const side = dir => list.filter(i => i.direction === dir);
  const sum = arr => arr.reduce((s, i) => s + _shNum(i.price), 0);
  const out = side('out'), inn = side('in');
  const cashIn = _shNum(head.cash_in), cashOut = _shNum(head.cash_out);
  const delta = sum(out) + cashOut - sum(inn) - cashIn;
  const li = arr => arr.map(i => `<li><span>${_shEsc((i.card_ref && i.card_ref.stock_code) ? i.card_ref.stock_code + ' · ' : '')}${_shEsc(i.card_title || 'Card')}</span><strong>${shMoney(i.price)}</strong></li>`).join('') || '<li class="sh-muted">None</li>';
  const TYPE = { trade: 'Trade', sale: 'Sale', lot_sale: 'Lot sale', buy: 'Buy' };
  const ov = document.createElement('div');
  ov.className = 'modal-overlay open sh-modal-ov';
  ov.onclick = e => { if (e.target === ov) ov.remove(); };
  ov.innerHTML = `<div class="modal sh-modal" role="dialog" aria-label="Transaction">
    <div class="sh-card-title">${TYPE[head.txn_type] || 'Transaction'}${head.is_ungrouped ? ' · ungrouped' : ''}
      <span class="sh-muted">${head.occurred_at ? new Date(head.occurred_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}</span></div>
    ${head.is_ungrouped ? '<p class="sh-muted">Cards traded at this show with no record of what came back for each one. Totals still count; grouping them is coming.</p>' : ''}
    <div class="sh-grid2">
      <div><div class="sh-side">Out · ${shMoney(sum(out))}</div><ul class="sh-items">${li(out)}</ul></div>
      <div><div class="sh-side">In · ${shMoney(sum(inn))}</div><ul class="sh-items">${li(inn)}</ul></div>
    </div>
    ${_shStat('You received', shMoney(cashIn))}${_shStat('You paid', shMoney(cashOut))}
    ${head.txn_type === 'trade' && !head.is_ungrouped ? (Math.abs(delta) >= 0.01
      ? `<div class="sh-balance">${shMoney(Math.abs(delta))} ${delta > 0 ? 'more went out than came back' : 'more came in than went out'} — check the cash on this trade.${balanceHelp ? ' Editing trades comes with trade logging.' : ''}</div>`
      : '<div class="sh-muted">Balanced.</div>') : ''}
    ${head.review_note ? `<p class="sh-muted">${_shEsc(head.review_note)}</p>` : ''}
    <div class="sh-actions"><button class="btn btn-primary" onclick="this.closest('.sh-modal-ov').remove()">Done</button></div>
  </div>`;
  document.body.appendChild(ov);
}

// ── Add a missing cost on a card that left ──────────────────────────────────
function shFixCost(itemId) {
  const row = (_shReport && _shReport.rows || []).find(x => x.item_id === itemId);
  const ov = document.createElement('div');
  ov.className = 'modal-overlay open sh-modal-ov';
  ov.onclick = e => { if (e.target === ov) ov.remove(); };
  ov.innerHTML = `<div class="modal sh-modal" role="dialog" aria-label="Add cost">
    <div class="sh-card-title">What did you pay?</div>
    <div class="sh-muted">${_shEsc(row ? row.title : '')}</div>
    <input id="shCostInput" class="filter-select" inputmode="decimal" placeholder="0" style="margin-top:0.75rem;width:100%">
    <div class="sh-actions"><button class="btn btn-ghost" onclick="this.closest('.sh-modal-ov').remove()">Cancel</button>
      <button class="btn btn-primary" id="shCostSave">Save</button></div>
  </div>`;
  document.body.appendChild(ov);
  setTimeout(() => document.getElementById('shCostInput')?.focus(), 30);
  ov.querySelector('#shCostSave').onclick = async () => {
    const v = parseFloat(String(document.getElementById('shCostInput').value).replace(/[^0-9.]/g, ''));
    if (!(v >= 0)) { showToast('Enter what you paid', 'var(--danger)'); return; }
    const { data: { user } } = await db.auth.getUser();
    const res = await db.from('transaction_item_costs').upsert({ transaction_item_id: itemId, owner_id: user && user.id, cost_at_sale: v }, { onConflict: 'transaction_item_id' });
    if (res.error) { showToast('Couldn\'t save — ' + res.error.message, 'var(--danger)'); return; }
    ov.remove();
    showToast('✓ Cost saved');
    shOpenShow(_shKey.showId, _shKey.dealerShowId);
  };
}

// ── CSV (every card out + a summary). Never includes photos or payment method. ──
function shExportCsv() {
  const r = _shReport, k = _shKey;
  if (!r || !k) return;
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const n = v => (v == null ? '' : _shNum(v).toFixed(2));
  const lines = [['Code', 'Card', 'Type', 'Paid', 'Sold / traded for', 'Profit', 'Result'].map(q).join(',')];
  (r.rows || []).forEach(x => lines.push([x.code, x.title, x.type, n(x.cost), n(x.value), x.cost == null ? '' : n(x.profit), x.cost == null ? '' : x.result].map(q).join(',')));
  lines.push('');
  [['Show', k.name], ['Date', k.date], ['Cards out', r.cards_out], ['Net P/L', n(r.net_pl)], ['Margin on cost', shPct(r.margin_on_cost)],
   ['Trade value gained', n(r.trade_value_gained)], ['Cash sale profit', n(r.cash_sale_profit)], ['Win rate', shPct(r.win_rate)],
   ['Wins / losses / even', `${r.wins} / ${r.losses} / ${r.even}`], ['Cards in', r.in_cards], ['Cost of cards in', n(r.in_cost)],
   ['Still on hand', r.onhand_cards], ['Cash received', n(r.cash_received)], ['Cash paid', n(r.cash_paid)]]
    .forEach(([a, b]) => lines.push([a, b].map(q).join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cardshow-show-${String(k.name).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${_todayISO()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Snapshots ───────────────────────────────────────────────────────────────
// Online: the server computes it (take_inventory_snapshot, which reads costs from
// the database). Offline: computed here from the cards on this phone and queued.
function _shComputeSnapshot() {
  const avail = getSellerInventory().filter(c => c.Status === 'Available');
  const cost = c => (c.CostBasis != null && !isNaN(Number(c.CostBasis)) ? Number(c.CostBasis) : null);
  return {
    card_count: avail.length,
    cost_total: Math.round(avail.reduce((s, c) => s + (cost(c) || 0), 0) * 100) / 100,
    ask_total: Math.round(avail.reduce((s, c) => s + (Number(c.Price) || 0), 0) * 100) / 100,
    cards_missing_cost: avail.filter(c => cost(c) == null).length,
    cards_missing_price: avail.filter(c => !(Number(c.Price) > 0)).length,
  };
}

async function shSnapshot(kind, showId, dealerShowId) {
  const op = { type: 'inv_snapshot', kind, showId: showId || null, dealerShowId: dealerShowId || null,
               clientSnapshotId: (typeof _smUuid === 'function' ? _smUuid() : crypto.randomUUID()),
               values: _shComputeSnapshot(), takenAt: new Date().toISOString(), offline: !navigator.onLine };
  if (typeof smEnqueue === 'function') { await smEnqueue(op); return; }
  await shRunOp(op);
}

async function shRunOp(op) {
  if (op.type !== 'inv_snapshot') return 'done';
  // Taken offline: write the phone's numbers from that moment, not the inventory at sync time.
  const direct = async () => {
    const uid = typeof _smGetUid === 'function' ? await _smGetUid() : null;
    if (!uid) return { error: { message: 'offline' }, status: 0 };
    const r = await db.from('inventory_snapshots').insert(Object.assign({
      client_snapshot_id: op.clientSnapshotId, owner_id: uid, show_id: op.showId, dealer_show_id: op.dealerShowId, kind: op.kind, taken_at: op.takenAt,
    }, op.values));
    return r.error && r.error.code === '23505' ? { error: null } : r;   // already written (once per show / retried)
  };
  let res = op.offline ? await direct() : await db.rpc('take_inventory_snapshot', {
    p_kind: op.kind, p_show_id: op.showId, p_dealer_show_id: op.dealerShowId, p_client_snapshot_id: op.clientSnapshotId,
  });
  if (res.error && !op.offline && _shRpcMissing(res)) res = await direct();   // Phase 2 migration not run
  if (res.error) {
    if (typeof _smIsNetworkError === 'function' && _smIsNetworkError(res)) return 'retry';
    console.warn('[show-home] snapshot failed', res.error.message);
  }
  if (op.kind === 'baseline') shLoadBaseline();
  return 'done';
}

// show_start: once per dealer per show, the first time they start working it
// (open Show Mode on a show day, or the first sale at the show).
function shEnsureShowStart(showId) {
  if (!showId || !currentSeller || currentRole !== 'seller') return;
  const show = shows[showId];
  if (!show || (typeof _showIsToday === 'function' && !_showIsToday(show))) return;
  const key = `shStart:${currentSeller}:${showId}`;
  try { if (localStorage.getItem(key)) return; localStorage.setItem(key, '1'); } catch (_) {}
  shSnapshot('show_start', showId, null);
}

async function shTakeSnapshot(kind) {
  if (!_shKey) return;
  await shSnapshot(kind, _shKey.showId, _shKey.dealerShowId);
  setTimeout(() => shOpenShow(_shKey.showId, _shKey.dealerShowId), 600);
}
function shEndShow() {
  if (!confirm('End this show? This records your inventory now as the end of the show.')) return;
  shTakeSnapshot('show_end');
  showToast('✓ Show ended — inventory recorded');
}

// ── Baseline + "Growth since baseline" on the inventory page ────────────────
async function shLoadBaseline() {
  if (typeof db === 'undefined' || !currentSeller) return;
  const res = await db.from('inventory_snapshots').select('*').eq('kind', 'baseline').order('taken_at', { ascending: false }).limit(1);
  _shBaseline = (!res.error && res.data && res.data[0]) || null;
  shRenderBaseline();
}

function shRenderBaseline() {
  const el = document.getElementById('baselineStrip');
  if (!el) return;
  if (currentRole !== 'seller' || !_shBaseline) { el.style.display = 'none'; el.innerHTML = ''; return; }
  const now = _shComputeSnapshot(), b = _shBaseline;
  const dc = now.card_count - b.card_count, dCost = now.cost_total - _shNum(b.cost_total), dAsk = now.ask_total - _shNum(b.ask_total);
  el.style.display = '';
  el.innerHTML = `<span class="sh-muted">Since baseline (${_shDate(b.taken_at)}):</span>
    <span class="${_shCls(dc)}">${dc > 0 ? '+' : ''}${dc} cards</span>
    <span>cost <strong class="${_shCls(dCost)}">${shSigned(dCost)}</strong></span>
    <span>asking <strong class="${_shCls(dAsk)}">${shSigned(dAsk)}</strong></span>`;
}

async function shSetBaseline() {
  if (!confirm('Set your baseline to your inventory right now? "Growth since baseline" will count from today.')) return;
  await shSnapshot('baseline', null, null);
  showToast('✓ Baseline set');
}

function shReset() {
  _shList = null; _shKey = null; _shReport = null; _shBaseline = null; _shOnlyMissingCost = false;
  const el = document.getElementById('baselineStrip');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  document.querySelectorAll('.sh-modal-ov').forEach(x => x.remove());
}
