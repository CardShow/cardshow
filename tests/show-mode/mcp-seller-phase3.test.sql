-- Seller MCP Phase 3: set_prices, cards from photos, offers. Run with mcp-seller-phase3.test.sh. PASS / FAIL per check.
\set ON_ERROR_STOP 1
alter table inventory add column if not exists sold_date text, add column if not exists sale_notes text,
  add column if not exists location text, add column if not exists identification_status text,
  add column if not exists features text[], add column if not exists detected_confidence jsonb;
alter table sellers add column if not exists display_name text, add column if not exists instagram text,
  add column if not exists email text, add column if not exists whatsapp text;
alter table shows add column if not exists listed boolean default false, add column if not exists merged_into text;
alter table auth.users add column if not exists email text;
alter table show_floor_transactions
  add column if not exists api_eligible boolean default true, add column if not exists card_title text,
  add column if not exists item_type text, add column if not exists client_sale_id uuid, add column if not exists category text;
create table if not exists public.admins (id uuid primary key);
create table if not exists public.platform_admins (id uuid primary key);
\i ../../supabase/migrations/20261023120000_show_mode_sales.sql
\i ../../supabase/migrations/20261101120000_gtcr_buyer_badge.sql
\i ../../supabase/migrations/20261102120000_gtcr_daily_recheck.sql
\i ../../supabase/migrations/20261122120000_marketplace_listings.sql
\i ../../supabase/migrations/20261123120000_marketplace_sold_on_insert.sql
alter table inventory enable row level security;
create policy "Allow all" on inventory for all using (true) with check (true);
\i ../../supabase/migrations/20261124120000_inventory_rls.sql
\i ../../supabase/migrations/20261129120000_marketplace_listing_photos.sql
create or replace function public.is_cardshow_admin() returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from admins where id = auth.uid()) $$;
grant execute on function public.is_cardshow_admin() to authenticated, service_role;
\i ../../supabase/migrations/20261130120000_marketplace_pricing_search.sql
\i ../../supabase/migrations/20261202120000_pricing_admin.sql
alter table shows add column if not exists slug text, add column if not exists website text;
\i ../../supabase/migrations/20261203120000_marketplace_buyer_site.sql
\i ../../supabase/migrations/20261204120000_marketplace_photo_ranking.sql
\i ../../supabase/migrations/20261205120000_pricing_review.sql
\i ../../supabase/migrations/20261206120000_marketplace_show_pages.sql
\i ../../supabase/migrations/20261207120000_marketplace_holds.sql
\i ../../supabase/migrations/20261208120000_marketplace_offers.sql
\i ../../supabase/migrations/20261209120000_marketplace_bundle_offers.sql
\i ../../supabase/migrations/20261211120000_marketplace_offer_rules.sql
\i ../../supabase/migrations/20261114120000_cost_tracking.sql
do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then
  create role authenticator login noinherit; end if; end $$;
grant anon, authenticated, service_role to authenticator;
alter role service_role bypassrls;
\i ../../supabase/migrations/20261213120000_mcp_seller_phase1.sql
\i ../../supabase/migrations/20261214120000_mcp_seller_phase2.sql
\i ../../supabase/migrations/20261215120000_mcp_seller_phase3.sql
\i ../../supabase/migrations/20261215120000_mcp_seller_phase3.sql
\i ../../supabase/migrations/20261216120000_mcp_seller_phase3b.sql
\i ../../supabase/migrations/20261216120000_mcp_seller_phase3b.sql
grant all on all tables in schema public to service_role;
grant select on all tables in schema public to anon, authenticated;
grant insert, update, delete on inventory to authenticated;
grant all on public.stock_code_counters to authenticated;
revoke all on public.card_values, public.agent_actions, public.mcp_photo_jobs, public.mcp_photo_links from anon, authenticated;
grant select on public.agent_actions, public.mcp_client_grants, public.mcp_photo_jobs to authenticated;

create or replace function pg_temp.ok(p_name text, p_cond boolean) returns text language sql as $$
  select case when coalesce(p_cond, false) then 'PASS ' else 'FAIL ' end || p_name $$;
