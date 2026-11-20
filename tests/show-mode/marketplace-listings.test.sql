-- Marketplace Phase 0 (20261122120000_marketplace_listings.sql). Run with marketplace-listings.test.sh.
-- Prints PASS or FAIL per check. API calls run as session "authenticator" (like PostgREST),
-- so SECURITY DEFINER functions owned by postgres don't pass the session_user check.
\set ON_ERROR_STOP 1
alter table inventory
  add column if not exists sold_date text,
  add column if not exists sale_notes text;
alter table show_floor_transactions
  add column if not exists api_eligible boolean default true,
  add column if not exists card_title text,
  add column if not exists item_type text,
  add column if not exists client_sale_id uuid;
\i ../../supabase/migrations/20261023120000_show_mode_sales.sql
\i ../../supabase/migrations/20261122120000_marketplace_listings.sql
\i ../../supabase/migrations/20261122120000_marketplace_listings.sql
grant all on all tables in schema public to anon, authenticated, service_role;
revoke all on public.marketplace_settings from anon, authenticated;
revoke insert, update, delete on public.listing_reservations, public.listing_events from anon, authenticated;
do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then
  create role authenticator login noinherit; end if; end $$;
grant anon, authenticated, service_role to authenticator;
alter role service_role bypassrls;  -- as in Supabase

