// ── PRICING ADMIN (platform owner) ──────────────────────────────────────────
// "💲 Pricing" admin tab: how marketplace listings are priced, and a queue of cards the automatic
// Card Hedge match couldn't place. For each card: look it up with an editable search, check the
// result and its grade values, then "Use this match" (every listing of that card gets the comp),
// "Try again" (back to the automatic queue) or "Hide" (no comp for this card).
// Server: netlify/functions/pricing-admin.js + 20261202120000_pricing_admin.sql. Loaded after
// js/marketplace-dealer.js. Uses app.html globals: db, showToast, _escHtml, _isPlatformAdmin.

let _paFilter = 'check';     // 'check' | 'open' | 'auto' | 'manual' | 'ignored'
let _paRows = [];
let _paSummary = null;
let _paOpen = null;          // index of the row with the lookup box open
let _paResults = {};         // index → last lookup result
let _paLoading = false;

function paReset() {
  _paFilter = 'check'; _paRows = []; _paSummary = null; _paOpen = null; _paResults = {};
  const b = document.getElementById('paTabBadge');
  if (b) b.style.display = 'none';
}

async function paApi(action, payload = {}) {
  const { data } = await db.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error('Sign in again');
  const res = await fetch('/.netlify/functions/pricing-admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ action, ...payload }),
  });
  let body = {};
  try { body = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { code: body.error, status: res.status });
  return body;
}

const PA_ERRORS = {
  no_cardhedge_key: 'Card Hedge isn\'t set up (CARDHEDGE_API_KEY).',
  platform_owner_only: 'Only the platform owner can use this.',
  timeout: 'Card Hedge didn\'t answer in time. Try again.',
  network_error: 'Couldn\'t reach Card Hedge. Try again.',
  cardhedge_http_429: 'Card Hedge rate limit. Wait a minute and try again.',
  cardhedge_http_401: 'Card Hedge refused the API key.',
  cardhedge_http_403: 'Card Hedge refused the API key.',
};
const paErr = e => PA_ERRORS[e?.code] || PA_ERRORS[e?.message] || e?.message || 'Something went wrong';

// One pass of the automatic pricing job, run from the tab (the 5-minute schedule can't be called by URL).
async function paRunNow(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
  try {
    const { summary: r = {} } = await paApi('run');
    const parts = [];
    if (r.matched) parts.push(`${r.matched} matched`);
    if (r.review) parts.push(`${r.review} need a check`);
    if (r.no_match) parts.push(`${r.no_match} couldn't match`);
    if (r.refreshed) parts.push(`${r.refreshed} refreshed`);
    if (r.match_errors || r.refresh_errors) parts.push(`${(r.match_errors || 0) + (r.refresh_errors || 0)} errors`);
    const why = { daily_limit: 'Stopped: daily Card Hedge limit reached.', auth_error: 'Stopped: Card Hedge refused the API key.',
                  rate_limited: 'Stopped: Card Hedge rate limit. Try again in a minute.', time_budget: 'More cards left: run it again.' }[r.stopped] || '';
    const msg = parts.length ? parts.join(' · ') : (r.calls ? 'Nothing changed' : 'Nothing waiting to price');
    showToast(`Pricing run: ${msg}${why ? '. ' + why : ''}`, r.stopped === 'auth_error' ? '#ef4444' : undefined);
    console.log('[pricing] run', r);
  } catch (e) {
    showToast('Pricing run failed: ' + paErr(e), '#ef4444');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '▶ Run now'; }
  }
  paLoad();
}

async function paRefreshBadge() {
  try {
    const s = await paApi('summary');
    _paSummary = s;
    const b = document.getElementById('paTabBadge');
    if (b) { b.textContent = s.unmatched || ''; b.style.display = s.unmatched ? '' : 'none'; }
  } catch { /* migration or function not deployed yet */ }
}

async function paLoad() {
  if (_paLoading) return;
  _paLoading = true;
  const list = document.getElementById('paList');
  if (list && !_paRows.length) list.innerHTML = '<div class="dir-empty">Loading…</div>';
  try {
    const [s, q] = await Promise.all([paApi('summary'), paApi('queue', { status: _paFilter })]);
    _paSummary = s; _paRows = q.rows || []; _paOpen = null; _paResults = {};
    const b = document.getElementById('paTabBadge');
    if (b) { b.textContent = s.unmatched || ''; b.style.display = s.unmatched ? '' : 'none'; }
  } catch (e) {
    _paRows = [];
    if (list) list.innerHTML = `<div class="dir-empty">Couldn't load pricing: ${_escHtml(paErr(e))}</div>`;
    _paLoading = false;
    return;
  }
  _paLoading = false;
  paRender();
}