create or replace function pg_temp.as_user(p_uid text, p_client text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), false);
  perform set_config('request.jwt.claims', case when p_uid is null then '' else
    (jsonb_build_object('sub', p_uid, 'role', 'authenticated') || case when p_client is null then '{}'::jsonb
      else jsonb_build_object('client_id', p_client) end)::text end, false);
end $$;

\set A '''aaaaaaaa-0000-0000-0000-000000000001'''
\set B '''bbbbbbbb-0000-0000-0000-000000000002'''
\set C '''cccccccc-0000-0000-0000-000000000003'''
\set ZARD '''a0000000-0000-0000-0000-000000000001'''
\set NOCOMP '''a0000000-0000-0000-0000-000000000002'''
\set SOLD '''a0000000-0000-0000-0000-000000000003'''
\set HELD '''a0000000-0000-0000-0000-000000000004'''
\set NOPRICE '''a0000000-0000-0000-0000-000000000005'''
\set CHEAP '''a0000000-0000-0000-0000-000000000006'''
\set OFFERCARD '''a0000000-0000-0000-0000-000000000007'''
\set BCARD '''b0000000-0000-0000-0000-000000000001'''
insert into auth.users (id, email) values (:A, 'a@example.test'), (:B, 'b@example.test'), (:C, 'c@example.test');
insert into sellers (id, handle, display_name) values (:A, 'dealer_a', 'Dealer A'), (:B, 'dealer_b', 'Dealer B');
insert into shows (id, name, start_date, end_date, city, state, listed) values
  ('s_today', 'Today Show', current_date, current_date + 1, 'Pomona', 'CA', true);
insert into show_sellers (show_id, seller_id, table_number) values ('s_today', :A, '21');
insert into inventory (id, seller_id, card_title, player, year, card_set, card_number, grader, grade, cert_number, price, status) values
  (:ZARD, :A, '1999 Base Set Charizard', 'Charizard', 1999, 'Base Set', '4', 'PSA', 10, '111', 180, 'Available'),
  (:NOCOMP, :A, '2024 Prizm Daniels', 'Jayden Daniels', 2024, 'Prizm', '331', null, null, null, 25, 'Available'),
  (:SOLD, :A, 'Sold card', 'Sold Guy', 2020, 'Prizm', '1', null, null, null, 50, 'Sold'),
  (:HELD, :A, 'Held card', 'Held Guy', 2020, 'Prizm', '2', null, null, null, 60, 'Available'),
  (:NOPRICE, :A, 'No price card', 'Nobody', 2020, 'Prizm', '3', null, null, null, 0, 'Available'),
  (:CHEAP, :A, 'Cheap comp card', 'Cheap Guy', 2021, 'Prizm', '9', null, null, null, 10, 'Available'),
  (:OFFERCARD, :A, '2023 Prizm Wemby', 'Victor Wembanyama', 2023, 'Prizm', '136', null, null, null, 100, 'Available'),
  (:BCARD, :B, 'B card', 'B Guy', 2020, 'Prizm', '5', null, null, null, 70, 'Available');
update inventory set pricing_card_id = 'ch-zard', pricing_match_status = 'matched', comp_value_cents = 20000 where id = :ZARD;
update inventory set pricing_card_id = 'ch-cheap', pricing_match_status = 'manual', comp_value_cents = 1500 where id = :CHEAP;
update inventory set listing_status = 'reserved' where id = :HELD;
update inventory set listing_status = 'active', accepts_offers = true where id = :OFFERCARD;

set session authorization authenticator; set role authenticated;
select pg_temp.as_user(:A, null);
select assistant_grant_consent('claude-client', 'Claude', array['inventory:read','inventory:write','sales:write','offers:write']);
select assistant_grant_consent('read-only', 'Reader', array['inventory:read']);
select pg_temp.as_user(:B, null);
select assistant_grant_consent('claude-client', 'Claude', array['inventory:read','inventory:write','offers:write']);

