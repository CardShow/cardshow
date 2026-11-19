-- Trades + Show Home, Phase 1 (20261118120000_trades_show_home.sql). Run with trades.test.sh,
-- which builds a fresh database, runs the earlier migrations, and generates the two fixture files.
-- Every check prints PASS or FAIL.
\set ON_ERROR_STOP 1
-- Production ledger/inventory columns the shared stub doesn't have.
alter table show_floor_transactions
  add column if not exists api_eligible boolean default true,
  add column if not exists card_title text,
  add column if not exists item_type text;
alter table inventory add column if not exists location text;

\i ../../supabase/migrations/20261023120000_show_mode_sales.sql
\i ../../supabase/migrations/20261114120000_cost_tracking.sql
-- A pre-existing platform sale with a cost copy, to check the item-cost backfill.
insert into auth.users values ('99999999-9999-9999-9999-999999999999') on conflict do nothing;
insert into sellers values ('99999999-9999-9999-9999-999999999999', 'old_dealer') on conflict do nothing;
insert into shows (id, name) values ('show_t', 'CardShow Test Show'), ('show_x', 'Other show') on conflict do nothing;
insert into inventory (id, seller_id, card_title, price, status) values
  ('bbbbbbbb-0000-0000-0000-00000000000b', '99999999-9999-9999-9999-999999999999', 'Old card', 50, 'Sold');
\i ../../supabase/migrations/20261115120000_snap_sell.sql
insert into show_floor_transactions (id, sold_price, inventory_id, player, seller_id, show_id, client_sale_id)
  values ('dddddddd-0000-0000-0000-0000000000aa', 70, 'bbbbbbbb-0000-0000-0000-00000000000b', 'Old', '99999999-9999-9999-9999-999999999999', 'show_x', 'eeeeeeee-0000-0000-0000-0000000000aa');
insert into transaction_costs (client_sale_id, owner_id, inventory_id, sale_price, cost_at_sale)
  values ('eeeeeeee-0000-0000-0000-0000000000aa', '99999999-9999-9999-9999-999999999999', 'bbbbbbbb-0000-0000-0000-00000000000b', 70, 40);
-- Ledger GMV per show before the migration.
create temp table gmv_before as select show_id, sum(sold_price) gmv, count(*) n from show_floor_transactions group by show_id;

\i ../../supabase/migrations/20261118120000_trades_show_home.sql
\i ../../supabase/migrations/20261118120000_trades_show_home.sql
grant all on all tables in schema public to anon, authenticated;

select case when (select txn_type from show_floor_transactions where id = 'dddddddd-0000-0000-0000-0000000000aa') = 'sale'
  then 'PASS' else 'FAIL' end || ' existing sale rows migrate as txn_type sale';
select case when not exists (select 1 from gmv_before b left join
    (select show_id, sum(sold_price) gmv, count(*) n from show_floor_transactions group by show_id) a using (show_id)
    where a.gmv is distinct from b.gmv or a.n is distinct from b.n)
  then 'PASS' else 'FAIL' end || ' ledger GMV per show unchanged by the migration';
select case when (select c.cost_at_sale from transaction_item_costs c join transaction_items i on i.id = c.transaction_item_id
                   where i.sale_key = 'eeeeeeee-0000-0000-0000-0000000000aa') = 40
  then 'PASS' else 'FAIL' end || ' item cost backfilled from transaction_costs';

-- Load the fixture twice: Tito (private "Mall Show") and a second dealer at a CardShow show.
insert into auth.users values ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333') on conflict do nothing;
\i :fixture_private
\i :fixture_private
\i :fixture_cardshow
\set ON_ERROR_STOP 0

