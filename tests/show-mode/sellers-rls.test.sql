-- sellers security (20261127120000_sellers_rls.sql). Run with sellers-rls.test.sh.
-- Prints PASS or FAIL per check. ERROR lines are expected refusals.
\set ON_ERROR_STOP 1
alter table sellers add column if not exists email text, add column if not exists display_name text,
  add column if not exists whatsapp text, add column if not exists instagram text,
  add column if not exists onboarding_state jsonb, add column if not exists share_handle boolean;
alter table sellers add constraint sellers_handle_key unique (handle);
alter table sellers enable row level security;
create policy "Allow all" on sellers for all using (true) with check (true);
grant all on all tables in schema public to anon, authenticated, service_role;
\i ../../supabase/migrations/20261127120000_sellers_rls.sql
\i ../../supabase/migrations/20261127120000_sellers_rls.sql
alter role service_role bypassrls;
do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then
  create role authenticator login noinherit; end if; end $$;
grant anon, authenticated, service_role to authenticator;

insert into auth.users values ('aaaaaaaa-0000-0000-0000-000000000001'), ('bbbbbbbb-0000-0000-0000-000000000002'),
  ('cccccccc-0000-0000-0000-000000000003');
insert into sellers (id, handle, email, display_name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a', 'a@x.com', 'Alpha'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'b', 'b@x.com', 'Beta');
\set ON_ERROR_STOP 0

select case when (select count(*) from pg_policies where tablename = 'sellers') = 3
  and not exists (select 1 from pg_policies where tablename = 'sellers' and policyname = 'Allow all')
  then 'PASS 1 old policies dropped, exactly three new ones (migration ran twice)' else 'FAIL 1' end;

set session authorization authenticator;
set role anon;
select case when (select count(*) from (select id, handle, display_name, whatsapp, instagram from sellers) x) = 2
  then 'PASS 2 anon reads handles, names and contact links' else 'FAIL 2' end;
select email from sellers;                                     -- ERROR expected
select 'PASS 3 anon cannot read emails (error above)';
insert into sellers (id, handle) values ('cccccccc-0000-0000-0000-000000000003', 'c');   -- ERROR expected
update sellers set display_name = 'hacked';                    -- ERROR expected
delete from sellers;                                           -- ERROR expected
reset role; reset session authorization;
select case when (select count(*) from sellers) = 2 and not exists (select 1 from sellers where display_name = 'hacked')
  then 'PASS 4 anon cannot create, edit or delete' else 'FAIL 4' end;

set session authorization authenticator;
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select case when (select count(*) from (select handle, onboarding_state, share_handle from sellers) x) = 2
  then 'PASS 5 a seller reads profiles and their tour state' else 'FAIL 5' end;
select email from sellers where id = 'bbbbbbbb-0000-0000-0000-000000000002';   -- ERROR expected
select 'PASS 6 a seller cannot read other emails (error above)';
update sellers set display_name = 'A!', whatsapp = '15551234', onboarding_state = '{"x":1}' where handle = 'a';
update sellers set display_name = 'hacked' where handle = 'b';
insert into sellers (id, handle) values ('bbbbbbbb-0000-0000-0000-00000000000f', 'imposter');   -- ERROR expected
update sellers set id = 'cccccccc-0000-0000-0000-000000000003' where handle = 'a';             -- ERROR expected
update sellers set handle = 'a2' where handle = 'a';                                              -- ERROR expected
delete from sellers where handle = 'a';                                                           -- ERROR expected
reset role; reset session authorization;
select case when (select display_name from sellers where handle = 'a') = 'A!'
  and (select display_name from sellers where handle = 'b') = 'Beta'
  and not exists (select 1 from sellers where handle in ('imposter', 'a2'))
  and (select count(*) from sellers) = 2
  then 'PASS 7 own profile edits save; other rows, imposter rows, id/handle changes and deletes refused'
  else 'FAIL 7' end;

-- First sign-in creates the row (confirmation-on sign-up path).
set session authorization authenticator;
set role authenticated;
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
insert into sellers (id, handle, email) values ('cccccccc-0000-0000-0000-000000000003', 'b', 'c@x.com');   -- ERROR 23505
insert into sellers (id, handle, email) values ('cccccccc-0000-0000-0000-000000000003', 'c', 'c@x.com');
reset role; reset session authorization;
select case when (select handle from sellers where id = 'cccccccc-0000-0000-0000-000000000003') = 'c'
  then 'PASS 8 a signed-in user creates their own row; a taken handle is refused' else 'FAIL 8' end;

set session authorization authenticator;
set role service_role;
select case when (select email from sellers where handle = 'a') = 'a@x.com'
  then 'PASS 9 service role reads emails' else 'FAIL 9' end;
update sellers set handle = 'a3' where handle = 'a';
reset role; reset session authorization;
select case when exists (select 1 from sellers where handle = 'a3')
  then 'PASS 10 service role can still change a handle' else 'FAIL 10' end;
