-- Pricing admin (20261202120000_pricing_admin.sql). Run with pricing-admin.test.sh. Setup copied from marketplace-search.test.sql.
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
-- As in production: is_cardshow_admin() = anyone in admins (every organizer), defined before pricing_search.
create or replace function public.is_cardshow_admin() returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from admins where id = auth.uid()) $$;
grant execute on function public.is_cardshow_admin() to authenticated, service_role;
\i ../../supabase/migrations/20261130120000_marketplace_pricing_search.sql
\i ../../supabase/migrations/20261202120000_pricing_admin.sql
\i ../../supabase/migrations/20261202120000_pricing_admin.sql
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
-- The copied setup revokes after the migrations; put back what 20261202120000 grants.
grant select on public.pricing_cards, public.card_values, public.pricing_api_usage, public.agent_actions to authenticated;

create or replace function pg_temp.ok(p_name text, p_cond boolean) returns text language sql as $$
  select case when coalesce(p_cond, false) then 'PASS ' else 'FAIL ' end || p_name $$;

-- A is an organizer (admins), P the platform owner, C a buyer.
insert into auth.users (id) values ('ffffffff-0000-0000-0000-00000000000f');
insert into admins values ('aaaaaaaa-0000-0000-0000-000000000001');
insert into platform_admins values ('ffffffff-0000-0000-0000-00000000000f');
-- Card values exist; Charizard has no match, Wemby errored, Jayden matched automatically.
set session authorization authenticator; set role service_role;
select pricing_record_match((select pricing_identity from inventory where id = 'a0000000-0000-0000-0000-000000000001'), 'no_match');
select pricing_record_match((select pricing_identity from inventory where id = 'a0000000-0000-0000-0000-000000000005'), 'error');
select pricing_record_match((select pricing_identity from inventory where id = 'a0000000-0000-0000-0000-000000000002'), 'matched', 'ch-jd', 'q', 't');
select pricing_apply_values('ch-jd', '[{"grade":"PSA 9","value_cents":30000}]'::jsonb);
reset role; reset session authorization;

-- ── access ──
set session authorization authenticator; set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok('01 organizer (admins) can no longer read card_values / pricing_cards / usage',
  (select count(*) from card_values) = 0 and (select count(*) from pricing_cards) = 0 and (select count(*) from pricing_api_usage) = 0);
do $$ begin perform pricing_unmatched('open', 10); raise notice 'FAIL'; exception when others then null; end $$;
select pg_temp.ok('02 organizer cannot open the queue or resolve',
  (select count(*) from inventory where pricing_match_status = 'manual') = 0);
do $$ begin perform pricing_admin_resolve((select pricing_identity from inventory where id = 'a0000000-0000-0000-0000-000000000001'), 'ignore');
  exception when others then null; end $$;
set request.jwt.claim.sub = 'ffffffff-0000-0000-0000-00000000000f';
select pg_temp.ok('03 platform owner reads card_values', (select count(*) from card_values) = 1);
select pg_temp.ok('04 queue: Charizard (4 active listings) only; Wemby (1 error, retried automatically) and the matched card are not in it',
  jsonb_array_length(pricing_unmatched('open', 10)) = 1
  and (pricing_unmatched('open', 10)->0->>'listings')::int = 4
  and (pricing_unmatched('open', 10)->0->'card'->>'player') = 'Charizard');
select pg_temp.ok('05 summary counts', (pricing_admin_summary()->>'unmatched')::int = 4 and (pricing_admin_summary()->>'priced')::int = 1
  and (pricing_admin_summary()->>'waiting')::int = 1);
-- ── resolve ──
select pricing_admin_resolve((select pricing_identity from inventory where id = 'a0000000-0000-0000-0000-000000000005'), 'ignore');
select pg_temp.ok('06 ignore hides it from the queue and lists it under Hidden',
  jsonb_array_length(pricing_unmatched('open', 10)) = 1 and jsonb_array_length(pricing_unmatched('ignored', 10)) = 1);