-- ── set_prices ──────────────────────────────────────────────────────────────
select pg_temp.as_user(:A, 'claude-client');
\set R1 '''11111111-0000-0000-0000-000000000001'''
select pg_temp.ok('01 client_request_id required',
  (mcp_set_prices(jsonb_build_object('inventory_ids', jsonb_build_array(:ZARD), 'rule', '{"type":"pct_of_comp","percent":90}'::jsonb)))->>'error' = 'bad_input');
select pg_temp.ok('02 more than 200 cards refused',
  (mcp_set_prices(jsonb_build_object('inventory_ids', (select jsonb_agg(gen_random_uuid()) from generate_series(1, 201)),
    'rule', '{"type":"pct_of_comp","percent":90}'::jsonb), null, :R1))->>'error' = 'too_many');
select mcp_set_prices(jsonb_build_object('inventory_ids', jsonb_build_array(:ZARD, :NOCOMP, :SOLD, :HELD, :CHEAP, :BCARD),
  'rule', '{"type":"pct_of_comp","percent":80}'::jsonb), null, :R1) as p \gset
select pg_temp.ok('03 preview: comp cards repriced, others skipped with a reason, nothing changed',
  (:'p'::jsonb)->>'stage' = 'preview' and ((:'p'::jsonb)->'preview'->>'count')::int = 2
  and (:'p'::jsonb)->'preview'->'changes' @> jsonb_build_array(jsonb_build_object('inventory_id', :ZARD, 'new_price_cents', 16000))
  and (:'p'::jsonb)->'preview'->'changes' @> jsonb_build_array(jsonb_build_object('inventory_id', :CHEAP, 'new_price_cents', 1200))
  and (:'p'::jsonb)->'preview'->'skipped' @> jsonb_build_array(jsonb_build_object('inventory_id', :NOCOMP, 'reason', 'no_comp'),
      jsonb_build_object('inventory_id', :SOLD, 'reason', 'sold'), jsonb_build_object('inventory_id', :HELD, 'reason', 'held'),
      jsonb_build_object('inventory_id', :BCARD, 'reason', 'not_found'))
  and (select price from inventory where id = :ZARD) = 180);
select pg_temp.ok('04 totals before / after', (:'p'::jsonb)->'preview'->>'total_before' = '$190.00' and (:'p'::jsonb)->'preview'->>'total_after' = '$172.00');
select mcp_set_prices(jsonb_build_object('inventory_ids', jsonb_build_array(:ZARD, :CHEAP),
  'rule', '{"type":"pct_of_comp","percent":50}'::jsonb, 'floor_cents', 1500, 'ceiling_cents', 9500, 'round_to', 'five_dollars'), null, :R1) as p2 \gset
select pg_temp.ok('05 floor and ceiling respected, rounding to $5',
  (:'p2'::jsonb)->'preview'->'changes' @> jsonb_build_array(jsonb_build_object('inventory_id', :ZARD, 'new_price_cents', 9500, 'at_ceiling', true),
     jsonb_build_object('inventory_id', :CHEAP, 'new_price_cents', 1500, 'at_floor', true)));
-- data changed on one card → none change
select (:'p'::jsonb)->>'confirm_token' as tok \gset
select pg_temp.as_user(:A, null);
update inventory set price = 11 where id = :CHEAP;
select pg_temp.as_user(:A, 'claude-client');
select pg_temp.ok('06 one card changed since the preview: refused, no price changed',
  (mcp_set_prices(jsonb_build_object('inventory_ids', jsonb_build_array(:ZARD, :NOCOMP, :SOLD, :HELD, :CHEAP, :BCARD),
    'rule', '{"type":"pct_of_comp","percent":80}'::jsonb), :'tok', :R1))->>'error' = 'data_changed'
  and (select price from inventory where id = :ZARD) = 180);
\set ARGS '''{"inventory_ids":["a0000000-0000-0000-0000-000000000001","a0000000-0000-0000-0000-000000000006"],"rule":{"type":"pct_of_comp","percent":80}}'''
select (mcp_set_prices(:ARGS::jsonb, null, :R1))->>'confirm_token' as tok \gset
select mcp_set_prices(:ARGS::jsonb, :'tok', :R1) as a \gset
select pg_temp.ok('07 apply: every card changed together',
  (:'a'::jsonb)->>'stage' = 'applied' and ((:'a'::jsonb)->'result'->>'updated')::int = 2
  and (select price from inventory where id = :ZARD) = 160 and (select price from inventory where id = :CHEAP) = 12);
