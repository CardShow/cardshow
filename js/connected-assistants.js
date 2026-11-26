// Connected assistants (seller MCP server). Profile modal: the AI assistants this dealer connected to their
// CardShow account through OAuth (mcp_client_grants), what each may do, when it was last used, a Disconnect
// button, and the last 100 assistant actions (agent_actions, read-own). See CLAUDE.md "Seller MCP server".
// Loaded after js/pricing-admin.js.

// Off until Supabase's OAuth server is switched on. Test on one browser with ?assistants=1 (?assistants=0 clears).
const ASSISTANTS_UI_LAUNCHED = false;
const CA_MCP_URL = 'https://getcardshow.com/mcp/seller';
const CA_SCOPE_TEXT = {
  'inventory:read': 'See inventory and sales',
  'inventory:write': 'Update cards and prices',
  'sales:write': 'Record sales',
  'offers:write': 'Answer offers',
};
const CA_TOOL_TEXT = {
  whoami: 'Checked which account is connected',
  list_my_inventory: 'Looked through your inventory',
  get_my_card: 'Looked at a card',
  get_price_suggestion: 'Got price suggestions',
  list_my_shows: 'Looked at your shows',
  sales_summary: 'Looked at your sales',
  stale_inventory: 'Looked for cards that aren\'t selling',
  update_card: 'Updated a card',
  set_price: 'Changed a price',
  publish_to_show: 'Put a card on a show',
  unpublish_from_show: 'Took a card off a show',
  record_sale: 'Recorded a sale',
  list_offers: 'Looked at your offers',
  set_prices: 'Changed prices',
  add_cards_from_photos: 'Added cards from photos',
  respond_to_offer: 'Answered an offer',
};
// Phase 2 writes: the preview step is logged too ("Asked to change a price").
const CA_PREVIEW_TEXT = {
  update_card: 'Asked to update a card', set_price: 'Asked to change a price', publish_to_show: 'Asked to put a card on a show',
  unpublish_from_show: 'Asked to take a card off a show', record_sale: 'Asked to record a sale',
  set_prices: 'Asked to change prices', add_cards_from_photos: 'Sent photos to add cards', respond_to_offer: 'Asked to answer an offer',
};

function caEnabled() {
  if (ASSISTANTS_UI_LAUNCHED) return true;
  try { return localStorage.getItem('assistantsTest') === '1'; } catch (_) { return false; }
}
(function caReadTestSwitch() {
  try {
    const v = new URLSearchParams(location.search).get('assistants');
    if (v === '1') localStorage.setItem('assistantsTest', '1');
    if (v === '0') localStorage.removeItem('assistantsTest');
  } catch (_) {}
})();

function _caEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function _caWhen(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const mins = Math.round((Date.now() - d) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

async function caOpenInProfile() {
  const sec = document.getElementById('assistantsSection');
  if (!sec) return;
  const on = caEnabled() && currentRole === 'seller';
  sec.style.display = on ? '' : 'none';
  if (!on) return;
  document.getElementById('assistantsList').innerHTML = '<div class="ca-empty">Loading…</div>';
  document.getElementById('assistantActivity').innerHTML = '';
  await Promise.all([caLoadGrants(), caLoadActivity()]);
}

async function caLoadGrants() {
  const list = document.getElementById('assistantsList');
  const hint = document.getElementById('assistantsHint');
  let rows = [];
  try {
    const { data: { user } } = await db.auth.getUser();
    const { data, error } = await db.from('mcp_client_grants')
      .select('client_id, client_name, scopes, created_at, last_used_at, revoked_at')
      .eq('user_id', user?.id).is('revoked_at', null).order('created_at', { ascending: false });
    if (error) throw error;
    rows = data || [];
  } catch (e) {
    list.innerHTML = '<div class="ca-empty">Connected assistants are still being set up.</div>';
    hint.textContent = '';
    return;
  }
  hint.innerHTML = `To connect an assistant such as Claude, add a custom connector with <code>${_caEsc(CA_MCP_URL)}</code> and sign in with your CardShow login.`;
  if (!rows.length) { list.innerHTML = '<div class="ca-empty">No assistants connected.</div>'; return; }
  list.innerHTML = rows.map(g => `
    <div class="ca-row" data-client="${_caEsc(g.client_id)}">
      <div class="ca-main">
        <div class="ca-name">${_caEsc(g.client_name || 'Assistant')}</div>
        <div class="ca-meta">${(g.scopes || []).map(s => _caEsc(CA_SCOPE_TEXT[s] || s)).join(' · ')}</div>
        <div class="ca-meta">Connected ${_caEsc(_caWhen(g.created_at))} · last used ${_caEsc(_caWhen(g.last_used_at))}</div>
      </div>
      <button class="btn btn-ghost ca-disconnect" type="button" onclick="caDisconnect(this)">Disconnect</button>
    </div>`).join('');
}

async function caDisconnect(btn) {
  const row = btn.closest('.ca-row');
  const clientId = row?.dataset.client;
  const name = row?.querySelector('.ca-name')?.textContent || 'this assistant';
  if (!clientId || !confirm(`Disconnect ${name}? It will stop working with your CardShow account right away.`)) return;
  btn.disabled = true;
  // CardShow's approval first: that cuts the assistant off for every tool immediately.
  const { data, error } = await db.rpc('assistant_revoke_client', { p_client_id: clientId });
  if (error || !data?.ok) {
    btn.disabled = false;
    showToast("Couldn't disconnect. Check your connection and try again.", '#ef4444');
    return;
  }
  // Then Supabase's own consent, which also ends the assistant's sign-in and refresh tokens.
  try { if (db.auth.oauth?.revokeGrant) await db.auth.oauth.revokeGrant({ clientId }); }
  catch (e) { console.warn('[assistants] revokeGrant failed:', e?.message); }
  showToast(`${name} disconnected`);
  caLoadGrants();
}

async function caLoadActivity() {
  const box = document.getElementById('assistantActivity');
  try {
    const { data: { user } } = await db.auth.getUser();
    const { data, error } = await db.from('agent_actions')
      .select('created_at, client_name, tool, status, reason, result')
      .eq('owner_id', user?.id).eq('actor_type', 'dealer_agent')
      .order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    if (!data?.length) { box.innerHTML = '<div class="ca-empty">Nothing yet.</div>'; return; }
    box.innerHTML = data.map(a => {
      const what = (a.status === 'previewed' && CA_PREVIEW_TEXT[a.tool])
        || (a.status === 'read' && a.tool === 'add_cards_from_photos' && 'Checked on photos') || CA_TOOL_TEXT[a.tool] || a.tool || 'Action';
      const st = a.status === 'failed' ? ' <span class="ca-fail">· didn\'t work</span>'
        : a.status === 'rejected' ? ' <span class="ca-fail">· refused</span>'
        : a.status === 'applied' && a.result?.replayed ? ' · already done'
        : a.status === 'read' && a.tool === 'add_cards_from_photos' ? ' · still reading the photos' : '';
      return `<div class="ca-act"><span class="ca-act-when">${_caEsc(_caWhen(a.created_at))}</span>` +
        `<span>${_caEsc(a.client_name || 'Assistant')}: ${_caEsc(what)}${st}</span></div>`;
    }).join('');
  } catch (e) {
    box.innerHTML = '<div class="ca-empty">Activity isn\'t available yet.</div>';
  }
}
