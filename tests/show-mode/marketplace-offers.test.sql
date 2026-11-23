-- Make an Offer (20261208120000_marketplace_offers.sql). Run with marketplace-offers.test.sh.
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

-- 1. who may offer, and on what
set session authorization authenticator; set role anon;
do $$ begin perform make_offer('a0000000-0000-0000-0000-000000000001', 15000, 'X', 'x@x.test');
  raise notice 'FAIL anon cannot make an offer';
exception when insufficient_privilege then raise notice 'PASS anon cannot make an offer'; end $$;
set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('offer checks: amount, name, contact, above the price',
  make_offer(:A1, 50, 'Alex', 'a@x.test')->>'error' = 'bad_amount'
  and make_offer(:A1, 15000, ' ', 'a@x.test')->>'error' = 'missing_name'
  and make_offer(:A1, 15000, 'Alex', 'a')->>'error' = 'missing_contact'
  and make_offer(:A1, 18100, 'Alex', 'a@x.test')->>'error' = 'above_price');
select pg_temp.ok('unlisted, flagged and early-access cards take no offers',
  make_offer('a0000000-0000-0000-0000-000000000006', 5000, 'Alex', 'a@x.test')->>'error' = 'unavailable'
  and make_offer('a0000000-0000-0000-0000-000000000008', 5000, 'Alex', 'a@x.test')->>'error' = 'unavailable'
  and make_offer('a0000000-0000-0000-0000-000000000007', 5000, 'Alex', 'a@x.test')->>'error' = 'early_access');
reset role; reset session authorization;
update inventory set accepts_offers = false where id = 'a0000000-0000-0000-0000-000000000002';
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('a card set to no offers refuses them',
  make_offer('a0000000-0000-0000-0000-000000000002', 20000, 'Alex', 'a@x.test')->>'error' = 'no_offers');
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok('a dealer cannot offer on their own card', make_offer(:A1, 15000, 'Me', 'me@x.test')->>'error' = 'own_listing');

-- 2. make an offer
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('offer below the price waits for the dealer',
  make_offer(:A1, 15000, ' Alex  P ', '555-0100', 'Cash at the show')->>'status' = 'pending');
select pg_temp.ok('one open offer per card', make_offer(:A1, 15500, 'Alex', '555-0100')->>'error' = 'already_open');
set request.jwt.claim.sub = 'dddddddd-0000-0000-0000-000000000004';
select pg_temp.ok('another buyer can offer on the same card', make_offer(:A1, 14000, 'Dee', 'd@x.test')->>'status' = 'pending');
select pg_temp.ok('buyers cannot read other buyers'' offers',
  (select count(*) from offers) = 1 and jsonb_array_length(my_offers()) = 1);
reset role; reset session authorization;
select pg_temp.ok('offer saved: amount, asking price, 24 hours, card still on sale, dealer told',
  (select amount_cents = 15000 and offer_cents = 15000 and asking_cents = 18000 and buyer_name = 'Alex P'
          and expires_at between now() + interval '1439 minutes' and now() + interval '1441 minutes'
     from pg_temp.off(:A1, :C))
  and (select listing_status = 'active' from inventory where id = :A1)
  and pg_temp.ev((pg_temp.off(:A1, :C)).id) = 'new>dealer');

-- 3. lists
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok('dealer list: both offers with contact and card',
  jsonb_array_length(dealer_offers()) = 2
  and (select bool_and(e->>'status' = 'pending' and e ? 'buyer_contact' and e->'card'->>'title' like '%Charizard%')
         from jsonb_array_elements(dealer_offers()) e));
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
select pg_temp.ok('another dealer sees none', jsonb_array_length(dealer_offers()) = 0);
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('buyer list: the offer and the card as on the listing page',
  my_offers()->0->>'amount_cents' = '15000' and my_offers()->0->'card'->>'id' = 'a0000000-0000-0000-0000-000000000001');

-- 4. turns and counters
select pg_temp.ok('buyer cannot answer as the dealer, or before the dealer has',
  respond_offer((pg_temp.off(:A1, :C)).id, 'accept')->>'error' = 'not_found'
  and buyer_respond_offer((pg_temp.off(:A1, :C)).id, 'accept')->>'error' = 'not_your_turn');
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok('dealer counter must be above the offer and below the price',
  respond_offer((pg_temp.off(:A1, :C)).id, 'counter', 15000)->>'error' = 'bad_counter'
  and respond_offer((pg_temp.off(:A1, :C)).id, 'counter', 18000)->>'error' = 'bad_counter');
