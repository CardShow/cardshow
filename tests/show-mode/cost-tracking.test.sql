-- Cost Tracking & Stock Codes (20261114120000_cost_tracking.sql). Runs the migration
-- itself (twice). Every check prints PASS or FAIL.
--   createdb cs_cost && psql -d cs_cost -f supabase-stub.sql && psql -d cs_cost -f cost-tracking.test.sql
\set ON_ERROR_STOP 1
\i ../../supabase/migrations/20261114120000_cost_tracking.sql
\i ../../supabase/migrations/20261114120000_cost_tracking.sql
-- Supabase grants table access to anon/authenticated by default; RLS is what guards rows.
grant all on all tables in schema public to anon, authenticated;
\set ON_ERROR_STOP 0

insert into auth.users values ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222'), ('33333333-3333-3333-3333-333333333333')
  on conflict do nothing;
insert into sellers values ('11111111-1111-1111-1111-111111111111','alice'), ('22222222-2222-2222-2222-222222222222','bob');
insert into inventory (id, seller_id, card_title, grade, item_type, price) values
 ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Herbert PSA 10', 10,   'card',   120),
 ('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','Raw Crews',      null, 'card',   20),
 ('aaaaaaaa-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','Blaster',        null, 'sealed', 30),
 ('aaaaaaaa-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','Rookie lot',     null, 'lot',    50),
 ('aaaaaaaa-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','Second slab',    9.5,  'card',   80),
 ('aaaaaaaa-0000-0000-0000-000000000006','11111111-1111-1111-1111-111111111111','Custom first',   9,    'card',   80),
 ('bbbbbbbb-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','Bob slab',       10,   'card',   90);

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- A hand-typed S-2 must be skipped by the auto numbering.
select case when (public.set_stock_code('aaaaaaaa-0000-0000-0000-000000000006','S-2')->>'ok') = 'true' then 'PASS' else 'FAIL' end || ' set custom code S-2';
select public.assign_stock_codes(array['aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000002',
  'aaaaaaaa-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000004','aaaaaaaa-0000-0000-0000-000000000005',
  'bbbbbbbb-0000-0000-0000-000000000001']::uuid[]) \gset assign_
select case when (select string_agg(card_title || '=' || stock_code, ',' order by id) from inventory where seller_id = auth.uid())
  = 'Herbert PSA 10=S-1,Raw Crews=R-1,Blaster=B-1,Rookie lot=L-1,Second slab=S-3,Custom first=S-2'
  then 'PASS' else 'FAIL' end || ' prefixes S/R/B/L, in order, skipping the hand-typed S-2';
select case when (select stock_code from inventory where id = 'bbbbbbbb-0000-0000-0000-000000000001') is null
  then 'PASS' else 'FAIL' end || ' cannot code another seller''s card';
select case when jsonb_array_length(public.assign_stock_codes(array['aaaaaaaa-0000-0000-0000-000000000001']::uuid[])) = 0
  then 'PASS' else 'FAIL' end || ' already-coded card is left alone';
select case when (public.set_stock_code('aaaaaaaa-0000-0000-0000-000000000002','s 1')->>'error') = 'duplicate'
  then 'PASS' else 'FAIL' end || ' duplicate is case/punctuation-insensitive (s 1 vs S-1)';
select case when (public.set_stock_code('aaaaaaaa-0000-0000-0000-000000000002','topLoader-7')->>'ok') = 'true'
  then 'PASS' else 'FAIL' end || ' custom code accepted';
select case when (select stock_code_key from inventory where id='aaaaaaaa-0000-0000-0000-000000000002') = 'TOPLOADER7'
  then 'PASS' else 'FAIL' end || ' custom code normalized key';
select case when (public.set_stock_code('bbbbbbbb-0000-0000-0000-000000000001','X-1')->>'error') = 'not_found'
  then 'PASS' else 'FAIL' end || ' set_stock_code refuses another seller''s card';

-- Bob can also have S-1.
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select case when (public.assign_stock_codes(array['bbbbbbbb-0000-0000-0000-000000000001']::uuid[])->0->>'stock_code') = 'S-1'
  then 'PASS' else 'FAIL' end || ' two sellers can both have S-1';

-- Costs
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
insert into inventory_costs (inventory_id, cost_basis, acquired_from) values ('aaaaaaaa-0000-0000-0000-000000000001', 50, 'Card show buy');
insert into transaction_costs (client_sale_id, inventory_id, show_id, sale_price, cost_at_sale, sold_at)
  values ('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','show_a',85,50,now());
-- Re-sent (offline retry) → upsert, still one row.
insert into transaction_costs (client_sale_id, inventory_id, sale_price, cost_at_sale) values ('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001',85,50)
  on conflict (client_sale_id) do update set cost_at_sale = excluded.cost_at_sale;
select case when (select count(*) from transaction_costs) = 1 then 'PASS' else 'FAIL' end || ' retried sale cost stays one row';
update inventory_costs set cost_basis = 70 where inventory_id = 'aaaaaaaa-0000-0000-0000-000000000001';
select case when (select cost_at_sale from transaction_costs) = 50 then 'PASS' else 'FAIL' end || ' editing cost later does not change cost_at_sale';
select case when (select owner_id from inventory_costs) = auth.uid() then 'PASS' else 'FAIL' end || ' owner_id defaults to auth.uid()';
\echo 'expect an RLS error next:'
insert into inventory_costs (inventory_id, owner_id, cost_basis) values ('aaaaaaaa-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222',1);
select case when (select count(*) from inventory_costs where inventory_id = 'aaaaaaaa-0000-0000-0000-000000000002') = 0 then 'PASS' else 'FAIL' end || ' cannot write a cost owned by someone else';

-- Organizer / other dealer
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select case when (select count(*) from inventory_costs) = 0 and (select count(*) from transaction_costs) = 0
  and (select count(*) from stock_code_counters) = 0 then 'PASS' else 'FAIL' end || ' organizer sees no costs or counters';
update inventory_costs set cost_basis = 0;
delete from transaction_costs;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select case when (select count(*) from inventory_costs) = 0 and (select count(*) from transaction_costs) = 0
  then 'PASS' else 'FAIL' end || ' other dealer sees no costs';

-- Anon
reset role;
set role anon;
set request.jwt.claim.sub = '';
select case when (select count(*) from inventory_costs) = 0 and (select count(*) from transaction_costs) = 0
  then 'PASS' else 'FAIL' end || ' anon sees no costs (even with table grants)';
\echo 'expect a permission error next (anon cannot assign codes):'
select public.assign_stock_codes(array['aaaaaaaa-0000-0000-0000-000000000001']::uuid[]);
reset role;
select case when (select cost_basis from inventory_costs where inventory_id='aaaaaaaa-0000-0000-0000-000000000001') = 70
  and (select count(*) from transaction_costs) = 1 then 'PASS' else 'FAIL' end || ' organizer update/delete changed nothing';