select pg_temp.ok('08 the same request sent twice more changes nothing',
  (mcp_set_prices(:ARGS::jsonb, null, :R1))->>'replayed' = 'true' and (mcp_set_prices(:ARGS::jsonb, :'tok', :R1))->>'replayed' = 'true'
  and (select count(*) from mcp_write_results where client_request_id = :R1) = 1);
\set R2 '''11111111-0000-0000-0000-000000000002'''
select mcp_set_prices(jsonb_build_object('inventory_ids', jsonb_build_array(:ZARD, :NOPRICE),
  'rule', '{"type":"change_percent","percent":-10}'::jsonb), null, :R2) as p3 \gset
select pg_temp.ok('09 change_percent: -10% rounded to the dollar; a card with no price skipped',
  (:'p3'::jsonb)->'preview'->'changes' @> jsonb_build_array(jsonb_build_object('inventory_id', :ZARD, 'new_price_cents', 14400))
  and (:'p3'::jsonb)->'preview'->'skipped' @> jsonb_build_array(jsonb_build_object('inventory_id', :NOPRICE, 'reason', 'no_price')));
select pg_temp.ok('10 nothing to change refused',
  (mcp_set_prices(jsonb_build_object('inventory_ids', jsonb_build_array(:SOLD), 'rule', '{"type":"set_cents","cents":500}'::jsonb), null, :R2))->>'error' = 'no_changes');
select pg_temp.ok('11 bad rule refused',
  (mcp_set_prices(jsonb_build_object('inventory_ids', jsonb_build_array(:ZARD), 'rule', '{"type":"pct_of_comp","percent":0}'::jsonb), null, :R2))->>'error' = 'bad_input'
  and (mcp_set_prices(jsonb_build_object('inventory_ids', jsonb_build_array(:ZARD), 'rule', '{"type":"guess"}'::jsonb), null, :R2))->>'error' = 'bad_input');
select pg_temp.as_user(:A, 'read-only');
do $$ begin perform mcp_set_prices('{"inventory_ids":["a0000000-0000-0000-0000-000000000001"],"rule":{"type":"set_cents","cents":100}}'::jsonb,
  null, '11111111-0000-0000-0000-000000000009'); raise notice 'FAIL 12 read-only assistant could reprice';
exception when others then raise notice 'PASS 12 read-only assistant refused: %', sqlerrm; end $$;

-- ── photos ──────────────────────────────────────────────────────────────────
select pg_temp.as_user(:A, 'claude-client');
select pg_temp.ok('13 more than 20 photos refused',
  (mcp_photo_job_start(jsonb_build_object('images', (select jsonb_agg(jsonb_build_object('source', 'upload')) from generate_series(1, 21)))))->>'error' = 'bad_input');
select pg_temp.ok('14 non-https url refused',
  (mcp_photo_job_start('{"images":[{"source":"url","url":"http://example.com/a.jpg"}]}'::jsonb))->>'error' = 'bad_input');
select mcp_photo_job_start('{"images":[{"source":"upload","media_type":"image/jpeg"},{"source":"url","url":"https://example.com/b.jpg"},{"source":"upload"},{"source":"upload"}]}'::jsonb) as j \gset
select (:'j'::jsonb)->>'job_id' as job \gset
select pg_temp.ok('15 job started: one storage key per photo, in the dealer''s own folder',
  jsonb_array_length((:'j'::jsonb)->'images') = 4
  and (select bool_and(e->>'key' like 'aaaaaaaa-0000-0000-0000-000000000001/%/original.jpg') from jsonb_array_elements((:'j'::jsonb)->'images') e));
\set R3 '''22222222-0000-0000-0000-000000000001'''
select pg_temp.ok('16 while photos are read: stage working, nothing created',
  (mcp_add_cards_from_photos(jsonb_build_object('job_id', :'job'), null, :R3))->>'stage' = 'working');
