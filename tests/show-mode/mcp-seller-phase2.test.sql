-- Seller MCP Phase 2. Run with mcp-seller-phase2.test.sh (after the Phase 1 test data). PASS / FAIL per check.
\set ON_ERROR_STOP 1
reset role; reset session authorization;
\i ../../supabase/migrations/20261114120000_cost_tracking.sql
\i ../../supabase/migrations/20261214120000_mcp_seller_phase2.sql
\i ../../supabase/migrations/20261214120000_mcp_seller_phase2.sql
alter table inventory add column if not exists location text, add column if not exists identification_status text;
create table if not exists public.offers (id uuid primary key default gen_random_uuid(), status text, listing_ids uuid[]);
grant select on public.offers to authenticated;
grant select, insert, update, delete on public.inventory_costs, public.transaction_costs, public.sales to authenticated;
grant insert on public.show_floor_transactions to authenticated;
grant all on all tables in schema public to service_role;
create or replace function pg_temp.ok(p_name text, p_cond boolean) returns text language sql as $$
  select case when coalesce(p_cond, false) then 'PASS ' else 'FAIL ' end || p_name $$;
create or replace function pg_temp.as_user(p_uid text, p_client text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), false);
  perform set_config('request.jwt.claims', case when p_uid is null then '' else
    (jsonb_build_object('sub', p_uid, 'role', 'authenticated') || case when p_client is null then '{}'::jsonb
      else jsonb_build_object('client_id', p_client) end)::text end, false);
end $$;
create or replace function pg_temp.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null; exception when others then return sqlerrm; end $$;

\set A '''aaaaaaaa-0000-0000-0000-000000000001'''
\set B '''bbbbbbbb-0000-0000-0000-000000000002'''
\set ZARD '''a0000000-0000-0000-0000-000000000001'''
\set DAN '''a0000000-0000-0000-0000-000000000002'''
insert into shows (id, name, start_date, end_date, city, state, listed) values ('s_today', 'Today Show', current_date, current_date + 1, 'Pomona', 'CA', true);
insert into show_sellers values ('s_today', :A, '21');
insert into inventory (id, seller_id, card_title, player, year, card_set, card_number, grader, grade, cert_number, price, status, stock_code) values
  ('a0000000-0000-0000-0000-000000000010', :A, '2023 Prizm Victor Wembanyama Silver', 'Victor Wembanyama', 2023, 'Prizm', '136', 'PSA', 10, '1010', 300, 'Available', 'S-10'),
  ('a0000000-0000-0000-0000-000000000011', :A, '2023 Prizm Victor Wembanyama Base', 'Victor Wembanyama', 2023, 'Prizm', '136', null, null, null, 40, 'Available', 'R-11'),
  ('a0000000-0000-0000-0000-000000000012', :A, 'Held card', 'Held Guy', 2020, 'Prizm', '1', null, null, null, 50, 'Available', 'R-12'),
  ('a0000000-0000-0000-0000-000000000013', :A, 'Offer card', 'Offer Guy', 2020, 'Prizm', '2', null, null, null, 60, 'Available', 'R-13');
insert into show_inventory values ('s_today', 'a0000000-0000-0000-0000-000000000010');
update inventory set listing_status = 'reserved' where id = 'a0000000-0000-0000-0000-000000000012';
insert into offers (status, listing_ids) values ('pending', array['a0000000-0000-0000-0000-000000000013'::uuid]);
insert into inventory_costs (inventory_id, owner_id, cost_basis) values ('a0000000-0000-0000-0000-000000000010', :A, 180);

set session authorization authenticator; set role authenticated;
select pg_temp.as_user(:A, null);
select assistant_grant_consent('claude-client', 'Claude', array['inventory:read','inventory:write','sales:write']);
select assistant_grant_consent('read-only', 'Reader', array['inventory:read']);
select pg_temp.as_user(:B, null);
select assistant_grant_consent('claude-client', 'Claude', array['inventory:read','inventory:write']);

