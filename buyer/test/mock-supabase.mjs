// A tiny stand-in for Supabase used by the buyer-site tests: the public RPCs, saved_searches, password
// sign-in, and public storage. Synthetic data only. start() → { url, state, close }.
import http from 'node:http';

// A catalog image is small, like CardSight's (160x224).
const CATALOG_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAKAAAADgCAIAAAAL9foWAAABYklEQVR42u3RAREAAAQAMcSUSWg5uH2EX3ZP6G9lAWABFmABFmABFmDAAizAAizAAizAgAVYgAVYgAVYgAUYsAALsAALsAALMGABFmABFmABFmDAAizAAizAAizAAgxYgAVYgAVYgAUYsAALsAALsAALMGABFmABFmABFmABBizAAizAAizAAgxYgAVYgAVYgAVYgAELsAALsAALsAADFmABFmABFmABBizAAizAAizAAizAgAVYgAVYgAVYgAELsAALsAALsAADFmABFmABFmABFmDAAizAAizAAizAgAVYgAVYgAVYgAUYsAALsAALsAALMGABFmABFmABFmDAAizAAizAAizAAgxYgAVYgAVYgAUYsAALsAALsAALMGABFmABFmABFmABBizAAizAAizAAgxYgAVYgAVYgAVYgAELsAALsAALsAADFmABFmABFmABBizAAizAAizAAizAgHW9BTKuAwApJTkQAAAAAElFTkSuQmCC', 'base64');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const now = Date.now();
const day = 86400000;
const iso = t => new Date(t).toISOString();
const d = n => iso(now + n * day).slice(0, 10);

export function listings() {
  const show = { id: 'show_monster', name: 'Monster Show', start_date: d(2), end_date: d(4), venue: 'Cal Expo', city: 'Sacramento', state: 'CA', table_number: '12',
    url: '/s/monster-show-2026', pickup: true };
  const dealerA = { handle: 'dealer_a', display_name: 'Dealer A', url: '/d/dealer_a' };
  const dealerB = { handle: 'dealer_b', display_name: 'Dealer B', url: '/d/dealer_b' };
  return [
    { id: '11111111-1111-4111-8111-111111111111', url: '/c/11111111-1111-4111-8111-111111111111-1999-pokemon-base-set-charizard-holo-psa-10',
      title: '1999 Pokemon Base Set Charizard Holo PSA 10', player: 'Charizard', year: 1999, set: 'Base Set', number: '4', parallel: 'Holo',
      grader: 'PSA', grade: 10, grade_key: 'PSA 10', cert_number: '12345678', category: 'TCG', subcategory: 'Pokémon',
      listing_status: 'active', price_cents: 1800000, comp: { value_cents: 2100000, low_cents: 1900000, high_cents: 2300000, sales_30d: 6, few_sales: false, refreshed_at: iso(now - 2 * day) },
      pct_of_comp: 0.857, deal: true, accepts_offers: true, sale_modes: ['ship', 'local_pickup'], shipping_cents: 500, gtcr_clear: true,
      image: { photo_path: '11111111-1111-4111-8111-111111111111/cap.jpg', has_photo: true }, dealer: dealerA, show, listed_at: iso(now - day),
      _whatsapp: '15551234567', _instagram: 'dealer_a', features: ['RC'] },
    { id: '22222222-2222-4222-8222-222222222222', url: '/c/22222222-2222-4222-8222-222222222222-2024-prizm-jayden-daniels-silver',
      title: '2024 Prizm Jayden Daniels Silver', player: 'Jayden Daniels', year: 2024, set: 'Prizm', number: '331', parallel: 'Silver',
      grade_key: 'Raw', category: 'Sports', subcategory: 'Football', listing_status: 'active', price_cents: 4500, comp_unavailable: true,
      deal: false, sale_modes: ['ship'], gtcr_clear: false,
      image: { stock_image_url: '/.netlify/functions/card-image?id=abc', catalog_image: true }, dealer: dealerB, listed_at: iso(now - 3 * day) },
    { id: '33333333-3333-4333-8333-333333333333', url: '/c/33333333-3333-4333-8333-333333333333-wemby-prizm-bgs-9-5',
      title: 'Wemby Prizm BGS 9.5', player: 'Victor Wembanyama', grader: 'BGS', grade: 9.5, grade_key: 'BGS 9.5', cert_number: '999',
      listing_status: 'reserved', price_cents: 90000, comp: { value_cents: 80000, sales_30d: 1, few_sales: true, refreshed_at: iso(now) },
      pct_of_comp: 1.125, deal: false, sale_modes: ['ship'], image: {}, dealer: dealerB, listed_at: iso(now - 5 * day) },
    { id: '44444444-4444-4444-8444-444444444444', url: '/c/44444444-4444-4444-8444-444444444444-sold-card',
      title: 'Sold card', grade_key: 'Raw', listing_status: 'sold', price_cents: 1000, image: {}, dealer: dealerA, listed_at: iso(now - 9 * day) },
  ];
}