-- the worker (service role) reads the photos
reset role; reset session authorization;
insert into card_captures (id, seller_id, entry_point, original_key, uploaded_at)
  select (e->>'capture_id')::uuid, :A, 'case_scan', e->>'key', now() from mcp_photo_jobs, jsonb_array_elements(images) e where id = :'job';
insert into inventory (id, seller_id, card_title, grader, cert_number, price, status) values
  ('a0000000-0000-0000-0000-000000000099', :A, 'Already have this slab', 'PSA', '55555', 40, 'Available');
update mcp_photo_jobs set status = 'done', finished_at = now(), updated_at = now(), images = (
  select jsonb_agg(case (e->>'n')::int
    when 1 then e || '{"status":"done","card":{"player_name":"Shohei Ohtani","year":"2018","set_name":"Topps Chrome","card_number":"150","parallel_name":"Refractor","autograph":false,"grading_company":"PSA","grade":"10","cert_number":"777","confidence":{"player_name":0.95,"year":0.9,"set_name":0.9,"grade":0.95,"cert_number":0.95}}}'::jsonb
    when 2 then e || '{"status":"done","card":{"player_name":"Blurry Guy","year":"2020","set_name":"Prizm","autograph":true,"confidence":{"player_name":0.4,"year":0.9,"set_name":0.5}}}'::jsonb
    when 3 then e || '{"status":"done","card":{"player_name":"Dup Slab","year":"2019","set_name":"Prizm","grading_company":"PSA","grade":"9","cert_number":"55555","confidence":{"player_name":0.9,"year":0.9,"set_name":0.9,"grade":0.9,"cert_number":0.9}}}'::jsonb
    else e || '{"status":"failed","error":"Not a trading card"}'::jsonb end order by (e->>'n')::int)
  from mcp_photo_jobs j2, jsonb_array_elements(j2.images) e where j2.id = :'job') where id = :'job';
set session authorization authenticator; set role authenticated;
select pg_temp.as_user(:B, 'claude-client');
select pg_temp.ok('17 another dealer can''t see the batch',
  (mcp_add_cards_from_photos(jsonb_build_object('job_id', :'job'), null, :R3))->>'error' = 'not_found');
select pg_temp.as_user(:A, 'claude-client');
select mcp_add_cards_from_photos(jsonb_build_object('job_id', :'job'), null, :R3) as pv \gset
select pg_temp.ok('18 preview: drafts with confidence, unsure fields flagged, duplicate slab skipped, unreadable photo listed, no card created',
  (:'pv'::jsonb)->>'stage' = 'preview' and ((:'pv'::jsonb)->'preview'->>'count')::int = 2
  and ((:'pv'::jsonb)->'preview'->>'need_a_check')::int = 1
  and (:'pv'::jsonb)->'preview'->'cards' @> '[{"index":2,"low_confidence":true,"check_fields":["player","set"]}]'
  and (:'pv'::jsonb)->'preview'->'cards' @> '[{"index":1,"title":"2018 Topps Chrome Shohei Ohtani Refractor","grader":"PSA","grade":"10","low_confidence":false}]'
  and (:'pv'::jsonb)->'preview'->'skipped' @> '[{"index":3,"duplicate_of":"a0000000-0000-0000-0000-000000000099"}]'
  and (:'pv'::jsonb)->'preview'->'could_not_read' @> '[{"index":4,"reason":"Not a trading card"}]'
  and (:'pv'::jsonb)->'preview'->'show'->>'id' = 's_today'
  and not exists (select 1 from inventory where player = 'Shohei Ohtani'));
\set PARGS '''{"job_id":"JOB","cards":[{"index":2,"player":"Clear Guy","set":"Prizm Silver","price_cents":2500},{"index":1,"price_cents":30000}]}'''
select replace(:PARGS, 'JOB', :'job') as pargs \gset
select mcp_add_cards_from_photos(:'pargs'::jsonb, null, :R3) as pv2 \gset
select pg_temp.ok('19 dealer''s fixes clear the flag and set the price',
  ((:'pv2'::jsonb)->'preview'->>'need_a_check')::int = 0
  and (:'pv2'::jsonb)->'preview'->'cards' @> '[{"index":2,"player":"Clear Guy","price_cents":2500,"title":"2020 Prizm Silver Clear Guy Auto"}]');
