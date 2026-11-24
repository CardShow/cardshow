-- Bundle offers (20261209120000_marketplace_bundle_offers.sql). Run with marketplace-bundle-offers.test.sh.
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
\i ../../supabase/migrations/20261208120000_marketplace_offers.sql
\i ../../supabase/migrations/20261208120000_marketplace_offers.sql
\i ../../supabase/migrations/20261209120000_marketplace_bundle_offers.sql
\i ../../supabase/migrations/20261209120000_marketplace_bundle_offers.sql
\i ../../supabase/migrations/20261211120000_marketplace_offer_rules.sql
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
create or replace function pg_temp.off(p_card uuid, p_buyer uuid) returns public.offers language sql as $$
  select o.* from public.offers o where o.listing_id = p_card and o.buyer_id = p_buyer order by created_at desc limit 1 $$;
create or replace function pg_temp.ev(p_offer uuid) returns text language sql as $$
  select string_agg(kind || '>' || to_whom, ',' order by created_at) from public.offer_events where offer_id = p_offer $$;
\set A1 '''a0000000-0000-0000-0000-000000000001'''
\set C '''cccccccc-0000-0000-0000-000000000003'''
\set D '''dddddddd-0000-0000-0000-000000000004'''
\set A1 '''a0000000-0000-0000-0000-000000000001'''
\set A3 '''a0000000-0000-0000-0000-000000000003'''
\set A4 '''a0000000-0000-0000-0000-000000000004'''
\set A5 '''a0000000-0000-0000-0000-000000000005'''
create or replace function pg_temp.boff(p_buyer uuid) returns public.offers language sql as $$
  select o.* from public.offers o where o.buyer_id = p_buyer and cardinality(o.listing_ids) > 1 order by created_at desc limit 1 $$;

-- 1. what a bundle may hold
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('one dealer per bundle', make_bundle_offer(array[:A1, :A3]::uuid[], 30000, 'Alex', 'a@x.test')->>'error' = 'multiple_dealers');
select pg_temp.ok('a flagged card in the bundle: unavailable, naming it',
  make_bundle_offer(array[:A1, 'a0000000-0000-0000-0000-000000000008']::uuid[], 20000, 'Alex', 'a@x.test')
    @> '{"error":"unavailable","unavailable":["a0000000-0000-0000-0000-000000000008"]}');
select pg_temp.ok('no cards / bad amount', make_bundle_offer('{}'::uuid[], 20000, 'Alex', 'a@x.test')->>'error' = 'no_listings'
  and make_bundle_offer(array[:A3, :A4]::uuid[], 50, 'Alex', 'a@x.test')->>'error' = 'bad_amount');
select pg_temp.ok('above the total asking price ($290) refused',
  make_bundle_offer(array[:A3, :A4]::uuid[], 29100, 'Alex', 'a@x.test') @> '{"error":"above_price","price_cents":29000}');
reset role; reset session authorization;
update inventory set accepts_offers = false where id = 'a0000000-0000-0000-0000-000000000002';
insert into marketplace_settings (key, value) values ('max_cards_per_offer', '1') on conflict (key) do update set value = '1';
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('more cards than the limit refused', make_bundle_offer(array[:A3, :A4]::uuid[], 20000, 'Alex', 'a@x.test')->>'error' = 'too_many');
reset role; reset session authorization;
update marketplace_settings set value = '20' where key = 'max_cards_per_offer';
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('a card that takes no offers: refused, naming it',
  make_bundle_offer(array[:A1, 'a0000000-0000-0000-0000-000000000002']::uuid[], 20000, 'Alex', 'a@x.test')
    @> '{"error":"no_offers","no_offers":["a0000000-0000-0000-0000-000000000002"]}');

-- 2. make a bundle offer
select pg_temp.ok('bundle of two cards ($290): pending',
  make_bundle_offer(array[:A3, :A3, :A4]::uuid[], 25000, ' Alex ', '555-0100', 'Both for cash')->>'status' = 'pending');
reset role; reset session authorization;
select pg_temp.ok('saved once per card, in order, filed under the first, asking = total, dealer told',
  (select listing_ids = array[:A3, :A4]::uuid[] and listing_id = :A3 and asking_cents = 29000 and amount_cents = 25000
          and dealer_id = 'bbbbbbbb-0000-0000-0000-000000000002' from pg_temp.boff(:C))
  and pg_temp.ev((pg_temp.boff(:C)).id) = 'new>dealer'
  and (select bool_and(listing_status = 'active') from inventory where id in (:A3, :A4)));
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('a second offer sharing a card is refused (one-card or bundle)',
  make_offer(:A4, 5000, 'Alex', '555-0100')->>'error' = 'already_open'
  and make_bundle_offer(array[:A4, :A5]::uuid[], 90000, 'Alex', '555-0100')->>'error' = 'already_open');
