-- Dealer offer rules (20261211120000_marketplace_offer_rules.sql). Run with marketplace-offer-rules.test.sh.
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

-- dealer A's rule-test cards: R1..R12, $100 each (R5 $200), all listed
insert into inventory (id, seller_id, card_title, player, year, card_set, price, status, category, subcategory)
select ('e0000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'aaaaaaaa-0000-0000-0000-000000000001',
       'Rule card ' || n, 'Player ' || n, 2024, 'Prizm', case when n = 5 then 200 else 100 end, 'Available', 'Sports', 'Football'
  from generate_series(1, 13) n;
insert into card_captures (id, seller_id, entry_point, crop_key, uploaded_at)
select ('f' || substr(id::text, 2))::uuid, seller_id, 'case_scan', 'k/' || id || '/crop.jpg', now() from inventory where card_title like 'Rule card %';
update inventory set primary_capture_id = ('f' || substr(id::text, 2))::uuid where card_title like 'Rule card %';
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select (publish_listings(array(select id from inventory where card_title like 'Rule card %'))->>'published') is not null;
reset role; reset session authorization;
create or replace function pg_temp.r(n int) returns uuid language sql as $$
  select ('e0000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid $$;
create or replace function pg_temp.o(n int, p_buyer uuid) returns public.offers language sql as $$
  select o.* from public.offers o where pg_temp.r(n) = any(o.listing_ids) and o.buyer_id = p_buyer order by created_at desc limit 1 $$;
create or replace function pg_temp.last_log(p public.offers) returns jsonb language sql as $$
  select p.auto_log -> (jsonb_array_length(p.auto_log) - 1) $$;
\set A '''aaaaaaaa-0000-0000-0000-000000000001'''

-- 1. saving the rules
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok('bad percentages refused', set_offer_rules(0, 'asking', null, null, false)->>'error' = 'bad_pct'
  and set_offer_rules(null, 'asking', null, 100, false)->>'error' = 'bad_pct');
select pg_temp.ok('counter must sit between decline and accept',
  set_offer_rules(80, 'asking', 96, 95, false)->>'error' = 'bad_order'
  and set_offer_rules(80, 'asking', 75, 95, false)->>'error' = 'bad_order'
  and set_offer_rules(95, 'asking', null, 90, false)->>'error' = 'bad_order'
  and set_offer_rules(null, 'ebay', null, null, false)->>'error' = 'bad_basis');
select pg_temp.ok('decline on the comp isn''t compared with accept on asking', set_offer_rules(95, 'comp', null, 90, false)->>'ok' = 'true');
select pg_temp.ok('rules saved: decline under 80%, counter at 90%, accept at 95%',
  set_offer_rules(80, 'asking', 90, 95, false) @> '{"ok":true,"rules":{"decline_below_pct":80,"counter_pct":90,"accept_at_pct":95}}');
select pg_temp.ok('dealer reads their own rules', (select count(*) = 1 and max(accept_at_pct) = 95 from dealer_offer_rules));
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
select pg_temp.ok('another dealer can''t read them', (select count(*) = 0 from dealer_offer_rules));
set request.jwt.claim.sub = 'dddddddd-0000-0000-0000-000000000004';
select pg_temp.ok('a buyer (no seller account) can''t save rules', set_offer_rules(80, 'asking', null, null, false)->>'error' = 'not_a_seller');
select pg_temp.ok('no writes to the table', not has_table_privilege('authenticated', 'public.dealer_offer_rules', 'INSERT,UPDATE,DELETE'));
reset role; reset session authorization;
select pg_temp.ok('anon can''t save rules', not has_function_privilege('anon', 'public.set_offer_rules(numeric, text, numeric, numeric, boolean)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public._offer_auto(uuid, text)', 'EXECUTE'));

-- 2. decline, counter, accept by the rules
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('$70 on a $100 card (under 80%): declined at once', make_offer(pg_temp.r(1), 7000, 'Cal', 'c@x.test') @> '{"status":"declined","auto":true}');
reset role; reset session authorization;
select pg_temp.ok('decline logged: rule 80% of asking, line $80; dealer not emailed',
  pg_temp.last_log(pg_temp.o(1, :C)) @> '{"action":"decline","rule":"rule_decline","rule_pct":80,"basis":"asking","threshold_cents":8000,"pct_of_asking":70}'
  and pg_temp.ev((pg_temp.o(1, :C)).id) is null and (pg_temp.o(1, :C)).decided_by = 'auto');
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('$85 (between): countered at $90 at once',
  make_offer(pg_temp.r(1), 8500, 'Cal', 'c@x.test') @> '{"status":"countered","auto":true,"amount_cents":9000}');
reset role; reset session authorization;
select pg_temp.ok('counter recorded as the dealer''s move, buyer emailed, logged',
  (select status = 'countered' and last_by = 'dealer' and moves = 2 and amount_cents = 9000 and (history->1->>'auto')::boolean
     from pg_temp.o(1, :C))
  and pg_temp.ev((pg_temp.o(1, :C)).id) = 'countered>buyer'
  and pg_temp.last_log(pg_temp.o(1, :C)) @> '{"action":"counter","rule":"rule_counter","rule_pct":90,"counter_cents":9000,"cents":8500}');
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('buyer sees the counter in my_offers, without the dealer''s log',
  (select e->>'status' = 'countered' and e->>'amount_cents' = '9000' and not (e ? 'auto_log')
     from jsonb_array_elements(my_offers()) e where e->>'id' = (pg_temp.o(1, :C)).id::text));
select pg_temp.ok('buyer accepts the automatic counter', buyer_respond_offer((pg_temp.o(1, :C)).id, 'accept') @> '{"status":"accepted","agreed_cents":9000}');
select pg_temp.ok('$96 (95%+): accepted at once', make_offer(pg_temp.r(2), 9600, 'Cal', 'c@x.test') @> '{"status":"accepted","agreed_cents":9600}');
select pg_temp.ok('full price ($100): accepted at once', make_offer(pg_temp.r(6), 10000, 'Cal', 'c@x.test') @> '{"status":"accepted"}');
reset role; reset session authorization;
select pg_temp.ok('accept logged with the rule; full price logged as full price',
  pg_temp.last_log(pg_temp.o(2, :C)) @> '{"action":"accept","rule":"rule_accept","rule_pct":95,"threshold_cents":9500,"pct_of_asking":96}'
  and pg_temp.last_log(pg_temp.o(6, :C)) @> '{"action":"accept","rule":"full_price"}'
  and (pg_temp.o(2, :C)).decided_by = 'auto'
  and (select listing_status = 'reserved' and reserved_by = :C from inventory where id = pg_temp.r(2)));
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok('dealer_offers carries the automatic decisions',
  (select jsonb_array_length(e->'auto_log') = 1 and e->'auto_log'->0->>'action' = 'accept'
     from jsonb_array_elements(dealer_offers()) e where e->>'id' = (pg_temp.o(2, :C)).id::text));
reset role; reset session authorization;

-- 3. a card's own prices win; a card can opt out
update inventory set auto_accept_cents = 8800 where id in (pg_temp.r(3), pg_temp.r(13));
update inventory set use_offer_rules = false where id in (pg_temp.r(3), pg_temp.r(4));
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('card auto-accept $88 under the 90% counter: $85 is countered at $88, not $90',
  make_offer(pg_temp.r(13), 8500, 'Cal', 'c@x.test') @> '{"status":"countered","amount_cents":8800}');
select pg_temp.ok('card opted out of the rules: $85 waits for the dealer', make_offer(pg_temp.r(3), 8500, 'Cal', 'c@x.test')->>'status' = 'pending');
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select respond_offer((pg_temp.o(3, :C)).id, 'counter', 9200)->>'status' = 'countered';
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('buyer counters $89 (over the card''s own $88, which works without rules): accepted at once',
  buyer_respond_offer((pg_temp.o(3, :C)).id, 'counter', 8900) @> '{"status":"accepted","agreed_cents":8900}');
select pg_temp.ok('card opted out, no card prices: $60 waits for the dealer', make_offer(pg_temp.r(4), 6000, 'Cal', 'c@x.test')->>'status' = 'pending');
reset role; reset session authorization;
select pg_temp.ok('card auto-accept logged as the card''s price; opted-out card has no log, dealer told',
  pg_temp.last_log(pg_temp.o(3, :C)) @> '{"action":"accept","rule":"card_auto","threshold_cents":8800}'
  and not (pg_temp.last_log(pg_temp.o(3, :C)) ? 'rule_pct')
  and (pg_temp.o(4, :C)).auto_log = '[]'::jsonb and pg_temp.ev((pg_temp.o(4, :C)).id) = 'new>dealer');

-- 4. at a show: nothing accepted or countered automatically
insert into shows (id, name, start_date, end_date, city, state, listed) values ('show_today', 'Today Show', current_date - 1, current_date + 1, 'Reno', 'NV', true);
insert into show_sellers values ('show_today', 'aaaaaaaa-0000-0000-0000-000000000001', '3');
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select set_offer_rules(80, 'asking', 90, 95, true)->>'ok' = 'true';
set request.jwt.claim.sub = 'dddddddd-0000-0000-0000-000000000004';
select pg_temp.ok('at a show: full price waits for the dealer', make_offer(pg_temp.r(7), 10000, 'Dee', 'd@x.test')->>'status' = 'pending');
select pg_temp.ok('at a show: declines still happen', make_offer(pg_temp.r(8), 5000, 'Dee', 'd@x.test')->>'status' = 'declined');
select pg_temp.ok('at a show: the counter waits too', make_offer(pg_temp.r(9), 8500, 'Dee', 'd@x.test')->>'status' = 'pending');
reset role; reset session authorization;
select pg_temp.ok('logged as left for the dealer, with what the rule would have done',
  pg_temp.last_log(pg_temp.o(7, :D)) @> '{"action":"left_for_you","would":"accept","rule":"at_show"}'
  and pg_temp.last_log(pg_temp.o(9, :D)) @> '{"action":"left_for_you","would":"counter","counter_cents":9000}'
  and pg_temp.ev((pg_temp.o(7, :D)).id) = 'new>dealer'
  and (select listing_status = 'active' from inventory where id = pg_temp.r(7)));
update shows set start_date = current_date + 10, end_date = current_date + 11 where id = 'show_today';
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok('a show that isn''t today doesn''t count; dealer still answers by hand',
  respond_offer((pg_temp.o(7, :D)).id, 'accept')->>'status' = 'accepted');

-- 5. decline on the online comp
select set_offer_rules(80, 'comp', null, null, false)->>'ok' = 'true';
reset role; reset session authorization;
update inventory set comp_value_cents = 12000, pricing_match_status = 'manual' where id = pg_temp.r(10);
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('comp $120, rule 80%: $90 (90% of asking) is declined',
  make_offer(pg_temp.r(10), 9000, 'Cal', 'c@x.test')->>'status' = 'declined'
  and pg_temp.last_log(pg_temp.o(10, :C)) @> '{"basis":"comp","threshold_cents":9600}');
reset role; reset session authorization;
update inventory set pricing_match_status = 'review' where id = pg_temp.r(10);
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('a comp still being checked isn''t used: $90 waits for the dealer',
  make_offer(pg_temp.r(10), 9000, 'Cal', 'c@x.test')->>'status' = 'pending');

-- 6. bundles: each card's lines added up
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select set_offer_rules(80, 'asking', 90, 95, false)->>'ok' = 'true';
set request.jwt.claim.sub = 'dddddddd-0000-0000-0000-000000000004';
select pg_temp.ok('bundle $300 asking: $230 declined (under $240)',
  make_bundle_offer(array[pg_temp.r(5), pg_temp.r(11)], 23000, 'Dee', 'd@x.test')->>'status' = 'declined');
select pg_temp.ok('bundle $255: countered at $270',
  make_bundle_offer(array[pg_temp.r(5), pg_temp.r(11)], 25500, 'Dee', 'd@x.test') @> '{"status":"countered","amount_cents":27000}');
reset role; reset session authorization;
update inventory set use_offer_rules = false where id = pg_temp.r(12);
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'dddddddd-0000-0000-0000-000000000004';
select pg_temp.ok('a bundle with an opted-out card isn''t countered automatically',
  make_bundle_offer(array[pg_temp.r(4), pg_temp.r(12)], 17000, 'Dee', 'd@x.test')->>'status' = 'pending');
reset role; reset session authorization;

-- 7. dealers without rules: unchanged
set session authorization authenticator; set role authenticated; set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.ok('dealer B has no rules: a low offer waits for them', make_offer(:A5, 30000, 'Cal', 'c@x.test')->>'status' = 'pending');
reset role; reset session authorization;