select mcp_add_cards_from_photos(:'pargs'::jsonb, (:'pv2'::jsonb)->>'confirm_token', :R3) as ap \gset
select pg_temp.ok('20 apply creates the cards with their photos, publishes to today''s show, gives stock codes',
  (:'ap'::jsonb)->>'stage' = 'applied' and ((:'ap'::jsonb)->'result'->>'added')::int = 2
  and (select count(*) from inventory i where i.seller_id = :A and i.player in ('Shohei Ohtani', 'Clear Guy')
         and i.primary_capture_id is not null and i.status = 'Available') = 2
  and (select count(*) from card_captures c join inventory i on i.id = c.inventory_id where i.player in ('Shohei Ohtani', 'Clear Guy') and c.status = 'attached') = 2
  and (select count(*) from show_inventory si join inventory i on i.id = si.card_id where si.show_id = 's_today' and i.player in ('Shohei Ohtani', 'Clear Guy')) = 2
  and (select count(*) from inventory where player in ('Shohei Ohtani', 'Clear Guy') and stock_code is not null) = 2
  and (select price from inventory where player = 'Shohei Ohtani') = 300
  and (select features from inventory where player = 'Clear Guy') = array['Auto']
  and jsonb_array_length((:'ap'::jsonb)->'result'->'gtcr_recheck_ids') = 1);
select pg_temp.ok('21 the same request again adds nothing',
  (mcp_add_cards_from_photos(:'pargs'::jsonb, null, :R3))->>'replayed' = 'true'
  and (select count(*) from inventory where player in ('Shohei Ohtani', 'Clear Guy')) = 2);
select pg_temp.ok('22 a batch can''t be added twice',
  (mcp_add_cards_from_photos(:'pargs'::jsonb, null, '22222222-0000-0000-0000-000000000002'))->>'error' = 'already_added');
select pg_temp.as_user(:A, 'read-only');
do $$ begin perform mcp_photo_job_start('{"images":[{"source":"upload"}]}'::jsonb); raise notice 'FAIL 23 read-only assistant started a photo batch';
exception when others then raise notice 'PASS 23 read-only assistant can''t send photos: %', sqlerrm; end $$;

-- ── offers ──────────────────────────────────────────────────────────────────
reset role; reset session authorization;
insert into offers (id, listing_id, listing_ids, dealer_id, buyer_id, buyer_name, buyer_contact, amount_cents, offer_cents, asking_cents,
                    last_by, history, expires_at, status)
values ('0f000000-0000-0000-0000-000000000001', :OFFERCARD, array[:OFFERCARD::uuid], :A, :C, 'Casey', 'casey@example.test', 7000, 7000, 10000,
        'buyer', '[{"by":"buyer","cents":7000}]', now() + interval '1 day', 'pending');
set session authorization authenticator; set role authenticated;
select pg_temp.as_user(:A, 'claude-client');
select mcp_my_offers('{}'::jsonb) as lo \gset
select pg_temp.ok('24 list_offers: the offer waiting for the dealer, without the buyer''s contact',
  ((:'lo'::jsonb)->>'total')::int = 1 and (:'lo'::jsonb)->'results'->0->>'offer' = '$70.00'
  and (:'lo'::jsonb)->'results'->0->>'your_turn' = 'true' and (:'lo'::jsonb)->'results'->0->>'buyer_name' = 'Casey'
  and (:'lo'::jsonb)::text not like '%casey@example%');
select pg_temp.as_user(:B, 'claude-client');
select pg_temp.ok('25 another dealer sees none and can''t answer it',
  ((mcp_my_offers('{}'::jsonb))->>'total')::int = 0
  and (mcp_respond_offer('{"offer_id":"0f000000-0000-0000-0000-000000000001","action":"decline"}'::jsonb))->>'error' = 'not_found');
