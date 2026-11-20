-- Marketplace Phase 1 (20261130120000_marketplace_pricing_search.sql). Run with marketplace-search.test.sh.
-- Prints PASS or FAIL per check. API calls run as session "authenticator" (like PostgREST).
\set ON_ERROR_STOP 1
alter table inventory add column if not exists sold_date text, add column if not exists sale_notes text;
alter table sellers add column if not exists display_name text, add column if not exists instagram text,
  add column if not exists email text;
alter table shows add column if not exists listed boolean default false, add column if not exists merged_into text;
alter table auth.users add column if not exists email text;
alter table show_floor_transactions
  add column if not exists api_eligible boolean default true, add column if not exists card_title text,
  add column if not exists item_type text, add column if not exists client_sale_id uuid;
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
\i ../../supabase/migrations/20261130120000_marketplace_pricing_search.sql
grant all on all tables in schema public to service_role;
grant select on all tables in schema public to anon, authenticated;
grant insert, update, delete on inventory to authenticated;
revoke all on public.pricing_cards, public.card_values, public.pricing_api_usage, public.agent_actions,
              public.api_rate_limits, public.pricing_identity_claims, public.marketplace_settings from anon, authenticated;
grant select on public.agent_actions to authenticated;
grant select, insert, update, delete on public.saved_searches to authenticated;
revoke all on public.saved_searches from anon;
do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then
  create role authenticator login noinherit; end if; end $$;
grant anon, authenticated, service_role to authenticator;
alter role service_role bypassrls;

-- dealer A, dealer B, buyer C
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000000001', 'a@example.test'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'b@example.test'), ('cccccccc-0000-0000-0000-000000000003', 'c@example.test');
insert into sellers (id, handle, display_name, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'dealer_a', 'Dealer A', 'a@example.test'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'dealer_b', null, 'b@example.test');
insert into shows (id, name, start_date, end_date, city, state, listed) values
  ('show_near', 'Near Show', current_date + 2, current_date + 3, 'Anaheim', 'CA', true),
  ('show_far',  'Far Show',  current_date + 2, current_date + 2, 'Dallas', 'TX', true),
  ('show_old',  'Old Show',  current_date - 30, current_date - 29, 'Anaheim', 'CA', true),
  ('show_hidden', 'Unlisted', current_date + 5, current_date + 5, 'Ontario', 'CA', false);
update shows set latitude = 33.8366, longitude = -117.9143 where id = 'show_near';
update shows set latitude = 32.7767, longitude = -96.7970 where id = 'show_far';
insert into show_sellers values ('show_near', 'aaaaaaaa-0000-0000-0000-000000000001', '12'), ('show_far', 'bbbbbbbb-0000-0000-0000-000000000002', '4');

