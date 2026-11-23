-- Holds (20261207120000_marketplace_holds.sql). Run with marketplace-holds.test.sh.
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
\i ../../supabase/migrations/20261207120000_marketplace_holds.sql
\i ../../supabase/migrations/20261207120000_marketplace_holds.sql
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

insert into auth.users (id, email) values ('dddddddd-0000-0000-0000-000000000004', 'd@example.test');

\set ON_ERROR_STOP 0
create or replace function pg_temp.ok(p_name text, p_cond boolean) returns text language sql as $$
  select case when coalesce(p_cond, false) then 'PASS ' else 'FAIL ' end || p_name $$;
create or replace function pg_temp.res(p_card uuid) returns public.listing_reservations language sql as $$
  select r.* from public.listing_reservations r where p_card = any(r.listing_ids) order by created_at desc limit 1 $$;
grant execute on function pg_temp.ok(text, boolean) to anon, authenticated, service_role;

-- 1. who may hold
set session authorization authenticator; set role anon;
do $$ begin perform place_hold('a0000000-0000-0000-0000-000000000001', 'X', 'x@x.test');
  raise notice 'FAIL anon cannot place a hold';
exception when insufficient_privilege then raise notice 'PASS anon cannot place a hold'; end $$;
set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
do $$ begin perform reserve_listings(array['a0000000-0000-0000-0000-000000000001']::uuid[], 'cccccccc-0000-0000-0000-000000000003', 'checkout', 10080);
  raise notice 'FAIL buyers can no longer call reserve_listings directly';
exception when insufficient_privilege then raise notice 'PASS buyers can no longer call reserve_listings directly'; end $$;
select pg_temp.ok('name and contact are required',
  place_hold('a0000000-0000-0000-0000-000000000001', '  ', 'x@x.test')->>'error' = 'missing_name'
  and place_hold('a0000000-0000-0000-0000-000000000001', 'Alex', 'x')->>'error' = 'missing_contact');

-- 2. place a hold
select place_hold('a0000000-0000-0000-0000-000000000001', '  Alex   P ', '555-0100', 'Can meet Saturday') is not null;
reset role; reset session authorization;
select pg_temp.ok('hold: 24 hours, card reserved for the buyer, name/contact/note kept',
  (select reason = 'hold' and status = 'active' and buyer_name = 'Alex P' and buyer_contact = '555-0100'
          and buyer_note = 'Can meet Saturday' and expires_at between now() + interval '1439 minutes' and now() + interval '1441 minutes'
     from pg_temp.res('a0000000-0000-0000-0000-000000000001'))
  and (select listing_status = 'reserved' and reserved_by = 'cccccccc-0000-0000-0000-000000000003'
         from inventory where id = 'a0000000-0000-0000-0000-000000000001'));
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('holding it again says it is already yours',
  place_hold('a0000000-0000-0000-0000-000000000001', 'Alex', '555-0100')->>'error' = 'already_yours');
select pg_temp.ok('early access, flagged and unlisted cards cannot be held',
  place_hold('a0000000-0000-0000-0000-000000000007', 'Alex', '555-0100')->>'error' = 'early_access'
  and place_hold('a0000000-0000-0000-0000-000000000008', 'Alex', '555-0100')->>'error' = 'unavailable'
  and place_hold('a0000000-0000-0000-0000-000000000006', 'Alex', '555-0100')->>'error' = 'unavailable');
set request.jwt.claim.sub = 'dddddddd-0000-0000-0000-000000000004';
select pg_temp.ok('another buyer cannot hold a held card',
  place_hold('a0000000-0000-0000-0000-000000000001', 'Dee', 'd@x.test')->>'error' = 'unavailable');
select pg_temp.ok('another buyer sees no holds and cannot read the hold',
  jsonb_array_length(my_holds()) = 0 and (select count(*) from listing_reservations) = 0);
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok('a dealer cannot hold their own card',
  place_hold('a0000000-0000-0000-0000-000000000002', 'Me', 'me@x.test')->>'error' = 'own_listing');

-- 3. lists
select pg_temp.ok('dealer list: buyer name, contact, note, card with stock code field',
  dealer_holds()->0->>'buyer_name' = 'Alex P' and dealer_holds()->0->>'buyer_contact' = '555-0100'
  and dealer_holds()->0->>'status' = 'active' and dealer_holds()->0->'cards'->0->>'title' = '1999 Pokemon Base Set Charizard Holo PSA 10');
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
select pg_temp.ok('another dealer sees none of it', jsonb_array_length(dealer_holds()) = 0);
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('buyer list: open hold with the card and the dealer contact',
  jsonb_array_length(my_holds()) = 1 and my_holds()->0->>'status' = 'active'
  and my_holds()->0->'cards'->0->'dealer'->>'whatsapp' = '15551234567');

-- 4. ending holds
set request.jwt.claim.sub = 'dddddddd-0000-0000-0000-000000000004';
select pg_temp.ok('only the buyer can cancel', cancel_hold((pg_temp.res('a0000000-0000-0000-0000-000000000001')).id)->>'error' = 'not_found');
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('buyer cannot release or complete as the dealer',
  release_hold((pg_temp.res('a0000000-0000-0000-0000-000000000001')).id)->>'error' = 'not_found'
  and complete_hold((pg_temp.res('a0000000-0000-0000-0000-000000000001')).id)->>'error' = 'not_found');
select cancel_hold((pg_temp.res('a0000000-0000-0000-0000-000000000001')).id) is not null;
reset role; reset session authorization;
select pg_temp.ok('buyer cancelled: card back on sale',
  (select status = 'released' and end_reason = 'buyer_cancelled' from pg_temp.res('a0000000-0000-0000-0000-000000000001'))
  and (select listing_status = 'active' and reservation_id is null from inventory where id = 'a0000000-0000-0000-0000-000000000001'));