select pg_temp.ok('buyer list: the bundle with both cards',
  (select jsonb_array_length(e->'cards') = 2 and (e->>'card_count')::int = 2 and e->'cards'->1->>'id' = 'a0000000-0000-0000-0000-000000000004'
     from jsonb_array_elements(my_offers()) e where (e->>'card_count')::int = 2));
set request.jwt.claim.sub = 'dddddddd-0000-0000-0000-000000000004';
select pg_temp.ok('another buyer can still offer on one of the cards', make_offer(:A4, 5000, 'Dee', 'd@x.test')->>'status' = 'pending');
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
select pg_temp.ok('dealer list: the bundle with both cards and their codes/prices',
  (select jsonb_array_length(e->'cards') = 2 and e->'cards'->0->>'price_cents' = '23000' and e->>'buyer_contact' = '555-0100'
     from jsonb_array_elements(dealer_offers()) e where (e->>'card_count')::int = 2));

-- 3. counter + accept → one hold over both cards
select pg_temp.ok('dealer counter must be under the bundle total',
  respond_offer((pg_temp.boff(:C)).id, 'counter', 29000)->>'error' = 'bad_counter'
  and respond_offer((pg_temp.boff(:C)).id, 'counter', 27000)->>'status' = 'countered');
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('buyer accepts $270', buyer_respond_offer((pg_temp.boff(:C)).id, 'accept') @> '{"status":"accepted","agreed_cents":27000}');
reset role; reset session authorization;
select pg_temp.ok('one hold over both cards at $270; both reserved for the buyer',
  (select r.listing_ids = array[:A3, :A4]::uuid[] and r.agreed_cents = 27000 and r.reason = 'offer_accepted' and r.status = 'active'
     from listing_reservations r where r.id = (pg_temp.boff(:C)).reservation_id)
  and (select bool_and(listing_status = 'reserved' and reserved_by = :C and reservation_id = (pg_temp.boff(:C)).reservation_id)
         from inventory where id in (:A3, :A4)));
select pg_temp.ok('the other buyer''s offer on a card in the bundle closes; they are told',
  (select status = 'closed' and end_reason = 'other_offer_accepted' from pg_temp.off(:A4, :D))
  and pg_temp.ev((pg_temp.off(:A4, :D)).id) = 'new>dealer,closed>buyer');
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
select pg_temp.ok('dealer holds: one hold, two cards, agreed price',
  (select jsonb_array_length(e->'cards') = 2 and e->>'agreed_cents' = '27000' from jsonb_array_elements(dealer_holds()) e
    where e->>'status' = 'active'));
select pg_temp.ok('sold to them: both cards back to active for the sale, agreed price returned',
  complete_hold((pg_temp.boff(:C)).reservation_id) @> '{"agreed_cents":27000}');
reset role; reset session authorization;
select pg_temp.ok('after Sold to them both cards are active again',
  (select bool_and(listing_status = 'active' and reservation_id is null) from inventory where id in (:A3, :A4)));

-- 4. the cards' own settings, added up
update inventory set auto_accept_cents = 20000 where id = :A3;
update inventory set auto_accept_cents = 5000, min_offer_cents = 4000 where id = :A4;
update inventory set min_offer_cents = 15000 where id = :A3;
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'dddddddd-0000-0000-0000-000000000004';
select pg_temp.ok('under the sum of lowest offers ($190): declined at once',
  make_bundle_offer(array[:A3, :A4]::uuid[], 18000, 'Dee', 'd@x.test') @> '{"status":"declined","auto":true}');
select pg_temp.ok('at the sum of auto-accept prices ($250): accepted at once',
  make_bundle_offer(array[:A3, :A4]::uuid[], 25000, 'Dee', 'd@x.test') @> '{"status":"accepted","agreed_cents":25000}');
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
select release_hold((pg_temp.boff(:D)).reservation_id) is not null;
set request.jwt.claim.sub = 'dddddddd-0000-0000-0000-000000000004';
select pg_temp.ok('auto-accept only counts when every card has one (A5 has none): pending',
  make_bundle_offer(array[:A4, :A5]::uuid[], 80000, 'Dee', 'd@x.test')->>'status' = 'pending');

-- 5. a card in the bundle sells at the table: the offer closes
reset role; reset session authorization;
update inventory set status = 'Sold', sold_price = 900 where id = :A5;
set session authorization authenticator; set role service_role;
select pg_temp.ok('sweep closes the bundle when one card sold', expire_offers() >= 1);
reset role; reset session authorization;
select pg_temp.ok('closed as sold; buyer told',
  (select status = 'closed' and end_reason = 'sold' from pg_temp.boff(:D))
  and pg_temp.ev((pg_temp.boff(:D)).id) = 'new>dealer,closed>buyer');

-- 6. emails list every card
set session authorization authenticator; set role service_role;
select pg_temp.ok('offer emails carry every card of a bundle',
  (select count(*) > 0 and bool_and(jsonb_array_length(e->'cards') = (e->>'card_count')::int)
     from jsonb_array_elements(offer_notices_due(200)) e where (e->>'card_count')::int = 2));
reset role; reset session authorization;