insert into inventory (id, seller_id, card_title, player, year, card_set, card_number, parallel, grader, grade, cert_number, price, status, category, subcategory) values
  ('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '1999 Pokemon Base Set Charizard Holo PSA 10', 'Charizard', 1999, 'Base Set', '4', 'Holo', 'PSA', 10, '111', 180, 'Available', 'TCG', 'Pokémon'),
  ('a0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', '2024 Prizm Jayden Daniels Silver PSA 9.0', 'Jayden Daniels', 2024, 'Prizm', '331', 'Silver', 'psa', 9.0, '222', 250, 'Available', 'Sports', 'Football'),
  ('a0000000-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000002', '1999 Pokemon Base Set Charizard Holo PSA 10', 'Charizard', 1999, 'Base Set', '4', 'Holo', 'PSA', 10, '333', 230, 'Available', 'TCG', 'Pokémon'),
  ('a0000000-0000-0000-0000-000000000004', 'bbbbbbbb-0000-0000-0000-000000000002', '1999 Pokemon Base Set Charizard Holo', 'Charizard', 1999, 'Base Set', '4', 'Holo', null, null, null, 60, 'Available', 'TCG', 'Pokémon'),
  ('a0000000-0000-0000-0000-000000000005', 'bbbbbbbb-0000-0000-0000-000000000002', 'BGS 9.50 Wemby', 'Victor Wembanyama', 2023, 'Prizm', '136', null, 'BGS', 9.5, '555', 900, 'Available', 'Sports', 'Basketball'),
  ('a0000000-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001', 'Draft card never listed', 'Charizard', 1999, 'Base Set', '4', 'Holo', 'PSA', 10, '666', 100, 'Available', 'TCG', 'Pokémon'),
  ('a0000000-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000001', 'Early access Charizard', 'Charizard', 1999, 'Base Set', '4', 'Holo', 'PSA', 10, '777', 150, 'Available', 'TCG', 'Pokémon'),
  ('a0000000-0000-0000-0000-000000000008', 'aaaaaaaa-0000-0000-0000-000000000001', 'Flagged Charizard', 'Charizard', 1999, 'Base Set', '4', 'Holo', 'PSA', 10, '888', 150, 'Available', 'TCG', 'Pokémon');
-- every card has an uploaded photo (the listing rule needs one)
insert into card_captures (id, seller_id, entry_point, crop_key, uploaded_at)
select ('c' || substr(id::text, 2))::uuid, seller_id, 'case_scan', 'k/' || id || '/crop.jpg', now() from inventory;
update inventory set primary_capture_id = ('c' || substr(id::text, 2))::uuid;
insert into show_inventory values ('show_near', 'a0000000-0000-0000-0000-000000000001'), ('show_near', 'a0000000-0000-0000-0000-000000000002'),
  ('show_far', 'a0000000-0000-0000-0000-000000000003'), ('show_old', 'a0000000-0000-0000-0000-000000000004');
-- publish (as the dealers), then make one early-access and flag one (as owner/service)
set session authorization authenticator; set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select publish_listings(array['a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002',
  'a0000000-0000-0000-0000-000000000007','a0000000-0000-0000-0000-000000000008']::uuid[]);
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
select publish_listings(array['a0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-000000000005']::uuid[]);
reset role; reset session authorization;
update inventory set early_access_until = now() + interval '1 day' where id = 'a0000000-0000-0000-0000-000000000007';
update inventory set trust_flag = 'flagged' where id = 'a0000000-0000-0000-0000-000000000008';
\set ON_ERROR_STOP 0

create or replace function pg_temp.ok(p_name text, p_cond boolean) returns text language sql as $$
  select case when coalesce(p_cond, false) then 'PASS ' else 'FAIL ' end || p_name $$;

-- ── Generated columns ──
select pg_temp.ok('01 grade_key PSA 10 / psa 9.0→PSA 9 / BGS 9.50→BGS 9.5 / raw→Raw',
  (select array_agg(grade_key order by id) from inventory where id in ('a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-000000000005'))
  = array['PSA 10','PSA 9','Raw','BGS 9.5']);
select pg_temp.ok('02 same card typed the same → same pricing identity',
  (select count(distinct pricing_identity) from inventory where id in ('a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-000000000004')) = 1);
select pg_temp.ok('03 listed_at set when published',
  (select count(*) from inventory where listing_status = 'active' and listed_at is not null) = 6);

-- ── Guard ──
set session authorization authenticator; set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
do $$ begin
  update inventory set comp_value_cents = 999999 where id = 'a0000000-0000-0000-0000-000000000001';
  raise notice 'FAIL 04 seller set their own comp value';
exception when others then raise notice 'x'; end $$;
select pg_temp.ok('04 seller cannot set comp value', (select comp_value_cents from inventory where id = 'a0000000-0000-0000-0000-000000000001') is null);
do $$ begin
  update inventory set listed_at = now() + interval '1 year' where id = 'a0000000-0000-0000-0000-000000000001';
exception when others then null; end $$;
select pg_temp.ok('05 seller cannot bump listed_at', (select listed_at < now() + interval '1 hour' from inventory where id = 'a0000000-0000-0000-0000-000000000001'));
do $$ begin
  update inventory set pricing_card_id = 'fake' where id = 'a0000000-0000-0000-0000-000000000001';
exception when others then null; end $$;
select pg_temp.ok('06 seller cannot set match id', (select pricing_card_id from inventory where id = 'a0000000-0000-0000-0000-000000000001') is null);
-- ordinary edits still work
update inventory set price = 185 where id = 'a0000000-0000-0000-0000-000000000001';
select pg_temp.ok('07 ordinary price edit still works', (select price from inventory where id = 'a0000000-0000-0000-0000-000000000001') = 185);
update inventory set price = 180 where id = 'a0000000-0000-0000-0000-000000000001';
-- service functions refused
do $$ begin perform pricing_claim_work(5, 5); raise notice 'FAIL 08'; exception when others then null; end $$;
select pg_temp.ok('08 app cannot call pricing job functions',
  not has_function_privilege('authenticated', 'public.pricing_claim_work(int,int)', 'execute'));
reset role; reset session authorization;

-- ── Matching queue: one call per identity ──
set session authorization authenticator; set role service_role;
select (pricing_claim_work(20, 50)->'match') as m \gset
select pg_temp.ok('09 queue: 3 Charizard listings (PSA 10, PSA 10, Raw) are one match item; 4 identities total',
  jsonb_array_length(:'m'::jsonb) = 3
  and (select count(*) from jsonb_array_elements(:'m'::jsonb) x where x->'card'->>'player' = 'Charizard') = 1);
select pg_temp.ok('10 claimed identities are not handed out twice',
  jsonb_array_length(pricing_claim_work(20, 50)->'match') = 0);
select pricing_record_match((select pricing_identity from inventory where id = 'a0000000-0000-0000-0000-000000000001'),
  'matched', 'ch-zard', '1999 Base Set Charizard Holo', 'Charizard 1999 Base Set #4');
select pg_temp.ok('11 one match applies to every listing of that card (both PSA 10s and the raw)',
  (select count(*) from inventory where pricing_card_id = 'ch-zard') = 6);
-- 6: three public + draft + early + flagged share the identity
select pricing_apply_values('ch-zard', '[{"grade":"PSA 10","value_cents":21000,"low_cents":19500,"high_cents":23000,"sales_30d":14},
  {"grade":"PSA 9","value_cents":9000,"sales_30d":20},{"grade":"Raw","value_cents":5000,"sales_30d":2},{"grade":"BGS 9.5","value_cents":15000}]'::jsonb);
select pg_temp.ok('12 one refresh fills every grade returned (4 rows)', (select count(*) from card_values where card_id = 'ch-zard') = 4);
select pg_temp.ok('13 comp copied to listings by their own grade',
  (select comp_value_cents from inventory where id = 'a0000000-0000-0000-0000-000000000001') = 21000
  and (select comp_value_cents from inventory where id = 'a0000000-0000-0000-0000-000000000004') = 5000);
select pg_temp.ok('14 pct_of_comp = price ÷ comp', (select pct_of_comp from inventory where id = 'a0000000-0000-0000-0000-000000000001') = 0.8571);
select pricing_record_match((select pricing_identity from inventory where id = 'a0000000-0000-0000-0000-000000000005'), 'no_match');
select pricing_record_match((select pricing_identity from inventory where id = 'a0000000-0000-0000-0000-000000000002'), 'error');
select pg_temp.ok('15 no match → admin queue status, error → retried (status still null)',
  (select pricing_match_status from inventory where id = 'a0000000-0000-0000-0000-000000000005') = 'no_match'
  and (select pricing_match_status from inventory where id = 'a0000000-0000-0000-0000-000000000002') is null);
-- failed refresh keeps the value
select pricing_apply_values('ch-zard', null, 'cardhedge_http_500');
select pg_temp.ok('16 failed refresh keeps the last value and backs off',
  (select comp_value_cents from inventory where id = 'a0000000-0000-0000-0000-000000000001') = 21000
  and (select fail_count = 1 and next_refresh_at > now() from pricing_cards where card_id = 'ch-zard'));
reset role; reset session authorization;

-- ── Grade change switches comp; identity change clears it ──
set session authorization authenticator; set role authenticated;
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
update inventory set grader = 'PSA', grade = 9, cert_number = '444' where id = 'a0000000-0000-0000-0000-000000000004';
select pg_temp.ok('17 grade edit picks up that grade''s stored value', (select comp_value_cents from inventory where id = 'a0000000-0000-0000-0000-000000000004') = 9000);
update inventory set player = 'Blastoise', card_number = '2' where id = 'a0000000-0000-0000-0000-000000000004';
select pg_temp.ok('18 identity edit clears match and comp',
  (select pricing_card_id is null and comp_value_cents is null from inventory where id = 'a0000000-0000-0000-0000-000000000004'));
reset role; reset session authorization;

-- ── Priorities ──
set session authorization authenticator; set role service_role;
select pricing_record_match((select pricing_identity from inventory where id = 'a0000000-0000-0000-0000-000000000005'), 'matched', 'ch-wemby', 'q', 't');
-- (status was no_match, so this does nothing: that's for pricing_set_match)
select pg_temp.ok('19 a no_match listing is not re-matched by the job', (select pricing_card_id from inventory where id = 'a0000000-0000-0000-0000-000000000005') is null);
insert into pricing_cards (card_id, priority, refreshed_at, next_refresh_at) values ('ch-lonely', 'normal', now() - interval '1 day', now());
select pricing_recalc_priorities();
select pg_temp.ok('20 card at a show in the next 7 days → high; card with no listings → dormant (no schedule)',
  (select priority from pricing_cards where card_id = 'ch-zard') = 'high'
  and (select priority = 'dormant' and next_refresh_at is null from pricing_cards where card_id = 'ch-lonely'));
update pricing_cards set claimed_until = null, next_refresh_at = now() + interval '1 day', requested_at = null;
select pg_temp.ok('21 nothing due → no refresh work', jsonb_array_length(pricing_claim_work(0, 50)->'refresh') = 0);
reset role; reset session authorization;

-- ── On demand ──
select request_card_value_refresh('a0000000-0000-0000-0000-000000000001') ->> 'status' as s1 \gset
update pricing_cards set next_refresh_at = now() - interval '1 minute' where card_id = 'ch-zard';
set session authorization authenticator; set role anon;
select request_card_value_refresh('a0000000-0000-0000-0000-000000000001') ->> 'status' as s2 \gset
reset role; reset session authorization;
select pg_temp.ok('22 viewing a current value does nothing; an overdue one is queued', :'s1' = 'current' and :'s2' = 'refreshing');
set session authorization authenticator; set role service_role;
select pg_temp.ok('23 on-demand card comes back first', (pricing_claim_work(0, 1)->'refresh'->0->>'card_id') = 'ch-zard');
reset role; reset session authorization;

-- ── Usage ──
set session authorization authenticator; set role service_role;
select pricing_bump_usage('cardhedge', 3, 1, 0); select pricing_bump_usage('cardhedge', 2, 0, 1);
select pg_temp.ok('24 usage adds up per day', (select calls = 5 and uncached_calls = 1 and errors = 1 from pricing_api_usage where provider = 'cardhedge'));
select pg_temp.ok('25 80% alert marked once per day', pricing_mark_alert('cardhedge') and not pricing_mark_alert('cardhedge'));
reset role; reset session authorization;

-- ── Search (as anon) ──
set session authorization authenticator; set role anon;
select search_listings('{"q":"charizard psa 10"}') as r \gset
select pg_temp.ok('26 "charizard psa 10" finds the two public PSA 10s, not draft / early-access / flagged',
  (:'r'::jsonb->>'total')::int = 2);
select pg_temp.ok('27 results carry comp, pct and dealer; no stock code or seller id',
  (:'r'::jsonb->'results'->0->'comp'->>'value_cents')::int = 21000
  and :'r'::jsonb->'results'->0 ? 'dealer' and not (:'r'::jsonb->'results'->0 ? 'seller_id')
  and not (:'r'::jsonb->'results'->0 ? 'stock_code'));
select pg_temp.ok('28 typo "charzard" still finds Charizard', (search_listings('{"q":"charzard"}')->>'total')::int >= 2);
select pg_temp.ok('29 deals only: the $180 card (86% of $210) yes, the $230 card (110%) no',
  (search_listings('{"q":"charizard","deals_only":true}')->'results'->0->>'id') = 'a0000000-0000-0000-0000-000000000001'
  and (search_listings('{"q":"charizard","deals_only":true}')->>'total')::int = 1);
select pg_temp.ok('30 deal sort puts the best deal first',
  (search_listings('{"sort":"deal"}')->'results'->0->>'id') = 'a0000000-0000-0000-0000-000000000001');
select pg_temp.ok('31 within 25 miles of Anaheim, this weekend → only cards at Near Show',
  (select array_agg(x->>'id' order by x->>'id') from jsonb_array_elements(
     search_listings(jsonb_build_object('near', jsonb_build_object('lat', 33.81, 'lng', -117.92, 'miles', 25),
                                        'date_from', current_date, 'date_to', current_date + 7))->'results') x)
  = array['a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002']);
select pg_temp.ok('32 filters: grader BGS + grade 9.5 + category Sports',
  (search_listings('{"grader":"bgs","grade_min":9.5,"category":"sports"}')->>'total')::int = 1);
select pg_temp.ok('33 show filter and state filter',
  (search_listings('{"show_id":"show_far"}')->>'total')::int = 1 and (search_listings('{"state":"tx"}')->>'total')::int = 1);
select pg_temp.ok('34 dealer filter + storefront count',
  (search_listings('{"dealer":"dealer_b"}')->>'total')::int = 3 and (get_dealer_storefront('DEALER_B')->>'listings')::int = 3);
select pg_temp.ok('35 price sort + paging',
  (search_listings('{"sort":"price_asc","limit":2,"offset":1}')->'results'->0->>'price_cents')::int = 18000
  and jsonb_array_length(search_listings('{"sort":"price_asc","limit":2,"offset":1}')->'results') = 2);
select pg_temp.ok('36 listing page: public opens, draft/early/flagged are not_found',
  get_listing('a0000000-0000-0000-0000-000000000001')->>'id' = 'a0000000-0000-0000-0000-000000000001'
  and get_listing('a0000000-0000-0000-0000-000000000006')->>'error' = 'not_found'
  and get_listing('a0000000-0000-0000-0000-000000000007')->>'error' = 'not_found'
  and get_listing('a0000000-0000-0000-0000-000000000008')->>'error' = 'not_found');
select pg_temp.ok('37 listing page shows next show + table, URL slug',
  get_listing('a0000000-0000-0000-0000-000000000001')->'show'->>'id' = 'show_near'
  and get_listing('a0000000-0000-0000-0000-000000000001')->'show'->>'table_number' = '12'
  and get_listing('a0000000-0000-0000-0000-000000000001')->>'url' like '/c/a0000000-0000-0000-0000-000000000001-1999-pokemon-base-set-charizard-holo-psa-10');
select pg_temp.ok('38 upcoming shows: listed + future only, with listed-card counts',
  (select array_agg(x->>'id' order by x->>'id') from jsonb_array_elements(list_upcoming_shows('{}')) x) = array['show_far','show_near']
  and (select (x->>'listed_cards')::int from jsonb_array_elements(list_upcoming_shows('{}')) x where x->>'id' = 'show_near') = 2);
select pg_temp.ok('39 anon cannot read card_values or pricing tables directly',
  not has_table_privilege('anon', 'public.card_values', 'select') and not has_table_privilege('anon', 'public.pricing_api_usage', 'select'));
reset role; reset session authorization;

-- ── Selling a card takes it out of search ──
set session authorization authenticator; set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
update inventory set status = 'Sold' where id = 'a0000000-0000-0000-0000-000000000002';
set role anon;
select pg_temp.ok('40 sold card leaves search, its page still opens as sold',
  (search_listings('{"q":"jayden"}')->>'total')::int = 0
  and get_listing('a0000000-0000-0000-0000-000000000002')->>'listing_status' = 'sold');
reset role; reset session authorization;

-- ── Saved searches ──
set session authorization authenticator; set role authenticated;
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
insert into saved_searches (name, params) values ('Zards', '{"q":"charizard"}');
select pg_temp.ok('41 buyer sees own saved search', (select count(*) from saved_searches) = 1);
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok('42 another user sees none of it', (select count(*) from saved_searches) = 0);
do $$ begin insert into saved_searches (user_id, name) values ('cccccccc-0000-0000-0000-000000000003', 'spoof');
  raise notice 'FAIL 43'; exception when others then null; end $$;
select pg_temp.ok('43 cannot create one for someone else', true);
reset role; reset session authorization;
update saved_searches set last_checked_at = now() - interval '2 hours';
set session authorization authenticator; set role service_role;
select pg_temp.ok('44 due list carries the owner email (service only)',
  saved_searches_due(10)->0->>'email' = 'c@example.test');
select pg_temp.ok('45 rate limit: 3rd hit over a limit of 2 is refused',
  (rate_limit_hit('mcp:test', 60, 2)->>'allowed')::boolean and (rate_limit_hit('mcp:test', 60, 2)->>'allowed')::boolean
  and not (rate_limit_hit('mcp:test', 60, 2)->>'allowed')::boolean);
reset role; reset session authorization;

-- ── Admin match ──
insert into admins values ('aaaaaaaa-0000-0000-0000-000000000001');
set session authorization authenticator; set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok('46 admin sees the unmatched card', jsonb_array_length(pricing_unmatched(10)) = 1);
select pricing_set_match((select pricing_identity from inventory where id = 'a0000000-0000-0000-0000-000000000005'), 'ch-wemby');
reset role; reset session authorization;
select pg_temp.ok('47 admin match links it and queues a refresh',
  (select pricing_card_id from inventory where id = 'a0000000-0000-0000-0000-000000000005') = 'ch-wemby'
  and (select requested_at is not null from pricing_cards where card_id = 'ch-wemby'));
set session authorization authenticator; set role authenticated;
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
do $$ begin perform pricing_unmatched(10); raise notice 'FAIL 48 non-admin read queue'; exception when others then null; end $$;
select pg_temp.ok('48 non-admin refused', true);
reset role; reset session authorization;

-- ── Performance: 10,000 listings ──
insert into inventory (seller_id, card_title, player, year, card_set, card_number, grader, grade, price, status)
select 'bbbbbbbb-0000-0000-0000-000000000002', 'Card ' || g, (array['Charizard','Pikachu','Mewtwo','Trout','Ohtani'])[1 + g % 5],
       1990 + g % 35, 'Set ' || (g % 40), (g % 300)::text, case when g % 3 = 0 then 'PSA' end, case when g % 3 = 0 then 10 end, 10 + g % 500, 'Available'
  from generate_series(1, 10000) g;
set cardshow.listing_fn = 'on';
update inventory set listing_status = 'active' where card_title like 'Card %';
reset cardshow.listing_fn;
analyze inventory;
set session authorization authenticator; set role anon;
\timing on
select (search_listings('{"q":"charizard psa 10"}')->>'total')::int as perf_total \gset
\timing off
reset role; reset session authorization;
select pg_temp.ok('49 10k-listing search returns results (timing printed above)', :perf_total > 600);
