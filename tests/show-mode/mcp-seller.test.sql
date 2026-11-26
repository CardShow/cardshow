-- Seller MCP Phase 1. Run with mcp-seller.test.sh. Prints PASS or FAIL per check.
-- API calls run as session "authenticator" with role authenticated, like PostgREST.
\set ON_ERROR_STOP 1
alter table inventory add column if not exists sold_date text, add column if not exists sale_notes text,
  add column if not exists stock_code text;
alter table sellers add column if not exists display_name text, add column if not exists instagram text, add column if not exists email text;
alter table shows add column if not exists listed boolean default false, add column if not exists merged_into text;
alter table auth.users add column if not exists email text;
alter table show_floor_transactions add column if not exists api_eligible boolean default true, add column if not exists card_title text,
  add column if not exists item_type text, add column if not exists client_sale_id uuid, add column if not exists category text;
create table if not exists public.admins (id uuid primary key);
\i ../../supabase/migrations/20261023120000_show_mode_sales.sql
\i ../../supabase/migrations/20261101120000_gtcr_buyer_badge.sql
\i ../../supabase/migrations/20261102120000_gtcr_daily_recheck.sql
\i ../../supabase/migrations/20261122120000_marketplace_listings.sql
\i ../../supabase/migrations/20261123120000_marketplace_sold_on_insert.sql
alter table inventory enable row level security;
create policy "Allow all" on inventory for all using (true) with check (true);
\i ../../supabase/migrations/20261124120000_inventory_rls.sql
\i ../../supabase/migrations/20261129120000_marketplace_listing_photos.sql
\i ../../supabase/migrations/20261130120000_marketplace_pricing_search.sql
\i ../../supabase/migrations/20261205120000_pricing_review.sql
do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then
  create role authenticator login noinherit; end if; end $$;
grant anon, authenticated, service_role to authenticator;
alter role service_role bypassrls;
\i ../../supabase/migrations/20261213120000_mcp_seller_phase1.sql
\i ../../supabase/migrations/20261213120000_mcp_seller_phase1.sql
grant all on all tables in schema public to service_role;
grant select on all tables in schema public to anon, authenticated;
grant insert, update, delete on inventory to authenticated;
revoke all on public.card_values, public.agent_actions from anon, authenticated;
grant select on public.agent_actions, public.mcp_client_grants to authenticated;

create or replace function pg_temp.ok(p_name text, p_cond boolean) returns text language sql as $$
  select case when coalesce(p_cond, false) then 'PASS ' else 'FAIL ' end || p_name $$;
-- Become a user. p_client null = normal app session; otherwise an assistant (OAuth) token.
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
insert into auth.users (id, email) values (:A, 'a@example.test'), (:B, 'b@example.test'), ('cccccccc-0000-0000-0000-000000000003', 'c@example.test');
insert into sellers (id, handle, display_name) values (:A, 'dealer_a', 'Dealer A'), (:B, 'dealer_b', 'Dealer B');
insert into shows (id, name, start_date, end_date, city, state, listed) values
  ('s_up', 'Upcoming Show', current_date + 3, current_date + 4, 'Anaheim', 'CA', true),
  ('s_p1', 'Past One', current_date - 90, current_date - 89, 'Anaheim', 'CA', true),
  ('s_p2', 'Past Two', current_date - 60, current_date - 60, 'Dallas', 'TX', true),
  ('s_p3', 'Past Three', current_date - 30, current_date - 29, 'Austin', 'TX', true),
  ('s_b', 'B Only', current_date + 5, current_date + 5, 'Reno', 'NV', true);
