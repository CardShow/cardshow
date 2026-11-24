// Show Directory → "Show feed": The Card Shop Finder (CSF) events sync, for the platform owner.
// See CLAUDE.md "Card Shop Finder events". Data: csf_feed_admin() / csf_resolve_match() / csf_removal_handled()
// (20261210120000_csf_events.sql, which check the platform owner); "Run sync now" → csf-feed-admin.js.
// Loaded after app.html's main script; uses its db, _escHtml, showToast, _formatShowDateRange, loadShowDirectory.

let _sfData = null;
let _sfOpen = false;
const _dirFeedUrls = {};   // external_events.id → { source_url } for Directory rows (the CSF credit)

function _sfEsc(s) { return typeof _escHtml === 'function' ? _escHtml(s) : String(s == null ? '' : s); }
function _sfWhen(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function _sfDates(a, b) {
  return a && typeof _formatShowDateRange === 'function' ? _formatShowDateRange(a, b) : (a || '');
}

// The credit link for Directory rows linked to the feed.
async function sfLoadEventUrls(rows) {
  const ids = [...new Set((rows || []).map(r => r.external_event_id).filter(id => id && !_dirFeedUrls[id]))];
  if (!ids.length || typeof dbSelectIn !== 'function') return;
  const { data, error } = await dbSelectIn(c => db.from('external_events').select('id, source_url, status').in('id', c), ids);
  if (error) { console.warn('[show feed] event urls:', error.message); return; }
  (data || []).forEach(e => { _dirFeedUrls[e.id] = e; });
}
function sfRowFeedHTML(r) {
  const e = r.external_event_id && _dirFeedUrls[r.external_event_id];
  if (!r.external_event_id) return '';
  const credit = e?.source_url
    ? `<a class="csf-credit" href="${_sfEsc(e.source_url)}" target="_blank" rel="noopener">via The Card Shop Finder</a>` : 'via The Card Shop Finder';
  const what = r.source === 'csf' ? 'From the feed, kept in sync (edits to its details are replaced when the feed changes)'
    : 'Your organizer\'s show, linked to the feed (its details stay as entered)';
  const gone = r.feed_removed_at ? ' · <b>No longer in the feed: hidden from buyers and sellers</b>' : '';
  return `<div class="dir-row-meta">${what} · ${credit}${gone}</div>`;
}

async function sfLoad() {
  const box = document.getElementById('dirFeed');
  if (!box || typeof db === 'undefined') return;
  const { data, error } = await db.rpc('csf_feed_admin');
  if (error || data?.error) {
    // Before the migration runs there's nothing to show.
    box.style.display = 'none';
    if (error && !/csf_feed_admin|PGRST202/.test(error.message + (error.code || ''))) console.warn('[show feed]', error.message);
    return;
  }
  _sfData = data;
  box.style.display = '';
  sfRender();
}

function sfToggle() { _sfOpen = !_sfOpen; sfRender(); }

function sfRender() {
  const box = document.getElementById('dirFeed');
  if (!box || !_sfData) return;
  const d = _sfData, run = (d.runs || [])[0], c = d.counts || {};
  const matches = d.matches || [], removals = (d.removals || []);
  const openRemovals = removals.filter(r => !r.handled_at && !r.restored_at);
  let status;
  if (!run) status = '<span class="sf-status">No sync has run yet.</span>';
  else if (!run.finished_at) status = `<span class="sf-status">Syncing since ${_sfWhen(run.started_at)}…</span>`;
  else if (!run.ok) status = `<span class="sf-status bad">Last sync failed ${_sfWhen(run.started_at)}: ${_sfEsc(run.error || 'error')}</span>`;
  else if (run.suspicious) status = `<span class="sf-status bad">Suspicious sync ${_sfWhen(run.started_at)}: ${_sfEsc(run.error || '')}</span>`;
  else status = `<span class="sf-status ok">Last sync ${_sfWhen(run.started_at)}: ${run.events_received} events · ${run.inserted} new · ${run.updated} updated · ${run.ended} ended · ${run.removed} removed</span>`;
  const keyWarn = run && run.http_status === 403 && /Blocked before reaching/.test(run.error || '')
    ? '<div class="dir-warn">The Card Shop Finder\'s firewall (Cloudflare) is blocking our server before the request reaches their API. Send them the run\'s cf-ray id (Details) and ask them to allow requests to /api/partner/events.php that carry a valid X-API-Key.</div>'
    : run && run.http_status === 401
    ? '<div class="dir-warn">CSF key rejected. Check CSF_API_KEY in Netlify, or ask The Card Shop Finder for a new key.</div>' : '';
  const flags = [matches.length ? `${matches.length} to review` : '', openRemovals.length ? `${openRemovals.length} removed show${openRemovals.length === 1 ? '' : 's'}` : '']
    .filter(Boolean).join(' · ');

  box.innerHTML = `
    <div class="sf-head">
      <div style="min-width:0">
        <div class="sf-title">Show feed: The Card Shop Finder ${flags ? `<span class="dir-tab-badge">${_sfEsc(flags)}</span>` : ''}</div>
        <div class="dir-row-meta">${status}</div>
        <div class="dir-row-meta">${c.active_events ?? 0} events in the feed · ${c.csf_shows ?? 0} upcoming shows from it · ${c.linked_shows ?? 0} organizer shows linked · ${c.no_coords ?? 0} waiting for a location</div>
        ${keyWarn}
      </div>
      <div class="dir-row-actions">
        <button class="btn btn-ghost dir-btn" id="sfRunBtn" onclick="sfRunNow()">Run sync now</button>
        <button class="btn btn-ghost dir-btn" onclick="sfToggle()">${_sfOpen ? 'Hide' : 'Details'}</button>
      </div>
    </div>
    ${_sfOpen ? `
      <div class="sf-section">Runs</div>
      <div class="sf-runs">${(d.runs || []).map(r => `<div class="dir-row-meta">${_sfWhen(r.started_at)} · ${_sfEsc(r.trigger || '')} · ${
        !r.finished_at ? 'running' : r.ok ? (r.suspicious ? 'suspicious' : 'ok') : 'failed'}${r.http_status ? ' · HTTP ' + r.http_status : ''}${
        r.events_received != null ? ` · ${r.events_received} events, ${r.shows_created || 0} shows made, ${r.shows_linked || 0} linked, ${r.matches_pending || 0} to review, ${r.removed || 0} removed, ${r.ended || 0} ended` : ''}${
        r.error ? ' · ' + _sfEsc(r.error) : ''}</div>`).join('') || '<div class="dir-row-meta">None yet.</div>'}</div>
      <div class="sf-section">Same show? (${matches.length})</div>
      ${matches.length ? matches.map(sfMatchHTML).join('') : '<div class="dir-row-meta">Nothing to review.</div>'}
      <div class="sf-section">Removed from the feed</div>
      ${removals.length ? removals.map(sfRemovalHTML).join('') : '<div class="dir-row-meta">No shows removed recently.</div>'}
    ` : ''}`;
}

function sfMatchHTML(m) {
  const e = m.event || {}, s = m.show || {}, r = m.reasons || {};
  const why = [`name ${Math.round((r.name_similarity ?? m.score ?? 0) * 100)}% alike`, r.same_city ? 'same city' : 'different city',
    r.miles != null ? `${r.miles} mi apart` : ''].filter(Boolean).join(' · ');
  return `
    <div class="dir-row sf-match">
      <div class="sf-pair">
        <div><div class="sf-label">The Card Shop Finder</div>
          <div class="dir-row-name">${_sfEsc(e.name)}</div>
          <div class="dir-row-meta">${_sfEsc(_sfDates(e.date_start, e.date_end))} · ${_sfEsc([e.venue, e.city, e.state].filter(Boolean).join(', '))}</div>
          <div class="dir-row-meta"><a class="csf-credit" href="${_sfEsc(e.url)}" target="_blank" rel="noopener">via The Card Shop Finder</a></div></div>
        <div><div class="sf-label">CardShow show</div>
          <div class="dir-row-name">${_sfEsc(s.name)}</div>
          <div class="dir-row-meta">${_sfEsc(_sfDates(s.start_date, s.end_date))} · ${_sfEsc([s.venue, s.city, s.state].filter(Boolean).join(', '))}</div></div>
      </div>
      <div class="dir-row-meta" style="width:100%">${_sfEsc(why)}</div>
      <div class="dir-row-actions">
        <button class="btn btn-primary dir-btn" onclick="sfResolve('${m.id}', 'link')">Same show: link</button>
        <button class="btn btn-ghost dir-btn" onclick="sfResolve('${m.id}', 'reject')">Different shows</button>
      </div>
    </div>`;
}

function sfRemovalHTML(x) {
  const s = x.show || {};
  const names = l => l.map(i => _sfEsc((i.stock_code ? i.stock_code + ' ' : '') + (i.title || ''))).join(', ');
  const state = x.restored_at ? 'Back in the feed ' + _sfWhen(x.restored_at) : x.handled_at ? 'Handled ' + _sfWhen(x.handled_at) : '';
  const what = x.kind === 'flagged'
    ? 'An organizer\'s show whose Card Shop Finder event left the feed. It stays up: check with the organizer.'
    : 'Hidden from buyers and sellers; pickup removed from its listings.';
  return `
    <div class="dir-row">
      <div class="dir-row-main">
        <div class="dir-row-name">${_sfEsc(s.name)} <span class="dir-badge">${x.kind === 'flagged' ? 'Flagged' : 'Hidden'}</span></div>
        <div class="dir-row-meta">${_sfEsc([s.date, [s.city, s.state].filter(Boolean).join(', ')].filter(Boolean).join(' · '))} · left the feed ${_sfWhen(x.removed_at)}</div>
        <div class="dir-row-meta">${what}</div>
        ${x.listings?.length ? `<div class="dir-row-meta">Listings with pickup here (${x.listings.length}): ${names(x.listings)}</div>` : ''}
        ${x.holds?.length ? `<div class="dir-warn">Open holds to follow up: ${x.holds.map(h => _sfEsc(h.buyer_name || 'buyer')).join(', ')}</div>` : ''}
        ${x.offers?.length ? `<div class="dir-warn">Open offers to follow up: ${x.offers.map(o => _sfEsc(o.buyer_name || 'buyer')).join(', ')}</div>` : ''}
        ${x.kind === 'hidden' ? `<div class="dir-row-meta">Emails: ${x.emails?.sent ?? 0} of ${x.emails?.queued ?? 0} sent</div>` : ''}
        ${state ? `<div class="dir-row-meta">${state}</div>` : ''}
      </div>
      <div class="dir-row-actions">
        ${x.handled_at ? '' : `<button class="btn btn-ghost dir-btn" onclick="sfHandled('${x.id}')">Mark handled</button>`}
      </div>
    </div>`;
}

async function sfRunNow() {
  const btn = document.getElementById('sfRunBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
  try {
    const { data } = await db.auth.getSession();
    const token = data?.session?.access_token;
    const res = await fetch('/.netlify/functions/csf-feed-admin', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ action: 'run' }),
    });
    const out = await res.json().catch(() => ({}));
    if (out.ok) showToast(`Synced: ${out.received} events · ${out.shows_created || 0} new shows · ${out.removed || 0} removed${out.suspicious ? ' · suspicious, nothing removed' : ''}`);
    else if (out.skipped) showToast('The feed sync is switched off (CSF_SYNC_ENABLED)');
    else if (res.status === 403 && out.error === 'platform_owner_only') showToast('Only the platform owner can run the sync (sign in again if you are)', 'error');
    else showToast(`Sync failed: ${out.message || out.error || res.status}`, 'error');
  } catch (e) {
    showToast('Sync failed: ' + e.message, 'error');
  }
  if (typeof loadShowDirectory === 'function') loadShowDirectory(); else sfLoad();
}

async function sfResolve(id, action) {
  const { data, error } = await db.rpc('csf_resolve_match', { p_match: id, p_action: action });
  if (error || data?.error) { showToast(`Couldn't save: ${error?.message || data.error}`, 'error'); return; }
  showToast(action === 'link' ? 'Linked: buyers see it as one show' : 'Kept apart: the next sync adds it as its own show');
  if (typeof loadShowDirectory === 'function') loadShowDirectory(); else sfLoad();
}

async function sfHandled(id) {
  const { data, error } = await db.rpc('csf_removal_handled', { p_removal: id });
  if (error || data?.error) { showToast(`Couldn't save: ${error?.message || data.error}`, 'error'); return; }
  sfLoad();
}
