-- show_sellers security (20261126120000_show_sellers_rls.sql). Run with show-sellers-rls.test.sh.
-- Prints PASS or FAIL per check. ERROR lines are expected refusals.
\set ON_ERROR_STOP 1
alter table shows add column if not exists created_by uuid;
alter table show_sellers add column if not exists x_pct numeric(5,2), add column if not exists y_pct numeric(5,2);
create table if not exists public.admins (id uuid primary key);
\i ../../supabase/migrations/20261027120000_seller_self_join.sql
\i ../../supabase/migrations/20261028120000_show_directory.sql
alter table show_sellers enable row level security;
create policy "Allow all" on show_sellers for all using (true) with check (true);
\i ../../supabase/migrations/20261125120000_show_inventory_rls.sql
\i ../../supabase/migrations/20261126120000_show_sellers_rls.sql
\i ../../supabase/migrations/20261126120000_show_sellers_rls.sql
grant all on all tables in schema public to anon, authenticated, service_role;
revoke insert, update, delete, truncate on public.show_sellers, public.show_inventory from anon;
alter role service_role bypassrls;
do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then
  create role authenticator login noinherit; end if; end $$;
grant anon, authenticated, service_role to authenticator;

-- A, B: sellers. O: organizer of show_1. O2: another organizer. P: platform owner.
insert into auth.users values ('aaaaaaaa-0000-0000-0000-000000000001'), ('bbbbbbbb-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000a2'), ('00000000-0000-0000-0000-0000000000f1');
insert into sellers values ('aaaaaaaa-0000-0000-0000-000000000001', 'a'), ('bbbbbbbb-0000-0000-0000-000000000002', 'b');
insert into admins values ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000a2');
insert into platform_admins values ('00000000-0000-0000-0000-0000000000f1');
insert into shows (id, name, start_date, end_date, created_by, listed, seller_self_join) values
  ('show_1', 'One', current_date, current_date + 1, '00000000-0000-0000-0000-0000000000a1', true, true),
  ('show_2', 'Two', current_date, current_date + 1, '00000000-0000-0000-0000-0000000000a2', true, true);
insert into show_sellers (show_id, seller_id, table_number) values ('show_1', 'bbbbbbbb-0000-0000-0000-000000000002', '7');
\set ON_ERROR_STOP 0

select case when (select count(*) from pg_policies where tablename = 'show_sellers') = 4
  and not exists (select 1 from pg_policies where tablename = 'show_sellers' and policyname = 'Allow all')
  then 'PASS 1 old policies dropped, exactly four new ones (migration ran twice)' else 'FAIL 1' end;

set session authorization authenticator;
set role anon;
select case when (select count(*) from show_sellers) = 1 then 'PASS 2 anon can still read sellers and tables' else 'FAIL 2' end;
insert into show_sellers (show_id, seller_id) values ('show_1', 'aaaaaaaa-0000-0000-0000-000000000001');
update show_sellers set table_number = '99';
delete from show_sellers;

set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select case when (select count(*) from show_sellers) = 1 and (select table_number from show_sellers) = '7'
  then 'PASS 3 anon cannot add, edit or remove (errors above expected)' else 'FAIL 3' end;

-- Seller A: direct insert refused; the join function works.
insert into show_sellers (show_id, seller_id) values ('show_1', 'aaaaaaaa-0000-0000-0000-000000000001');
select case when not exists (select 1 from show_sellers where seller_id = 'aaaaaaaa-0000-0000-0000-000000000001')
  then 'PASS 4 seller cannot add themselves directly (error above expected)' else 'FAIL 4' end;
select join_show_as_seller('show_1') as joined \gset
select case when (:'joined'::jsonb->>'ok') = 'true'
  and exists (select 1 from show_sellers where show_id = 'show_1' and seller_id = 'aaaaaaaa-0000-0000-0000-000000000001')
  then 'PASS 5 seller joins through join_show_as_seller()' else 'FAIL 5' end;
update show_sellers set table_number = '1' where show_id = 'show_1';
delete from show_sellers where seller_id = 'bbbbbbbb-0000-0000-0000-000000000002';
select case when (select table_number from show_sellers where seller_id = 'bbbbbbbb-0000-0000-0000-000000000002') = '7'
  and (select table_number from show_sellers where seller_id = 'aaaaaaaa-0000-0000-0000-000000000001') is null
  then 'PASS 6 seller cannot change tables or remove another seller' else 'FAIL 6' end;
select leave_show_as_seller('show_1') as left_show \gset
select case when (:'left_show'::jsonb->>'ok') = 'true'
  and not exists (select 1 from show_sellers where seller_id = 'aaaaaaaa-0000-0000-0000-000000000001')
  then 'PASS 7 seller leaves through leave_show_as_seller()' else 'FAIL 7' end;

-- Organizer of show_1: add, table number, floor pin, remove.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
insert into show_sellers (show_id, seller_id) values ('show_1', 'aaaaaaaa-0000-0000-0000-000000000001');
update show_sellers set table_number = '12', x_pct = 40, y_pct = 60 where show_id = 'show_1' and seller_id = 'aaaaaaaa-0000-0000-0000-000000000001';
delete from show_sellers where show_id = 'show_1' and seller_id = 'bbbbbbbb-0000-0000-0000-000000000002';
select case when (select table_number from show_sellers where seller_id = 'aaaaaaaa-0000-0000-0000-000000000001') = '12'
  and (select x_pct from show_sellers where seller_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 40
  and not exists (select 1 from show_sellers where seller_id = 'bbbbbbbb-0000-0000-0000-000000000002')
  then 'PASS 8 organizer adds, sets table and floor pin, removes' else 'FAIL 8' end;
insert into show_sellers (show_id, seller_id) values ('show_2', 'aaaaaaaa-0000-0000-0000-000000000001');
select case when not exists (select 1 from show_sellers where show_id = 'show_2')
  then 'PASS 9 organizer cannot add to another organizer''s show (error above expected)' else 'FAIL 9' end;

-- Another organizer can't touch show_1; the platform owner can touch any show.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
update show_sellers set table_number = '99' where show_id = 'show_1';
delete from show_sellers where show_id = 'show_1';
select case when (select table_number from show_sellers where show_id = 'show_1') = '12'
  then 'PASS 10 another organizer cannot edit or remove' else 'FAIL 10' end;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000f1';
insert into show_sellers (show_id, seller_id) values ('show_2', 'bbbbbbbb-0000-0000-0000-000000000002');
select case when exists (select 1 from show_sellers where show_id = 'show_2')
  then 'PASS 11 platform owner adds to any show' else 'FAIL 11' end;
reset role;
reset session authorization;
