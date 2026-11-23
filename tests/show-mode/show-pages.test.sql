-- Show pages, pickup show, shipping (20261206120000_marketplace_show_pages.sql). Run with show-pages.test.sh.
-- Setup copied from buyer-site.test.sql. Prints PASS or FAIL per check.
\set ON_ERROR_STOP 1
alter table inventory add column if not exists sold_date text, add column if not exists sale_notes text;
alter table sellers add column if not exists display_name text, add column if not exists instagram text,
  add column if not exists email text, add column if not exists whatsapp text;
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
alter table shows add column if not exists slug text, add column if not exists website text;
\i ../../supabase/migrations/20261203120000_marketplace_buyer_site.sql
\i ../../supabase/migrations/20261204120000_marketplace_photo_ranking.sql
\i ../../supabase/migrations/20261205120000_pricing_review.sql
\i ../../supabase/migrations/20261206120000_marketplace_show_pages.sql
\i ../../supabase/migrations/20261206120000_marketplace_show_pages.sql
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
update sellers set whatsapp = '+1 (555) 123-4567', instagram = '@dealer_a' where handle = 'dealer_a';
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
update shows set slug = 'near-show-2026', website = 'https://near.example' where id = 'show_near';
insert into shows (id, name, start_date, end_date, city, state, listed, merged_into) values
  ('show_dup', 'Near Show (duplicate)', current_date + 2, current_date + 3, 'Anaheim', 'CA', false, 'show_near');
insert into show_sellers values ('show_near', 'bbbbbbbb-0000-0000-0000-000000000002', null);

\set ON_ERROR_STOP 0
create or replace function pg_temp.ok(p_name text, p_cond boolean) returns text language sql as $$
  select case when coalesce(p_cond, false) then 'PASS ' else 'FAIL ' end || p_name $$;

-- 1. shipping price
set session authorization authenticator; set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
update inventory set shipping_options = '{"flat_cents": 500}' where id = 'a0000000-0000-0000-0000-000000000001';
do $$ begin
  update inventory set shipping_options = '{"flat_cents": -1}' where id = 'a0000000-0000-0000-0000-000000000002';
  raise notice 'FAIL negative shipping refused';
exception when check_violation then raise notice 'PASS negative shipping refused'; end $$;
do $$ begin
  update inventory set shipping_options = '{"flat_cents": 2.5}' where id = 'a0000000-0000-0000-0000-000000000002';
  raise notice 'FAIL fractional cents refused';
exception when check_violation then raise notice 'PASS fractional cents refused'; end $$;
update inventory set shipping_options = '{"flat_cents": 0}' where id = 'a0000000-0000-0000-0000-000000000002';
-- 2. pickup show: only a show the dealer is in
update inventory set pickup_show_id = 'show_near', sale_modes = '{ship,local_pickup}' where id = 'a0000000-0000-0000-0000-000000000002';
do $$ begin
  update inventory set pickup_show_id = 'show_far' where id = 'a0000000-0000-0000-0000-000000000001';
  raise notice 'FAIL pickup at a show the dealer is not in refused';
exception when others then raise notice 'PASS pickup at a show the dealer is not in refused (%)', sqlerrm; end $$;
reset role; reset session authorization;

set session authorization authenticator; set role anon;
select pg_temp.ok('listing: shipping price shown, free shipping is 0',
  (get_listing('a0000000-0000-0000-0000-000000000001')->>'shipping_cents')::int = 500
  and (get_listing('a0000000-0000-0000-0000-000000000002')->>'shipping_cents')::int = 0
  and get_listing('a0000000-0000-0000-0000-000000000003') ? 'shipping_cents' = false);
select pg_temp.ok('listing: pickup show flagged, link uses the slug',
  get_listing('a0000000-0000-0000-0000-000000000002')->'show'->>'url' = '/s/near-show-2026'
  and (get_listing('a0000000-0000-0000-0000-000000000002')->'show'->>'pickup')::boolean
  and get_listing('a0000000-0000-0000-0000-000000000002')->'show'->>'table_number' = '12');
select pg_temp.ok('listing: show without a slug links by id',
  get_listing('a0000000-0000-0000-0000-000000000003')->'show'->>'url' = '/s/show_far');
select pg_temp.ok('upcoming shows link to /s/',
  (select bool_and(e->>'url' like '/s/%') and count(*) = 2 from jsonb_array_elements(list_upcoming_shows()) e));

-- 3. show page
select pg_temp.ok('show page by slug: details, website, both dealers, card count',
  get_show_page('near-show-2026')->>'name' = 'Near Show'
  and get_show_page('near-show-2026')->>'website' = 'https://near.example'
  and (get_show_page('near-show-2026')->>'listed_cards')::int = 2
  and jsonb_array_length(get_show_page('near-show-2026')->'dealers') = 2
  and get_show_page('near-show-2026')->'dealers'->0->>'handle' = 'dealer_a'
  and (get_show_page('near-show-2026')->'dealers'->0->>'listings')::int = 2
  and get_show_page('near-show-2026')->'dealers'->0->>'table_number' = '12'
  and (get_show_page('near-show-2026')->'dealers'->1->>'listings')::int = 0
  and get_show_page('near-show-2026')->>'show_page' = '/show.html?id=show_near');
select pg_temp.ok('show page by id redirects to the slug',
  get_show_page('show_near')->>'redirect' = '/s/near-show-2026');
select pg_temp.ok('merged show redirects to the show it was merged into',
  get_show_page('show_dup')->>'redirect' = '/s/near-show-2026');
select pg_temp.ok('show without a slug opens by id; ended flag',
  get_show_page('show_far')->>'name' = 'Far Show' and (get_show_page('show_old')->>'ended')::boolean
  and not (get_show_page('show_far')->>'ended')::boolean);
select pg_temp.ok('unknown show: not_found', get_show_page('nope')->>'error' = 'not_found'
  and get_show_page('')->>'error' = 'not_found');
select pg_temp.ok('search by show_id finds the pickup card',
  (search_listings('{"show_id":"show_near"}')->>'total')::int = 2);
reset role; reset session authorization;

-- 4. dealer leaves the show: pickup cleared
delete from show_sellers where show_id = 'show_near' and seller_id = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok('leaving the show clears the pickup show',
  (select pickup_show_id is null from inventory where id = 'a0000000-0000-0000-0000-000000000002'));
set session authorization authenticator; set role anon;
select pg_temp.ok('show page dealers: only the one still in the show',
  jsonb_array_length(get_show_page('near-show-2026')->'dealers') = 1);
reset role; reset session authorization;