-- 5. emails
set session authorization authenticator; set role service_role;
select pg_temp.ok('a hold cancelled before the dealer heard about it emails nobody',
  (select e->>'to' = 'none' from jsonb_array_elements(hold_notices_due()) e where e->>'kind' = 'ended'));
select hold_notice_sent((e->>'reservation_id')::uuid, e->>'kind') from jsonb_array_elements(hold_notices_due()) e;
reset role; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select place_hold('a0000000-0000-0000-0000-000000000002', 'Alex', 'alex@x.test') is not null;
reset role; set role service_role;
select pg_temp.ok('new hold: dealer email with buyer, card, link',
  jsonb_array_length(hold_notices_due()) = 1 and hold_notices_due()->0->>'kind' = 'placed'
  and hold_notices_due()->0->>'email' = 'a@example.test' and hold_notices_due()->0->>'buyer_contact' = 'alex@x.test'
  and hold_notices_due()->0->'cards'->0->>'url' like '/c/a0000000-0000-0000-0000-000000000002-%');
select hold_notice_sent((hold_notices_due()->0->>'reservation_id')::uuid, 'placed');
select pg_temp.ok('sent once', jsonb_array_length(hold_notices_due()) = 0);
reset role; set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select release_hold((pg_temp.res('a0000000-0000-0000-0000-000000000002')).id) is not null;
reset role; set role service_role;
select pg_temp.ok('dealer released: buyer email',
  hold_notices_due()->0->>'kind' = 'ended' and hold_notices_due()->0->>'to' = 'buyer'
  and hold_notices_due()->0->>'email' = 'c@example.test' and hold_notices_due()->0->>'end_reason' = 'dealer_released');
select hold_notice_sent((hold_notices_due()->0->>'reservation_id')::uuid, 'ended');
reset role; set role authenticated;
do $$ begin perform hold_notices_due(); raise notice 'FAIL emails list is service only';
exception when insufficient_privilege then raise notice 'PASS emails list is service only'; end $$;

-- 6. sold to the holder vs sold to someone else
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select place_hold('a0000000-0000-0000-0000-000000000003', 'Alex', 'alex@x.test') is not null;
select place_hold('a0000000-0000-0000-0000-000000000004', 'Alex', 'alex@x.test') is not null;
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
select complete_hold((pg_temp.res('a0000000-0000-0000-0000-000000000003')).id) is not null;
update inventory set status = 'Sold', sold_price = 230 where id = 'a0000000-0000-0000-0000-000000000003';
update inventory set status = 'Sold', sold_price = 60 where id = 'a0000000-0000-0000-0000-000000000004';
reset role; reset session authorization;
select pg_temp.ok('sold to the holder: hold converted, card sold, nobody emailed',
  (select status = 'converted' and end_reason = 'sold_to_holder' from pg_temp.res('a0000000-0000-0000-0000-000000000003'))
  and (select listing_status = 'sold' from inventory where id = 'a0000000-0000-0000-0000-000000000003'));
select pg_temp.ok('sold to someone else at the table: hold broken',
  (select status = 'broken' and end_reason = 'sold_elsewhere' from pg_temp.res('a0000000-0000-0000-0000-000000000004')));
set session authorization authenticator; set role service_role;
select pg_temp.ok('emails: none for the holder sale, buyer told about the other',
  (select count(*) = 2 and bool_and(case when e->>'end_reason' = 'sold_to_holder' then e->>'to' = 'none'
                                          else e->>'to' = 'buyer' and e->>'end_reason' = 'sold_elsewhere' end)
     from jsonb_array_elements(hold_notices_due()) e));
select hold_notice_sent((e->>'reservation_id')::uuid, e->>'kind') from jsonb_array_elements(hold_notices_due()) e;

-- 7. a lapsed hold ends when someone else wants the card; the buyer is told it expired
reset role; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select place_hold('a0000000-0000-0000-0000-000000000005', 'Alex', 'alex@x.test') is not null;
reset role; reset session authorization;
update listing_reservations set expires_at = now() - interval '1 minute' where id = (pg_temp.res('a0000000-0000-0000-0000-000000000005')).id;
select set_config('cardshow.listing_fn', 'on', false);
update inventory set reserved_until = now() - interval '1 minute' where id = 'a0000000-0000-0000-0000-000000000005';
select set_config('cardshow.listing_fn', 'off', false);
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('a hold past its end shows as expired before the sweep',
  (select e->>'status' = 'expired' from jsonb_array_elements(my_holds()) e where e->'cards'->0->>'id' = 'a0000000-0000-0000-0000-000000000005'));
set request.jwt.claim.sub = 'dddddddd-0000-0000-0000-000000000004';
select pg_temp.ok('lapsed hold: another buyer can hold the card', place_hold('a0000000-0000-0000-0000-000000000005', 'Dee', 'd@x.test')->>'ok' = 'true');
reset role; set role service_role;
select pg_temp.ok('first buyer emailed that the hold expired',
  (select count(*) = 1 from jsonb_array_elements(hold_notices_due()) e
    where e->>'kind' = 'ended' and e->>'to' = 'buyer' and e->>'email' = 'c@example.test' and e->>'status' = 'expired'));

-- 8. daily limit
reset role; reset session authorization;
update marketplace_settings set value = '5' where key = 'max_holds_per_day';
insert into marketplace_settings (key, value) values ('max_holds_per_day', '5') on conflict (key) do update set value = '5';
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('more than the daily number of holds is refused',
  place_hold('a0000000-0000-0000-0000-000000000001', 'Alex', 'alex@x.test')->>'error' = 'hold_limit_day');
reset role; reset session authorization;
