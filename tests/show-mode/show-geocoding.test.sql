-- Show geocoding (20261201120000_show_geocoding.sql). Run with show-geocoding.test.sh.
\set ON_ERROR_STOP 1
alter table shows add column if not exists created_by uuid, add column if not exists access_code text,
  add column if not exists published_at timestamptz, add column if not exists floor_plan_url text;
create table if not exists public.admins (id uuid primary key);
\i ../../supabase/migrations/20261027120000_seller_self_join.sql
\i ../../supabase/migrations/20261028120000_show_directory.sql
alter table shows enable row level security;
create policy "Allow all" on shows for all using (true) with check (true);
\i ../../supabase/migrations/20261128120000_shows_rls.sql
\i ../../supabase/migrations/20261201120000_show_geocoding.sql
\i ../../supabase/migrations/20261201120000_show_geocoding.sql
grant all on all tables in schema public to anon, authenticated, service_role;
revoke insert, update, delete, truncate on public.shows from anon;
alter role service_role bypassrls;
do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then
  create role authenticator login noinherit; end if; end $$;
grant anon, authenticated, service_role to authenticator;

insert into auth.users values ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000f1');
insert into admins values ('00000000-0000-0000-0000-0000000000a1');
insert into platform_admins values ('00000000-0000-0000-0000-0000000000f1');
insert into shows (id, name, created_by, city, state) values ('show_a', 'A Show', '00000000-0000-0000-0000-0000000000a1', 'Sacramento', 'CA');
\set ON_ERROR_STOP 0
create or replace function pg_temp.ok(p_name text, p_cond boolean) returns text language sql as $$
  select case when coalesce(p_cond, false) then 'PASS ' else 'FAIL ' end || p_name $$;

-- service role sets a location
set session authorization authenticator; set role service_role;
update shows set latitude = 38.5954, longitude = -121.4343, geo_source = 'census_address', geocoded_at = now() where id = 'show_a';
reset role; reset session authorization;
select pg_temp.ok('01 service role sets the location', (select geo_source = 'census_address' and latitude = 38.5954 from shows where id = 'show_a'));

-- organizer can edit the show but not its coordinates
set session authorization authenticator; set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
do $$ begin update shows set latitude = 40, longitude = -70 where id = 'show_a'; exception when others then null; end $$;
reset role; reset session authorization;
select pg_temp.ok('02 organizer cannot move the show', (select latitude = 38.5954 from shows where id = 'show_a'));
set session authorization authenticator; set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
update shows set name = 'A Show 2026' where id = 'show_a';
reset role; reset session authorization;
select pg_temp.ok('03 other edits keep the location', (select name = 'A Show 2026' and geo_source = 'census_address' from shows where id = 'show_a'));
set session authorization authenticator; set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
update shows set street_address = '1600 Exposition Blvd' where id = 'show_a';
reset role; reset session authorization;
select pg_temp.ok('04 address change clears the location for re-geocoding',
  (select latitude is null and longitude is null and geo_source is null and geocoded_at is null from shows where id = 'show_a'));
set session authorization authenticator; set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
do $$ begin insert into shows (id, name, created_by, latitude, longitude) values ('show_x', 'X', '00000000-0000-0000-0000-0000000000a1', 1, 1);
  exception when others then null; end $$;
reset role; reset session authorization;
select pg_temp.ok('05 organizer cannot create a show with coordinates', not exists (select 1 from shows where id = 'show_x'));

-- platform owner can set one by hand
set session authorization authenticator; set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000f1';
update shows set latitude = 38.59, longitude = -121.43, geo_source = 'manual' where id = 'show_a';
reset role; reset session authorization;
select pg_temp.ok('06 platform owner sets a manual location', (select geo_source = 'manual' from shows where id = 'show_a'));
set session authorization authenticator; set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000f1';
update shows set city = 'West Sacramento', latitude = 38.58, longitude = -121.53, geo_source = 'manual' where id = 'show_a';
reset role; reset session authorization;
select pg_temp.ok('07 address change with new coordinates in the same update keeps them', (select latitude = 38.58 from shows where id = 'show_a'));
do $$ begin update shows set latitude = 95 where id = 'show_a'; exception when others then null; end $$;
select pg_temp.ok('08 out-of-range latitude refused', (select latitude = 38.58 from shows where id = 'show_a'));