insert into show_sellers values ('s_up', :A, '12'), ('s_p3', :A, '7'), ('s_b', :B, '3');
insert into inventory (id, seller_id, card_title, player, year, card_set, card_number, parallel, grader, grade, cert_number, price, status, category, subcategory, stock_code, created_at) values
  ('a0000000-0000-0000-0000-000000000001', :A, '1999 Pokemon Base Set Charizard Holo PSA 10', 'Charizard', 1999, 'Base Set', '4', 'Holo', 'PSA', 10, '111', 180, 'Available', 'TCG', 'Pokémon', 'S-1', now() - interval '200 days'),
  ('a0000000-0000-0000-0000-000000000002', :A, '2024 Prizm Jayden Daniels Silver', 'Jayden Daniels', 2024, 'Prizm', '331', 'Silver', null, null, null, 25, 'Available', 'Sports', 'Football', 'R-4', now() - interval '10 days'),
  ('a0000000-0000-0000-0000-000000000003', :A, 'Mystery card', null, null, null, null, null, 'BGS', null, null, null, 'Available', null, null, null, now()),
  ('a0000000-0000-0000-0000-000000000004', :A, '2023 Prizm Wemby PSA 9', 'Victor Wembanyama', 2023, 'Prizm', '136', null, 'PSA', 9, '444', 400, 'Sold', 'Sports', 'Basketball', 'S-2', now() - interval '5 days'),
  ('b0000000-0000-0000-0000-000000000001', :B, 'B secret Charizard', 'Charizard', 1999, 'Base Set', '4', 'Holo', 'PSA', 10, '999', 500, 'Available', 'TCG', 'Pokémon', 'S-1', now());
update inventory set sold_price = 380, payment_method = 'Cash', sold_date = to_char(current_date, 'YYYY-MM-DD') where id = 'a0000000-0000-0000-0000-000000000004';
insert into show_inventory values ('s_p1', 'a0000000-0000-0000-0000-000000000001'), ('s_p2', 'a0000000-0000-0000-0000-000000000001'),
  ('s_p3', 'a0000000-0000-0000-0000-000000000001'), ('s_up', 'a0000000-0000-0000-0000-000000000001'),
  ('s_p3', 'a0000000-0000-0000-0000-000000000002'), ('s_up', 'a0000000-0000-0000-0000-000000000004'),
  ('s_b', 'b0000000-0000-0000-0000-000000000001');
-- Card Hedge values: Charizard matched ($200, 40 sales), Daniels matched but under review (hidden).
update inventory set pricing_card_id = 'ch-zard', pricing_match_status = 'matched', comp_value_cents = 20000, comp_refreshed_at = now()
 where id = 'a0000000-0000-0000-0000-000000000001';
update inventory set pricing_card_id = 'ch-dan', pricing_match_status = 'review', comp_value_cents = 900
 where id = 'a0000000-0000-0000-0000-000000000002';
update inventory set pricing_card_id = 'ch-zard', pricing_match_status = 'matched', comp_value_cents = 20000
 where id = 'b0000000-0000-0000-0000-000000000001';
insert into card_values (card_id, grade, value_cents, low_cents, high_cents, sales_30d, refreshed_at) values
  ('ch-zard', 'PSA 10', 20000, 17000, 24000, 40, now()), ('ch-dan', 'Raw', 900, 500, 1500, 2, now());
-- Ledger: A sold the Wemby at s_up for $380 cash, a $120 Venmo sale later undone, B sold one at s_b.
insert into show_floor_transactions (id, sold_at, sold_price, payment_method, source, inventory_id, player, card_title, category, seller_id, show_id) values
  ('f0000000-0000-0000-0000-000000000001', now(), 380, 'Cash', 'platform', 'a0000000-0000-0000-0000-000000000004', 'Victor Wembanyama', '2023 Prizm Wemby PSA 9', 'Sports', :A, 's_up'),
  ('f0000000-0000-0000-0000-000000000002', now(), 120, 'Venmo', 'platform', null, 'Somebody', 'Undone sale', 'Sports', :A, 's_up'),
  ('f0000000-0000-0000-0000-000000000003', now(), 999, 'Cash', 'platform', null, 'B card', 'B sale', 'TCG', :B, 's_b');
insert into show_floor_transactions (sold_at, sold_price, payment_method, source, seller_id, show_id, voids_transaction_id)
  values (now(), -120, 'Venmo', 'platform', :A, 's_up', 'f0000000-0000-0000-0000-000000000002');

set session authorization authenticator; set role authenticated;

-- 01–05 consent
select pg_temp.as_user(:A, null);
select pg_temp.ok('01 dealer approves read access for Claude',
  (assistant_grant_consent('claude-client', 'Claude', array['inventory:read']))->>'ok' = 'true');
