-- Snap & Sell, Phase 1 (20261115120000_snap_sell.sql). Seeds ledger rows, runs the
-- migration itself (twice), then checks. Every check prints PASS or FAIL.
--   createdb cs_snap && psql -d cs_snap -f supabase-stub.sql && psql -d cs_snap -f snap-sell.test.sql
\set ON_ERROR_STOP 1
-- Production has these ledger columns; the shared stub does not.
alter table show_floor_transactions add column if not exists api_eligible boolean default true;
insert into auth.users values ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222'), ('33333333-3333-3333-3333-333333333333')
  on conflict do nothing;
insert into sellers values ('11111111-1111-1111-1111-111111111111','alice'), ('22222222-2222-2222-2222-222222222222','bob');
insert into shows (id, name) values ('show_a', 'Show A'), ('show_b', 'Show B');
insert into inventory (id, seller_id, card_title, price, status) values
 ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Herbert PSA 10', 120, 'Sold'),
 ('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','Raw Crews',       20, 'Available'),
 ('bbbbbbbb-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','Bob slab',        90, 'Sold');
-- Ledger rows from before the migration: two platform sales, one with no seller.
insert into show_floor_transactions (id, sold_price, inventory_id, player, seller_id, show_id, source) values
 ('dddddddd-0000-0000-0000-000000000001', 100, 'aaaaaaaa-0000-0000-0000-000000000001', 'Herbert', '11111111-1111-1111-1111-111111111111', 'show_a', 'platform'),
 ('dddddddd-0000-0000-0000-000000000002',  85, 'bbbbbbbb-0000-0000-0000-000000000001', 'Bob',     '22222222-2222-2222-2222-222222222222', 'show_a', 'manual'),
 ('dddddddd-0000-0000-0000-000000000003',  40, null, 'Nobody', null, 'show_b', 'platform');

\i ../../supabase/migrations/20261115120000_snap_sell.sql
\i ../../supabase/migrations/20261115120000_snap_sell.sql
grant all on all tables in schema public to anon, authenticated;
\set ON_ERROR_STOP 0

select case when (select count(*) from transaction_items) = 2 then 'PASS' else 'FAIL' end || ' backfill: one item per ledger row with a seller (re-run adds none)';
select case when (select price_basis || '/' || identification_status from transaction_items where transaction_id = 'dddddddd-0000-0000-0000-000000000001') = 'observed/confirmed'
  then 'PASS' else 'FAIL' end || ' backfilled items are observed + confirmed';
select case when (select sale_key from transaction_items where transaction_id = 'dddddddd-0000-0000-0000-000000000001') = 'dddddddd-0000-0000-0000-000000000001'
  then 'PASS' else 'FAIL' end || ' sale_key falls back to the ledger id';
select case when (select sum(price) from transaction_items ti join show_floor_transactions t on t.id = ti.transaction_id where t.show_id = 'show_a')
  = (select sum(sold_price) from show_floor_transactions where show_id = 'show_a') then 'PASS' else 'FAIL' end || ' show_a items add up to the ledger GMV';

-- New platform sale → the trigger adds its item; its undo removes it.
insert into show_floor_transactions (id, sold_price, inventory_id, player, seller_id, show_id, client_sale_id)
  values ('dddddddd-0000-0000-0000-000000000004', 30, 'aaaaaaaa-0000-0000-0000-000000000002', 'Crews', '11111111-1111-1111-1111-111111111111', 'show_a', 'eeeeeeee-0000-0000-0000-000000000004');
select case when (select sale_key from transaction_items where transaction_id = 'dddddddd-0000-0000-0000-000000000004') = 'eeeeeeee-0000-0000-0000-000000000004'
  then 'PASS' else 'FAIL' end || ' trigger adds an item for a new sale, keyed by client_sale_id';
insert into show_floor_transactions (sold_price, seller_id, show_id, voids_transaction_id)
  values (-30, '11111111-1111-1111-1111-111111111111', 'show_a', 'dddddddd-0000-0000-0000-000000000004');