function paSetFilter(f) {
  if (_paFilter === f) return;
  _paFilter = f;
  paLoad();
}

const paMoney = c => c == null ? '—' : '$' + (c / 100).toLocaleString(undefined, { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });

function paSummaryHTML(s) {
  if (!s) return '';
  const use = (s.usage_today && s.usage_today.cardhedge) || { calls: 0 };
  const pct = s.daily_limit ? Math.round((use.calls / s.daily_limit) * 100) : 0;
  const stat = (v, label, warn) => `<div class="pa-stat"><div class="pa-stat-val${warn ? ' warn' : ''}">${v}</div><div class="pa-stat-label">${label}</div></div>`;
  const last = s.last_refresh ? new Date(s.last_refresh).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never';
  return stat((s.listed || 0).toLocaleString(), 'Listed cards')
    + stat((s.priced || 0).toLocaleString(), 'Have an online comp')
    + stat((s.waiting || 0).toLocaleString(), 'Waiting for a match')
    + stat((s.check || 0).toLocaleString(), 'Need a check', s.check > 0)
    + stat((s.unmatched || 0).toLocaleString(), 'Couldn\'t match', s.unmatched > 0)
    + stat((s.ignored || 0).toLocaleString(), 'Hidden (no comp)')
    + stat(`${(use.calls || 0).toLocaleString()} / ${(s.daily_limit || 0).toLocaleString()}`, `Card Hedge calls today (${pct}%)`, pct >= 80)
    + `<div class="pa-stat"><div class="pa-stat-label">Last refresh</div><div style="font-size:0.85rem;color:var(--text);margin-top:0.2rem">${_escHtml(last)}</div>`
    + (s.failing_refreshes ? `<div class="pa-stat-label" style="color:var(--accent)">${s.failing_refreshes} card${s.failing_refreshes === 1 ? '' : 's'} failing to refresh</div>` : '')
    + '</div>';
}

function paNotes(s) {
  if (!s) return '';
  const notes = [];
  if (!s.cardhedge_key) notes.push('<div class="pa-note warn">CARDHEDGE_API_KEY isn\'t set, so nothing can be priced or looked up.</div>');
  if (!s.enabled) notes.push('<div class="pa-note">Automatic pricing is off until MARKETPLACE_ENABLED is true. Matching cards by hand works now; their values are stored right away.</div>');
  return notes.join('');
}