select pg_temp.ok('02 read scope is required', (assistant_grant_consent('x', 'X', array['sales:write']))->>'error' = 'read_scope_required');
select pg_temp.ok('03 unknown scopes refused', (assistant_grant_consent('x', 'X', array['inventory:read','admin']))->>'error' = 'bad_scope');
select pg_temp.as_user(:B, null);
select (assistant_grant_consent('claude-client', 'Claude', array['inventory:read','inventory:write']))->>'ok' as b_ok \gset
select pg_temp.ok('04 a second dealer connects the same assistant separately', :'b_ok' = 'true');
select pg_temp.as_user(:A, 'claude-client');
select pg_temp.ok('05 an assistant token cannot widen its own scopes',
  pg_temp.err($$select assistant_grant_consent('claude-client', 'Claude', array['inventory:read','sales:write'])$$) like '%assistant_token_not_allowed%');

-- 06–12 who may call the tools
select pg_temp.ok('06 whoami returns the dealer and scopes', (select s->>'handle' = 'dealer_a' and s->'scopes' = '["inventory:read"]'
  from (select mcp_session() s) x));
select pg_temp.as_user(:A, null);
select pg_temp.ok('07 a normal app session is refused (OAuth required)', pg_temp.err('select mcp_session()') like '%mcp:oauth_required%');
select pg_temp.as_user(:A, 'other-client');
select pg_temp.ok('08 an assistant the dealer never approved is refused', pg_temp.err('select mcp_my_inventory()') like '%mcp:not_connected%');
select pg_temp.as_user('cccccccc-0000-0000-0000-000000000003', 'claude-client');
select pg_temp.ok('09 a non-seller account is refused', pg_temp.err('select mcp_session()') like '%mcp:not_a_seller%');
reset role;
set role anon;
select pg_temp.as_user(null, null);
select pg_temp.ok('10 anon cannot call seller tools', pg_temp.err('select mcp_my_inventory()') like '%permission denied%');
reset role; set role authenticated;
select pg_temp.as_user(:A, 'claude-client');
select pg_temp.ok('11 read scope is enough for inventory', (mcp_my_inventory('{}'))->>'total' = '3');
select pg_temp.ok('12 _mcp_require reports a missing scope', pg_temp.err($$select _mcp_require('sales:write')$$) like '%mcp:scope_missing:sales:write%');

-- 13–24 list_my_inventory / get_my_card (A only ever sees A)
select pg_temp.ok('13 default lists unsold cards only (sold Wemby left out)',
  (select bool_and(e->>'status' <> 'sold') and count(*) = 3 from jsonb_array_elements((mcp_my_inventory('{}'))->'results') e));
select pg_temp.ok('14 never another dealer''s cards',
  (select count(*) = 0 from jsonb_array_elements((mcp_my_inventory('{"status":"all","limit":100}'))->'results') e where e->>'id' like 'b%'));
select pg_temp.ok('15 text search: "charizard 10"', (mcp_my_inventory('{"text":"charizard 10"}'))->>'total' = '1');
select pg_temp.ok('16 stock code search: "s1" finds S-1', (mcp_my_inventory('{"text":"s1"}'))->'results'->0->>'stock_code' = 'S-1');
select pg_temp.ok('17 raw filter', (mcp_my_inventory('{"raw":true}'))->'results'->0->>'player' = 'Jayden Daniels');
select pg_temp.ok('18 missing price + player finds the mystery card',
  (mcp_my_inventory('{"missing_fields":["price","player"]}'))->'results'->0->>'title' = 'Mystery card');
select pg_temp.ok('19 status sold + grade range', (mcp_my_inventory('{"status":"sold","grade_min":9}'))->'results'->0->'sale'->>'sold_price' = '$380.00');
select pg_temp.ok('20 price sort and cents/dollars',
  (select r->0->>'price_cents' = '18000' and r->0->>'price' = '$180.00' from (select (mcp_my_inventory('{"sort":"price_desc"}'))->'results' r) x));
select pg_temp.ok('21 comp shown when matched, pct_of_comp 0.9',
  (select c->'comp'->>'value' = '$200.00' and c->>'pct_of_comp' = '0.900'
     from (select mcp_my_card('a0000000-0000-0000-0000-000000000001') c) x));
select pg_temp.ok('22 comp under review reads "No comp yet"',
  (mcp_my_card('a0000000-0000-0000-0000-000000000002'))->'comp'->>'note' = 'No comp yet');