reset role; reset session authorization;
set session authorization authenticator; set role service_role;
select pg_temp.ok('07 the automatic job never picks up a hidden card',
  not exists (select 1 from jsonb_array_elements(pricing_claim_work(50, 0)->'match') x
               where x->>'identity' = (select pricing_identity from inventory where id = 'a0000000-0000-0000-0000-000000000005')));
-- manual match on Charizard with values (as pricing-admin.js does: resolve, then apply)
select pricing_admin_resolve((select pricing_identity from inventory where id = 'a0000000-0000-0000-0000-000000000001'), 'match', 'ch-zard', '1999 Base Set Charizard #4 Holo', 'Charizard');
select pricing_apply_values('ch-zard', '[{"grade":"PSA 10","value_cents":21000},{"grade":"Raw","value_cents":5000}]'::jsonb);
reset role; reset session authorization;
select pg_temp.ok('08 manual match: every listing of the card linked, status manual, comps filled by grade',
  (select count(*) from inventory where pricing_card_id = 'ch-zard' and pricing_match_status = 'manual') = 6
  and (select comp_value_cents from inventory where id = 'a0000000-0000-0000-0000-000000000001') = 21000
  and (select comp_value_cents from inventory where id = 'a0000000-0000-0000-0000-000000000004') = 5000);
select pg_temp.ok('09 query stored for future refreshes', (select query from pricing_cards where card_id = 'ch-zard') = '1999 Base Set Charizard #4 Holo');
set session authorization authenticator; set role service_role;
select pricing_record_match((select pricing_identity from inventory where id = 'a0000000-0000-0000-0000-000000000001'), 'no_match');
reset role; reset session authorization;
select pg_temp.ok('10 the automatic job does not overwrite a manual match', (select pricing_match_status from inventory where id = 'a0000000-0000-0000-0000-000000000001') = 'manual');
-- change the match to another card: old comps cleared, new ones from stored values
insert into card_values (card_id, grade, value_cents, refreshed_at) values ('ch-zard2', 'PSA 10', 99900, now());
set session authorization authenticator; set role authenticated;
set request.jwt.claim.sub = 'ffffffff-0000-0000-0000-00000000000f';
select pricing_admin_resolve((select pricing_identity from inventory where id = 'a0000000-0000-0000-0000-000000000001'), 'match', 'ch-zard2');
reset role; reset session authorization;
select pg_temp.ok('11 changing the match uses the new card''s values; grades it lacks go blank',
  (select comp_value_cents from inventory where id = 'a0000000-0000-0000-0000-000000000001') = 99900
  and (select comp_value_cents from inventory where id = 'a0000000-0000-0000-0000-000000000004') is null);
set session authorization authenticator; set role authenticated;
set request.jwt.claim.sub = 'ffffffff-0000-0000-0000-00000000000f';
select pricing_admin_resolve((select pricing_identity from inventory where id = 'a0000000-0000-0000-0000-000000000001'), 'retry');
select pricing_admin_resolve((select pricing_identity from inventory where id = 'a0000000-0000-0000-0000-000000000005'), 'retry');
reset role; reset session authorization;
select pg_temp.ok('12 retry: back to the automatic queue with no comp and attempts reset',
  (select bool_and(pricing_match_status is null and pricing_card_id is null and comp_value_cents is null and pricing_match_attempts = 0)
     from inventory where pricing_identity in (select pricing_identity from inventory where id in ('a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000005'))));
set session authorization authenticator; set role anon;
do $$ begin perform pricing_admin_summary(); raise notice 'x'; exception when others then null; end $$;
reset role; reset session authorization;
select pg_temp.ok('13 anon cannot call the admin functions', not has_function_privilege('anon', 'public.pricing_admin_summary()', 'execute'));
select pg_temp.ok('14 old pricing_set_match still works through the same rules', (select pricing_set_match((select pricing_identity from inventory where id = 'a0000000-0000-0000-0000-000000000005'), 'ch-w')->>'ok')::boolean);