select case when (select count(*) from inventory where seller_id = '11111111-1111-1111-1111-111111111111') = 181
  and (select count(*) from transaction_items where owner_id = '11111111-1111-1111-1111-111111111111') = 97
  then 'PASS' else 'FAIL' end || ' fixture loaded once (181 cards, 97 items) even when run twice';

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
create temp table rep as select public.dealer_show_report(null, (select id from dealer_shows limit 1)) j;
create temp table expected (k text, v numeric);
insert into expected values
  ('cards_out', 29), ('net_pl', 240), ('margin_on_cost', 0.0744), ('trade_value_gained', 145), ('cash_sale_profit', 95),
  ('win_rate', 0.5172), ('wins', 15), ('losses', 3), ('even', 11), ('biggest_win', 100), ('biggest_loss', -90),
  ('trade_cards', 23), ('trade_cost', 2925), ('trade_value', 3070), ('trade_gain', 145), ('trade_gain_on_cost', 0.0496),
  ('cash_cards', 6), ('cash_cost', 300), ('cash_value', 395), ('cash_profit', 95), ('cash_margin', 0.3167),
  ('in_cards', 68), ('in_cost', 5956), ('in_ask', 7726), ('in_ask_gain', 1770), ('in_ask_gain_pct', 0.2972),
  ('onhand_cards', 56), ('onhand_cost', 4256), ('onhand_ask', 5596), ('onhand_ask_gain_pct', 0.3148),
  ('unbalanced_trades', 2), ('ungrouped_cards', 12);
