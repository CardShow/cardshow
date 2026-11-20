-- show_inventory security (20261125120000_show_inventory_rls.sql). Run with show-inventory-rls.test.sh.
-- Prints PASS or FAIL per check. ERROR lines are expected refusals.
\set ON_ERROR_STOP 1
alter table shows add column if not exists created_by uuid;
create table if not exists public.admins (id uuid primary key);
create table if not exists public.platform_admins (id uuid primary key);
alter table show_inventory enable row level security;
create policy "Allow all" on show_inventory for all using (true) with check (true);
\i ../../supabase/migrations/20261125120000_show_inventory_rls.sql
\i ../../supabase/migrations/20261125120000_show_inventory_rls.sql
grant all on all tables in schema public to anon, authenticated, service_role;
revoke insert, update, delete, truncate on public.show_inventory from anon;
alter role service_role bypassrls;
do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then
  create role authenticator login noinherit; end if; end $$;
grant anon, authenticated, service_role to authenticator;

-- A, B: sellers in show_1. C: seller not in show_1. O: organizer of show_1. O2: another organizer.
-- L: an admin; show_legacy has no created_by. P: platform owner.
insert into auth.users values ('aaaaaaaa-0000-0000-0000-000000000001'), ('bbbbbbbb-0000-0000-0000-000000000002'),
  ('cccccccc-0000-0000-0000-000000000003'), ('00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000a2'), ('00000000-0000-0000-0000-0000000000a3'), ('00000000-0000-0000-0000-0000000000f1');
insert into sellers values ('aaaaaaaa-0000-0000-0000-000000000001', 'a'), ('bbbbbbbb-0000-0000-0000-000000000002', 'b'),
  ('cccccccc-0000-0000-0000-000000000003', 'c');
insert into admins values ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000a2'), ('00000000-0000-0000-0000-0000000000a3');
insert into platform_admins values ('00000000-0000-0000-0000-0000000000f1');
insert into shows (id, name, created_by) values ('show_1', 'One', '00000000-0000-0000-0000-0000000000a1'),
  ('show_2', 'Two', '00000000-0000-0000-0000-0000000000a2'), ('show_legacy', 'Legacy', null);
insert into show_sellers (show_id, seller_id) values ('show_1', 'aaaaaaaa-0000-0000-0000-000000000001'),
  ('show_1', 'bbbbbbbb-0000-0000-0000-000000000002'), ('show_legacy', 'cccccccc-0000-0000-0000-000000000003');