export async function start({ port = 0 } = {}) {
  const state = { calls: [], saved: [], refresh: [], users: { 'buyer@example.test': 'password123' }, failSearch: false };
  const all = listings();
  const pub = l => { const { _whatsapp, _instagram, features, ...rest } = l; return rest; };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const c of req) body += c;
    const j = body ? JSON.parse(body) : {};
    const send = (status, data, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*', 'Access-Control-Expose-Headers': '*' });
      res.end(type === 'application/json' ? JSON.stringify(data) : data);
    };
    if (req.method === 'OPTIONS') return send(204, '', 'text/plain');
    state.calls.push({ method: req.method, path: url.pathname, body: j, query: url.search });

    if (url.pathname === '/.netlify/functions/card-image') return send(200, CATALOG_PNG, 'image/png');
    if (url.pathname.startsWith('/storage/v1/object/public/') || url.pathname.startsWith('/assets/')) return send(200, PNG, 'image/png');
    const m = /^\/rest\/v1\/rpc\/(\w+)$/.exec(url.pathname);
    if (m) {
      const name = m[1];
      if (name === 'search_listings') {
        if (state.failSearch) return send(500, { message: 'boom' });
        const p = j.p || {};
        let rows = all.filter(l => l.listing_status === 'active');
        if (p.q) rows = rows.filter(l => p.q.toLowerCase().split(/\s+/).every(w => l.title.toLowerCase().includes(w)));
        if (p.dealer) rows = rows.filter(l => l.dealer.handle === p.dealer);
        if (p.show_id) rows = rows.filter(l => l.show?.id === p.show_id);
        if (p.near) rows = rows.filter(l => l.show).map(l => ({ ...l, miles: 3.2 }));
        if (p.category) rows = rows.filter(l => l.category === p.category);
        if (p.raw === true) rows = rows.filter(l => l.grade_key === 'Raw');
        if (p.raw === false) rows = rows.filter(l => l.grade_key !== 'Raw');
        if (p.deals_only) rows = rows.filter(l => l.deal);
        if (p.price_max_cents != null) rows = rows.filter(l => l.price_cents <= p.price_max_cents);
        if (p.sort === 'price_asc') rows = [...rows].sort((a, b) => a.price_cents - b.price_cents);
        const off = p.offset || 0, lim = p.limit || 24;
        return send(200, { total: rows.length, limit: lim, offset: off, results: rows.slice(off, off + lim).map(pub) });
      }
      if (name === 'get_listing') {
        const l = all.find(x => x.id === j.p_id);
        if (!l) return send(200, { error: 'not_found' });
        const { _whatsapp, _instagram, ...rest } = l;
        return send(200, { ...rest, dealer: { ...l.dealer, ...(_whatsapp ? { whatsapp: _whatsapp } : {}), ...(_instagram ? { instagram: _instagram } : {}) } });
      }
      if (name === 'get_dealer_storefront') {
        const h = String(j.p_handle || '').toLowerCase();
        if (h === 'dealer_a') return send(200, { handle: 'dealer_a', display_name: 'Dealer A', instagram: 'dealer_a', listings: 1, url: '/d/dealer_a' });
        if (h === 'dealer_b') return send(200, { handle: 'dealer_b', display_name: 'Dealer B', listings: 1, url: '/d/dealer_b' });
        return send(200, { error: 'not_found' });
      }
      if (name === 'get_show_page') {
        const k = String(j.p_key || '');
        if (k === 'show_monster') return send(200, { redirect: '/s/monster-show-2026' });
        if (k !== 'monster-show-2026') return send(200, { error: 'not_found' });
        return send(200, { id: 'show_monster', key: k, url: '/s/' + k, name: 'Monster Show', start_date: d(2), end_date: d(4),
          venue: 'Cal Expo', city: 'Sacramento', state: 'CA', street_address: '1600 Exposition Blvd', website: 'https://monster.example',
          listed: true, ended: false, listed_cards: 1, show_page: '/show.html?id=show_monster',
          dealers: [{ handle: 'dealer_a', display_name: 'Dealer A', table_number: '12', url: '/d/dealer_a', listings: 1 },
                    { handle: 'dealer_b', display_name: 'Dealer B', url: '/d/dealer_b', listings: 0 }] });
      }
      if (name === 'list_upcoming_shows') {
        const p = j.p || {};
        state.showArgs = p;
        if (p.state && p.state !== 'CA') return send(200, []);
        return send(200, [{ id: 'show_monster', name: 'Monster Show', url: '/s/monster-show-2026', start_date: d(2), end_date: d(4),
          venue: 'Cal Expo', city: 'Sacramento', state: 'CA', listed_cards: 1, ...(p.near ? { miles: 4.1 } : {}) }]);
      }
      if (name === 'request_card_value_refresh') { state.refresh.push(j.p_listing_id); return send(200, { ok: true }); }
      return send(404, { message: 'no such function' });
    }

    // auth (password sign-in only)
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      if (state.users[j.email] !== j.password) return send(400, { error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials', code: 'invalid_credentials' });
      const user = { id: 'cccccccc-0000-4000-8000-000000000003', email: j.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: iso(now) };
      return send(200, { access_token: 'tok-buyer', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(now / 1000) + 3600, refresh_token: 'r1', user });
    }
    if (url.pathname === '/auth/v1/user') {
      return send(200, { id: 'cccccccc-0000-4000-8000-000000000003', email: 'buyer@example.test', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} });
    }
    if (url.pathname === '/auth/v1/logout') return send(204, '', 'text/plain');

    // saved_searches (own rows; the token stands in for RLS)
    if (url.pathname === '/rest/v1/saved_searches') {
      if (!/tok-buyer/.test(req.headers.authorization || '')) return send(401, { message: 'JWT required' });
      const idEq = (url.searchParams.get('id') || '').replace(/^eq\./, '');
      if (req.method === 'POST') {
        const rows = (Array.isArray(j) ? j : [j]).map((r, i) => ({ id: `5a0000${state.saved.length + i}-0000-4000-8000-000000000000`, alerts: true, created_at: iso(now + state.saved.length), ...r }));
        state.saved.push(...rows);
        const one = (req.headers.accept || '').includes('vnd.pgrst.object');
        return send(201, one ? rows[0] : rows);
      }
      if (req.method === 'PATCH') { state.saved.filter(s => s.id === idEq).forEach(s => Object.assign(s, j)); return send(204, '', 'text/plain'); }
      if (req.method === 'DELETE') { state.saved = state.saved.filter(s => s.id !== idEq); return send(204, '', 'text/plain'); }
      let rows = state.saved; if (idEq) rows = rows.filter(s => s.id === idEq);
      const one = (req.headers.accept || '').includes('vnd.pgrst.object');
      if (one) return rows[0] ? send(200, rows[0]) : send(406, { code: 'PGRST116', message: 'no rows' });
      return send(200, [...rows].reverse());
    }
    send(404, { message: `not mocked: ${url.pathname}` });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, state, close: () => new Promise(r => server.close(r)) };
}