select pg_temp.as_user(:A, 'claude-client');
select pg_temp.ok('26 counter out of range refused with the range',
  (mcp_respond_offer('{"offer_id":"0f000000-0000-0000-0000-000000000001","action":"counter","counter_cents":12000}'::jsonb))->>'max_cents' = '9999');
select mcp_respond_offer('{"offer_id":"0f000000-0000-0000-0000-000000000001","action":"counter","counter_cents":9000}'::jsonb) as op \gset
select pg_temp.ok('27 preview says what happens, offer unchanged',
  (:'op'::jsonb)->>'stage' = 'preview' and (:'op'::jsonb)->'preview'->>'what_happens' like 'Casey gets an email with your counter of $90.00%'
  and (select status from offers where id = '0f000000-0000-0000-0000-000000000001') = 'pending');
-- buyer withdraws between preview and apply
select (:'op'::jsonb)->>'confirm_token' as otok \gset
reset role; reset session authorization;
update offers set updated_at = now() + interval '1 second' where id = '0f000000-0000-0000-0000-000000000001';
set session authorization authenticator; set role authenticated;
select pg_temp.as_user(:A, 'claude-client');
select pg_temp.ok('28 offer changed since the preview: refused',
  (mcp_respond_offer('{"offer_id":"0f000000-0000-0000-0000-000000000001","action":"counter","counter_cents":9000}'::jsonb, :'otok'))->>'error' = 'data_changed');
select (mcp_respond_offer('{"offer_id":"0f000000-0000-0000-0000-000000000001","action":"counter","counter_cents":9000}'::jsonb))->>'confirm_token' as otok \gset
select mcp_respond_offer('{"offer_id":"0f000000-0000-0000-0000-000000000001","action":"counter","counter_cents":9000}'::jsonb, :'otok') as oa \gset
reset role; reset session authorization;
select pg_temp.ok('29 counter applied through respond_offer, buyer email queued',
  (:'oa'::jsonb)->'result'->>'offer_status' = 'countered'
  and (select amount_cents from offers where id = '0f000000-0000-0000-0000-000000000001') = 9000
  and exists (select 1 from offer_events where offer_id = '0f000000-0000-0000-0000-000000000001' and kind = 'countered' and to_whom = 'buyer'));
set session authorization authenticator; set role authenticated;
select pg_temp.as_user(:A, 'claude-client');
select pg_temp.ok('30 buyer''s turn now: can''t answer again',
  (mcp_respond_offer('{"offer_id":"0f000000-0000-0000-0000-000000000001","action":"accept"}'::jsonb))->>'error' = 'not_your_turn');
-- buyer counters; dealer accepts
reset role; reset session authorization;
update offers set status = 'pending', last_by = 'buyer', amount_cents = 8000, moves = moves + 1, updated_at = now() where id = '0f000000-0000-0000-0000-000000000001';
set session authorization authenticator; set role authenticated;
select pg_temp.as_user(:A, 'claude-client');
select (mcp_respond_offer('{"offer_id":"0f000000-0000-0000-0000-000000000001","action":"accept"}'::jsonb))->>'confirm_token' as otok \gset
select mcp_respond_offer('{"offer_id":"0f000000-0000-0000-0000-000000000001","action":"accept"}'::jsonb, :'otok') as oa2 \gset
select pg_temp.ok('31 accept: offer accepted, card on hold for the buyer at the agreed price',
  (:'oa2'::jsonb)->'result'->>'offer_status' = 'accepted'
  and (select listing_status from inventory where id = :OFFERCARD) = 'reserved'
  and (select agreed_cents from listing_reservations where buyer_id = :C and status = 'active') = 8000);
select pg_temp.as_user(:A, 'read-only');
do $$ begin perform mcp_respond_offer('{"offer_id":"0f000000-0000-0000-0000-000000000001","action":"decline"}'::jsonb);
  raise notice 'FAIL 32 assistant without offers:write answered';
exception when others then raise notice 'PASS 32 offers:write needed: %', sqlerrm; end $$;
select pg_temp.ok('33 list_offers works with inventory:read', ((mcp_my_offers('{"status":"all"}'::jsonb))->>'total')::int = 1);