-- ── update_card ─────────────────────────────────────────────────────────────
select pg_temp.as_user(:A, 'claude-client');
select mcp_update_card(jsonb_build_object('inventory_id', :DAN, 'player', 'Jayden Daniels Jr', 'year', '2025')) as p \gset
select pg_temp.ok('01 preview lists old → new and changes nothing',
  (:'p'::jsonb)->>'stage' = 'preview' and (:'p'::jsonb)->'preview'->'changes' @> '[{"field":"player","old":"Jayden Daniels","new":"Jayden Daniels Jr"}]'
  and (select player from inventory where id = :DAN) = 'Jayden Daniels' and length((:'p'::jsonb)->>'confirm_token') = 64);
select (:'p'::jsonb)->>'confirm_token' as tok \gset
select pg_temp.ok('02 different arguments refused (and the token is used up)',
  (mcp_update_card(jsonb_build_object('inventory_id', :DAN, 'player', 'Someone Else', 'year', '2025'), :'tok'))->>'error' = 'arguments_changed');
select pg_temp.ok('03 used token refused', (mcp_update_card(jsonb_build_object('inventory_id', :DAN, 'player', 'Jayden Daniels Jr', 'year', '2025'), :'tok'))->>'error' = 'token_used');
select (mcp_update_card(jsonb_build_object('inventory_id', :DAN, 'player', 'Jayden Daniels Jr', 'year', '2025')))->>'confirm_token' as tok \gset
select mcp_update_card(jsonb_build_object('inventory_id', :DAN, 'player', 'Jayden Daniels Jr', 'year', '2025'), :'tok') as a \gset
select pg_temp.ok('04 apply with the token changes exactly the previewed fields',
  (:'a'::jsonb)->>'stage' = 'applied' and (select player || '|' || year from inventory where id = :DAN) = 'Jayden Daniels Jr|2025');
select pg_temp.ok('05 no-op change refused', (mcp_update_card(jsonb_build_object('inventory_id', :DAN, 'year', '2025')))->>'error' = 'no_changes');
select pg_temp.ok('06 unknown field refused', (mcp_update_card(jsonb_build_object('inventory_id', :DAN, 'price', '1')))->>'error' = 'bad_input');
select pg_temp.ok('07 bad token refused', (mcp_update_card(jsonb_build_object('inventory_id', :DAN, 'year', '2024'), 'deadbeef'))->>'error' = 'invalid_token');
-- expired
select (mcp_update_card(jsonb_build_object('inventory_id', :DAN, 'year', '2024')))->>'confirm_token' as tok \gset
reset role; reset session authorization;
update mcp_confirmations set expires_at = now() - interval '1 minute' where token_hash = _mcp_token_hash(:'tok');
set session authorization authenticator; set role authenticated;
select pg_temp.as_user(:A, 'claude-client');
select pg_temp.ok('08 expired token refused', (mcp_update_card(jsonb_build_object('inventory_id', :DAN, 'year', '2024'), :'tok'))->>'error' = 'token_expired');
-- data changed between preview and apply (dealer edits the card in the app)
select (mcp_update_card(jsonb_build_object('inventory_id', :DAN, 'year', '2024')))->>'confirm_token' as tok \gset
select pg_temp.as_user(:A, null);
update inventory set price = 26 where id = :DAN;
select pg_temp.as_user(:A, 'claude-client');
select pg_temp.ok('09 card changed since the preview: refused', (mcp_update_card(jsonb_build_object('inventory_id', :DAN, 'year', '2024'), :'tok'))->>'error' = 'data_changed'
  and (select year from inventory where id = :DAN) = 2025);
