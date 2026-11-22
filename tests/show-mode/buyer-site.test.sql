-- Buyer site support (20261203120000_marketplace_buyer_site.sql): public listing photos, dealer contact.
-- Run with buyer-site.test.sh. Setup copied from pricing-admin.test.sql. Prints PASS or FAIL per check.
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
\i ../../supabase/migrations/20261203120000_marketplace_buyer_site.sql
\i ../../supabase/migrations/20261203120000_marketplace_buyer_site.sql
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

\set ON_ERROR_STOP 0
create or replace function pg_temp.ok(p_name text, p_cond boolean) returns text language sql as $$
  select case when coalesce(p_cond, false) then 'PASS ' else 'FAIL ' end || p_name $$;
create or replace function pg_temp.due_ids(p jsonb, k text) returns text[] language sql as $$
  select coalesce(array_agg(e->>'id' order by e->>'id'), '{}') from jsonb_array_elements(p->k) e $$;

-- 1. what needs a public photo (service role)
set session authorization authenticator; set role service_role;
select pg_temp.ok('due: every listed, unflagged card with an uploaded photo (6), nothing to remove',
  cardinality(pg_temp.due_ids(listing_photos_due(), 'add')) = 6
  and not ('a0000000-0000-0000-0000-000000000008' = any(pg_temp.due_ids(listing_photos_due(), 'add')))
  and not ('a0000000-0000-0000-0000-000000000006' = any(pg_temp.due_ids(listing_photos_due(), 'add')))
  and jsonb_array_length(listing_photos_due()->'remove') = 0);
select pg_temp.ok('due: limited to the cards asked for, with the capture key',
  (select (listing_photos_due(array['a0000000-0000-0000-0000-000000000001']::uuid[])->'add'->0->>'key')
     = 'k/a0000000-0000-0000-0000-000000000001/crop.jpg')
  and jsonb_array_length(listing_photos_due(array['a0000000-0000-0000-0000-000000000001']::uuid[])->'add') = 1);
select listing_photo_set('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
                         'a0000000-0000-0000-0000-000000000001/c0000000-0000-0000-0000-000000000001.jpg');
select listing_photo_set('a0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002',
                         'a0000000-0000-0000-0000-000000000002/c0000000-0000-0000-0000-000000000002.jpg');
select pg_temp.ok('set: card leaves the add list',
  not ('a0000000-0000-0000-0000-000000000001' = any(pg_temp.due_ids(listing_photos_due(), 'add'))));
reset role; reset session authorization;

-- 2. what the public sees
set session authorization authenticator; set role anon;
select pg_temp.ok('listing page: photo path, catalog flag off, dealer contact cleaned',
  get_listing('a0000000-0000-0000-0000-000000000001')->'image'->>'photo_path' = 'a0000000-0000-0000-0000-000000000001/c0000000-0000-0000-0000-000000000001.jpg'
  and coalesce((get_listing('a0000000-0000-0000-0000-000000000001')->'image'->>'catalog_image')::boolean, false) = false
  and get_listing('a0000000-0000-0000-0000-000000000001')->'dealer'->>'whatsapp' = '15551234567'
  and get_listing('a0000000-0000-0000-0000-000000000001')->'dealer'->>'instagram' = 'dealer_a');
select pg_temp.ok('search results: photo path, no WhatsApp or Instagram',
  (select r->'image'->>'photo_path' is not null and r->'dealer'->>'whatsapp' is null and r->'dealer'->>'instagram' is null
     from jsonb_array_elements(search_listings('{"q":"jayden"}')->'results') r limit 1));
select pg_temp.ok('anon cannot call the photo functions',
  not has_function_privilege('anon', 'public.listing_photos_due(uuid[], int)', 'execute')
  and not has_function_privilege('anon', 'public.listing_photo_set(uuid, uuid, text)', 'execute'));
reset role; reset session authorization;

-- 3. dealers can't set it themselves
set session authorization authenticator; set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
do $$ begin
  update inventory set public_photo_path = 'x.jpg' where id = 'a0000000-0000-0000-0000-000000000002';
  raise notice 'FAIL dealer cannot write public_photo_path';
exception when others then raise notice 'PASS dealer cannot write public_photo_path (%)', sqlerrm; end $$;
do $$ begin
  perform listing_photos_due();
  raise notice 'FAIL dealer cannot call listing_photos_due';
