-- shows security: only organizers create shows, and only a show's organizer (or the platform owner)
-- edits or deletes it. Re-runnable. See CLAUDE.md "shows security".
-- Run after 20261028120000_show_directory.sql (uses platform_admins and the listing columns).
--
-- Before: the dashboard-made policies let anyone (anon included) create, rename, re-date, list or
-- delete any show. After:
-- * Read: everyone (show.html, Join a show, the buyer view and access-code lookups read as anon).
-- * Create: an organizer (admins) or the platform owner (platform_admins), as created_by = themselves.
--   The platform owner may create a show for another organizer.
-- * Edit / delete: the show's organizer (created_by), any organizer for a show with no created_by
--   (older shows), or the platform owner. An organizer can't hand a show to someone else.
-- * Listing (listed, listed_at, listed_by, slug, merged_into) stays with the platform owner: only
--   set_show_listed() / merge_shows() or the platform owner can change it, so an organizer can't list
--   their own show.
-- Unaffected: the service role (refresh_show_statuses job) and SECURITY DEFINER functions
-- (set_show_listed, merge_shows, delete_show, resolve_show_request, join/leave) bypass RLS.
--
-- To see the policies this replaces, run before applying:
--   select policyname, cmd, roles, qual, with_check from pg_policies
--    where schemaname = 'public' and tablename = 'shows';

begin;

alter table public.shows add column if not exists created_by uuid;

-- Signed in as an organizer (admins) or the platform owner.
create or replace function public._shows_is_admin() returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_found boolean := false;
begin
  if v_uid is null then return false; end if;
  if to_regclass('public.admins') is not null then
    execute 'select exists (select 1 from public.admins where id = $1)' into v_found using v_uid;
    if v_found then return true; end if;
  end if;
  return public._shows_is_platform_admin();
end $$;

create or replace function public._shows_is_platform_admin() returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_found boolean := false;
begin
  if v_uid is null or to_regclass('public.platform_admins') is null then return false; end if;
  execute 'select exists (select 1 from public.platform_admins where id = $1)' into v_found using v_uid;
  return v_found;
end $$;

-- May the caller write a show row whose creator is p_created_by?
create or replace function public._shows_can_edit(p_created_by uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then return false; end if;
  if public._shows_is_platform_admin() then return true; end if;
  if p_created_by is not null then return p_created_by = auth.uid(); end if;
  return public._shows_is_admin();
end $$;

revoke all on function public._shows_is_admin() from public;
revoke all on function public._shows_is_platform_admin() from public;
revoke all on function public._shows_can_edit(uuid) from public;
grant execute on function public._shows_is_admin() to authenticated;
grant execute on function public._shows_is_platform_admin() to authenticated;
grant execute on function public._shows_can_edit(uuid) to authenticated;

alter table public.shows enable row level security;

do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'shows' loop
    execute format('drop policy %I on public.shows', p.policyname);
  end loop;
end $$;

create policy shows_read_all on public.shows
  for select to anon, authenticated using (true);
create policy shows_insert_organizer on public.shows
  for insert to authenticated
  with check (public._shows_is_admin()
              and (created_by = auth.uid() or public._shows_is_platform_admin()));
create policy shows_update_organizer on public.shows
  for update to authenticated
  using (public._shows_can_edit(created_by))
  with check (public._shows_can_edit(created_by));
create policy shows_delete_organizer on public.shows
  for delete to authenticated using (public._shows_can_edit(created_by));

revoke insert, update, delete, truncate on public.shows from anon;

-- Listing is the platform owner's call. Read through to_jsonb so a project without the directory
-- columns yet doesn't break.
create or replace function public._shows_listing_guard() returns trigger
language plpgsql set search_path = public as $$
declare k text; n jsonb; o jsonb;
begin
  if current_user not in ('anon', 'authenticated') then return new; end if;   -- service role, definer functions
  if public._shows_is_platform_admin() then return new; end if;
  n := to_jsonb(new);
  o := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  foreach k in array array['listed', 'listed_at', 'listed_by', 'slug', 'merged_into'] loop
    if tg_op = 'INSERT' then
      if coalesce(n->>k, 'false') not in ('false') then
        raise exception 'listing_locked' using errcode = '42501',
          hint = 'Only CardShow lists shows (Show Directory).';
      end if;
    elsif (n->k) is distinct from (o->k) then
      raise exception 'listing_locked' using errcode = '42501',
        hint = 'Only CardShow lists shows (Show Directory).';
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists shows_listing_guard on public.shows;
create trigger shows_listing_guard before insert or update on public.shows
  for each row execute function public._shows_listing_guard();

commit;

-- Check (run after): expect shows_delete_organizer, shows_insert_organizer, shows_read_all, shows_update_organizer.
--   select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'shows';