-- another assistant / another dealer can't use the token
select (mcp_update_card(jsonb_build_object('inventory_id', :DAN, 'year', '2024')))->>'confirm_token' as tok \gset
select pg_temp.as_user(:B, 'claude-client');
select pg_temp.ok('10 dealer B can''t see or change A''s card', (mcp_update_card(jsonb_build_object('inventory_id', :DAN, 'year', '2024'), :'tok'))->>'error' = 'not_found');
select pg_temp.as_user(:A, 'read-only');
select pg_temp.ok('11 read-only assistant can''t write', pg_temp.err($$select mcp_update_card('{"inventory_id":"a0000000-0000-0000-0000-000000000002","year":"2024"}')$$) like '%scope_missing:inventory:write%');
select pg_temp.as_user(:A, 'claude-client');
select pg_temp.ok('12 held card refused', (mcp_update_card(jsonb_build_object('inventory_id', 'a0000000-0000-0000-0000-000000000012', 'year', '2021')))->>'error' = 'held');
-- cert change asks for a GTCR recheck; blank clears a field
select (mcp_update_card(jsonb_build_object('inventory_id', :ZARD, 'cert_number', '112', 'parallel', '')))->'preview' as pv \gset
select pg_temp.ok('13 cert change flagged for a GTCR recheck', (:'pv'::jsonb)->>'gtcr_recheck' = 'true'
  and (:'pv'::jsonb)->'changes' @> '[{"field":"parallel","old":"Holo","new":null}]');

-- ── set_price ───────────────────────────────────────────────────────────────
select mcp_set_price(jsonb_build_object('inventory_id', :ZARD, 'price_cents', 19500)) as p \gset
select pg_temp.ok('14 price preview: old, new, % of comp', (:'p'::jsonb)->'preview'->>'old_price' = '$180.00'
  and (:'p'::jsonb)->'preview'->>'new_price' = '$195.00' and (:'p'::jsonb)->'preview'->>'new_pct_of_comp' = '0.975');
select mcp_set_price(jsonb_build_object('inventory_id', :ZARD, 'price_cents', 19500), (:'p'::jsonb)->>'confirm_token') as a \gset
select pg_temp.ok('15 price applied', (:'a'::jsonb)->>'stage' = 'applied' and (select price from inventory where id = :ZARD) = 195);
select pg_temp.ok('16 fractional / zero cents refused', (mcp_set_price(jsonb_build_object('inventory_id', :ZARD, 'price_cents', 12.5)))->>'error' = 'bad_input'
  and (mcp_set_price(jsonb_build_object('inventory_id', :ZARD, 'price_cents', 0)))->>'error' = 'bad_input');
select pg_temp.ok('17 sold card refused', (mcp_set_price(jsonb_build_object('inventory_id', 'a0000000-0000-0000-0000-000000000004', 'price_cents', 100)))->>'error' = 'sold');

-- ── publish / unpublish ─────────────────────────────────────────────────────
select mcp_publish_to_show(jsonb_build_object('inventory_id', :DAN, 'show_id', 's_up')) as p \gset
select pg_temp.ok('18 publish preview names the show', (:'p'::jsonb)->'preview'->'show'->>'name' = 'Upcoming Show'
  and not exists (select 1 from show_inventory where show_id = 's_up' and card_id = :DAN));
select mcp_publish_to_show(jsonb_build_object('inventory_id', :DAN, 'show_id', 's_up'), (:'p'::jsonb)->>'confirm_token') as a \gset
select pg_temp.ok('19 publish applied (through RLS)', (:'a'::jsonb)->>'stage' = 'applied'
  and exists (select 1 from show_inventory where show_id = 's_up' and card_id = :DAN));
select pg_temp.ok('20 show not joined / ended refused', (mcp_publish_to_show(jsonb_build_object('inventory_id', :DAN, 'show_id', 's_b')))->>'error' = 'not_joined'
  and (mcp_publish_to_show(jsonb_build_object('inventory_id', 'a0000000-0000-0000-0000-000000000011', 'show_id', 's_p3')))->>'error' = 'show_ended');
select (mcp_unpublish_from_show(jsonb_build_object('inventory_id', :DAN, 'show_id', 's_up')))->>'confirm_token' as tok \gset
select mcp_unpublish_from_show(jsonb_build_object('inventory_id', :DAN, 'show_id', 's_up'), :'tok') as a \gset
select pg_temp.ok('21 unpublish applied', (:'a'::jsonb)->>'stage' = 'applied'
  and not exists (select 1 from show_inventory where show_id = 's_up' and card_id = :DAN));