exception when others then raise notice 'PASS dealer cannot call listing_photos_due'; end $$;
-- replace card 1's photo, delist card 2
insert into card_captures (id, seller_id, entry_point, crop_key, uploaded_at)
values ('c0000000-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000001', 'case_scan', 'k/new.jpg', now());
update inventory set primary_capture_id = 'c0000000-0000-0000-0000-0000000000a1' where id = 'a0000000-0000-0000-0000-000000000001';
select delist_listings(array['a0000000-0000-0000-0000-000000000002']::uuid[]);
reset role; reset session authorization;

set session authorization authenticator; set role anon;
select pg_temp.ok('replaced photo: the old public copy is no longer shown',
  get_listing('a0000000-0000-0000-0000-000000000001')->'image'->>'photo_path' is null);
reset role; reset session authorization;

set session authorization authenticator; set role service_role;
select pg_temp.ok('replaced photo: back on the add list with the old path to delete',
  (select e->>'old_path' = 'a0000000-0000-0000-0000-000000000001/c0000000-0000-0000-0000-000000000001.jpg' and e->>'key' = 'k/new.jpg'
     from jsonb_array_elements(listing_photos_due()->'add') e where e->>'id' = 'a0000000-0000-0000-0000-000000000001'));
select pg_temp.ok('delisted: on the remove list',
  pg_temp.due_ids(listing_photos_due(), 'remove') = array['a0000000-0000-0000-0000-000000000002']);
select pg_temp.ok('set with a new path returns the old one',
  (listing_photo_set('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-0000000000a1', 'a0000000-0000-0000-0000-000000000001/new.jpg')->>'old_path')
     = 'a0000000-0000-0000-0000-000000000001/c0000000-0000-0000-0000-000000000001.jpg');
select listing_photo_set('a0000000-0000-0000-0000-000000000002', null, null);
select pg_temp.ok('clearing empties both columns and the remove list',
  (select public_photo_path is null and public_photo_capture_id is null from inventory where id = 'a0000000-0000-0000-0000-000000000002')
  and jsonb_array_length(listing_photos_due()->'remove') = 0);
reset role; reset session authorization;

-- 4. a card sold at the table drops its public photo
update inventory set status = 'Sold' where id = 'a0000000-0000-0000-0000-000000000001';
set session authorization authenticator; set role service_role;
select pg_temp.ok('sold: on the remove list', 'a0000000-0000-0000-0000-000000000001' = any(pg_temp.due_ids(listing_photos_due(), 'remove')));
reset role; reset session authorization;

-- 5. search ranking (20261204120000_marketplace_photo_ranking.sql): the dealer's own photo first
\set ON_ERROR_STOP 1
\i ../../supabase/migrations/20261204120000_marketplace_photo_ranking.sql
\i ../../supabase/migrations/20261204120000_marketplace_photo_ranking.sql
\set ON_ERROR_STOP 0
update inventory set listed_at = now() - interval '1 hour' * (case id::text
  when 'a0000000-0000-0000-0000-000000000003' then 1 when 'a0000000-0000-0000-0000-000000000004' then 2
  when 'a0000000-0000-0000-0000-000000000005' then 3 else 4 end);
set session authorization authenticator; set role service_role;
select listing_photo_set('a0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000005',
                         'a0000000-0000-0000-0000-000000000005/c0000000-0000-0000-0000-000000000005.jpg');
reset role; reset session authorization;
set session authorization authenticator; set role anon;
select pg_temp.ok('default order: the listing with a dealer photo first (the oldest), then newest',
  (select array_agg(e->>'id' order by n) from jsonb_array_elements(search_listings('{}')->'results') with ordinality x(e, n))
    = array['a0000000-0000-0000-0000-000000000005','a0000000-0000-0000-0000-000000000003',
            'a0000000-0000-0000-0000-000000000004']);
select pg_temp.ok('sort newest stays strictly newest',
  (search_listings('{"sort":"newest"}')->'results'->0->>'id') = 'a0000000-0000-0000-0000-000000000003');
reset role; reset session authorization;
update inventory set primary_capture_id = null where id = 'a0000000-0000-0000-0000-000000000005';
set session authorization authenticator; set role anon;
select pg_temp.ok('stale photo: back to newest first',
  (search_listings('{}')->'results'->0->>'id') = 'a0000000-0000-0000-0000-000000000003');
reset role; reset session authorization;