select pg_temp.ok('23 another dealer''s card is not_found', (mcp_my_card('b0000000-0000-0000-0000-000000000001'))->>'error' = 'not_found');
select pg_temp.ok('24 show filter + bad status rejected', (mcp_my_inventory('{"show_id":"s_p3"}'))->>'total' = '2'
  and pg_temp.err($$select mcp_my_inventory('{"status":"lost"}')$$) like '%mcp:bad_input%');

-- 25–29 price suggestions
select pg_temp.ok('25 suggestion at 95% of comp, high confidence, range shown',
  (select r->>'suggested_price_cents' = '19000' and r->>'confidence' = 'high' and r->'comp'->>'low' = '$170.00'
     from (select (mcp_price_suggestions(array['a0000000-0000-0000-0000-000000000001']::uuid[], 0.95))->'results'->0 r) x));
select pg_temp.ok('26 no comp: says so, no number invented',
  (select r->>'note' = 'No comp yet' and r->'suggested_price_cents' = 'null'::jsonb
     from (select (mcp_price_suggestions(array['a0000000-0000-0000-0000-000000000002']::uuid[]))->'results'->0 r) x));
select pg_temp.ok('27 another dealer''s card: not_found (no values leaked)',
  (mcp_price_suggestions(array['b0000000-0000-0000-0000-000000000001']::uuid[]))->'results'->0->>'error' = 'not_found');
select pg_temp.ok('28 over 50 cards refused', pg_temp.err($$select mcp_price_suggestions(array(select gen_random_uuid() from generate_series(1,51)))$$) like '%At most 50%');
select pg_temp.ok('29 card_values still unreadable directly', pg_temp.err('select * from card_values') like '%permission denied%');

-- 30–32 shows, sales, stale
select pg_temp.ok('30 upcoming shows: s_up with table 12 and 2 cards, not B''s show',
  (select s->'shows'->0->>'id' = 's_up' and s->'shows'->0->>'table_number' = '12' and s->'shows'->0->>'cards_published' = '2'
          and jsonb_array_length(s->'shows') = 1 from (select mcp_my_shows('{}') s) x));
select pg_temp.ok('31 sales summary at s_up: $380, undone sale out, B''s sale out, sell-through 1 of 2',
  (select s->>'total' = '$380.00' and s->>'sales_count' = '1' and s->'by_payment_method'->0->>'method' = 'Cash'
          and s->'sell_through'->>'cards_sold' = '1' and s->'sell_through'->>'cards_brought' = '2'
     from (select mcp_sales_summary('{"show_id":"s_up"}') s) x));
select pg_temp.ok('32 stale: Charizard at 3 ended shows, Daniels at 1 not listed',
  (select s->>'total' = '1' and s->'results'->0->>'ended_shows_count' = '3' from (select mcp_stale_inventory('{}') s) x));

-- 33–36 revoke and the pre-request hook
select pg_temp.as_user(:A, null);
select pg_temp.ok('33 dealer disconnects the assistant', (assistant_revoke_client('claude-client'))->>'revoked' = 'true');
select pg_temp.as_user(:A, 'claude-client');
select pg_temp.ok('34 its token stops working at once', pg_temp.err('select mcp_session()') like '%mcp:not_connected%');
select set_config('request.path', '/inventory', false);
select pg_temp.ok('35 hook: an assistant token cannot reach tables', pg_temp.err('select mcp_pre_request()') like '%only use the CardShow MCP tools%');
select set_config('request.path', '/rpc/record_sale', false);
select pg_temp.ok('36 hook: nor the app''s other functions', pg_temp.err('select mcp_pre_request()') is not null);
select set_config('request.path', '/rpc/mcp_my_inventory', false);
select pg_temp.ok('37 hook: mcp_* functions allowed', pg_temp.err('select mcp_pre_request()') is null);
select pg_temp.as_user(:A, null); select set_config('request.path', '/inventory', false);
select pg_temp.ok('38 hook: normal app sessions untouched', pg_temp.err('select mcp_pre_request()') is null);
select pg_temp.as_user(:A, 'claude-client');
select pg_temp.ok('39 storage refuses assistant tokens', pg_temp.err($$insert into storage.objects (bucket_id, name) values ('card-captures', 'x/y.jpg')$$) is not null);
reset role; reset session authorization;
select pg_temp.ok('40 PostgREST pre-request hook configured',
  exists (select 1 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) c
           where r.rolname = 'authenticator' and c = 'pgrst.db_pre_request=public.mcp_pre_request'));