-- dealer A, dealer B, buyer C
insert into auth.users values ('aaaaaaaa-0000-0000-0000-000000000001'), ('bbbbbbbb-0000-0000-0000-000000000002'), ('cccccccc-0000-0000-0000-000000000003');
insert into sellers values ('aaaaaaaa-0000-0000-0000-000000000001', 'dealer_a'), ('bbbbbbbb-0000-0000-0000-000000000002', 'dealer_b');
insert into shows (id, name, start_date) values ('show_m', 'Market Show', '2026-11-28');
insert into inventory (id, seller_id, card_title, price, status) values
  ('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'A1', 100, 'Available'),
  ('a0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'A2', 50.25, 'Available'),
  ('a0000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'A3 no price', null, 'Available'),
  ('a0000000-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 'A4', 30, 'Available'),
  ('a0000000-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001', 'A5', 40, 'Available'),
  ('a0000000-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001', 'A6 flagged', 40, 'Available'),
  ('b0000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 'B1', 75, 'Available');
update inventory set trust_flag = 'flagged' where id = 'a0000000-0000-0000-0000-000000000006';
\set ON_ERROR_STOP 0

select case when (select count(*) from inventory where listing_status = 'draft') = 7
  and (select price_cents from inventory where id = 'a0000000-0000-0000-0000-000000000002') = 5025
  then 'PASS 1 existing cards start as draft; price_cents follows price' else 'FAIL 1' end;

set session authorization authenticator;
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';

-- 2. Direct writes to listing fields are refused, even with the price edit that rides along.
update inventory set listing_status = 'active' where id = 'a0000000-0000-0000-0000-000000000001';
update inventory set sold_channel = 'cardshow', price = 101 where id = 'a0000000-0000-0000-0000-000000000001';
insert into inventory (seller_id, card_title, listing_status) values ('aaaaaaaa-0000-0000-0000-000000000001', 'sneaky', 'active');
-- A normal dealer-app edit (no listing fields) still works.
update inventory set price = 110 where id = 'a0000000-0000-0000-0000-000000000001';
select case when (select listing_status from inventory where id = 'a0000000-0000-0000-0000-000000000001') = 'draft'
  and (select price from inventory where id = 'a0000000-0000-0000-0000-000000000001') = 110
  and not exists (select 1 from inventory where card_title = 'sneaky')
  then 'PASS 2 clients cannot write listing_status; ordinary edits still save' else 'FAIL 2' end;

-- 3. A SECURITY DEFINER function that isn't a listing function can't set it either (record_sale new item).
select public.record_sale('dddddddd-0000-0000-0000-000000000001', null,
  '{"card_title":"via record_sale","listing_status":"active","price":5}'::jsonb,
  'show_m', 5, 'Cash', null, '2026-11-28', '2:00 PM', null);
select case when not exists (select 1 from inventory where card_title = 'via record_sale' and listing_status = 'active')
  then 'PASS 3 record_sale cannot smuggle listing_status' else 'FAIL 3' end;

-- 4. Publish: skips no price, flagged, other dealer's; publishes the rest.
create temp table p as select public.publish_listings(array[
  'a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000003',
  'a0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-000000000005','a0000000-0000-0000-0000-000000000006',
  'b0000000-0000-0000-0000-000000000001']::uuid[]) j;
select case when jsonb_array_length((select j->'published' from p)) = 4
  and (select j->'skipped' from p) @> '[{"id":"a0000000-0000-0000-0000-000000000003","reason":"no_price"}]'
  and (select j->'skipped' from p) @> '[{"id":"a0000000-0000-0000-0000-000000000006","reason":"trust_flag"}]'
  and (select j->'skipped' from p) @> '[{"id":"b0000000-0000-0000-0000-000000000001","reason":"not_found"}]'
  and (select listing_status from inventory where id = 'b0000000-0000-0000-0000-000000000001') = 'draft'
  then 'PASS 4 publish_listings checks price, GTCR flag, ownership' else 'FAIL 4 ' || (select j::text from p) end;

-- 5. Dealer can't reserve own card; buyer can't reserve for someone else.
select case when public.reserve_listing('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'buy_now')->>'error' = 'own_listing'
  then 'PASS 5 dealer cannot reserve own card' else 'FAIL 5' end;
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select public.reserve_listing('a0000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 'buy_now');
select case when (select listing_status from inventory where id = 'a0000000-0000-0000-0000-000000000001') = 'active'
  then 'PASS 6 buyer cannot reserve for another account' else 'FAIL 6' end;

-- 7. All-or-none: one draft card in the set → nothing reserved.
create temp table r0 as select public.reserve_listings(array['a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000003']::uuid[],
  'cccccccc-0000-0000-0000-000000000003', 'lot') j;
select case when (select j->>'error' from r0) = 'unavailable'
  and (select j->'unavailable' from r0) = '["a0000000-0000-0000-0000-000000000003"]'
  and (select listing_status from inventory where id = 'a0000000-0000-0000-0000-000000000001') = 'active'
  and not exists (select 1 from listing_reservations)
  then 'PASS 7 reserve_listings is all or none' else 'FAIL 7 ' || (select j::text from r0) end;

-- 8. Reserve two cards in one hold.
create temp table r1 as select public.reserve_listings(array['a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002']::uuid[],
  'cccccccc-0000-0000-0000-000000000003', 'buy_now', 15) j;
select case when (select j->>'ok' from r1) = 'true'
  and (select count(*) from inventory where listing_status = 'reserved' and reserved_by = 'cccccccc-0000-0000-0000-000000000003'
         and reservation_id = (select (j->>'reservation_id')::uuid from r1)) = 2
  and (select count(*) from listing_events where action = 'reserved') = 2
  and (select count(*) from listing_reservations) = 1
  then 'PASS 8 reserve_listings holds both cards under one reservation, logged' else 'FAIL 8 ' || (select j::text from r1) end;

-- 9. A second reservation of a held card fails.
select case when public.reserve_listing('a0000000-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000003', 'buy_now')->>'error' = 'unavailable'
  then 'PASS 9 held card cannot be reserved again' else 'FAIL 9' end;

-- 10. Buyer reads own reservation; dealer B sees nothing; buyer can't write the table.
select case when (select count(*) from listing_reservations) = 1 then 'PASS 10a buyer sees own reservation' else 'FAIL 10a' end;
update listing_reservations set expires_at = now() + interval '1 year';
select case when (select expires_at < now() + interval '1 hour' from listing_reservations limit 1)
  then 'PASS 10b buyer cannot extend a hold' else 'FAIL 10b' end;
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
select case when (select count(*) from listing_reservations) = 0 and (select count(*) from listing_events) = 0
  then 'PASS 10c other dealer sees no reservations or events' else 'FAIL 10c' end;
select public.release_listing((select (j->>'reservation_id')::uuid from r1));
select case when (select count(*) from inventory where listing_status = 'reserved') = 2
  then 'PASS 10d other dealer cannot release it' else 'FAIL 10d' end;

-- 11. Dealer A releases (declines) → both cards back to active.
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select public.release_listing((select (j->>'reservation_id')::uuid from r1), 'declined');
select case when (select count(*) from inventory where listing_status = 'reserved') = 0
  and (select count(*) from inventory where listing_status = 'active' and reservation_id is null) = 4
  and (select status from listing_reservations) = 'released'
  then 'PASS 11 dealer release returns cards to active' else 'FAIL 11' end;

-- 12. Reservation cap: limit 3 cards per buyer.
reset role; reset session authorization;
update marketplace_settings set value = '3' where key = 'max_reserved_cards_per_buyer';
set session authorization authenticator; set role authenticated;
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
create temp table r2 as select public.reserve_listings(array['a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002']::uuid[],
  'cccccccc-0000-0000-0000-000000000003', 'buy_now') j;
select j->>'reservation_id' as r2id from r2 \gset
select case when public.reserve_listings(array['a0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-000000000005']::uuid[],
  'cccccccc-0000-0000-0000-000000000003', 'buy_now')->>'error' = 'reservation_limit'
  and (select listing_status from inventory where id = 'a0000000-0000-0000-0000-000000000004') = 'active'
  then 'PASS 12 per-buyer reservation cap' else 'FAIL 12' end;

-- 13. In-person sale of a held card (existing dealer app path) wins: sold, hold broken, logged.
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
update inventory set status = 'Sold', sold_price = 95, payment_method = 'Cash' where id = 'a0000000-0000-0000-0000-000000000001';
select case when (select listing_status || '/' || sold_channel || '/' || coalesce(reservation_id::text, 'none')
                  from inventory where id = 'a0000000-0000-0000-0000-000000000001') = 'sold/in_person/none'
  and (select status from listing_reservations where id = :'r2id'::uuid) = 'broken'
  and exists (select 1 from listing_events where action = 'reservation_broken' and listing_id = 'a0000000-0000-0000-0000-000000000001')
  then 'PASS 13 table sale of a held card marks it sold and breaks the hold' else 'FAIL 13' end;

-- 14. Undo that sale → listing back to active (the broken hold isn't restored).
update inventory set status = 'Available', sold_price = null where id = 'a0000000-0000-0000-0000-000000000001';
select case when (select listing_status || '/' || coalesce(sold_channel, '-') from inventory where id = 'a0000000-0000-0000-0000-000000000001') = 'active/-'
  then 'PASS 14 undoing the sale relists the card' else 'FAIL 14' end;

-- 15. A2 is still in the broken hold's card list but no longer reserved to it? (it is: only A1 sold)
select case when (select listing_status from inventory where id = 'a0000000-0000-0000-0000-000000000002') = 'reserved'
  then 'PASS 15 the other card in the broken hold stays held' else 'FAIL 15' end;

-- 16. mark_sold by the service role needs the matching reservation.
reset role; set role service_role;
set request.jwt.claim.sub = '';
select case when public.mark_sold(array['a0000000-0000-0000-0000-000000000002']::uuid[], 'cardshow')->>'error' = 'unavailable'
  then 'PASS 16a mark_sold refuses a held card without its reservation' else 'FAIL 16a' end;
-- The broken reservation can't be used either.
select case when public.mark_sold(array['a0000000-0000-0000-0000-000000000002']::uuid[], 'cardshow',
                                   :'r2id'::uuid)->>'error' = 'reservation_broken'
  then 'PASS 16b mark_sold refuses a broken reservation' else 'FAIL 16b' end;
-- Release A2 via the expiry sweep: force it to expire.
reset role; reset session authorization;
update listing_reservations set expires_at = now() - interval '1 minute', status = 'active' where id = :'r2id'::uuid;
set session authorization authenticator;
set role authenticated;
select public.expire_listing_reservations();
reset role; set role service_role;
select public.expire_listing_reservations() as expired_n \gset
select case when :expired_n = 1
  and (select listing_status from inventory where id = 'a0000000-0000-0000-0000-000000000002') = 'active'
  and (select status from listing_reservations where id = :'r2id'::uuid) = 'expired'
  then 'PASS 17 expiry sweep (service role only) returns held cards' else 'FAIL 17' end;

-- 18. Service role reserves for buyer C (agent actor) and sells through the reservation.
create temp table r3 as select public.reserve_listings(array['a0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-000000000005']::uuid[],
  'cccccccc-0000-0000-0000-000000000003', 'checkout', 15, 'external_agent') j;
select j->>'reservation_id' as r3id from r3 \gset
select public.mark_sold(array['a0000000-0000-0000-0000-000000000004']::uuid[], 'cardshow', :'r3id'::uuid);
select case when (select listing_status || '/' || status || '/' || sold_channel from inventory where id = 'a0000000-0000-0000-0000-000000000004') = 'sold/Sold/cardshow'
  and (select listing_status from inventory where id = 'a0000000-0000-0000-0000-000000000005') = 'active'
  and (select status || '/' || actor_type from listing_reservations where id = :'r3id'::uuid) = 'converted/external_agent'
  then 'PASS 18 mark_sold through a reservation; unsold card in the hold goes back on sale' else 'FAIL 18' end;
select case when public.mark_sold(array['a0000000-0000-0000-0000-000000000004']::uuid[], 'ebay')->>'error' = 'unavailable'
  then 'PASS 19 a sold card cannot be sold again' else 'FAIL 19' end;

-- 20. Undoing a marketplace sale in the dealer app does not relist it.
reset role; set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
update inventory set status = 'Available' where id = 'a0000000-0000-0000-0000-000000000004';
select case when (select listing_status from inventory where id = 'a0000000-0000-0000-0000-000000000004') = 'delisted'
  then 'PASS 20 undoing a marketplace sale delists instead of relisting' else 'FAIL 20' end;

-- 21. GTCR flag on an active listing delists it; publish then refuses it.
reset role; set role service_role;
update inventory set trust_flag = 'flagged' where id = 'a0000000-0000-0000-0000-000000000005';
select case when (select listing_status from inventory where id = 'a0000000-0000-0000-0000-000000000005') = 'delisted'
  then 'PASS 21 stolen/lost flag takes an active listing down' else 'FAIL 21' end;

-- 22. Delist: dealer can delist active; can't delist a held card.
reset role; set role authenticated;
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
create temp table r4 as select public.reserve_listing('a0000000-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000003', 'local_pickup', 99999) j;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
create temp table d as select public.delist_listings(array['a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002']::uuid[]) j;
select case when (select j->'delisted' from d) = '["a0000000-0000-0000-0000-000000000001"]'
  and (select j->'skipped' from d) @> '[{"id":"a0000000-0000-0000-0000-000000000002","reason":"reserved"}]'
  and (select reserved_until <= now() + interval '7 days 1 minute' from inventory where id = 'a0000000-0000-0000-0000-000000000002')
  then 'PASS 22 delist skips held cards; hold length capped at 7 days' else 'FAIL 22 ' || (select j::text from d) end;

-- 23. Anon can't call any of it.
reset role; set role anon;
select public.reserve_listing('a0000000-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000003', 'buy_now');
select public.publish_listings(array['a0000000-0000-0000-0000-000000000002']::uuid[]);
reset role; reset session authorization;
select case when (select count(*) from listing_reservations) = 4 then 'PASS 23 anon refused (errors above expected)' else 'FAIL 23 ' || (select count(*) from listing_reservations)::text end;

-- ── Follow-up 20261123120000_marketplace_sold_on_insert.sql ──
-- A card created sold before the fix stays draft (the bug), then the migration backfills it.
insert into inventory (id, seller_id, card_title, price, status) values
  ('a0000000-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000001', 'Old manual sale', 10, 'Sold');
select case when (select listing_status from inventory where id = 'a0000000-0000-0000-0000-000000000009') = 'draft'
  then 'PASS 25 before the fix, a card created sold stays draft' else 'FAIL 25' end;
\i ../../supabase/migrations/20261123120000_marketplace_sold_on_insert.sql
\i ../../supabase/migrations/20261123120000_marketplace_sold_on_insert.sql
select case when (select listing_status || '/' || sold_channel || '/' || listing_status_before_sale
                  from inventory where id = 'a0000000-0000-0000-0000-000000000009') = 'sold/in_person/draft'
  and not exists (select 1 from inventory where status = 'Sold' and listing_status = 'draft')
  then 'PASS 26 backfill marks every Sold card sold' else 'FAIL 26' end;

set session authorization authenticator; set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
-- Log a Manual Sale path: insert with status Sold.
insert into inventory (id, seller_id, card_title, price, status) values
  ('a0000000-0000-0000-0000-000000000010', 'aaaaaaaa-0000-0000-0000-000000000001', 'Manual sale', 0, 'Sold');
select case when (select listing_status || '/' || sold_channel from inventory where id = 'a0000000-0000-0000-0000-000000000010') = 'sold/in_person'
  then 'PASS 27 manual sale (card inserted sold) is marked sold' else 'FAIL 27' end;
-- Show Mode "Log a sale": record_sale with a new item.
select public.record_sale('dddddddd-0000-0000-0000-000000000002', null,
  '{"id":"a0000000-0000-0000-0000-000000000011","card_title":"Show Mode logged sale","price":25}'::jsonb,
  'show_m', 25, 'Cash', null, '2026-11-28', '2:10 PM', null);
select case when (select listing_status || '/' || status from inventory where id = 'a0000000-0000-0000-0000-000000000011') = 'sold/Sold'
  then 'PASS 28 Show Mode logged sale (record_sale new item) is marked sold' else 'FAIL 28' end;
-- Undo it: back to draft, never onto the marketplace.
select public.void_sale('dddddddd-0000-0000-0000-000000000002');
select case when (select listing_status || '/' || status from inventory where id = 'a0000000-0000-0000-0000-000000000011') = 'draft/Available'
  then 'PASS 29 undoing a logged sale returns the card to draft' else 'FAIL 29' end;
-- An ordinary unsold insert is still draft, and a client still can't insert as sold-listed.
insert into inventory (seller_id, card_title, price, status, listing_status) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'sneaky2', 5, 'Available', 'sold');
select case when not exists (select 1 from inventory where card_title = 'sneaky2')
  then 'PASS 30 guard still refuses a client-set listing_status (error above expected)' else 'FAIL 30' end;
reset role; reset session authorization;
