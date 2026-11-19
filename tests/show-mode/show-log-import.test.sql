-- Show log import (20261120120000_show_log_import.sql). Run with show-log-import.test.sh.
-- Prints PASS or FAIL per check. Expected ERROR lines: the refused imports near the end.
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
\i ../../supabase/migrations/20261120120000_show_log_import.sql
grant all on all tables in schema public to anon, authenticated;

-- Dealer A with six cards; dealer B with one.
insert into auth.users values ('aaaaaaaa-0000-0000-0000-000000000001'), ('bbbbbbbb-0000-0000-0000-000000000002') on conflict do nothing;
insert into sellers values ('aaaaaaaa-0000-0000-0000-000000000001', 'dealer_a'), ('bbbbbbbb-0000-0000-0000-000000000002', 'dealer_b') on conflict do nothing;
insert into shows (id, name, start_date, location, city, state) values ('show_i', 'Import Test Show', '2026-11-21', 'Hall, Sacramento, CA', 'Sacramento', 'CA');
insert into inventory (id, seller_id, card_title, grade, grader, price, status, stock_code) values
  ('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Card S1', 10, 'PSA', 150, 'Available', 'S-1'),
  ('a0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'Card S2', 9,  'PSA', 240, 'Available', 'S-2'),
  ('a0000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'Card R1', null, null, 15, 'Available', 'R-1'),
  ('a0000000-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 'Card R2', null, null, 30, 'Available', 'R-2'),
  ('a0000000-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001', 'Card R3', null, null, 45, 'Available', 'R-3'),
  ('a0000000-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001', 'Card R4', null, null, 20, 'Available', 'R-4'),
  ('a0000000-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000001', 'Card S3', 8,  'PSA', 90,  'Available', 'S-3'),
  ('a0000000-0000-0000-0000-000000000008', 'aaaaaaaa-0000-0000-0000-000000000001', 'Card R5', null, null, 12, 'Available', 'R-5'),
  ('a0000000-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000001', 'Card R6', null, null, 18, 'Available', 'R-6'),
  ('b0000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 'B card', null, null, 10, 'Available', 'R-1');
insert into inventory_costs (inventory_id, owner_id, cost_basis) values
  ('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 100),
  ('a0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 200),
  ('a0000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 10),
  ('a0000000-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 20),
  ('a0000000-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001', 30),
  ('a0000000-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000001', 60),
  ('a0000000-0000-0000-0000-000000000008', 'aaaaaaaa-0000-0000-0000-000000000001', 5),
  ('a0000000-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000001', 6);
insert into dealer_shows (id, owner_id, name, show_date) values
  ('d0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Test Mall', '2026-11-20');
\set ON_ERROR_STOP 0

-- The log (private show): SOLD, SOLD lot, TRADE with cash received, chained TRADE with cash paid,
-- BUY, and a TRADE with nothing recorded coming back.
\set log '[{"key":"k1","occurred_at":"2026-11-20T18:00:00Z","local_date":"2026-11-20","local_time":"10:00 AM","txn_type":"sale","cash_in":160,"payment_method":"Cash","out":[{"inventory_id":"a0000000-0000-0000-0000-000000000001","value":160}]},{"key":"k2","occurred_at":"2026-11-20T18:10:00Z","txn_type":"lot_sale","cash_in":50,"out":[{"inventory_id":"a0000000-0000-0000-0000-000000000003","value":25},{"inventory_id":"a0000000-0000-0000-0000-000000000004","value":25}]},{"key":"k3","occurred_at":"2026-11-20T18:20:00Z","txn_type":"trade","cash_in":20,"out":[{"inventory_id":"a0000000-0000-0000-0000-000000000002","value":220}],"in":[{"ref":"k3:in:0","title":"Luka Doncic PSA 9","value":200,"grader":"PSA","grade":"9"}]},{"key":"k4","occurred_at":"2026-11-20T18:30:00Z","txn_type":"trade","cash_out":10,"out":[{"ref":"k3:in:0","value":210}],"in":[{"ref":"k4:in:0","title":"Wemby RC","value":220,"stock_code":"R-90"}]},{"key":"k5","occurred_at":"2026-11-20T18:40:00Z","txn_type":"buy","cash_out":150,"in":[{"ref":"k5:in:0","title":"Mahomes PSA 10","value":150,"grader":"PSA","grade":"10"}]},{"key":"k6","occurred_at":"2026-11-20T18:50:00Z","txn_type":"trade","out":[{"inventory_id":"a0000000-0000-0000-0000-000000000005","value":40}]}]'

set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
create temp table imp1 as select public.import_show_log(null, 'd0000000-0000-0000-0000-000000000001', :'log') j;
select case when (select (j->>'imported')::int from imp1) = 6 and (select jsonb_array_length(j->'created') from imp1) = 3
  then 'PASS' else 'FAIL' end || ' first import: 6 transactions, 3 new cards  (got ' || (select j::text from imp1) || ')';
create temp table imp2 as select public.import_show_log(null, 'd0000000-0000-0000-0000-000000000001', :'log') j;
select case when (select (j->>'imported')::int from imp2) = 0 and (select jsonb_array_length(j->'duplicates') from imp2) = 6
  and (select count(*) from dealer_transactions) = 6 and (select count(*) from inventory where seller_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 12
  then 'PASS' else 'FAIL' end || ' same log again: nothing imported, 6 duplicates, no new rows';

create temp table rep as select public.dealer_show_report(null, 'd0000000-0000-0000-0000-000000000001') j;
create temp table expected (k text, v numeric);
-- Hand calculation: S1 160-100, R1 25-10, R2 25-20, S2 220-200, Luka 210-200, R3 40-30.
insert into expected values ('cards_out', 6), ('net_pl', 120), ('trade_value_gained', 40), ('cash_sale_profit', 80),
  ('wins', 6), ('losses', 0), ('even', 0), ('trade_cards', 3), ('trade_cost', 430), ('trade_value', 470),
  ('cash_cards', 3), ('cash_cost', 130), ('cash_value', 210), ('in_cards', 3), ('in_cost', 570),
  ('onhand_cards', 2), ('onhand_cost', 370), ('cash_received', 230), ('cash_paid', 160),
  ('unbalanced_trades', 0), ('ungrouped_cards', 1), ('cost_coverage', 1);
select case when (j->>k)::numeric = v then 'PASS' else 'FAIL' end || ' report ' || k || ' = ' || v || '  (got ' || coalesce(j->>k, 'null') || ')'
  from rep, expected order by k;
select case when (select count(*) from dealer_transactions where txn_type = 'sale') = 1 and (select count(*) from dealer_transactions where txn_type = 'lot_sale') = 1
  and (select count(*) from dealer_transactions where txn_type = 'trade') = 3 and (select count(*) from dealer_transactions where txn_type = 'buy') = 1
  and (select cash_out from dealer_transactions where import_key = 'k4') = 10 and (select cash_in from dealer_transactions where import_key = 'k3') = 20
  and (select is_ungrouped from dealer_transactions where import_key = 'k6') and not (select is_ungrouped from dealer_transactions where import_key = 'k3')
  and (select bool_and(source = 'import') from dealer_transactions)
  then 'PASS' else 'FAIL' end || ' types, cash both ways, ungrouped flag, source import';
select case when (select count(*) from inventory where seller_id = 'aaaaaaaa-0000-0000-0000-000000000001' and identification_status = 'unidentified') = 3
  and (select status from inventory where card_title = 'Luka Doncic PSA 9') = 'Sold'
  and (select status from inventory where card_title = 'Wemby RC') = 'Available'
  and (select stock_code from inventory where card_title = 'Wemby RC') = 'R-90'
  and (select stock_code from inventory where card_title = 'Mahomes PSA 10') like 'S-%'
  and (select stock_code from inventory where card_title = 'Mahomes PSA 10') not in ('S-1', 'S-2', 'S-3')
  then 'PASS' else 'FAIL' end || ' new cards: unidentified, chained card sold, given code kept, others auto-coded without clashes';
select case when (select c.cost_basis from inventory_costs c join inventory i on i.id = c.inventory_id where i.card_title = 'Wemby RC') = 220
  and (select c.acquired_txn_id from inventory_costs c join inventory i on i.id = c.inventory_id where i.card_title = 'Wemby RC')
      = (select id from dealer_transactions where import_key = 'k4')
  and (select c.acquired_from from inventory_costs c join inventory i on i.id = c.inventory_id where i.card_title = 'Mahomes PSA 10') = 'Buy'
  then 'PASS' else 'FAIL' end || ' in-card cost = agreed value / price paid, linked to its trade';
select case when (select string_agg(status || ':' || coalesce(payment_method, '') || ':' || coalesce(sold_price::text, ''), ',' order by stock_code)
                    from inventory where stock_code in ('S-1', 'S-2', 'R-1', 'R-2', 'R-3') and seller_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 'Sold:Cash:25,Sold:Cash:25,Sold:Trade:40,Sold:Cash:160,Sold:Trade:220'
  and (select sold_time from inventory where stock_code = 'S-1') = '10:00 AM'
  then 'PASS' else 'FAIL' end || ' cards out marked Sold (trades as "Trade"), with the log''s time';
select case when (select string_agg(price_basis, ',' order by price_basis) from transaction_items where direction = 'out') = 'agreed_trade_value,agreed_trade_value,agreed_trade_value,allocated,allocated,observed'
  and (select price_basis from transaction_items where direction = 'in' and card_title = 'Mahomes PSA 10') = 'observed'
  then 'PASS' else 'FAIL' end || ' price basis: trades agreed, lot allocated, sale observed';

select case when public.show_log_imported_keys(array['k1', 'k6', 'nope']) = array['k1', 'k6'] then 'PASS' else 'FAIL' end || ' imported-keys lookup: k1, k6 yes, nope no';
-- A new row that trades away a card created by an earlier import of the same log.
\set log2 '[{"key":"k7","occurred_at":"2026-11-20T19:00:00Z","txn_type":"sale","cash_in":260,"out":[{"ref":"k4:in:0","value":260}]},{"key":"k4","occurred_at":"2026-11-20T18:30:00Z","txn_type":"trade","cash_out":10,"out":[{"ref":"k3:in:0","value":210}],"in":[{"ref":"k4:in:0","title":"Wemby RC","value":220}]}]'
select (public.import_show_log(null, 'd0000000-0000-0000-0000-000000000001', :'log2')->>'imported')::int as imported3 \gset
select case when :imported3 = 1
  and (select status from inventory where card_title = 'Wemby RC') = 'Sold'
  then 'PASS' else 'FAIL' end || ' later row can sell a card from an already-imported row (ref found through the duplicate)';

-- Refusals: nothing is written.
create temp table before as select (select count(*) from dealer_transactions) d, (select count(*) from transaction_items) i;
select public.import_show_log(null, 'd0000000-0000-0000-0000-000000000001',
  '[{"key":"x1","occurred_at":"2026-11-20T20:00:00Z","txn_type":"sale","cash_in":5,"out":[{"inventory_id":"a0000000-0000-0000-0000-000000000006","value":5}]},{"key":"x2","occurred_at":"2026-11-20T20:01:00Z","txn_type":"sale","cash_in":5,"out":[{"inventory_id":"b0000000-0000-0000-0000-000000000001","value":5}]}]');
select public.import_show_log(null, 'd0000000-0000-0000-0000-000000000001',
  '[{"key":"x3","occurred_at":"2026-11-20T20:02:00Z","txn_type":"sale","cash_in":5,"out":[{"inventory_id":"a0000000-0000-0000-0000-000000000001","value":5}]}]');
select public.import_show_log(null, 'd0000000-0000-0000-0000-000000000001',
  '[{"key":"x4","occurred_at":"2026-11-20T20:03:00Z","txn_type":"trade","out":[{"ref":"nope","value":5}]}]');
select case when (select d from before) = (select count(*) from dealer_transactions) and (select i from before) = (select count(*) from transaction_items)
  and (select status from inventory where stock_code = 'R-4' and seller_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 'Available'
  then 'PASS' else 'FAIL' end || ' another dealer''s card, an already-sold card, or an unknown card: whole import refused, nothing written';

set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
select public.import_show_log(null, 'd0000000-0000-0000-0000-000000000001', '[]');
select case when (select count(*) from dealer_transactions) = 0 then 'PASS' else 'FAIL' end || ' other dealer: sees none of A''s imported transactions';

-- At a CardShow show: sales go on the ledger (once), trades stay private.
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
\set log3 '[{"key":"c1","occurred_at":"2026-11-21T18:00:00Z","txn_type":"sale","cash_in":100,"payment_method":"Venmo","out":[{"inventory_id":"a0000000-0000-0000-0000-000000000007","value":100}]},{"key":"c2","occurred_at":"2026-11-21T18:10:00Z","txn_type":"lot_sale","cash_in":30,"out":[{"inventory_id":"a0000000-0000-0000-0000-000000000008","value":12},{"inventory_id":"a0000000-0000-0000-0000-000000000009","value":18}]},{"key":"c3","occurred_at":"2026-11-21T18:20:00Z","txn_type":"trade","out":[{"inventory_id":"a0000000-0000-0000-0000-000000000006","value":25}],"in":[{"ref":"c3:in:0","title":"Trade card","value":25}]}]'
select public.import_show_log('show_i', null, :'log3') is not null as ok \gset
select public.import_show_log('show_i', null, :'log3') is not null as ok2 \gset
create temp table rep2 as select public.dealer_show_report('show_i', null) j;
-- S3 100-60, R5 12-5, R6 18-6 (cash, +59); R4 traded at 25 with no cost (+25, counted as missing cost).
select case when (select (j->>'cards_out')::int from rep2) = 4 and (select (j->>'net_pl')::numeric from rep2) = 84
  and (select (j->>'cash_sale_profit')::numeric from rep2) = 59 and (select (j->>'trade_value_gained')::numeric from rep2) = 25
  and (select (j->>'cards_missing_cost')::int from rep2) = 1
  then 'PASS' else 'FAIL' end || ' CardShow show report: 4 out, +84, cash +59, trade +25, 1 missing cost  (got ' || (select (j->>'net_pl') from rep2) || ')';
select case when public.show_log_imported_keys(array['c1', 'c2', 'c3']) = array['c1', 'c2', 'c3'] then 'PASS' else 'FAIL' end || ' imported-keys lookup finds ledger rows too';
reset role;
select case when (select count(*) from show_floor_transactions where show_id = 'show_i') = 2
  and (select sum(sold_price) from show_floor_transactions where show_id = 'show_i') = 130
  and (select txn_type from show_floor_transactions where show_id = 'show_i' and sold_price = 30) = 'lot_sale'
  and not (select api_eligible from show_floor_transactions where show_id = 'show_i' and sold_price = 30)
  and (select bool_and(source = 'import') from show_floor_transactions where show_id = 'show_i')
  then 'PASS' else 'FAIL' end || ' ledger: 1 sale + 1 lot ($130 organizer GMV), imported once, lot kept out of comps';
select case when (select count(*) from dealer_transactions where show_id = 'show_i') = 1
  then 'PASS' else 'FAIL' end || ' the trade at the CardShow show stays off the ledger';
select case when (select c.cost_at_sale from transaction_item_costs c join transaction_items i on i.id = c.transaction_item_id
                   where i.inventory_id = 'a0000000-0000-0000-0000-000000000007') = 60
  then 'PASS' else 'FAIL' end || ' ledger sale item got its cost (via transaction_costs)';

set role anon;
select public.import_show_log(null, 'd0000000-0000-0000-0000-000000000001', '[]');
reset role;