-- Ratios compare at 4 decimals (the spec's precision); everything else exactly.
select case when round((j->>k)::numeric, case when v <> round(v) or k like '%pct' or k like '%rate' or k like 'margin%' or k like '%on_cost' then 4 else 0 end) = v
  then 'PASS' else 'FAIL' end || ' report ' || k || ' = ' || v || coalesce('  (got ' || (j->>k) || ')', '')
  from rep, expected order by k;
select case when (select (j->'mix'->'traded'->>'cards')::int from rep) = 23 and (select (j->'mix'->'lot'->>'cards')::int from rep) = 2
  and (select (j->'mix'->'cash_sale'->>'cards')::int from rep) = 4 then 'PASS' else 'FAIL' end || ' mix: 23 traded / 4 cash sale / 2 lot';
select case when (select jsonb_array_length(j->'rows') from rep) = 29 and (select (j->>'cost_coverage')::numeric from rep) = 1
  then 'PASS' else 'FAIL' end || ' 29 transaction rows, every card costed';
select case when exists (select 1 from rep, jsonb_array_elements(j->'rows') x where x->>'code' = 'S-21' and (x->>'profit')::numeric = -90 and x->>'result' = 'Loss')
  then 'PASS' else 'FAIL' end || ' row S-21: -90, Loss';
-- Chained trade: S-75 came in (NOV7-99) and went out (NOV7-10); its profit uses the agreed in-value.
select case when exists (select 1 from rep, jsonb_array_elements(j->'rows') x where x->>'code' = 'S-75' and (x->>'cost')::numeric = 100 and (x->>'profit')::numeric = -10)
  then 'PASS' else 'FAIL' end || ' chained trade S-75: cost 100 (agreed in-value), profit -10';

-- Same dealer data at a CardShow show (second dealer).
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
create temp table rep2 as select public.dealer_show_report('show_t', null) j;
select case when (select count(*) from rep, rep2, expected where round((rep.j->>k)::numeric, 6) is distinct from round((rep2.j->>k)::numeric, 6)) = 0
  then 'PASS' else 'FAIL' end || ' same numbers when the show is a CardShow show';
reset role;
select case when (select sum(sold_price) from show_floor_transactions where show_id = 'show_t') = 395
  then 'PASS' else 'FAIL' end || ' organizer GMV for the CardShow show = $395 (trades add $0)';
select case when not exists (select 1 from show_floor_transactions where show_id = 'show_t' and txn_type not in ('sale', 'lot_sale'))
  then 'PASS' else 'FAIL' end || ' no trade rows on the shared ledger';
select case when (select count(*) from show_floor_transactions where show_id = 'show_t' and txn_type = 'lot_sale') = 1
  and (select count(*) from transaction_items i join show_floor_transactions t on i.sale_key = t.client_sale_id
        where t.show_id = 'show_t' and t.txn_type = 'lot_sale') = 2
  then 'PASS' else 'FAIL' end || ' lot sale: one ledger row, two allocated items';
-- v_comp_sales (social migrations) keeps only api_eligible rows; the lot row must not be one.
select case when (select api_eligible from show_floor_transactions where show_id = 'show_t' and txn_type = 'lot_sale') = false
  then 'PASS' else 'FAIL' end || ' lot total kept out of comps (api_eligible false)';
select id as tito_show from dealer_shows where owner_id = '11111111-1111-1111-1111-111111111111' \gset
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select case when public.show_trade_count('show_t') = 6 then 'PASS' else 'FAIL' end || ' organizer sees the trade count (6) for the show';

-- RLS: the organizer-like third user, and anon, see nothing of either dealer.
select case when (select count(*) from dealer_shows) + (select count(*) from dealer_transactions)
  + (select count(*) from inventory_snapshots) + (select count(*) from transaction_item_costs)
  + (select count(*) from transaction_items) = 0 then 'PASS' else 'FAIL' end || ' another user sees no dealer_shows / trades / snapshots / items / costs';
select case when (public.dealer_show_report('show_t', null)->>'cards_out')::int = 0
  and (public.dealer_show_report(null, :'tito_show')->>'cards_out')::int = 0
  then 'PASS' else 'FAIL' end || ' another user''s report for that show is empty';
update dealer_transactions set cash_in = 999;
reset role;
select case when not exists (select 1 from dealer_transactions where cash_in = 999) then 'PASS' else 'FAIL' end || ' another user cannot change a trade';
set role anon;
select 'FAIL anon can read dealer_transactions' from dealer_transactions;
select public.dealer_show_report('show_t', null);
reset role;

-- Snapshots: one show_start per dealer per show; edits on trades are allowed for the owner.
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
insert into inventory_snapshots (show_id, kind, card_count, cost_total, ask_total, cards_missing_cost, cards_missing_price)
  values ('show_t', 'show_start', 152, 10451, 13379, 6, 12);
insert into inventory_snapshots (show_id, kind, card_count, cost_total, ask_total, cards_missing_cost, cards_missing_price)
  values ('show_t', 'show_start', 1, 1, 1, 0, 0);
select case when (select count(*) from inventory_snapshots where kind = 'show_start') = 1 then 'PASS' else 'FAIL' end || ' second show_start refused (error above is expected)';
insert into inventory_snapshots (show_id, kind, card_count, cost_total, ask_total, cards_missing_cost, cards_missing_price)
  values ('show_t', 'show_end', 164, 11000, 14200, 6, 12);
select case when (public.dealer_show_report('show_t', null)->>'growth_cards')::int = 12
  and (public.dealer_show_report('show_t', null)->>'growth_cost')::numeric = 549 then 'PASS' else 'FAIL' end || ' report shows start/end snapshots and growth';
update dealer_transactions set cash_in = 25 where import_key = 'NOV7-09';
select case when (public.dealer_show_report('show_t', null)->>'unbalanced_trades')::int = 1 then 'PASS' else 'FAIL' end
  || ' owner edits a trade (NOV7-09 + $25 cash) → 1 unbalanced trade left';
select case when (public.dealer_show_report('show_t', null)->>'net_pl')::numeric = 240 then 'PASS' else 'FAIL' end || ' cash fix leaves net P/L unchanged';
reset role;
-- Price basis check: agreed values are allowed, junk refused.
insert into transaction_items (sale_key, owner_id, price, price_basis) values (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 1, 'junk');
select 'PASS junk price_basis refused (error above is expected)' where not exists (select 1 from transaction_items where price_basis = 'junk');