-- ── record_sale ─────────────────────────────────────────────────────────────
\set REQ '''11111111-2222-3333-4444-555555555555'''
select pg_temp.ok('22 client_request_id required', (mcp_record_sale(jsonb_build_object('inventory_id', :ZARD, 'sale_price_cents', 100, 'payment_method', 'cash')))->>'error' = 'bad_input');
select pg_temp.ok('23 trade isn''t a payment method here', (mcp_record_sale(jsonb_build_object('inventory_id', :ZARD, 'sale_price_cents', 100, 'payment_method', 'trade'), null, :REQ))->>'error' = 'bad_input');
select mcp_record_sale(jsonb_build_object('description', 'wembanyama', 'sale_price_cents', 28000, 'payment_method', 'venmo'), null, :REQ) as p \gset
select pg_temp.ok('24 a description matching two cards returns both, no preview', (:'p'::jsonb)->>'error' = 'ambiguous' and jsonb_array_length((:'p'::jsonb)->'candidates') = 2);
select mcp_record_sale(jsonb_build_object('description', 'S-10', 'sale_price_cents', 28000, 'payment_method', 'venmo', 'buyer_note', 'Paid with Venmo @kid'), null, :REQ) as p \gset
select pg_temp.ok('25 stock code resolves; preview shows card, price, payment, today''s show, last copy',
  (:'p'::jsonb)->'preview'->'card'->>'stock_code' = 'S-10' and (:'p'::jsonb)->'preview'->>'sale_price' = '$280.00'
  and (:'p'::jsonb)->'preview'->>'payment_method' = 'Venmo' and (:'p'::jsonb)->'preview'->'show'->>'id' = 's_today'
  and (:'p'::jsonb)->'preview'->>'last_copy' = 'true' and (select status from inventory where id = 'a0000000-0000-0000-0000-000000000010') = 'Available');
select (:'p'::jsonb)->>'confirm_token' as tok \gset
select mcp_record_sale(jsonb_build_object('description', 'S-10', 'sale_price_cents', 28000, 'payment_method', 'venmo', 'buyer_note', 'Paid with Venmo @kid'), :'tok', :REQ) as a1 \gset
select mcp_record_sale(jsonb_build_object('description', 'S-10', 'sale_price_cents', 28000, 'payment_method', 'venmo', 'buyer_note', 'Paid with Venmo @kid'), :'tok', :REQ) as a2 \gset
select mcp_record_sale(jsonb_build_object('description', 'S-10', 'sale_price_cents', 28000, 'payment_method', 'venmo', 'buyer_note', 'Paid with Venmo @kid'), :'tok', :REQ) as a3 \gset
select pg_temp.ok('26 sent 3 times: one sale, one ledger row, the same result back',
  (:'a1'::jsonb)->>'stage' = 'applied' and (:'a2'::jsonb)->>'replayed' = 'true' and (:'a3'::jsonb)->>'replayed' = 'true'
  and (:'a1'::jsonb)->'result'->>'sale_id' = (:'a3'::jsonb)->'result'->>'sale_id'
  and (select count(*) from sales where client_sale_id = :REQ) = 1
  and (select count(*) from show_floor_transactions where client_sale_id = :REQ) = 1);
select pg_temp.ok('27 sold like an app sale: card Sold, ledger source agent at the show, price + payment',
  (select status || '|' || sold_price || '|' || payment_method from inventory where id = 'a0000000-0000-0000-0000-000000000010') = 'Sold|280.0000000000000000|Venmo'
  or (select status = 'Sold' and sold_price = 280 and payment_method = 'Venmo' from inventory where id = 'a0000000-0000-0000-0000-000000000010'));