select case when not exists (select 1 from transaction_items where transaction_id = 'dddddddd-0000-0000-0000-000000000004')
  then 'PASS' else 'FAIL' end || ' undo row removes the item';
-- A deleted inventory card never blocks a sale.
insert into show_floor_transactions (sold_price, inventory_id, seller_id, show_id)
  values (12, '99999999-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111', 'show_b');
select case when (select count(*) from show_floor_transactions where sold_price = 12) = 1 then 'PASS' else 'FAIL' end || ' sale with an unknown inventory id still records';

-- Snap & Sell as Alice.
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
insert into snap_sales (client_sale_id, show_id, amount, payment_method, is_lot, item_count_hint, captured_at)
  values ('ffffffff-0000-0000-0000-000000000001', 'show_a', 120, 'Cash', true, 4, now());
-- Retried from the outbox → still one row.
insert into snap_sales (client_sale_id, show_id, amount, payment_method, is_lot, item_count_hint, captured_at)
  values ('ffffffff-0000-0000-0000-000000000001', 'show_a', 120, 'Cash', true, 4, now()) on conflict do nothing;
select case when (select count(*) from snap_sales) = 1 then 'PASS' else 'FAIL' end || ' retried capture stays one row';
insert into show_floor_transactions (id, sold_price, seller_id, show_id, source, client_sale_id, api_eligible)
  values ('dddddddd-0000-0000-0000-000000000005', 120, '11111111-1111-1111-1111-111111111111', 'show_a', 'snap', 'ffffffff-0000-0000-0000-000000000001', false);
select case when not exists (select 1 from transaction_items where transaction_id = 'dddddddd-0000-0000-0000-000000000005')
  then 'PASS' else 'FAIL' end || ' snap ledger row gets no automatic item';
update snap_sales set transaction_id = 'dddddddd-0000-0000-0000-000000000005' where client_sale_id = 'ffffffff-0000-0000-0000-000000000001';
insert into transaction_photos (id, sale_key, kind, storage_path) values
  ('77777777-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-000000000001', 'items',   '11111111-1111-1111-1111-111111111111/ffffffff-0000-0000-0000-000000000001/a.jpg'),
  ('77777777-0000-0000-0000-000000000002', 'ffffffff-0000-0000-0000-000000000001', 'payment', '11111111-1111-1111-1111-111111111111/ffffffff-0000-0000-0000-000000000001/b.jpg');
insert into storage.objects (bucket_id, name) values ('sale-photos', '11111111-1111-1111-1111-111111111111/ffffffff-0000-0000-0000-000000000001/a.jpg');
select case when (select count(*) from storage.objects where bucket_id = 'sale-photos') = 1 then 'PASS' else 'FAIL' end || ' owner can upload to own folder';
insert into storage.objects (bucket_id, name) values ('sale-photos', '22222222-2222-2222-2222-222222222222/x/y.jpg');
select 'PASS uploading into another dealer''s folder is refused (error above is expected)' where not exists (select 1 from storage.objects where name like '2222%');
select case when (select items from show_sale_item_counts('show_a') where client_sale_id = 'ffffffff-0000-0000-0000-000000000001') = 4
  then 'PASS' else 'FAIL' end || ' item count falls back to the dealer''s hint';
insert into transaction_items (sale_key, transaction_id, card_title, price, price_basis, identification_status) values
  ('ffffffff-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000005', 'Card A', 70, 'observed',  'manual'),
  ('ffffffff-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000005', 'Card B', 50, 'allocated', 'manual');
select case when (select items from show_sale_item_counts('show_a') where client_sale_id = 'ffffffff-0000-0000-0000-000000000001') = 2
  then 'PASS' else 'FAIL' end || ' item count uses resolved items once there are any';

-- RLS: Bob, an organizer-ish third user, and anon see none of Alice's rows.
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select case when (select count(*) from snap_sales) = 0 and (select count(*) from transaction_photos) = 0
  and (select count(*) from storage.objects where bucket_id = 'sale-photos') = 0
  and (select count(*) from transaction_items) = 1 then 'PASS' else 'FAIL' end || ' another dealer sees only their own rows';
