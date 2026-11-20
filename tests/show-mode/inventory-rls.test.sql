-- Inventory security (20261124120000_inventory_rls.sql). Run with inventory-rls.test.sh.
-- Prints PASS or FAIL per check. ERROR lines are expected refusals.
\set ON_ERROR_STOP 1
alter table inventory add column if not exists sold_date text, add column if not exists sale_notes text;
\i ../../supabase/migrations/20261101120000_gtcr_buyer_badge.sql
\i ../../supabase/migrations/20261102120000_gtcr_daily_recheck.sql
-- The dashboard-made policies this replaces were wide open; recreate that starting point.
alter table inventory enable row level security;
create policy "Allow all" on inventory for all using (true) with check (true);
\i ../../supabase/migrations/20261124120000_inventory_rls.sql
\i ../../supabase/migrations/20261124120000_inventory_rls.sql
grant all on all tables in schema public to anon, authenticated, service_role;
revoke insert, update, delete, truncate on public.inventory from anon;
alter role service_role bypassrls;
do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then
  create role authenticator login noinherit; end if; end $$;
grant anon, authenticated, service_role to authenticator;

insert into auth.users values ('aaaaaaaa-0000-0000-0000-000000000001'), ('bbbbbbbb-0000-0000-0000-000000000002');
insert into sellers values ('aaaaaaaa-0000-0000-0000-000000000001', 'dealer_a'), ('bbbbbbbb-0000-0000-0000-000000000002', 'dealer_b');
insert into inventory (id, seller_id, card_title, price, grader, cert_number, status) values
  ('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'A1', 100, 'PSA', '111', 'Available'),
  ('b0000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 'B1', 50, 'PSA', '222', 'Available');
update inventory set trust_flag = 'flagged' where id = 'b0000000-0000-0000-0000-000000000001';
update inventory set trust_clear_at = now(), trust_recheck_at = now() where id = 'a0000000-0000-0000-0000-000000000001';
\set ON_ERROR_STOP 0

select case when (select count(*) from pg_policies where tablename = 'inventory') = 4
  and not exists (select 1 from pg_policies where tablename = 'inventory' and policyname = 'Allow all')
  then 'PASS 1 old policies dropped, exactly four new ones (migration ran twice)' else 'FAIL 1' end;

set session authorization authenticator;
set role anon;
select case when (select count(*) from inventory) = 2 then 'PASS 2 anon can still read every card' else 'FAIL 2' end;
insert into inventory (seller_id, card_title) values ('aaaaaaaa-0000-0000-0000-000000000001', 'anon insert');
update inventory set price = 1;
delete from inventory;
reset role;

set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select case when (select count(*) from inventory) = 2 and (select sum(price) from inventory) = 150
  then 'PASS 3 anon could not insert, update or delete (errors above expected)' else 'FAIL 3' end;

insert into inventory (id, seller_id, card_title, price) values ('a0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'A2', 20);
update inventory set price = 120 where id = 'a0000000-0000-0000-0000-000000000001';
select case when (select price from inventory where id = 'a0000000-0000-0000-0000-000000000001') = 120
  and exists (select 1 from inventory where id = 'a0000000-0000-0000-0000-000000000002')
  then 'PASS 4 seller inserts and edits own cards' else 'FAIL 4' end;

insert into inventory (seller_id, card_title) values ('bbbbbbbb-0000-0000-0000-000000000002', 'planted on B');
update inventory set price = 1 where id = 'b0000000-0000-0000-0000-000000000001';
delete from inventory where id = 'b0000000-0000-0000-0000-000000000001';
update inventory set seller_id = 'bbbbbbbb-0000-0000-0000-000000000002' where id = 'a0000000-0000-0000-0000-000000000002';
select case when not exists (select 1 from inventory where card_title = 'planted on B')
  and (select price from inventory where id = 'b0000000-0000-0000-0000-000000000001') = 50
  and (select seller_id from inventory where id = 'a0000000-0000-0000-0000-000000000002') = 'aaaaaaaa-0000-0000-0000-000000000001'
  then 'PASS 5 seller cannot insert as, edit, delete or give cards to another seller' else 'FAIL 5' end;

-- Trust fields.
update inventory set trust_flag = 'flagged' where id = 'a0000000-0000-0000-0000-000000000001';
update inventory set trust_clear_at = now() + interval '1 year' where id = 'a0000000-0000-0000-0000-000000000001';
insert into inventory (seller_id, card_title, trust_clear_at) values ('aaaaaaaa-0000-0000-0000-000000000001', 'fake badge', now());
select case when (select trust_flag from inventory where id = 'a0000000-0000-0000-0000-000000000001') is null
  and (select trust_clear_at < now() + interval '1 day' from inventory where id = 'a0000000-0000-0000-0000-000000000001')
  and not exists (select 1 from inventory where card_title = 'fake badge')
  then 'PASS 6 seller cannot set trust_flag or a GTCR badge (errors above expected)' else 'FAIL 6' end;
-- Editing the cert still clears the badge (cert-change trigger), and a plain edit keeps it.
update inventory set price = 125 where id = 'a0000000-0000-0000-0000-000000000001';
select case when (select trust_clear_at is not null from inventory where id = 'a0000000-0000-0000-0000-000000000001')
  then 'PASS 7 a normal edit keeps the GTCR badge' else 'FAIL 7' end;
update inventory set cert_number = '999' where id = 'a0000000-0000-0000-0000-000000000001';
select case when (select trust_clear_at is null and trust_recheck_at is null from inventory where id = 'a0000000-0000-0000-0000-000000000001')
  then 'PASS 8 editing the cert # clears the badge as before' else 'FAIL 8' end;
delete from inventory where id = 'a0000000-0000-0000-0000-000000000002';
select case when not exists (select 1 from inventory where id = 'a0000000-0000-0000-0000-000000000002')
  then 'PASS 9 seller deletes own card' else 'FAIL 9' end;

-- Seller B can't clear their own stolen flag; the service role (GTCR functions) can.
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
update inventory set trust_flag = null where id = 'b0000000-0000-0000-0000-000000000001';
reset role; set role service_role;
select case when (select trust_flag from inventory where id = 'b0000000-0000-0000-0000-000000000001') = 'flagged'
  then 'PASS 10 seller cannot clear their own stolen flag (error above expected)' else 'FAIL 10' end;
update inventory set trust_flag = 'disputed', trust_clear_at = null where id = 'b0000000-0000-0000-0000-000000000001';
update inventory set trust_clear_at = now() where id = 'a0000000-0000-0000-0000-000000000001';
select case when (select trust_flag from inventory where id = 'b0000000-0000-0000-0000-000000000001') = 'disputed'
  and (select trust_clear_at is not null from inventory where id = 'a0000000-0000-0000-0000-000000000001')
  then 'PASS 11 service role (GTCR) still sets trust fields on any card' else 'FAIL 11' end;
reset role; reset session authorization;