select pg_temp.ok('28 ledger row: agent, seller, show, card snapshot',
  (select source = 'agent' and seller_id = :A and show_id = 's_today' and sold_price = 280 and card_title like '%Silver'
     from show_floor_transactions where client_sale_id = :REQ)
  and (select source from sales where client_sale_id = :REQ) = 'agent');
select pg_temp.ok('29 private cost copy and profit', (select cost_at_sale from transaction_costs where client_sale_id = :REQ) = 180
  and (:'a1'::jsonb)->'result'->>'profit' = '$100.00');
select pg_temp.ok('30 same request id with no token still replays (no second sale)',
  (mcp_record_sale(jsonb_build_object('inventory_id', 'a0000000-0000-0000-0000-000000000011', 'sale_price_cents', 1, 'payment_method', 'cash'), null, :REQ))->>'replayed' = 'true');
select pg_temp.ok('31 held card / open offer refused',
  (mcp_record_sale(jsonb_build_object('inventory_id', 'a0000000-0000-0000-0000-000000000012', 'sale_price_cents', 100, 'payment_method', 'cash'), null, gen_random_uuid()))->>'error' = 'held'
  and (mcp_record_sale(jsonb_build_object('inventory_id', 'a0000000-0000-0000-0000-000000000013', 'sale_price_cents', 100, 'payment_method', 'cash'), null, gen_random_uuid()))->>'error' = 'open_offer');
select pg_temp.ok('32 already sold refused', (mcp_record_sale(jsonb_build_object('inventory_id', 'a0000000-0000-0000-0000-000000000010', 'sale_price_cents', 100, 'payment_method', 'cash'), null, gen_random_uuid()))->>'error' = 'sold');
-- off-show sale: no ledger row
\set REQ2 '''22222222-2222-3333-4444-555555555555'''
select (mcp_record_sale(jsonb_build_object('inventory_id', 'a0000000-0000-0000-0000-000000000011', 'sale_price_cents', 4000, 'payment_method', 'cash'), null, :REQ2))->>'confirm_token' as tok \gset
select mcp_record_sale(jsonb_build_object('inventory_id', 'a0000000-0000-0000-0000-000000000011', 'sale_price_cents', 4000, 'payment_method', 'cash'), :'tok', :REQ2) as a \gset
select pg_temp.ok('33 off-show sale: sold, no ledger row', (:'a'::jsonb)->>'stage' = 'applied' and (:'a'::jsonb)->'result'->>'show' is null
  and (select status from inventory where id = 'a0000000-0000-0000-0000-000000000011') = 'Sold'
  and not exists (select 1 from show_floor_transactions where client_sale_id = :REQ2));
select pg_temp.as_user(:B, 'claude-client');
select pg_temp.ok('34 dealer B without sales scope can''t record', pg_temp.err($$select mcp_record_sale('{}'::jsonb, null, gen_random_uuid())$$) like '%scope_missing:sales:write%');
select pg_temp.ok('35 B can''t read A''s results', (select count(*) from mcp_write_results) = 0);

-- ── assistant tokens and the helpers ────────────────────────────────────────
select pg_temp.as_user(:A, 'claude-client');
select set_config('request.path', '/rpc/_mcp_confirm_issue', false);
select pg_temp.ok('36 the pre-request hook blocks the token helpers', pg_temp.err('select mcp_pre_request()') is not null);
select set_config('request.path', '/rpc/mcp_record_sale', false);
select pg_temp.ok('37 …and allows the write tools', pg_temp.err('select mcp_pre_request()') is null);
select pg_temp.ok('38 confirmation tokens unreadable', pg_temp.err('select * from mcp_confirmations') like '%permission denied%');
select pg_temp.as_user(:A, null);
select pg_temp.ok('39 app sessions can''t use the write tools', pg_temp.err($$select mcp_set_price('{}'::jsonb)$$) like '%oauth_required%');
reset role; reset session authorization;
select pg_temp.ok('40 tokens stored hashed only', not exists (select 1 from mcp_confirmations where length(token_hash) <> 64));
