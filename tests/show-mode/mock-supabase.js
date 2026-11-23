(function(){
  const today = new Date().toLocaleDateString('en-CA');
  const UID = 'u1';
  const S = window.__srv = JSON.parse(localStorage.getItem('__srv') || 'null') || {
    sellers: [{ id: UID, handle: 'tester', display_name: 'Tester', onboarding_complete: true, onboarding_state: null }],
    admins: [],
    shows: [{ id:'show_a', name:'Monster Show', date:'Today', location:'Cal Expo, Sacramento, CA', status:'active', access_code:'MON', start_date: today, end_date: today }],
    show_sellers: [{ show_id:'show_a', seller_id: UID, table_number:'12' }],
    inventory: [
      { id:'c1', seller_id:UID, card_title:'2024 Bowman Chrome Dylan Crews', player:'Dylan Crews', year:2024, card_set:'Bowman Chrome', card_number:'BCP-1', grader:'PSA', grade:10, cert_number:'12345678', price:120, status:'Available' },
      { id:'c2', seller_id:UID, card_title:'2023 Topps Chrome Elly De La Cruz', player:'Elly De La Cruz', year:2023, card_set:'Topps Chrome', grader:null, grade:null, price:40, status:'Available' },
      { id:'c3', seller_id:UID, card_title:'2018 Prizm Luka Doncic', player:'Luka Doncic', year:2018, card_set:'Prizm', grader:'PSA', grade:9, price:300, status:'Sold', sold_price:280, payment_method:'Venmo', sold_time:'1:05 PM', sold_date: today },
    ],
    show_inventory: [{ show_id:'show_a', card_id:'c1' }, { show_id:'show_a', card_id:'c2' }],
    sales: [], card_captures: [], show_floor_transactions: [], storage: [], show_events: [],
    cert_trust_checks: [], gtcr_consent_events: [],
  };
  const save = () => localStorage.setItem('__srv', JSON.stringify(S));
  const offline = () => !navigator.onLine;
  const netErr = { data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 };
  window.__mockLog = [];
  function q(table){
    let rows = null, single=false, op='select', payload=null, filters=[], opts={};
    const b = {
      select(){ return b; }, order(){ return b; }, range(){ return b; }, limit(){ return b; },
      eq(c,v){ filters.push(r=>String(r[c])===String(v)); return b; },
      neq(c,v){ filters.push(r=>String(r[c])!==String(v)); return b; },
      in(c,vs){ filters.push(r=>vs.map(String).includes(String(r[c]))); return b; },
      is(c,v){ filters.push(r=> v===null ? (r[c]==null) : r[c]===v); return b; },
      gte(c,v){ filters.push(r=> String(r[c]) >= String(v)); return b; },
      not(c,o,v){
        if (o==='is' && v===null) filters.push(r=>r[c]!=null);
        if (o==='in') { const vs = String(v).replace(/^\(|\)$/g,'').split(',').filter(Boolean); filters.push(r=>!vs.includes(String(r[c]))); }
        return b; }, lte(){ return b; }, ilike(){ return b; }, or(){ return b; }, filter(){ return b; },
      maybeSingle(){ single=true; return b; }, single(){ single=true; return b; },
      insert(p){ op='insert'; payload=p; return b; },
      upsert(p,o){ op='upsert'; payload=p; opts=o||{}; return b; },
      update(p){ op='update'; payload=p; return b; },
      delete(){ op='delete'; return b; },
      then(res, rej){
        if (offline()) return Promise.resolve(netErr).then(res, rej);
        window.__mockLog.push({table, op, payload});
        const T = (S[table] = S[table] || []);
        let out = { data: null, error: null, status: 200 };
        const match = r => filters.every(f => f(r));
        if (op === 'select') { const d = T.filter(match); out.data = single ? (d[0]||null) : d; out.count = d.length; }
        else if (op === 'insert' || op === 'upsert') {
          const list = Array.isArray(payload) ? payload : [payload];
          for (const p of list) {
            const row = Object.assign({ id: p.id || ('gen_' + Math.random().toString(36).slice(2)) }, p);
            if (table === 'card_captures') row.status = row.status || 'unattached';
            if (table === 'show_floor_transactions' && row.client_sale_id && T.some(r => r.client_sale_id === row.client_sale_id)) {
              out = { data:null, error:{ message:'duplicate key value violates unique constraint', code:'23505' }, status:409 }; continue;
            }
            const key = opts.onConflict && !opts.onConflict.includes(',') ? opts.onConflict : 'id';
            const existing = T.find(r => r[key] != null && r[key] === row[key]);
            if (existing) { if (op === 'upsert' && !opts.ignoreDuplicates) Object.assign(existing, row); }
            else T.push(row);
          }
          out.data = single ? { id: list[0].id || T[T.length-1].id } : list.map(p => ({ id: p.id }));
        }
        else if (op === 'update') { T.filter(match).forEach(r => {
          // Like the listing sync trigger: a held card sold by any other path breaks the hold.
          if (table === 'inventory' && payload.status === 'Sold' && r.status !== 'Sold' && r.reservation_id) {
            const h = (S.holds || []).find(x => x.id === r.reservation_id && x.status === 'active');
            if (h) { h.status = 'broken'; h.end_reason = 'sold_elsewhere'; }
            r.reservation_id = null; r.listing_status = 'sold';
          }
          Object.assign(r, payload); }); }
        else if (op === 'delete') { S[table] = T.filter(r => !match(r)); }
        save();
        return Promise.resolve(out).then(res, rej);
      },
    };
    return b;
  }
  function rpc(name, a){
    if (offline()) return Promise.resolve(netErr);
    window.__mockLog.push({ table: 'rpc', op: name, payload: a });
    let data = null;
    if (name === 'record_sale') {
      const ex = S.sales.find(s => s.client_sale_id === a.p_client_sale_id);
      if (ex) data = { created:false, sale_id: ex.id, inventory_id: ex.inventory_id, status: ex.status, sold_at: ex.sold_at };
      else {
        let invId = a.p_inventory_id;
        if (invId) {
          const inv = S.inventory.find(r => r.id === invId);
          if (!inv) return Promise.resolve({ data:null, error:{ message:'item_not_found', code:'P0002' }, status:400 });
          if ((inv.status||'').toLowerCase() === 'sold') { data = { error:'already_sold', inventory_id: invId }; save(); return Promise.resolve({ data, error:null, status:200 }); }
          Object.assign(inv, { status:'Sold', sold_price:a.p_price, payment_method:a.p_payment_method, sold_date:a.p_sold_date, sold_time:a.p_sold_time });
        } else {
          invId = a.p_new_item.id;
          S.inventory.push(Object.assign({}, a.p_new_item, { seller_id: UID, status:'Sold', sold_price:a.p_price, payment_method:a.p_payment_method, sold_date:a.p_sold_date, sold_time:a.p_sold_time, source:a.p_source }));
        }
        if (a.p_show_id && !S.show_inventory.some(r => r.show_id===a.p_show_id && r.card_id===invId)) S.show_inventory.push({ show_id:a.p_show_id, card_id:invId });
        const sale = { id:'sale_'+S.sales.length, client_sale_id:a.p_client_sale_id, seller_id:UID, show_id:a.p_show_id, inventory_id:invId, capture_id:a.p_capture_id, price:a.p_price, payment_method:a.p_payment_method, buyer_handle:a.p_buyer_handle, source:a.p_source, status:'completed', sold_at:new Date().toISOString() };
        S.sales.push(sale);
        if (a.p_capture_id) { const c = S.card_captures.find(x => x.id === a.p_capture_id); if (c) { Object.assign(c, { inventory_id:invId, sale_id:sale.id, status:'attached' }); const inv = S.inventory.find(r=>r.id===invId); if (inv && !inv.primary_capture_id) inv.primary_capture_id = a.p_capture_id; } }
        data = { created:true, sale_id:sale.id, inventory_id:invId, status:'completed', sold_at:sale.sold_at };
      }
    } else if (name === 'join_show_as_seller') {
      const show = S.shows.find(x => x.id === a.p_show_id);
      if (!show) data = { error:'not_found' };
      else if (S.show_sellers.some(r => r.show_id === show.id && r.seller_id === UID)) data = { ok:true, already:true };
      else if (show.listed === false) data = { error:'not_listed' };
      else if (show.seller_self_join === false) data = { error:'closed' };
      else if ((show.end_date || show.start_date) && (show.end_date || show.start_date) < today) data = { error:'ended' };
      else { S.show_sellers.push({ show_id:show.id, seller_id:UID, table_number:null, self_joined:true }); data = { ok:true, already:false }; }
    } else if (name === 'leave_show_as_seller') {
      const row = S.show_sellers.find(r => r.show_id === a.p_show_id && r.seller_id === UID);
      if (!row) data = { error:'not_joined' };
      else if (!row.self_joined) data = { error:'organizer_added' };
      else {
        const mine = new Set(S.inventory.filter(r => r.seller_id === UID).map(r => r.id));
        const before = S.show_inventory.length;
        S.show_inventory = S.show_inventory.filter(r => !(r.show_id === a.p_show_id && mine.has(r.card_id)));
        S.show_sellers = S.show_sellers.filter(r => r !== row);
        data = { ok:true, cards_removed: before - S.show_inventory.length };
      }
    } else if (name === 'is_platform_admin') {
      data = (S.platform_admins || []).some(r => r.id === UID);
    } else if (name === 'set_show_listed') {
      const show = S.shows.find(x => x.id === a.p_show_id);
      if (!(S.platform_admins || []).some(r => r.id === UID)) data = { error:'forbidden' };
      else if (!show) data = { error:'not_found' };
      else if (!a.p_listed) { show.listed = false; data = { ok:true, listed:false }; }
      else {
        const miss = [];
        if (!show.name) miss.push('name'); if (!show.start_date) miss.push('start_date');
        if (!show.venue) miss.push('venue'); if (!show.city) miss.push('city');
        if (!/^[A-Z]{2}$/.test(show.state || '')) miss.push('state'); if (show.merged_into) miss.push('merged');
        if (miss.length) data = { error:'missing_fields', fields: miss };
        else {
          show.slug = show.slug || (show.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + show.start_date.slice(0, 7));
          Object.assign(show, { listed:true, listed_at:new Date().toISOString() });
          data = { ok:true, listed:true, slug:show.slug };
        }
      }
    } else if (name === 'submit_show_request') {
      S.show_requests = S.show_requests || [];
      const p = a.p;
      if (!p.name || !p.start_date) data = { error:'missing_fields' };
      else {
        const ex = S.show_requests.find(r => r.seller_id === UID && r.status === 'pending' && r.name.toLowerCase() === p.name.toLowerCase() && r.start_date === p.start_date);
        if (ex) data = { ok:true, id:ex.id, already:true };
        else {
          const row = { id:'req_' + S.show_requests.length, seller_id:UID, status:'pending', created_at:new Date().toISOString(),
            name:p.name, start_date:p.start_date, end_date:p.end_date || null, venue:p.venue || null, city:p.city || null,
            state:p.state || null, website:p.website || null, notes:p.notes || null };
          S.show_requests.push(row); data = { ok:true, id:row.id, already:false };
        }
      }
    } else if (name === 'resolve_show_request') {
      const req = (S.show_requests || []).find(r => r.id === a.p_request_id);
      if (!(S.platform_admins || []).some(r => r.id === UID)) data = { error:'forbidden' };
      else if (!req) data = { error:'not_found' };
      else if (a.p_action === 'listed' && !S.shows.some(x => x.id === a.p_show_id && x.listed)) data = { error:'show_not_listed' };
      else {
        if (a.p_action === 'listed' && !S.show_sellers.some(r => r.show_id === a.p_show_id && r.seller_id === req.seller_id))
          S.show_sellers.push({ show_id:a.p_show_id, seller_id:req.seller_id, table_number:null, self_joined:true });
        Object.assign(req, { status:a.p_action, show_id:a.p_action === 'listed' ? a.p_show_id : null, review_note:a.p_note });
        data = { ok:true };
      }
    } else if (name === 'merge_shows') {
      let moved = 0, cards = 0;
      S.show_sellers.filter(r => r.show_id === a.p_from).forEach(r => {
        if (!S.show_sellers.some(t => t.show_id === a.p_into && t.seller_id === r.seller_id)) { S.show_sellers.push(Object.assign({}, r, { show_id:a.p_into })); moved++; }
      });
      S.show_inventory.filter(r => r.show_id === a.p_from).forEach(r => {
        if (!S.show_inventory.some(t => t.show_id === a.p_into && t.card_id === r.card_id)) { S.show_inventory.push({ show_id:a.p_into, card_id:r.card_id }); cards++; }
      });
      S.show_sellers = S.show_sellers.filter(r => r.show_id !== a.p_from);
      S.show_inventory = S.show_inventory.filter(r => r.show_id !== a.p_from);
      let socialMoved = 0;
      (S.social_sales||[]).filter(r => r.show_id === a.p_from).forEach(r => { r.show_id = a.p_into; socialMoved++; });
      Object.assign(S.shows.find(x => x.id === a.p_from), { listed:false, seller_self_join:false, merged_into:a.p_into });
      data = { ok:true, sellers_moved:moved, cards_moved:cards, social_sales_moved: socialMoved };
    } else if (name === 'delete_show') {
      const sales = (S.show_floor_transactions||[]).filter(t => t.show_id === a.p_show_id).length;
      const social = (S.social_sales||[]).filter(t => t.show_id === a.p_show_id).length;
      const tags = (S.show_hashtags||[]).filter(t => t.show_id === a.p_show_id).length;
      if (sales) data = { error:'has_sales', sales };
      else if (social) data = { error:'has_social_sales', social_sales: social };
      else if (tags) data = { error:'has_hashtags', hashtags: tags };
      else {
        S.show_inventory = (S.show_inventory||[]).filter(r => r.show_id !== a.p_show_id);
        S.show_sellers = (S.show_sellers||[]).filter(r => r.show_id !== a.p_show_id);
        (S.show_requests||[]).filter(r => r.show_id === a.p_show_id).forEach(r => Object.assign(r, { status:'pending', show_id:null }));
        S.shows = S.shows.filter(r => r.id !== a.p_show_id);
        data = { ok:true };
      }
    } else if (name === 'assign_stock_codes') {
      // Same rules as the SQL: S graded / R raw / B sealed / L lot, next free number, skips taken keys.
      const key = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      S.stock_code_counters = S.stock_code_counters || {};
      data = [];
      for (const id of a.p_ids) {
        const inv = S.inventory.find(r => r.id === id && r.seller_id === UID);
        if (!inv || inv.stock_code) continue;
        const pre = inv.item_type === 'sealed' ? 'B' : inv.item_type === 'lot' ? 'L' : /^[0-9]+(\.[0-9]+)?$/.test(String(inv.grade ?? '')) ? 'S' : 'R';
        let code;
        do { const n = S.stock_code_counters[pre] || 1; S.stock_code_counters[pre] = n + 1; code = pre + '-' + n; }
        while (S.inventory.some(r => r.seller_id === UID && r.stock_code && key(r.stock_code) === key(code)));
        inv.stock_code = code; data.push({ id, stock_code: code });
      }
    } else if (name === 'set_stock_code') {
      const key = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const inv = S.inventory.find(r => r.id === a.p_id && r.seller_id === UID);
      const code = String(a.p_code || '').trim() || null;
      const dup = code && S.inventory.find(r => r.seller_id === UID && r.id !== a.p_id && r.stock_code && key(r.stock_code) === key(code));
      if (!inv) data = { error: 'not_found' };
      else if (dup) data = { error: 'duplicate', card_id: dup.id, card_title: dup.card_title };
      else { inv.stock_code = code; data = { ok: true, stock_code: code }; }
    } else if (name === 'dealer_show_list') {
      data = S.__showList || [];
    } else if (name === 'dealer_show_report') {
      data = (S.__reports || {})[a.p_dealer_show_id || a.p_show_id] || { error: 'not_found' };
    } else if (name === 'show_log_imported_keys') {
      const done = new Set((S.dealer_transactions || []).map(d => d.import_key).filter(Boolean));
      data = (a.p_keys || []).filter(k => done.has(k));
    } else if (name === 'import_show_log') {
      // Enough of the SQL (20261120120000_show_log_import.sql) for the browser test: dedup by key,
      // outs marked Sold, ins created as "Needs details" cards with a code, refs for chained trades.
      S.dealer_transactions = S.dealer_transactions || [];
      const refs = {}; let imported = 0; const dups = [], created = []; let next = 500;
      for (const t of a.p_txns) {
        if (S.dealer_transactions.some(d => d.import_key === t.key)) { dups.push(t.key); continue; }
        const id = 'dtx_' + Math.random().toString(36).slice(2);
        S.dealer_transactions.push({ id, owner_id: UID, txn_type: t.txn_type, import_key: t.key, cash_in: t.cash_in, cash_out: t.cash_out,
          dealer_show_id: a.p_dealer_show_id, show_id: a.p_show_id, source: 'import', occurred_at: t.occurred_at });
        for (const n of t.in || []) {
          const cid = 'imp_' + (next++);
          const code = n.stock_code || ((n.grade ? 'S' : 'R') + '-' + next);
          S.inventory.push({ id: cid, seller_id: UID, card_title: n.title, price: 0, status: 'Available', stock_code: code,
            grader: n.grader, grade: n.grade ? Number(n.grade) : null, identification_status: 'unidentified' });
          refs[n.ref] = cid; created.push({ ref: n.ref, id: cid, stock_code: code });
        }
        for (const o of t.out || []) {
          const inv = S.inventory.find(r => r.id === (o.inventory_id || refs[o.ref]));
          Object.assign(inv, { status: 'Sold', sold_price: o.value, payment_method: t.txn_type === 'trade' ? 'Trade' : (t.payment_method || 'Cash') });
        }
        imported++;
      }
      data = { imported, duplicates: dups, created };
    } else if (name === 'dealer_holds' || name === 'release_hold' || name === 'complete_hold') {
      // Enough of 20261207120000_marketplace_holds.sql. __mhMissing simulates the migration not run.
      if (window.__mhMissing) return Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.' + name } });
      S.holds = S.holds || [];
      if (name === 'dealer_holds') {
        data = S.holds.filter(h => h.dealer_id === UID).map(h => ({ ...h, cards: h.listing_ids.map(id => {
          const r = S.inventory.find(x => x.id === id) || {};
          return { id, title: r.card_title, stock_code: r.stock_code, price_cents: Math.round(Number(r.price || 0) * 100), status: r.status, listing_status: r.listing_status };
        }) }));
      } else {
        const h = S.holds.find(x => x.id === a.p_reservation_id && x.dealer_id === UID);
        if (!h) data = { error: 'not_found' };
        else if (h.status !== 'active') data = { ok: true, already: true };
        else {
          h.status = name === 'release_hold' ? 'released' : 'converted';
          h.end_reason = name === 'release_hold' ? 'dealer_released' : 'sold_to_holder';
          h.listing_ids.forEach(id => { const r = S.inventory.find(x => x.id === id); if (r) { r.listing_status = 'active'; r.reservation_id = null; } });
          data = { ok: true };
        }
      }
    } else if (name === 'dealer_offers' || name === 'respond_offer') {
      // Enough of 20261208120000_marketplace_offers.sql. __moMissing simulates the migration not run.
      if (window.__moMissing) return Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.' + name } });
      S.offers = S.offers || [];
      const cardOf = id => { const r = S.inventory.find(x => x.id === id) || {};
        return { id, title: r.card_title, stock_code: r.stock_code, price_cents: Math.round(Number(r.price || 0) * 100), status: r.status, listing_status: r.listing_status }; };
      if (name === 'dealer_offers') {
        data = S.offers.filter(o => o.dealer_id === UID).map(o => ({ ...o, can_counter: o.moves < 3, card: cardOf(o.listing_id) }));
      } else {
        const o = S.offers.find(x => x.id === a.p_offer_id && x.dealer_id === UID);
        const r = o && S.inventory.find(x => x.id === o.listing_id);
        if (!o) data = { error: 'not_found' };
        else if (o.status !== 'pending') data = { error: 'not_your_turn' };
        else if (a.p_action === 'accept') {
          if (r.listing_status !== 'active' || r.status === 'Sold') { o.status = 'closed'; data = { error: 'unavailable' }; }
          else {
            S.holds = S.holds || [];
            const h = { id: 'ho' + S.holds.length, dealer_id: UID, buyer_name: o.buyer_name, buyer_contact: o.buyer_contact, status: 'active',
              expires_at: new Date(Date.now() + 864e5).toISOString(), listing_ids: [o.listing_id], agreed_cents: o.amount_cents, from_offer: true };
            S.holds.push(h); r.listing_status = 'reserved'; r.reservation_id = h.id;
            Object.assign(o, { status: 'accepted', decided_by: 'dealer', reservation_id: h.id });
            S.offers.filter(x => x !== o && x.listing_id === o.listing_id && ['pending', 'countered'].includes(x.status))
              .forEach(x => Object.assign(x, { status: 'closed', end_reason: 'other_offer_accepted' }));
            data = { ok: true, status: 'accepted', reservation_id: h.id, agreed_cents: o.amount_cents };
          }
        } else if (a.p_action === 'decline') { Object.assign(o, { status: 'declined', decided_by: 'dealer' }); data = { ok: true, status: 'declined' }; }
        else if (a.p_action === 'counter') {
          const price = Math.round(Number(r.price || 0) * 100);
          if (o.moves >= 3) data = { error: 'no_more_counters' };
          else if (!(a.p_counter_cents > o.amount_cents && a.p_counter_cents < price)) data = { error: 'bad_counter' };
          else { Object.assign(o, { status: 'countered', amount_cents: a.p_counter_cents, last_by: 'dealer', moves: o.moves + 1,
                   history: [...o.history, { by: 'dealer', cents: a.p_counter_cents }] }); data = { ok: true, status: 'countered' }; }
        }
      }
    } else if (name === 'publish_listings' || name === 'delist_listings') {
      // Same checks as the SQL (20261122120000_marketplace_listings.sql). __mkMissing simulates the migration not run.
      if (window.__mkMissing) return Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.' + name } });
      const ok = [], skipped = [];
      for (const id of a.p_ids) {
        const r = S.inventory.find(x => x.id === id && x.seller_id === UID);
        if (!r) { skipped.push({ id, reason: 'not_found' }); continue; }
        const ls = r.listing_status || 'draft';
        if (name === 'publish_listings') {
          const why = (r.status === 'Sold' || ls === 'sold') ? 'sold' : ls === 'reserved' ? 'reserved'
            : ['flagged','disputed'].includes(r.trust_flag) ? 'trust_flag' : r.identification_status === 'unidentified' ? 'needs_details'
            : !(Number(r.price) > 0) ? 'no_price'
            : (r.item_type || 'card') === 'sealed' ? null
            : (() => { const c = r.primary_capture_id && S.card_captures.find(x => x.id === r.primary_capture_id);
                       const photo = !c || c.deleted_at || !c.crop_key ? 'no_photo' : !c.uploaded_at ? 'photo_uploading' : null;
                       if (!photo) return null;
                       const g = String(r.grader || '').trim();
                       const t = String(r.card_title || '');
                       const graded = (g && g.toLowerCase() !== 'raw') || String(r.cert_number || '').trim()
                         || /\b(PSA|BGS|BVG|SGC|CGC|TAG|HGA|GMA|CSG|AGS|ISA)\b/.test(t) || /\b(psa|bgs|bvg|sgc|cgc|tag|hga|gma|csg)\s?(10|[1-9](\.5)?)\b/i.test(t);
                       return !graded && r.stock_image_id ? null : photo; })();
          if (why) skipped.push({ id, reason: why }); else { r.listing_status = 'active'; ok.push(id); }
        } else {
          if (ls === 'reserved' || ls === 'sold') skipped.push({ id, reason: ls });
          else { if (ls === 'active') r.listing_status = 'delisted'; ok.push(id); }
        }
      }
      data = name === 'publish_listings' ? { ok: true, published: ok, skipped } : { ok: true, delisted: ok, skipped };
    } else if (name === 'record_trade') {
      // Enough of 20261121120000_trade_logging.sql: idempotent on client id, refuses a sold card,
      // new cards keep the phone's id and get a code, outs Sold as Trade and off the show.
      S.dealer_transactions = S.dealer_transactions || []; S.transaction_items = S.transaction_items || [];
      S.inventory_costs = S.inventory_costs || [];
      const ex = S.dealer_transactions.find(d => d.client_capture_id === a.p_client_id);
      const t = a.p_txn;
      if (ex) data = { ok: true, already: true, id: ex.id, created: S.transaction_items.filter(i => i.dealer_txn_id === ex.id && i.direction === 'in')
        .map(i => ({ id: i.inventory_id, stock_code: (S.inventory.find(r => r.id === i.inventory_id) || {}).stock_code })) };
      else {
        const sold = (t.out || []).map(o => S.inventory.find(r => r.id === o.inventory_id)).find(r => !r || r.status === 'Sold');
        if (sold !== undefined) data = sold ? { error: 'already_sold', card: sold.id, title: sold.stock_code || sold.card_title } : { error: 'unknown_card' };
        else {
          const id = 'dtx_' + Math.random().toString(36).slice(2), created = [];
          S.dealer_transactions.push({ id, client_capture_id: a.p_client_id, owner_id: UID, txn_type: t.txn_type, show_id: a.p_show_id,
            cash_in: t.cash_in, cash_out: t.cash_out, note: t.note, source: 'app', occurred_at: t.occurred_at });
          let n2 = 700 + S.inventory.length;
          for (const n of t.in || []) {
            const code = n.stock_code || ((n.grade ? 'S' : 'R') + '-' + (n2++));
            S.inventory.push({ id: n.id, seller_id: UID, card_title: n.title, price: n.price || 0, status: 'Available', stock_code: code,
              grader: n.grader, grade: n.grade ? Number(n.grade) : null, identification_status: 'unidentified' });
            S.inventory_costs.push({ inventory_id: n.id, owner_id: UID, cost_basis: n.value, acquired_txn_id: id });
            S.transaction_items.push({ id: 'ti_' + Math.random().toString(36).slice(2), dealer_txn_id: id, sale_key: id, direction: 'in', inventory_id: n.id, card_title: n.title, price: n.value, price_basis: t.txn_type === 'buy' ? 'observed' : 'agreed_trade_value' });
            created.push({ id: n.id, stock_code: code });
          }
          for (const o of t.out || []) {
            const inv = S.inventory.find(r => r.id === o.inventory_id);
            Object.assign(inv, { status: 'Sold', sold_price: o.value, payment_method: 'Trade', sold_date: t.local_date, sold_time: t.local_time });
            S.show_inventory = S.show_inventory.filter(r => r.card_id !== inv.id);
            S.transaction_items.push({ id: 'ti_' + Math.random().toString(36).slice(2), dealer_txn_id: id, sale_key: id, direction: 'out', inventory_id: inv.id, card_title: inv.card_title, price: o.value, price_basis: 'agreed_trade_value' });
          }
          data = { ok: true, id, created };
        }
      }
    } else if (name === 'delete_dealer_trade') {
      const d = (S.dealer_transactions || []).find(x => x.id === a.p_txn_id);
      if (!d) data = { error: 'not_found' };
      else {
        const items = S.transaction_items.filter(i => i.dealer_txn_id === d.id);
        const moved = items.filter(i => i.direction === 'in').map(i => S.inventory.find(r => r.id === i.inventory_id)).find(r => r && r.status === 'Sold');
        if (moved) data = { error: 'card_moved_on', title: moved.stock_code || moved.card_title };
        else {
          const ins = new Set(items.filter(i => i.direction === 'in').map(i => i.inventory_id));
          S.inventory = S.inventory.filter(r => !ins.has(r.id));
          items.filter(i => i.direction === 'out').forEach(i => {
            const inv = S.inventory.find(r => r.id === i.inventory_id);
            if (inv) Object.assign(inv, { status: 'Available', sold_price: null, payment_method: null, sold_date: null, sold_time: null });
            if (d.show_id && !S.show_inventory.some(r => r.show_id === d.show_id && r.card_id === i.inventory_id)) S.show_inventory.push({ show_id: d.show_id, card_id: i.inventory_id });
          });
          S.transaction_items = S.transaction_items.filter(i => i.dealer_txn_id !== d.id);
          S.dealer_transactions = S.dealer_transactions.filter(x => x !== d);
          data = { ok: true };
        }
      }
    } else if (name === 'update_dealer_trade') {
      const d = (S.dealer_transactions || []).find(x => x.id === a.p_txn_id);
      if (!d) data = { error: 'not_found' };
      else {
        if ('cash_in' in a.p_vals) d.cash_in = a.p_vals.cash_in;
        if ('cash_out' in a.p_vals) d.cash_out = a.p_vals.cash_out;
        (a.p_vals.items || []).forEach(v => { const i = S.transaction_items.find(x => x.id === v.id); if (i) i.price = v.value; });
        data = { ok: true };
      }
    } else if (name === 'take_inventory_snapshot') {
      // Same rules as the SQL: Available cards, once per show for show_start/show_end, retries by client id.
      S.inventory_snapshots = S.inventory_snapshots || [];
      const key = a.p_show_id || a.p_dealer_show_id;
      const ex = S.inventory_snapshots.find(x => (a.p_client_snapshot_id && x.client_snapshot_id === a.p_client_snapshot_id)
        || (['show_start', 'show_end'].includes(a.p_kind) && x.kind === a.p_kind && (x.show_id || x.dealer_show_id) === key));
      if (ex) data = Object.assign({ already: true }, ex);
      else {
        const av = S.inventory.filter(r => r.seller_id === UID && r.status === 'Available');
        const cost = id => ((S.inventory_costs || []).find(c => c.inventory_id === id) || {}).cost_basis;
        data = { id: 'snap_' + Math.random().toString(36).slice(2), client_snapshot_id: a.p_client_snapshot_id, owner_id: UID,
          show_id: a.p_show_id || null, dealer_show_id: a.p_dealer_show_id || null, kind: a.p_kind, taken_at: new Date().toISOString(),
          card_count: av.length, cost_total: av.reduce((t, r) => t + (Number(cost(r.id)) || 0), 0), ask_total: av.reduce((t, r) => t + (Number(r.price) || 0), 0),
          cards_missing_cost: av.filter(r => cost(r.id) == null).length, cards_missing_price: av.filter(r => !(Number(r.price) > 0)).length };
        S.inventory_snapshots.push(data);
      }
    } else if (name === 'void_snap_sale') {
      // Same rules as the SQL (20261115120000_snap_sell.sql).
      const s = (S.snap_sales || []).find(x => x.client_sale_id === a.p_client_sale_id);
      if (!s) data = { error: 'not_found' };
      else if (s.voided_at) data = { voided: true, already: true };
      else if ((s.capture_status || 'needs_review') !== 'needs_review') data = { error: 'resolved' };
      else {
        s.voided_at = new Date().toISOString();
        S.transaction_items = (S.transaction_items || []).filter(i => i.sale_key !== s.client_sale_id);
        const tx = S.show_floor_transactions.find(t => t.client_sale_id === s.client_sale_id);
        if (tx) S.show_floor_transactions.push(Object.assign({}, tx, { id:'rev_'+tx.id, client_sale_id:null, sold_price:-tx.sold_price, voids_transaction_id:tx.id }));
        data = { voided: true };
      }
    } else if (name === 'show_sale_item_counts') {
      data = (S.snap_sales || []).filter(x => x.show_id === a.p_show_id && !x.voided_at).map(x => ({
        client_sale_id: x.client_sale_id,
        items: (S.transaction_items || []).filter(i => i.sale_key === x.client_sale_id).length || x.item_count_hint || 1,
      }));
    } else if (name === 'void_sale') {
      const s = S.sales.find(x => x.client_sale_id === a.p_client_sale_id);
      if (s.status === 'voided') data = { voided:false, status:'voided' };
      else {
        s.status = 'voided';
        const inv = S.inventory.find(r => r.id === s.inventory_id);
        Object.assign(inv, { status:'Available', sold_price:null, payment_method:null, sold_date:null, sold_time:null });
        const tx = S.show_floor_transactions.find(t => t.client_sale_id === s.client_sale_id);
        if (tx) S.show_floor_transactions.push(Object.assign({}, tx, { id:'rev_'+tx.id, client_sale_id:null, sold_price:-tx.sold_price, voids_transaction_id:tx.id }));
        data = { voided:true, status:'voided', inventory_id:s.inventory_id };
      }
    }
    save();
    return Promise.resolve({ data, error:null, status:200 });
  }
  window.supabase = { createClient(){ return {
    from: q, rpc,
    channel(){ const c={ on(){return c;}, subscribe(){return c;} }; return c; },
    removeChannel(){},
    storage: { from(){ return {
      upload: async (key)=>{ if (offline()) return { error:{ message:'Failed to fetch' } }; S.storage.push(key); save(); return { error:null }; },
      createSignedUrl: async ()=>({ data:{ signedUrl:'' } }),
      createSignedUrls: async (keys)=>({ data: keys.map(k=>({ path:k, signedUrl: location.origin + '/__signed/' + k, error:null })), error:null }),
      getPublicUrl: ()=>({ data:{ publicUrl:'' } }),
    }; } },
    auth: {
      async getSession(){ const s=localStorage.getItem('mock_session'); return { data:{ session: s? JSON.parse(s):null } }; },
      async signOut(){ localStorage.removeItem('mock_session'); return {error:null}; },
      async signInWithPassword(){ const s={user:{id:UID,email:'t@x.com'},access_token:'t'}; localStorage.setItem('mock_session',JSON.stringify(s)); return {data:{session:s,user:s.user},error:null}; },
      async getUser(){ const s=localStorage.getItem('mock_session'); return {data:{user:s?JSON.parse(s).user:null}}; },
      onAuthStateChange(){ return {data:{subscription:{unsubscribe(){}}}}; },
    },
  }; } };
})();