function paQuery(card) {
  const c = card || {};
  const num = c.number ? String(c.number).replace(/^#/, '') : '';
  const parts = c.player || c.set ? [c.year, c.set, c.player, num ? `#${num}` : '', c.parallel] : [c.title, c.parallel];
  return parts.map(v => String(v ?? '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ');
}

function paRowHTML(r, i) {
  const c = r.card || {};
  const name = c.title || [c.year, c.set, c.player].filter(Boolean).join(' ') || 'Untitled card';
  const facts = [c.player, c.year, c.set, c.number ? '#' + String(c.number).replace(/^#/, '') : '', c.parallel].filter(Boolean).join(' · ');
  const grades = (r.grades || []).join(', ');
  const why = r.status === 'error' ? `Card Hedge didn't answer (${r.attempts || 0} tries)`
    : r.status === 'no_match' ? 'No confident match in Card Hedge'
    : r.status === 'ignored' ? 'Hidden: no comp shown'
    : r.reason === 'parallel_unconfirmed' ? 'Hidden from buyers: Card Hedge\'s card doesn\'t name this parallel or print run'
    : r.reason === 'base_value_only' ? 'Hidden from buyers: Card Hedge only found the base card, not this parallel. Looks right = show the base value'
    : r.reason === 'value_far_off' ? 'Hidden from buyers: the value is far from the asking price'
    : r.status === 'review' ? 'Hidden from buyers until checked'
    : r.status === 'manual' ? `Matched by hand${r.card_id ? ' · card ' + r.card_id : ''}`
    : r.status === 'matched' ? 'Matched automatically' : '';
  // The card Card Hedge matched, with its value next to the asking price.
  const matched = (r.status === 'review' || r.status === 'matched') && (r.match_title || r.card_id)
    ? `<div class="dir-row-meta">Card Hedge: <strong>${_escHtml(r.match_title || 'card ' + r.card_id)}</strong>`
      + `${r.value_cents != null ? ` · value ${paMoney(r.value_cents)}` : ' · no value for this grade'}`
      + `${r.price_cents != null ? ` · asking ${paMoney(r.price_cents)}` : ''}</div>` : '';
  const actions = _paFilter === 'check'
    ? `<button class="btn btn-primary dir-btn" onclick="paResolve(${i}, 'confirm')" title="It's the same card: show this value to buyers">Looks right</button>
       <button class="btn btn-ghost dir-btn" onclick="paToggleFind(${i})">${_paOpen === i ? 'Close' : 'Wrong card'}</button>
       <button class="btn btn-ghost dir-btn" onclick="paResolve(${i}, 'ignore')" title="Show no online comp for this card">Hide</button>`
    : _paFilter === 'auto'
    ? `<button class="btn btn-ghost dir-btn" onclick="paToggleFind(${i})">${_paOpen === i ? 'Close' : 'Wrong card'}</button>
       <button class="btn btn-ghost dir-btn" onclick="paResolve(${i}, 'retry')" title="Match it again automatically">Try again</button>
       <button class="btn btn-ghost dir-btn" onclick="paResolve(${i}, 'ignore')" title="Show no online comp for this card">Hide</button>`
    : _paFilter === 'open'
    ? `<button class="btn btn-primary dir-btn" onclick="paToggleFind(${i})">${_paOpen === i ? 'Close' : 'Find match'}</button>
       <button class="btn btn-ghost dir-btn" onclick="paResolve(${i}, 'retry')" title="Send it back to the automatic match">Try again</button>
       <button class="btn btn-ghost dir-btn" onclick="paResolve(${i}, 'ignore')" title="Show no online comp for this card">Hide</button>`
    : _paFilter === 'manual'
      ? `<button class="btn btn-ghost dir-btn" onclick="paToggleFind(${i})">${_paOpen === i ? 'Close' : 'Change match'}</button>
         <button class="btn btn-ghost dir-btn" onclick="paResolve(${i}, 'retry')">Undo</button>`
      : `<button class="btn btn-ghost dir-btn" onclick="paResolve(${i}, 'retry')">Bring back</button>`;
  return `
    <div class="dir-row" data-pa-idx="${i}" style="flex-wrap:wrap">
      <div class="dir-row-main">
        <div class="dir-row-name">${_escHtml(name)}</div>
        ${facts && facts !== name ? `<div class="dir-row-meta">${_escHtml(facts)}</div>` : ''}
        <div class="dir-row-meta">${r.listings} listing${r.listings === 1 ? '' : 's'} · ${r.dealers} dealer${r.dealers === 1 ? '' : 's'}${grades ? ' · ' + _escHtml(grades) : ''}</div>
        ${matched}
        ${why ? `<div class="${r.status === 'error' || r.reason ? 'dir-warn' : 'dir-row-meta'}">${_escHtml(why)}</div>` : ''}
      </div>
      <div class="dir-row-actions">${actions}</div>
      ${_paOpen === i ? paFindHTML(r, i) : ''}
    </div>`;
}

function paFindHTML(r, i) {
  const res = _paResults[i];
  let out = '';
  if (res && res.loading) out = '<div class="pa-result">Looking it up…</div>';
  else if (res && res.error) out = `<div class="pa-result dir-warn">${_escHtml(res.error)}</div>`;
  else if (res && res.found === false) out = '<div class="pa-result">Card Hedge found nothing for that. Try fewer words, or the set\'s exact name.</div>';
  else if (res && res.card_id) {
    const conf = res.confidence != null ? Math.round(res.confidence * 100) : null;
    const listed = new Set(r.grades || []);
    const vals = (res.values || []).slice().sort((a, b) => (listed.has(b.grade) - listed.has(a.grade)) || (b.value_cents - a.value_cents));
    const covered = (r.grades || []).filter(g => vals.some(v => v.grade === g));
    out = `<div class="pa-result">
        <strong>${_escHtml(res.title || 'Card ' + res.card_id)}</strong>
        ${conf != null ? `<span class="pa-conf${conf < 90 ? ' low' : ''}">${conf}% sure</span>` : ''}
        ${conf != null && conf < 90 ? '<div class="pa-grades" style="color:var(--accent)">Below the automatic bar (90%). Check it\'s the same card before using it.</div>' : ''}
        <div class="pa-grades">${vals.length ? vals.slice(0, 10).map(v => `${_escHtml(v.grade)} ${paMoney(v.value_cents)}${listed.has(v.grade) ? ' ✓' : ''}`).join(' · ') : 'No grade values returned.'}</div>
        <div class="pa-grades">${(r.grades || []).length ? `Listed grades with a value: ${covered.length} of ${(r.grades || []).length}` : ''}</div>
        <button class="btn btn-primary dir-btn" onclick="paUseMatch(${i})">Use this match</button>
      </div>`;
  }
  return `<div class="pa-find">
      <div class="pa-find-row">
        <input class="show-input" id="paQuery${i}" value="${_escHtml(res?.query || paQuery(r.card))}" maxlength="200"
               onkeydown="if(event.key==='Enter'){event.preventDefault();paLookup(${i})}">
        <button class="btn btn-ghost dir-btn" onclick="paLookup(${i})">Search</button>
      </div>
      <div class="pa-grades">Each search is one Card Hedge call. Leave the grade out: one match covers every grade.</div>
      ${out}
    </div>`;
}

function paRender() {
  const sum = document.getElementById('paSummary');
  if (sum) sum.innerHTML = paSummaryHTML(_paSummary);
  const filters = document.getElementById('paFilters');
  if (filters) {
    const s = _paSummary || {};
    const f = (key, label, n) => `<button class="dir-filter${_paFilter === key ? ' active' : ''}" onclick="paSetFilter('${key}')">${label}${n != null ? `<span>${n}</span>` : ''}</button>`;
    filters.innerHTML = paNotes(_paSummary) + f('check', 'Needs a check', s.check) + f('open', 'Couldn\'t match', s.unmatched)
      + f('auto', 'Matched automatically', s.auto) + f('manual', 'Matched by hand', s.manual) + f('ignored', 'Hidden', s.ignored);
  }
  const list = document.getElementById('paList');
  if (!list) return;
  const term = (document.getElementById('paSearch')?.value || '').trim().toLowerCase();
  const rows = _paRows.map((r, i) => [r, i]).filter(([r]) => {
    if (!term) return true;
    const c = r.card || {};
    return [c.title, c.player, c.set, c.year, c.number, c.parallel].join(' ').toLowerCase().includes(term);
  });
  if (!rows.length) {
    list.innerHTML = `<div class="dir-empty">${term ? 'No cards match that search.'
      : _paFilter === 'check' ? 'Nothing to check. Every automatic match shown to buyers names the right parallel and is close to its asking price.'
      : _paFilter === 'auto' ? 'No automatic matches yet.'
      : _paFilter === 'open' ? 'Nothing to fix. Every listed card either has a comp or is waiting for the automatic match.'
      : _paFilter === 'manual' ? 'No cards matched by hand yet.' : 'No hidden cards.'}</div>`;
    return;
  }
  list.innerHTML = rows.map(([r, i]) => paRowHTML(r, i)).join('');
}

function paToggleFind(i) {
  _paOpen = _paOpen === i ? null : i;
  paRender();
  if (_paOpen === i) document.getElementById('paQuery' + i)?.focus();
}

async function paLookup(i) {
  const input = document.getElementById('paQuery' + i);
  const query = (input?.value || '').trim();
  if (!query) { showToast('Type what to search for', '#ef4444'); return; }
  _paResults[i] = { loading: true, query };
  paRender();
  try {
    const r = await paApi('lookup', { query });
    _paResults[i] = { ...r, query };
  } catch (e) {
    _paResults[i] = { error: paErr(e), query };
  }
  paRender();
}

async function paUseMatch(i) {
  const r = _paRows[i], res = _paResults[i];
  if (!r || !res || !res.card_id) return;
  try {
    const out = await paApi('match', { identity: r.identity, card_id: res.card_id, query: res.query, title: res.title, values: res.values });
    showToast(`Matched · ${out.listings} listing${out.listings === 1 ? '' : 's'} updated${out.values ? '' : ' · values come with the next refresh'}`);
    paLoad();
  } catch (e) {
    showToast('Couldn\'t save the match: ' + paErr(e), '#ef4444');
  }
}

async function paResolve(i, action) {
  const r = _paRows[i];
  if (!r) return;
  if (action === 'ignore' && !confirm('Hide this card? Its listings will show no online comp, and it won\'t be matched automatically. You can bring it back from Hidden.')) return;
  try {
    await paApi(action, { identity: r.identity });
    showToast(action === 'ignore' ? 'Hidden' : action === 'confirm' ? 'Confirmed · buyers see this value now' : 'Sent back to the automatic match');
    paLoad();
  } catch (e) {
    showToast('Couldn\'t update: ' + paErr(e), '#ef4444');
  }
}
