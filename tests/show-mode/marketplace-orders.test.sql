-- Buy Now and orders (20261212120000_marketplace_orders.sql). Run with marketplace-orders.test.sh.
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
\i ../../supabase/migrations/20261211120000_marketplace_offer_rules.sql
\i ../../supabase/migrations/20261212120000_marketplace_orders.sql
\i ../../supabase/migrations/20261212120000_marketplace_orders.sql
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

-- dealer A's order cards O1..O10, $100 each, all listed
insert into inventory (id, seller_id, card_title, player, year, card_set, price, status, category, subcategory)
select ('e1000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'aaaaaaaa-0000-0000-0000-000000000001',
       'Order card ' || n, 'Player ' || n, 2024, 'Prizm', 100, 'Available', 'Sports', 'Football'
  from generate_series(1, 10) n;
insert into card_captures (id, seller_id, entry_point, crop_key, uploaded_at)
select ('f1' || substr(id::text, 3))::uuid, seller_id, 'case_scan', 'k/' || id || '/crop.jpg', now() from inventory where card_title like 'Order card %';
update inventory set primary_capture_id = ('f1' || substr(id::text, 3))::uuid where card_title like 'Order card %';
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select (publish_listings(array(select id from inventory where card_title like 'Order card %'))->>'published') is not null;
reset role; reset session authorization;
create or replace function pg_temp.o(n int) returns uuid language sql as $$
  select ('e1000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid $$;
create or replace function pg_temp.ord(n int) returns public.orders language sql as $$
  select o.* from public.orders o where pg_temp.o(n) = any(o.listing_ids) order by created_at desc limit 1 $$;
create or replace function pg_temp.oev(p uuid) returns text language sql as $$
  select string_agg(kind || '>' || to_whom, ',' order by created_at, kind) from public.order_events where order_id = p $$;
-- O1 ship $5 flat; O2 ship, no shipping price; O3/O4/O7 pickup at show_near; O5 ship+pickup; O8/O9 ship $5 / $3
update inventory set sale_modes = array['ship'], shipping_options = '{"flat_cents":500}' where id in (pg_temp.o(1), pg_temp.o(6));
update inventory set sale_modes = array['ship'] where id = pg_temp.o(2);
update inventory set sale_modes = array['local_pickup'], pickup_show_id = 'show_near' where id in (pg_temp.o(3), pg_temp.o(4), pg_temp.o(7));
update inventory set sale_modes = array['ship','local_pickup'], shipping_options = '{"flat_cents":500}' where id = pg_temp.o(5);
update inventory set sale_modes = array['ship'], shipping_options = '{"flat_cents":500}' where id = pg_temp.o(8);
update inventory set sale_modes = array['ship'], shipping_options = '{"flat_cents":300}' where id = pg_temp.o(9);
\set ADDR '''{"name":"Cal B","line1":"1 Main St","city":"Austin","state":"tx","postal":"78701"}'''

-- 1. how a dealer gets paid
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok('payment methods cleaned up: @handle, paypal.me link, $cashtag',
  set_payment_methods('[{"kind":"venmo","value":"@dealer-a"},{"kind":"paypal","value":"https://paypal.me/DealerA/10"},{"kind":"cashapp","value":"$dealera"},{"kind":"zelle","value":"a@example.test"},{"kind":"other","value":"Cash at the table"}]', 'Note the order #')
    @> '{"ok":true,"methods":[{"kind":"venmo","value":"dealer-a"},{"kind":"paypal","value":"DealerA"},{"kind":"cashapp","value":"dealera"}]}');
select pg_temp.ok('bad payment methods refused', set_payment_methods('[{"kind":"venmo","value":"no spaces allowed"}]')->>'error' = 'bad_method'
  and set_payment_methods('[{"kind":"link","value":"http://pay.example.test"}]')->>'error' = 'bad_method'
  and set_payment_methods('[{"kind":"bitcoin","value":"x"}]')->>'error' = 'bad_method');
select pg_temp.ok('dealer reads own methods', (select jsonb_array_length(methods) = 5 from dealer_payment_methods));
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
select pg_temp.ok('another dealer can''t read them', (select count(*) = 0 from dealer_payment_methods));
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('a buyer can''t set payment methods', set_payment_methods('[]')->>'error' = 'not_a_seller');

-- 2. Buy Now refusals
select pg_temp.ok('missing name / bad fulfillment / own listing refused',
  place_order(pg_temp.o(1), 'ship', '', 'c@x.test', null, :ADDR)->>'error' = 'missing_name'
  and place_order(pg_temp.o(1), 'fly', 'Cal', 'c@x.test', null, :ADDR)->>'error' = 'bad_fulfillment');
select pg_temp.ok('pickup on a ship-only card / bad address refused',
  place_order(pg_temp.o(1), 'local_pickup', 'Cal', 'c@x.test')->>'error' = 'fulfillment_not_offered'
  and place_order(pg_temp.o(1), 'ship', 'Cal', 'c@x.test', null, '{"name":"Cal","line1":"1 Main","city":"Austin","state":"Texas","postal":"787"}')->>'error' = 'bad_address');
select pg_temp.ok('early-access and flagged cards refused',
  place_order(:A1, 'ship', 'Cal', 'c@x.test', null, :ADDR)->>'error' is null   -- A1 is fine (control)
  and place_order('a0000000-0000-0000-0000-000000000007', 'ship', 'Cal', 'c@x.test', null, :ADDR)->>'error' = 'early_access'
  and place_order('a0000000-0000-0000-0000-000000000008', 'ship', 'Cal', 'c@x.test', null, :ADDR)->>'error' = 'unavailable');
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok('a dealer can''t buy their own card', place_order(pg_temp.o(1), 'ship', 'A', 'a@x.test', null, :ADDR)->>'error' = 'own_listing');

-- 3. Buy Now → confirm → paid → shipped → received
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('Buy Now (ship): awaiting confirmation, $100 + $5 shipping',
  place_order(pg_temp.o(1), 'ship', ' Cal ', 'c@x.test', 'Please bubble wrap', :ADDR) @> '{"ok":true,"status":"awaiting_confirmation","subtotal_cents":10000,"shipping_cents":500}');
select pg_temp.ok('buying it again: already ordered', place_order(pg_temp.o(1), 'ship', 'Cal', 'c@x.test', null, :ADDR)->>'error' = 'already_ordered');
select pg_temp.ok('no payment details before the dealer confirms',
  (select not (e ? 'payment') and e->>'status' = 'awaiting_confirmation' and e ? 'pickup_code'
     from jsonb_array_elements(my_orders()) e where e->>'id' = (pg_temp.ord(1)).id::text));
reset role; reset session authorization;
select pg_temp.ok('card reserved for the buyer until the confirm deadline; reservation runs a day past it; dealer told',
  (select listing_status = 'reserved' and reserved_by = :C from inventory where id = pg_temp.o(1))
  and (select o.confirm_by between now() + interval '119 minutes' and now() + interval '121 minutes'
          and lr.reason = 'buy_now' and lr.expires_at > o.confirm_by + interval '23 hours'
          and o.ship_to->>'state' = 'TX' and o.buyer_name = 'Cal' and o.fee_status = 'not_billed' and o.seller_fee_cents = 0
     from pg_temp.ord(1) o join listing_reservations lr on lr.id = o.reservation_id)
  and pg_temp.oev((pg_temp.ord(1)).id) = 'new>dealer');
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'dddddddd-0000-0000-0000-000000000004';
select pg_temp.ok('another buyer: unavailable', place_order(pg_temp.o(1), 'ship', 'Dee', 'd@x.test', null, :ADDR)->>'error' = 'unavailable');
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
select pg_temp.ok('another dealer can''t confirm it', confirm_order((pg_temp.ord(1)).id)->>'error' = 'not_found');
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok('dealer sees the order with the buyer''s contact and address',
  (select e->>'buyer_contact' = 'c@x.test' and e->'ship_to'->>'city' = 'Austin' and e->>'total_cents' = '10500' and not (e ? 'pickup_code')
     from jsonb_array_elements(dealer_orders()) e where e->>'id' = (pg_temp.ord(1)).id::text));
select pg_temp.ok('confirm: awaiting payment, 24 hours to pay',
  confirm_order((pg_temp.ord(1)).id) @> '{"ok":true,"status":"awaiting_payment","shipping_cents":500}'
  and (select pay_by between now() + interval '1439 minutes' and now() + interval '1441 minutes' from pg_temp.ord(1)));
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('buyer now sees how to pay',
  (select e->'payment'->'methods'->0->>'value' = 'dealer-a' and e->'payment'->>'note' = 'Note the order #' and e->>'total_cents' = '10500'
     from jsonb_array_elements(my_orders()) e where e->>'id' = (pg_temp.ord(1)).id::text));
select pg_temp.ok('buyer can''t mark it paid', (mark_order_paid((pg_temp.ord(1)).id, 'Venmo'))->>'error' = 'not_found');
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok('dealer marks it paid', mark_order_paid((pg_temp.ord(1)).id, 'Venmo') @> '{"ok":true,"status":"paid"}');
reset role; reset session authorization;
select pg_temp.ok('card sold on CardShow at $100 by Venmo, dated; buyer told; confirmed and paid emails queued',
  (select status = 'Sold' and listing_status = 'sold' and sold_channel = 'cardshow' and sold_price = 100
          and payment_method = 'Venmo' and sold_date is not null from inventory where id = pg_temp.o(1))
  and (select lr.status = 'converted' from listing_reservations lr where lr.id = (pg_temp.ord(1)).reservation_id)
  and pg_temp.oev((pg_temp.ord(1)).id) = 'new>dealer,confirmed>buyer,paid>buyer');
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok('shipping needs a tracking number', ship_order((pg_temp.ord(1)).id, 'USPS', '')->>'error' = 'missing_tracking'
  and ship_order((pg_temp.ord(1)).id, 'USPS', '9400 1000 0000') @> '{"status":"shipped"}');
set request.jwt.claim.sub = 'dddddddd-0000-0000-0000-000000000004';
select pg_temp.ok('someone else can''t say they got it', order_received((pg_temp.ord(1)).id)->>'error' = 'not_found');
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('buyer got it: completed', order_received((pg_temp.ord(1)).id) @> '{"status":"completed"}');
reset role; reset session authorization;
select pg_temp.ok('shipped email queued', pg_temp.oev((pg_temp.ord(1)).id) like '%shipped>buyer%' and (pg_temp.ord(1)).status = 'completed');
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';

-- 4. shipping set by the dealer, buyer cancels
select (place_order(pg_temp.o(2), 'ship', 'Cal', 'c@x.test', null, :ADDR)->>'ok')::boolean;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok('no flat shipping: the dealer must set it to confirm',
  confirm_order((pg_temp.ord(2)).id)->>'error' = 'shipping_required'
  and confirm_order((pg_temp.ord(2)).id, 450) @> '{"status":"awaiting_payment","shipping_cents":450}');
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('buyer cancels before paying: card back on sale, dealer told',
  cancel_order((pg_temp.ord(2)).id) @> '{"status":"cancelled"}');
reset role; reset session authorization;
select pg_temp.ok('after cancel', (select listing_status = 'active' and reserved_by is null from inventory where id = pg_temp.o(2))
  and (pg_temp.ord(2)).end_reason = 'buyer_cancelled' and pg_temp.oev((pg_temp.ord(2)).id) like '%cancelled>dealer%');

-- 5. pickup
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('Buy Now (pickup at the show)', place_order(pg_temp.o(3), 'local_pickup', 'Cal', 'c@x.test') @> '{"ok":true}');
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select (confirm_order((pg_temp.ord(3)).id)->>'ok')::boolean;
reset role; reset session authorization;
select pg_temp.ok('pickup: pay by the end of the show''s last day (Pacific)',
  (select o.pay_by = ((current_date + 4)::timestamp at time zone 'America/Los_Angeles') and o.pickup_show_id = 'show_near' from pg_temp.ord(3) o));
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('buyer sees the pickup show with the dealer''s table',
  (select e->'pickup_show'->>'name' = 'Near Show' and e->'pickup_show'->>'table_number' = '12'
     from jsonb_array_elements(my_orders()) e where e->>'id' = (pg_temp.ord(3)).id::text));
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok('paid and picked up in one tap: completed', mark_order_paid((pg_temp.ord(3)).id, 'Cash', true) @> '{"status":"completed"}');
select pg_temp.ok('card sold, by cash', (select status = 'Sold' and payment_method = 'Cash' from inventory where id = pg_temp.o(3)));
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select (place_order(pg_temp.o(4), 'local_pickup', 'Cal', 'c@x.test')->>'ok')::boolean;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok('paid at the table before the dealer confirmed: completed',
  mark_order_paid((pg_temp.ord(4)).id, 'Cash', true) @> '{"status":"completed"}'
  and (select confirmed_at is not null and paid_at is not null from pg_temp.ord(4)));

-- 6. dealer cancels
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select (place_order(pg_temp.o(5), 'ship', 'Cal', 'c@x.test', null, :ADDR)->>'ok')::boolean;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok('"didn''t pay" only once confirmed', dealer_cancel_order((pg_temp.ord(5)).id, 'not_paid')->>'error' = 'bad_reason');
select pg_temp.ok('not available: cancelled', dealer_cancel_order((pg_temp.ord(5)).id, 'not_available') @> '{"status":"cancelled"}');
reset role; reset session authorization;
select pg_temp.ok('the card comes off sale; buyer told', (select listing_status = 'delisted' from inventory where id = pg_temp.o(5))
  and pg_temp.oev((pg_temp.ord(5)).id) = 'new>dealer,cancelled>buyer');
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';

-- 7. a hold, an accepted offer and an accepted bundle offer become orders
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select (place_hold(pg_temp.o(6), 'Cal', 'c@x.test')->>'ok')::boolean;
select pg_temp.ok('Buy Now on a card I hold: the hold becomes the order',
  place_order(pg_temp.o(6), 'ship', 'Cal', 'c@x.test', null, :ADDR) @> '{"ok":true,"subtotal_cents":10000}');
reset role; reset session authorization;
select pg_temp.ok('hold converted ("ordered"), new buy_now reservation, order remembers the hold',
  (select lr.status = 'converted' and lr.end_reason = 'ordered' from listing_reservations lr where lr.id = (pg_temp.ord(6)).from_reservation_id)
  and (select lr.reason = 'buy_now' and lr.status = 'active' from listing_reservations lr where lr.id = (pg_temp.ord(6)).reservation_id));
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'dddddddd-0000-0000-0000-000000000004';
select (make_offer(pg_temp.o(7), 8000, 'Dee', 'd@x.test')->>'ok')::boolean;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select (respond_offer((pg_temp.off(pg_temp.o(7), :D)).id, 'accept')->>'ok')::boolean;
set request.jwt.claim.sub = 'dddddddd-0000-0000-0000-000000000004';
select pg_temp.ok('an accepted offer becomes an order at the agreed price; ship refused on a pickup-only card first',
  order_from_hold((pg_temp.off(pg_temp.o(7), :D)).reservation_id, 'ship', :ADDR)->>'error' = 'fulfillment_not_offered'
  and order_from_hold((pg_temp.off(pg_temp.o(7), :D)).reservation_id, 'local_pickup') @> '{"ok":true,"subtotal_cents":8000}'
  and (pg_temp.ord(7)).offer_id = (pg_temp.off(pg_temp.o(7), :D)).id and (pg_temp.ord(7)).buyer_name = 'Dee');
select (make_bundle_offer(array[pg_temp.o(8), pg_temp.o(9)], 15000, 'Dee', 'd@x.test')->>'ok')::boolean;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select (respond_offer((select id from offers where listing_ids = array[pg_temp.o(8), pg_temp.o(9)]), 'accept')->>'ok')::boolean;
set request.jwt.claim.sub = 'dddddddd-0000-0000-0000-000000000004';
select pg_temp.ok('a bundle hold becomes one order: both cards, agreed $150, the higher flat shipping',
  order_from_hold((select reservation_id from offers where listing_ids = array[pg_temp.o(8), pg_temp.o(9)]), 'ship', :ADDR)
    @> '{"ok":true,"subtotal_cents":15000,"shipping_cents":500}');
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select (confirm_order((pg_temp.ord(8)).id)->>'ok')::boolean, (mark_order_paid((pg_temp.ord(8)).id, 'PayPal')->>'ok')::boolean;
reset role; reset session authorization;
select pg_temp.ok('bundle paid: both sold, prices add up to $150',
  (select bool_and(status = 'Sold') and sum(sold_price) = 150 from inventory where id in (pg_temp.o(8), pg_temp.o(9))));

-- 8. the sweep
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select (place_order(pg_temp.o(10), 'ship', 'Cal', 'c@x.test', null, :ADDR)->>'ok')::boolean;
reset role; reset session authorization;
update orders set confirm_by = now() - interval '1 minute' where id = (pg_temp.ord(10)).id;
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('an overdue order reads expired before the sweep', (select e->>'status' = 'expired' and e->>'end_reason' = 'not_confirmed'
  from jsonb_array_elements(my_orders()) e where e->>'id' = (pg_temp.ord(10)).id::text));
select pg_temp.ok('the sweep is service-only', (select count(*) = 0 from (select 1) x where has_function_privilege('authenticated', 'public.expire_orders()', 'EXECUTE')));
reset role; reset session authorization;
-- card 6's order (from the hold): confirmed, then the card is sold at the table
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select (confirm_order((pg_temp.ord(6)).id)->>'ok')::boolean;
reset role; reset session authorization;
update inventory set status = 'Sold' where id = pg_temp.o(6);
-- card 7's order (from the offer): confirmed, then unpaid past the deadline
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select (confirm_order((pg_temp.ord(7)).id)->>'ok')::boolean;
reset role; reset session authorization;
update orders set pay_by = now() - interval '1 minute' where id = (pg_temp.ord(7)).id;
update orders set shipped_at = now() - interval '15 days' where id = (pg_temp.ord(8)).id;
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select (ship_order((pg_temp.ord(8)).id, 'UPS', '1Z999')->>'ok')::boolean;
reset role; reset session authorization;
update orders set shipped_at = now() - interval '15 days' where id = (pg_temp.ord(8)).id;
set role service_role;
select pg_temp.ok('sweep ended 3 orders', expire_orders() = 3);
reset role;
select pg_temp.ok('not confirmed in time: expired, card back on sale, both told',
  (pg_temp.ord(10)).status = 'expired' and (pg_temp.ord(10)).end_reason = 'not_confirmed'
  and (select listing_status = 'active' from inventory where id = pg_temp.o(10))
  and pg_temp.oev((pg_temp.ord(10)).id) = 'new>dealer,expired>buyer,expired>dealer');
select pg_temp.ok('sold at the table meanwhile: cancelled, buyer told',
  (pg_temp.ord(6)).status = 'cancelled' and (pg_temp.ord(6)).end_reason = 'sold_elsewhere'
  and pg_temp.oev((pg_temp.ord(6)).id) like '%cancelled>buyer%');
select pg_temp.ok('not paid in time: expired, card back on sale',
  (pg_temp.ord(7)).status = 'expired' and (pg_temp.ord(7)).end_reason = 'not_paid'
  and (select listing_status = 'active' from inventory where id = pg_temp.o(7)));
select pg_temp.ok('shipped two weeks ago: completed automatically', (pg_temp.ord(8)).status = 'completed');

-- 9. at a show: 15 minutes to confirm
insert into shows (id, name, start_date, end_date, city, state, listed) values ('show_now', 'Now Show', current_date - 1, current_date + 1, 'Reno', 'NV', true);
insert into show_sellers values ('show_now', 'aaaaaaaa-0000-0000-0000-000000000001', '5');
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('dealer at a show: 15 minutes to confirm',
  (select (r->>'confirm_by')::timestamptz between now() + interval '14 minutes' and now() + interval '16 minutes'
     from (select place_order(pg_temp.o(10), 'ship', 'Cal', 'c@x.test', null, :ADDR) r) q));

-- 10. privacy and emails
set request.jwt.claim.sub = 'dddddddd-0000-0000-0000-000000000004';
select pg_temp.ok('a buyer reads only their own orders; no access to the email queue',
  (select count(*) = 0 from orders where buyer_id = :C) and (select count(*) > 0 from orders where buyer_id = :D)
  and (select count(*) = 0 from order_events) and (select count(*) = 0 from dealer_payment_methods));
reset role; reset session authorization;
select pg_temp.ok('anon can''t place orders', not has_function_privilege('anon', 'public.place_order(uuid, text, text, text, text, jsonb)', 'EXECUTE'));
set role service_role;
select pg_temp.ok('emails due carry the address, payment methods and card list',
  (select bool_or(n->>'kind' = 'confirmed' and n->>'email' = 'c@example.test' and jsonb_array_length(n->'payment'->'methods') = 5
                  and n->'cards'->0->>'title' like 'Order card%')
     from jsonb_array_elements(order_notices_due(200)) n));
reset role;