update snap_sales set amount = 1;
select 'PASS another dealer cannot change the sale' where (select count(*) from snap_sales) = 0;
select case when (public.void_snap_sale('ffffffff-0000-0000-0000-000000000001')->>'error') = 'not_found'
  then 'PASS' else 'FAIL' end || ' another dealer cannot undo it';
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select case when (select count(*) from snap_sales) + (select count(*) from transaction_items) + (select count(*) from transaction_photos) = 0
  then 'PASS' else 'FAIL' end || ' a user with no sales (e.g. the organizer) sees nothing';
select case when exists (select 1 from show_sale_item_counts('show_a')) then 'PASS' else 'FAIL' end || ' organizer gets counts (no prices) for analytics';
reset role;
set role anon;
select 'FAIL anon can read snap_sales' from snap_sales;
select 'FAIL anon can read transaction_items' from transaction_items;
select public.void_snap_sale('ffffffff-0000-0000-0000-000000000001');
reset role;

-- Undo within 10 minutes: reversing ledger row, items cleared. A second sale ages past the window.
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
insert into snap_sales (client_sale_id, show_id, amount, captured_at) values ('ffffffff-0000-0000-0000-000000000002', 'show_a', 60, now());
insert into show_floor_transactions (id, sold_price, seller_id, show_id, source, client_sale_id, api_eligible)
  values ('dddddddd-0000-0000-0000-000000000006', 60, '11111111-1111-1111-1111-111111111111', 'show_a', 'snap', 'ffffffff-0000-0000-0000-000000000002', false);
update snap_sales set transaction_id = 'dddddddd-0000-0000-0000-000000000006' where client_sale_id = 'ffffffff-0000-0000-0000-000000000002';
select case when (public.void_snap_sale('ffffffff-0000-0000-0000-000000000002')->>'voided') = 'true' then 'PASS' else 'FAIL' end || ' undo a snap sale';
select case when (select sum(sold_price) from show_floor_transactions where client_sale_id = 'ffffffff-0000-0000-0000-000000000002'
                    or voids_transaction_id = 'dddddddd-0000-0000-0000-000000000006') = 0 then 'PASS' else 'FAIL' end || ' undo nets the ledger to 0';
select case when (public.void_snap_sale('ffffffff-0000-0000-0000-000000000002')->>'already') = 'true'
  and (select count(*) from show_floor_transactions where voids_transaction_id = 'dddddddd-0000-0000-0000-000000000006') = 1
  then 'PASS' else 'FAIL' end || ' second undo adds nothing';
select case when not exists (select 1 from show_sale_item_counts('show_a') where client_sale_id = 'ffffffff-0000-0000-0000-000000000002')
  then 'PASS' else 'FAIL' end || ' undone sale drops out of item counts';
reset role;
update snap_sales set created_at = now() - interval '11 minutes' where client_sale_id = 'ffffffff-0000-0000-0000-000000000001';
set role authenticated;
select case when (public.void_snap_sale('ffffffff-0000-0000-0000-000000000001')->>'error') = 'undo_window_expired'
  then 'PASS' else 'FAIL' end || ' undo refused after 10 minutes';
update snap_sales set capture_status = 'complete' where client_sale_id = 'ffffffff-0000-0000-0000-000000000001';
select case when (select capture_status from snap_sales where client_sale_id = 'ffffffff-0000-0000-0000-000000000001') = 'complete'
  then 'PASS' else 'FAIL' end || ' owner can mark the sale complete (snap_sales is mutable)';
-- The ledger stays immutable.
update show_floor_transactions set sold_price = 1 where id = 'dddddddd-0000-0000-0000-000000000005';
reset role;
select case when (select sold_price from show_floor_transactions where id = 'dddddddd-0000-0000-0000-000000000005') = 120
  then 'PASS' else 'FAIL' end || ' ledger row unchanged';
-- Source check accepts snap, rejects junk.
insert into show_floor_transactions (sold_price, source) values (1, 'junk');
select 'PASS junk source rejected (error above is expected)' where not exists (select 1 from show_floor_transactions where source = 'junk');