select pg_temp.ok('dealer counters at $170', respond_offer((pg_temp.off(:A1, :C)).id, 'counter', 17000)->>'status' = 'countered');
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('buyer counter must be above their offer and below the counter',
  buyer_respond_offer((pg_temp.off(:A1, :C)).id, 'counter', 15000)->>'error' = 'bad_counter'
  and buyer_respond_offer((pg_temp.off(:A1, :C)).id, 'counter', 17000)->>'error' = 'bad_counter');
select pg_temp.ok('buyer counters at $160', buyer_respond_offer((pg_temp.off(:A1, :C)).id, 'counter', 16000)->>'status' = 'pending');
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok('no fourth move: dealer can only accept or decline',
  respond_offer((pg_temp.off(:A1, :C)).id, 'counter', 16500)->>'error' = 'no_more_counters'
  and dealer_offers()->0->>'can_counter' = 'false');
reset role; reset session authorization;
select pg_temp.ok('history and emails follow each move',
  (select moves = 3 and last_by = 'buyer' and jsonb_array_length(history) = 3 and history->1->>'cents' = '17000' from pg_temp.off(:A1, :C))
  and pg_temp.ev((pg_temp.off(:A1, :C)).id) = 'new>dealer,countered>buyer,countered>dealer');

-- 5. accept → hold at the agreed price
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok('dealer accepts $160', respond_offer((pg_temp.off(:A1, :C)).id, 'accept')->>'agreed_cents' = '16000');
reset role; reset session authorization;
select pg_temp.ok('accepted offer is a 24-hour hold for the buyer at $160, not announced as a new hold',
  (select reason = 'offer_accepted' and status = 'active' and agreed_cents = 16000 and buyer_id = :C and buyer_name = 'Alex P'
          and buyer_note = 'Cash at the show' and placed_notice_at is not null
          and expires_at between now() + interval '1439 minutes' and now() + interval '1441 minutes'
     from pg_temp.res(:A1))
  and (select listing_status = 'reserved' and reserved_by = :C from inventory where id = :A1)
  and (select status = 'accepted' and decided_by = 'dealer' and reservation_id = (pg_temp.res(:A1)).id from pg_temp.off(:A1, :C))
  and pg_temp.ev((pg_temp.off(:A1, :C)).id) like '%accepted>buyer');
select pg_temp.ok('the other buyer''s offer closes and they are told',
  (select status = 'closed' and end_reason = 'other_offer_accepted' from pg_temp.off(:A1, :D))
  and pg_temp.ev((pg_temp.off(:A1, :D)).id) = 'new>dealer,closed>buyer');
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok('dealer holds list shows it with the agreed price',
  (select e->>'agreed_cents' = '16000' and e->>'from_offer' = 'true' from jsonb_array_elements(dealer_holds()) e
    where e->'cards'->0->>'id' = 'a0000000-0000-0000-0000-000000000001'));
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('buyer sees the accepted offer and the hold',
  my_offers()->0->>'status' = 'accepted' and my_offers()->0->'hold'->>'status' = 'active'
  and my_holds()->0->>'agreed_cents' = '16000');
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok('sold to them returns the agreed price', complete_hold((pg_temp.res(:A1)).id)->>'agreed_cents' = '16000');
reset role; reset session authorization;

-- 6. the dealer's settings answer at once
update inventory set auto_accept_cents = 20000 where id = 'a0000000-0000-0000-0000-000000000003';
update inventory set min_offer_cents = 80000 where id = 'a0000000-0000-0000-0000-000000000005';
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('at or above auto-accept: accepted and held at once',
  make_offer('a0000000-0000-0000-0000-000000000003', 21000, 'Alex', 'alex@x.test')->>'status' = 'accepted');
select pg_temp.ok('below the lowest offer: declined at once',
  make_offer('a0000000-0000-0000-0000-000000000005', 50000, 'Alex', 'alex@x.test') @> '{"status":"declined","auto":true}');
reset role; reset session authorization;
select pg_temp.ok('auto accept: dealer told, hold at $210; auto decline: nobody emailed',
  (select reason = 'offer_accepted' and agreed_cents = 21000 from pg_temp.res('a0000000-0000-0000-0000-000000000003'))
  and pg_temp.ev((pg_temp.off('a0000000-0000-0000-0000-000000000003', :C)).id) = 'accepted>dealer'
  and pg_temp.ev((pg_temp.off('a0000000-0000-0000-0000-000000000005', :C)).id) is null
  and (select decided_by = 'auto' and end_reason = 'below_minimum' from pg_temp.off('a0000000-0000-0000-0000-000000000005', :C)));

-- 7. withdraw, decline
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select make_offer('a0000000-0000-0000-0000-000000000004', 4000, 'Alex', 'alex@x.test') is not null;
select pg_temp.ok('buyer withdraws, then can offer again',
  withdraw_offer((pg_temp.off('a0000000-0000-0000-0000-000000000004', :C)).id)->>'status' = 'withdrawn'
  and make_offer('a0000000-0000-0000-0000-000000000004', 4500, 'Alex', 'alex@x.test')->>'status' = 'pending');
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
select pg_temp.ok('dealer declines',
  respond_offer((pg_temp.off('a0000000-0000-0000-0000-000000000004', :C)).id, 'decline')->>'status' = 'declined');
