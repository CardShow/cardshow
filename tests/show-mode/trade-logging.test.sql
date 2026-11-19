-- Trade logging (20261121120000_trade_logging.sql). Run with trade-logging.test.sh.
-- Prints PASS or FAIL per check. Expected ERROR lines: the anon call near the end.
\set ON_ERROR_STOP 1
alter table show_floor_transactions
  add column if not exists api_eligible boolean default true,
  add column if not exists card_title text,
  add column if not exists item_type text,
  add column if not exists client_sale_id uuid;
\i ../../supabase/migrations/20261023120000_show_mode_sales.sql
\i ../../supabase/migrations/20261114120000_cost_tracking.sql
\i ../../supabase/migrations/20261115120000_snap_sell.sql
\i ../../supabase/migrations/20261118120000_trades_show_home.sql
\i ../../supabase/migrations/20261119120000_show_home.sql
\i ../../supabase/migrations/20261120120000_show_log_import.sql
\i ../../supabase/migrations/20261121120000_trade_logging.sql
\i ../../supabase/migrations/20261121120000_trade_logging.sql
grant all on all tables in schema public to anon, authenticated;

insert into auth.users values ('aaaaaaaa-0000-0000-0000-000000000001'), ('bbbbbbbb-0000-0000-0000-000000000002') on conflict do nothing;
insert into sellers values ('aaaaaaaa-0000-0000-0000-000000000001', 'dealer_a'), ('bbbbbbbb-0000-0000-0000-000000000002', 'dealer_b') on conflict do nothing;
insert into shows (id, name, start_date, location, city, state) values ('show_t', 'Trade Test Show', '2026-11-21', 'Hall, Sacramento, CA', 'Sacramento', 'CA');
insert into inventory (id, seller_id, card_title, grade, grader, price, status, stock_code) values
  ('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Card S1', 10, 'PSA', 160, 'Available', 'S-1'),
  ('a0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'Card S2', 9,  'PSA', 240, 'Available', 'S-2'),
  ('a0000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'Card R1', null, null, 40, 'Available', 'R-1'),
  ('b0000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 'B card', null, null, 10, 'Available', 'R-1');
insert into inventory_costs (inventory_id, owner_id, cost_basis) values
  ('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 100),
  ('a0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 200),
  ('a0000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 25);
insert into show_inventory (show_id, card_id) values ('show_t', 'a0000000-0000-0000-0000-000000000001');
\set ON_ERROR_STOP 0

set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
-- T1: S-1 ($160) for a new card worth $140 + $20 cash received.
\set t1 '{"txn_type":"trade","occurred_at":"2026-11-21T18:00:00Z","local_date":"2026-11-21","local_time":"10:00 AM","cash_in":20,"out":[{"inventory_id":"a0000000-0000-0000-0000-000000000001","value":160}],"in":[{"id":"c0000000-0000-0000-0000-000000000001","title":"Wemby RC PSA 10","value":140,"grader":"PSA","grade":"10","price":175}]}'
create temp table r1 as select public.record_trade('11111111-0000-0000-0000-000000000001', 'show_t', null, :'t1') j;
select case when (select j->>'ok' from r1) = 'true' and (select jsonb_array_length(j->'created') from r1) = 1
  and (select (j->'created'->0->>'id') from r1) = 'c0000000-0000-0000-0000-000000000001'
  then 'PASS' else 'FAIL' end || ' record_trade: ok, the new card keeps the phone''s id  (got ' || (select j::text from r1) || ')';
select case when (select status || ':' || payment_method || ':' || sold_price::numeric(12,2) || ':' || sold_time from inventory where id = 'a0000000-0000-0000-0000-000000000001') = 'Sold:Trade:160.00:10:00 AM'
  and not exists (select 1 from show_inventory where card_id = 'a0000000-0000-0000-0000-000000000001')
  then 'PASS' else 'FAIL' end || ' card out: Sold as Trade at its value, taken off the show';
select case when (select status || ':' || price::numeric(12,2) || ':' || identification_status from inventory where id = 'c0000000-0000-0000-0000-000000000001') = 'Available:175.00:unidentified'
  and (select stock_code from inventory where id = 'c0000000-0000-0000-0000-000000000001') like 'S-%'
  and (select stock_code from inventory where id = 'c0000000-0000-0000-0000-000000000001') not in ('S-1', 'S-2')
  and (select cost_basis || ':' || acquired_from from inventory_costs where inventory_id = 'c0000000-0000-0000-0000-000000000001') = '140.00:Trade'
  then 'PASS' else 'FAIL' end || ' card in: Available at its asking price, needs details, new S code, cost = agreed value';
create temp table r1b as select public.record_trade('11111111-0000-0000-0000-000000000001', 'show_t', null, :'t1') j;
select case when (select j->>'already' from r1b) = 'true' and (select j->>'id' from r1b) = (select j->>'id' from r1)
  and (select count(*) from dealer_transactions) = 1 and (select count(*) from transaction_items) = 2
  then 'PASS' else 'FAIL' end || ' same client id again: returns the first trade, writes nothing';

-- B1: a buy for $50 cash.
select public.record_trade('11111111-0000-0000-0000-000000000002', 'show_t', null,
  '{"txn_type":"buy","occurred_at":"2026-11-21T18:10:00Z","cash_out":50,"payment_method":"Cash","in":[{"id":"c0000000-0000-0000-0000-000000000002","title":"Base card","value":50,"stock_code":"R-1"}]}') is not null as b1 \gset
select case when (select stock_code from inventory where id = 'c0000000-0000-0000-0000-000000000002') like 'R-%'
  and (select stock_code from inventory where id = 'c0000000-0000-0000-0000-000000000002') <> 'R-1'
  and (select price_basis from transaction_items where inventory_id = 'c0000000-0000-0000-0000-000000000002') = 'observed'
  then 'PASS' else 'FAIL' end || ' buy: taken code R-1 replaced with the next free one; price paid is observed';

create temp table rep as select public.dealer_show_report('show_t', null) j;
select case when (j->>'cards_out')::int = 1 and (j->>'net_pl')::numeric = 60 and (j->>'trade_value_gained')::numeric = 60
  and (j->>'in_cards')::int = 2 and (j->>'in_cost')::numeric = 190 and (j->>'cash_received')::numeric = 20 and (j->>'cash_paid')::numeric = 50
  and (j->>'unbalanced_trades')::int = 0
  then 'PASS' else 'FAIL' end || ' Show Home report: 1 out, +60, in 2 / $190, cash +20 / −50, balanced  (got ' || j::text || ')' from rep;
select case when (select count(*) from show_floor_transactions) = 0 then 'PASS' else 'FAIL' end || ' nothing on the ledger';

-- Refusals.
create temp table r2 as select public.record_trade('11111111-0000-0000-0000-000000000003', 'show_t', null,
  '{"txn_type":"trade","out":[{"inventory_id":"a0000000-0000-0000-0000-000000000001","value":1}],"in":[{"id":"c0000000-0000-0000-0000-000000000009","title":"x","value":1}]}') j;
create temp table r3 as select public.record_trade('11111111-0000-0000-0000-000000000004', 'show_t', null,
  '{"txn_type":"trade","out":[{"inventory_id":"b0000000-0000-0000-0000-000000000001","value":1}]}') j;
select case when (select j->>'error' from r2) = 'already_sold' and (select j->>'error' from r3) = 'not_your_card'
  and (select count(*) from dealer_transactions) = 2 and not exists (select 1 from inventory where id = 'c0000000-0000-0000-0000-000000000009')
  then 'PASS' else 'FAIL' end || ' card already sold / another dealer''s card: error returned, nothing written';

-- Edit T1: the card in was worth $150, cash received $10.
select public.update_dealer_trade((select (j->>'id')::uuid from r1),
  jsonb_build_object('cash_in', 10, 'items', jsonb_build_array(jsonb_build_object('id',
    (select id from transaction_items where inventory_id = 'c0000000-0000-0000-0000-000000000001'), 'value', 150)))) is not null as e1 \gset
select case when (select cash_in from dealer_transactions where id = (select (j->>'id')::uuid from r1)) = 10
  and (select cost_basis from inventory_costs where inventory_id = 'c0000000-0000-0000-0000-000000000001') = 150
  and (select (public.dealer_show_report('show_t', null)->>'unbalanced_trades')::int) = 0
  then 'PASS' else 'FAIL' end || ' edit: cash and in-card value (cost follows)';

-- Delete T1: S-1 back in the case, the new card gone.
create temp table d1 as select public.delete_dealer_trade((select (j->>'id')::uuid from r1)) j;
select case when (select j->>'ok' from d1) = 'true'
  and (select status || ':' || coalesce(payment_method, '-') || ':' || coalesce(sold_price::text, '-') from inventory where id = 'a0000000-0000-0000-0000-000000000001') = 'Available:-:-'
  and not exists (select 1 from inventory where id = 'c0000000-0000-0000-0000-000000000001')
  and not exists (select 1 from inventory_costs where inventory_id = 'c0000000-0000-0000-0000-000000000001')
  and (select count(*) from dealer_transactions) = 1 and (select count(*) from transaction_items) = 1
  and exists (select 1 from show_inventory where show_id = 'show_t' and card_id = 'a0000000-0000-0000-0000-000000000001')
  then 'PASS' else 'FAIL' end || ' delete: card out back to Available and on the show, card in removed, items gone';

-- Chained: T2 brings in X; T3 trades X away; deleting T2 is refused, T3 then T2 works.
select public.record_trade('11111111-0000-0000-0000-000000000005', null, null,
  '{"txn_type":"trade","out":[{"inventory_id":"a0000000-0000-0000-0000-000000000002","value":240}],"in":[{"id":"c0000000-0000-0000-0000-000000000003","title":"X","value":240}]}')->>'id' as t2 \gset
select public.record_trade('11111111-0000-0000-0000-000000000006', null, null,
  '{"txn_type":"trade","out":[{"inventory_id":"c0000000-0000-0000-0000-000000000003","value":260}],"in":[{"id":"c0000000-0000-0000-0000-000000000004","title":"Y","value":260}]}')->>'id' as t3 \gset
select case when (select cost_at_sale from transaction_item_costs c join transaction_items t on t.id = c.transaction_item_id
                   where t.inventory_id = 'c0000000-0000-0000-0000-000000000003' and t.direction = 'out') = 240
  then 'PASS' else 'FAIL' end || ' chained trade: the card traded on carries its trade-in cost';
select case when (public.delete_dealer_trade(:'t2')->>'error') = 'card_moved_on' then 'PASS' else 'FAIL' end || ' delete refused once a card that came in was traded on';
select public.delete_dealer_trade(:'t3')->>'ok' as d3 \gset
select public.delete_dealer_trade(:'t2')->>'ok' as d2 \gset
select case when :'d3' = 'true' and :'d2' = 'true'
  and (select status from inventory where id = 'a0000000-0000-0000-0000-000000000002') = 'Available'
  then 'PASS' else 'FAIL' end || ' newest first: both deletes work, S-2 back';

-- Another dealer, anon.
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
select case when (public.delete_dealer_trade((select id from dealer_transactions limit 1))->>'error') is not distinct from 'not_found'
  and (select count(*) from dealer_transactions) = 0
  then 'PASS' else 'FAIL' end || ' other dealer: sees nothing, can''t delete';
reset role;
set role anon;
select public.record_trade('11111111-0000-0000-0000-000000000007', null, null, '{"txn_type":"buy","in":[{"title":"x"}]}');
reset role;
select case when (select count(*) from dealer_transactions where client_capture_id = '11111111-0000-0000-0000-000000000007') = 0
  then 'PASS' else 'FAIL' end || ' anon refused';
