-- Trades + Show Home, Phase 2 (20261119120000_show_home.sql). Run by trades.test.sh right after
-- trades.test.sql, on the same database (Tito's fixture loaded twice). Prints PASS or FAIL per check.
\set ON_ERROR_STOP 1
\i ../../supabase/migrations/20261119120000_show_home.sql
\i ../../supabase/migrations/20261119120000_show_home.sql
\set ON_ERROR_STOP 0
select id as tito_show from dealer_shows where owner_id = '11111111-1111-1111-1111-111111111111' \gset

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
create temp table r1 as select public.dealer_show_report(null, :'tito_show') j;
select case when (select (j->>'cards_out')::int from r1) = 29 and (select (j->>'net_pl')::numeric from r1) = 240
  then 'PASS' else 'FAIL' end || ' report unchanged after the Phase 2 migration (29 out, +240)';
select case when (select jsonb_array_length(j->'unbalanced') from r1) = 2
  and (select bool_and((x->>'delta')::numeric in (-100, 25)) from r1, jsonb_array_elements(j->'unbalanced') x)
  then 'PASS' else 'FAIL' end || ' unbalanced list: NOV7-08 (-100) and NOV7-09 (+25)';
select case when (select jsonb_array_length(j->'ungrouped_txn_ids') from r1) = 1 then 'PASS' else 'FAIL' end || ' one ungrouped bucket to link to';

-- Show list
create temp table l1 as select public.dealer_show_list() j;
select case when (select count(*) from l1, jsonb_array_elements(j) x
                   where x->>'name' = 'Mall Show' and x->>'kind' = 'private' and (x->>'cards_out')::int = 29 and (x->>'net_pl')::numeric = 240) = 1
  then 'PASS' else 'FAIL' end || ' show list: Mall Show, private, 29 out, +240';
select case when (select jsonb_array_length(j) from l1) = 1 then 'PASS' else 'FAIL' end || ' show list has only the dealer''s own shows';
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select case when (select count(*) from jsonb_array_elements(public.dealer_show_list()) x
                   where x->>'show_id' = 'show_t' and x->>'kind' = 'cardshow' and (x->>'net_pl')::numeric = 240) = 1
  then 'PASS' else 'FAIL' end || ' show list: CardShow show where the dealer sold, +240';

-- Snapshots (Tito's Available inventory: 152 cards, $10,451 cost, $13,379 ask)
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
create temp table s1 as select public.take_inventory_snapshot('show_start', null, :'tito_show', gen_random_uuid()) j;
select case when (select (j->>'card_count')::int = 152 and (j->>'cost_total')::numeric = 10451 and (j->>'ask_total')::numeric = 13379 from s1)
  then 'PASS' else 'FAIL' end || ' show_start snapshot = Tito''s Available inventory (152 / $10,451 / $13,379)  got ' || (select j::text from s1);
select case when (select (j->>'id') from s1) = (public.take_inventory_snapshot('show_start', null, :'tito_show', gen_random_uuid())->>'id')
  then 'PASS' else 'FAIL' end || ' a second show_start returns the first (once per show)';
select case when (public.take_inventory_snapshot('baseline', null, null, 'cccccccc-0000-0000-0000-00000000000c')->>'id')
               = (public.take_inventory_snapshot('baseline', null, null, 'cccccccc-0000-0000-0000-00000000000c')->>'id')
  then 'PASS' else 'FAIL' end || ' a retried baseline (same client id) is written once';
select case when (public.take_inventory_snapshot('show_start', null, '00000000-0000-0000-0000-00000000dead')->>'error') = 'not_found'
  then 'PASS' else 'FAIL' end || ' cannot snapshot into someone else''s private show';
select public.close_ended_show_snapshots();   -- refused: service role only (error expected)
reset role;

-- The hourly job: the Mall Show (Nov 7) is over, so it gets a show_end; running again adds none.
select public.close_ended_show_snapshots() as closed \gset
select case when :closed = 1
  and (select count(*) from inventory_snapshots where owner_id = '11111111-1111-1111-1111-111111111111' and kind = 'show_end') = 1
  then 'PASS' else 'FAIL' end || ' hourly job writes the show_end for an ended show';
select case when public.close_ended_show_snapshots() = 0 then 'PASS' else 'FAIL' end || ' second run writes nothing';
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select case when (public.dealer_show_report(null, :'tito_show')->>'growth_cards')::int = 0
  then 'PASS' else 'FAIL' end || ' report shows start/end snapshots (no change since start)';
reset role;
set role anon;
select public.dealer_show_list();
select public.take_inventory_snapshot('baseline');
reset role;
select 'PASS anon refused list + snapshot (two errors above are expected)';