reset role; reset session authorization;
select pg_temp.ok('declined: buyer told', pg_temp.ev((pg_temp.off('a0000000-0000-0000-0000-000000000004', :C)).id) = 'new>dealer,declined>buyer');
set session authorization authenticator; set role authenticated;

-- 8. expiry and cards that leave the market
set request.jwt.claim.sub = 'dddddddd-0000-0000-0000-000000000004';
select make_offer('a0000000-0000-0000-0000-000000000005', 85000, 'Dee', 'd@x.test') is not null;
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select make_offer('a0000000-0000-0000-0000-000000000004', 5000, 'Alex', 'alex@x.test') is not null;
reset role; reset session authorization;
update offers set expires_at = now() - interval '1 minute' where id = (pg_temp.off('a0000000-0000-0000-0000-000000000005', :D)).id;
update inventory set status = 'Sold', sold_price = 60 where id = 'a0000000-0000-0000-0000-000000000004';
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'dddddddd-0000-0000-0000-000000000004';
select pg_temp.ok('an offer past its time shows as expired before the sweep',
  (select e->>'status' = 'expired' from jsonb_array_elements(my_offers()) e where e->>'listing_id' = 'a0000000-0000-0000-0000-000000000005'));
do $$ begin perform expire_offers(); raise notice 'FAIL sweep is service only';
exception when insufficient_privilege then raise notice 'PASS sweep is service only'; end $$;
reset role; set role service_role;
select pg_temp.ok('sweep: expired and sold-at-the-table offers end', expire_offers() = 2);
reset role; reset session authorization;
select pg_temp.ok('unanswered offer: buyer told; card sold: buyer told',
  (select status = 'expired' from pg_temp.off('a0000000-0000-0000-0000-000000000005', :D))
  and pg_temp.ev((pg_temp.off('a0000000-0000-0000-0000-000000000005', :D)).id) = 'new>dealer,expired>buyer'
  and (select status = 'closed' and end_reason = 'sold' from pg_temp.off('a0000000-0000-0000-0000-000000000004', :C))
  and pg_temp.ev((pg_temp.off('a0000000-0000-0000-0000-000000000004', :C)).id) like '%closed>buyer');

-- 9. emails
set session authorization authenticator; set role authenticated;
do $$ begin perform offer_notices_due(); raise notice 'FAIL offer emails list is service only';
exception when insufficient_privilege then raise notice 'PASS offer emails list is service only'; end $$;
reset role; set role service_role;
select pg_temp.ok('offer emails: addresses, amounts, card link',
  (select bool_and(case e->>'to' when 'dealer' then e->>'email' in ('a@example.test','b@example.test')
                                 else e->>'email' in ('c@example.test','d@example.test') end
                   and e->'card'->>'url' like '/c/a0000000-%' and (e->>'amount_cents')::int > 0)
     from jsonb_array_elements(offer_notices_due(200)) e)
  and (select count(*) from jsonb_array_elements(offer_notices_due(200)) e
        where e->>'kind' = 'accepted' and e->>'to' = 'buyer' and e->>'hold_expires_at' is not null) = 1);
select offer_notice_sent((e->>'event_id')::uuid) from jsonb_array_elements(offer_notices_due(200)) e;
select pg_temp.ok('each email sent once', jsonb_array_length(offer_notices_due(200)) = 0);
select pg_temp.ok('hold emails: the accepted offer''s hold is never announced as new',
  (select count(*) from jsonb_array_elements(hold_notices_due(200)) e where e->>'kind' = 'placed') = 0);

-- 10. buyer cancels an offer hold; the dealer is told
reset role; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('buyer can cancel an offer hold',
  cancel_hold((pg_temp.res('a0000000-0000-0000-0000-000000000003')).id)->>'ok' = 'true');
reset role; set role service_role;
select pg_temp.ok('dealer emailed that the buyer cancelled',
  (select count(*) = 1 from jsonb_array_elements(hold_notices_due(200)) e
    where e->>'kind' = 'ended' and e->>'to' = 'dealer' and e->>'agreed_cents' = '21000'));

-- 11. daily limit
reset role; reset session authorization;
insert into marketplace_settings (key, value) values ('max_offers_per_day', '3') on conflict (key) do update set value = '3';
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('more than the daily number of offers is refused',
  make_offer('a0000000-0000-0000-0000-000000000003', 15000, 'Alex', 'alex@x.test')->>'error' = 'offer_limit_day');
reset role; reset session authorization;
