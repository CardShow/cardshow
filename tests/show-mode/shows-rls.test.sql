-- shows security (20261128120000_shows_rls.sql). Run with shows-rls.test.sh.
-- Prints PASS or FAIL per check. ERROR lines are expected refusals.
\set ON_ERROR_STOP 1
alter table shows add column if not exists created_by uuid, add column if not exists access_code text,
  add column if not exists published_at timestamptz, add column if not exists floor_plan_url text;
create table if not exists public.admins (id uuid primary key);
\i ../../supabase/migrations/20261027120000_seller_self_join.sql
\i ../../supabase/migrations/20261028120000_show_directory.sql
alter table shows enable row level security;
create policy "Allow all" on shows for all using (true) with check (true);
\i ../../supabase/migrations/20261128120000_shows_rls.sql
\i ../../supabase/migrations/20261128120000_shows_rls.sql
grant all on all tables in schema public to anon, authenticated, service_role;
revoke insert, update, delete, truncate on public.shows from anon;
alter role service_role bypassrls;
do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then
  create role authenticator login noinherit; end if; end $$;
grant anon, authenticated, service_role to authenticator;

-- A, B: organizers. P: platform owner. S: seller.
insert into auth.users values ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000b2'),
  ('00000000-0000-0000-0000-0000000000f1'), ('5e000000-0000-0000-0000-000000000005');
insert into admins values ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000b2');
insert into platform_admins values ('00000000-0000-0000-0000-0000000000f1');
insert into sellers values ('5e000000-0000-0000-0000-000000000005', 's');
insert into shows (id, name, created_by) values
  ('show_a', 'A Show', '00000000-0000-0000-0000-0000000000a1'),
  ('show_b', 'B Show', '00000000-0000-0000-0000-0000000000b2'),
  ('show_old', 'Old Show', null);
\set ON_ERROR_STOP 0

select case when (select count(*) from pg_policies where tablename = 'shows') = 4
  and not exists (select 1 from pg_policies where tablename = 'shows' and policyname = 'Allow all')
  then 'PASS 1 old policies dropped, exactly four new ones (migration ran twice)' else 'FAIL 1' end;

set session authorization authenticator;
set role anon;
select case when (select count(*) from shows) = 3 then 'PASS 2 anon reads shows' else 'FAIL 2' end;
insert into shows (id, name) values ('x', 'x');                      -- ERROR expected
update shows set name = 'hacked';                                     -- ERROR expected
delete from shows;                                                    -- ERROR expected
reset role; reset session authorization;
select case when (select count(*) from shows) = 3 and not exists (select 1 from shows where name = 'hacked')
  then 'PASS 3 anon cannot create, edit or delete' else 'FAIL 3' end;

-- Seller
set session authorization authenticator; set role authenticated;
set request.jwt.claim.sub = '5e000000-0000-0000-0000-000000000005';
insert into shows (id, name, created_by) values ('s_show', 'Mine', '5e000000-0000-0000-0000-000000000005');  -- ERROR
update shows set name = 'hacked';
delete from shows;
reset role; reset session authorization;
select case when (select count(*) from shows) = 3 and not exists (select 1 from shows where name = 'hacked')
  then 'PASS 4 a seller cannot create, edit or delete shows' else 'FAIL 4' end;

-- Organizer A
set session authorization authenticator; set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
insert into shows (id, name, created_by) values ('a_new', 'A New', '00000000-0000-0000-0000-0000000000a1');
insert into shows (id, name, created_by) values ('a_fake', 'Fake', '00000000-0000-0000-0000-0000000000b2');   -- ERROR
insert into shows (id, name, created_by) values ('a_anon', 'Nobody', null);                                    -- ERROR
insert into shows (id, name, created_by, status) values ('a_new', 'A New 2', '00000000-0000-0000-0000-0000000000a1', 'active')
  on conflict (id) do update set name = excluded.name, status = excluded.status;
update shows set name = 'A Show!', floor_plan_url = 'x' where id = 'show_a';
update shows set name = 'hacked' where id = 'show_b';
delete from shows where id = 'show_b';
update shows set created_by = '00000000-0000-0000-0000-0000000000b2' where id = 'show_a';                    -- ERROR
update shows set listed = true where id = 'show_a';                                                          -- ERROR
update shows set slug = 'a-show' where id = 'show_a';                                                        -- ERROR
insert into shows (id, name, created_by, listed) values ('a_listed', 'L', '00000000-0000-0000-0000-0000000000a1', true);  -- ERROR
update shows set name = 'Old Show!', created_by = '00000000-0000-0000-0000-0000000000a1' where id = 'show_old';
reset role; reset session authorization;
select case when (select name from shows where id = 'a_new') = 'A New 2'
  and (select status from shows where id = 'a_new') = 'active'
  and not exists (select 1 from shows where id in ('a_fake', 'a_anon', 'a_listed'))
  then 'PASS 5 organizer creates and upserts own shows; can''t create for someone else or unowned' else 'FAIL 5' end;
select case when (select name from shows where id = 'show_a') = 'A Show!'
  and (select created_by from shows where id = 'show_a') = '00000000-0000-0000-0000-0000000000a1'
  and not (select listed from shows where id = 'show_a') and (select slug from shows where id = 'show_a') is null
  then 'PASS 6 organizer edits own show; can''t give it away or list it' else 'FAIL 6' end;
select case when (select name from shows where id = 'show_b') = 'B Show'
  then 'PASS 7 organizer can''t edit or delete another organizer''s show' else 'FAIL 7' end;
select case when (select name from shows where id = 'show_old') = 'Old Show!'
  and (select created_by from shows where id = 'show_old') = '00000000-0000-0000-0000-0000000000a1'
  then 'PASS 8 an older show with no organizer can be edited and claimed by an organizer' else 'FAIL 8' end;

-- Organizer B now can't touch the claimed show
set session authorization authenticator; set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b2';
update shows set name = 'hacked' where id = 'show_old';
delete from shows where id = 'show_b';
reset role; reset session authorization;
select case when (select name from shows where id = 'show_old') = 'Old Show!' and not exists (select 1 from shows where id = 'show_b')
  then 'PASS 9 claimed show is A''s only; B deletes their own show' else 'FAIL 9' end;

-- Platform owner
set session authorization authenticator; set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000f1';
update shows set name = 'A Show (edited)' where id = 'show_a';
insert into shows (id, name, created_by) values ('p_new', 'Directory Show', '00000000-0000-0000-0000-0000000000f1');
update shows set listed = true, slug = 'dir-show' where id = 'p_new';
delete from shows where id = 'a_new';
reset role; reset session authorization;
select case when (select name from shows where id = 'show_a') = 'A Show (edited)'
  and (select listed from shows where id = 'p_new') and not exists (select 1 from shows where id = 'a_new')
  then 'PASS 10 platform owner edits, lists and deletes any show' else 'FAIL 10' end;

set session authorization authenticator; set role service_role;
update shows set status = 'past' where id = 'show_a';
reset role; reset session authorization;
select case when (select status from shows where id = 'show_a') = 'past'
  then 'PASS 11 service role (status job) still updates shows' else 'FAIL 11' end;