insert into inventory (id, seller_id, card_title) values
  ('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'A1'),
  ('a0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'A2'),
  ('b0000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 'B1'),
  ('b0000000-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', 'B2'),
  ('c0000000-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000003', 'C1');
insert into show_inventory values ('show_1', 'b0000000-0000-0000-0000-000000000001');
\set ON_ERROR_STOP 0

select case when (select count(*) from pg_policies where tablename = 'show_inventory') = 4
  and not exists (select 1 from pg_policies where tablename = 'show_inventory' and policyname = 'Allow all')
  then 'PASS 1 old policies dropped, exactly four new ones (migration ran twice)' else 'FAIL 1' end;

set session authorization authenticator;
set role anon;
select case when (select count(*) from show_inventory) = 1 then 'PASS 2 anon can still read' else 'FAIL 2' end;
insert into show_inventory values ('show_1', 'a0000000-0000-0000-0000-000000000001');
delete from show_inventory;
select case when (select count(*) from show_inventory) = 1 then 'PASS 3 anon cannot add or remove (errors above expected)' else 'FAIL 3' end;

set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
insert into show_inventory values ('show_1', 'a0000000-0000-0000-0000-000000000001');
insert into show_inventory values ('show_1', 'a0000000-0000-0000-0000-000000000001')
  on conflict (show_id, card_id) do update set card_id = excluded.card_id;   -- the app's upsert
select case when exists (select 1 from show_inventory where card_id = 'a0000000-0000-0000-0000-000000000001')
  then 'PASS 4 seller adds own card to a show they are in, re-publish (upsert) works' else 'FAIL 4' end;
insert into show_inventory values ('show_1', 'b0000000-0000-0000-0000-000000000002');
insert into show_inventory values ('show_2', 'a0000000-0000-0000-0000-000000000002');
delete from show_inventory where card_id = 'b0000000-0000-0000-0000-000000000001';
select case when not exists (select 1 from show_inventory where card_id in ('b0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000002'))
  and exists (select 1 from show_inventory where card_id = 'b0000000-0000-0000-0000-000000000001')
  then 'PASS 5 seller cannot add another seller''s card, add to a show they''re not in, or remove another seller''s card' else 'FAIL 5' end;
delete from show_inventory where card_id = 'a0000000-0000-0000-0000-000000000001';
select case when not exists (select 1 from show_inventory where card_id = 'a0000000-0000-0000-0000-000000000001')
  then 'PASS 6 seller removes own card' else 'FAIL 6' end;

-- Organizer of show_1 publishes and removes other sellers' cards there.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
insert into show_inventory values ('show_1', 'a0000000-0000-0000-0000-000000000001'), ('show_1', 'b0000000-0000-0000-0000-000000000002')
  on conflict (show_id, card_id) do update set card_id = excluded.card_id;
insert into show_inventory values ('show_1', 'c0000000-0000-0000-0000-000000000001');
select case when (select count(*) from show_inventory where show_id = 'show_1') = 3
  and not exists (select 1 from show_inventory where card_id = 'c0000000-0000-0000-0000-000000000001')
  then 'PASS 7 organizer publishes authorized sellers'' cards, not an outsider''s' else 'FAIL 7' end;
delete from show_inventory where show_id = 'show_1' and card_id = 'b0000000-0000-0000-0000-000000000002';
select case when not exists (select 1 from show_inventory where card_id = 'b0000000-0000-0000-0000-000000000002')
  then 'PASS 8 organizer removes a seller''s card from their show' else 'FAIL 8' end;

-- Another organizer can't touch show_1.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
insert into show_inventory values ('show_1', 'b0000000-0000-0000-0000-000000000002');
delete from show_inventory where show_id = 'show_1';
select case when (select count(*) from show_inventory where show_id = 'show_1') = 2
  then 'PASS 9 another organizer cannot add to or remove from the show' else 'FAIL 9' end;

-- Seller removed from show_1 can no longer add to it, but can still take their card out.
set role service_role; delete from show_sellers where seller_id = 'aaaaaaaa-0000-0000-0000-000000000001'; set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
insert into show_inventory values ('show_1', 'a0000000-0000-0000-0000-000000000002');
delete from show_inventory where card_id = 'a0000000-0000-0000-0000-000000000001';
select case when not exists (select 1 from show_inventory where card_id::text like 'a%')
  then 'PASS 10 removed seller can''t republish, can still remove own card' else 'FAIL 10' end;

-- Legacy show (no created_by): any admin; platform owner: any show.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a3';
insert into show_inventory values ('show_legacy', 'c0000000-0000-0000-0000-000000000001');
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000f1';
delete from show_inventory where show_id = 'show_1';
select case when exists (select 1 from show_inventory where show_id = 'show_legacy')
  and not exists (select 1 from show_inventory where show_id = 'show_1')
  then 'PASS 11 admin publishes on a show with no organizer; platform owner removes from any show' else 'FAIL 11' end;

-- Seller C can't call the helper as someone else's card / show 2.
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select case when not public._show_inventory_can_add('show_2', 'c0000000-0000-0000-0000-000000000001')
  and not public._show_inventory_is_organizer('show_1')
  then 'PASS 12 helpers answer only for the caller' else 'FAIL 12' end;
reset role;
reset session authorization;
set role service_role;
delete from show_inventory where show_id = 'show_legacy';
select case when not exists (select 1 from show_inventory) then 'PASS 13 service role (GTCR function) still removes cards' else 'FAIL 13' end;
reset role;
